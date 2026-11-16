import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUDIENCES, MAX_BATCH, SOURCES, type DraftBatch, type DraftQuestion, type GenerateRequest } from '../../shared/packs.js';
import {
  DEFAULT_MODEL,
  MODELS,
  describeError,
  generateQuestions,
  hasCredentials,
  verifyQuestions,
  writeFacts,
} from './author.js';
import { OPENTDB_CATEGORIES, UNAVAILABLE_REASON, importQuestions } from './trivia-db.js';
import type { Bank } from './content.js';
import type { DraftStore } from './drafts.js';
import { listPacks, packPrompts, publishPack } from './packs.js';

/**
 * REST endpoints behind the authoring screen.
 *
 * Kept separate from the websocket because none of it is live: generating a
 * batch takes the better part of a minute, review happens over an evening, and
 * none of it should be able to touch a game in progress.
 */

export interface AuthorDeps {
  contentDir: string;
  drafts: DraftStore;
  bank: () => Bank;
  reloadBank: () => { ok: boolean; message: string };
  /** Returns true when the bearer token in the request is a valid control token. */
  authorised: (req: IncomingMessage) => boolean;
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

/** Returns true when it handled the request. */
export async function handleAuthorRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: AuthorDeps,
): Promise<boolean> {
  if (!path.startsWith('/api/author')) return false;

  if (!deps.authorised(req)) {
    send(res, 401, { error: 'The question bank editor needs the host password.' });
    return true;
  }

  try {
    // --- what the screen needs to render itself
    if (path === '/api/author/context' && req.method === 'GET') {
      const bank = deps.bank();
      send(res, 200, {
        credentials: hasCredentials(),
        models: MODELS,
        defaultModel: DEFAULT_MODEL,
        audiences: AUDIENCES,
        maxBatch: MAX_BATCH,
        sources: SOURCES,
        categories: bank.categories.map((c) => ({
          id: c.id,
          name: c.name,
          blurb: c.blurb,
          count: (bank.byCategory.get(c.id) ?? []).length,
          // Which sources can fill this category. The screen greys out what it
          // cannot offer and says why, rather than letting the MC pick a
          // category that returns nothing after a five-second wait.
          importable: !!OPENTDB_CATEGORIES[c.id]?.length,
          importBlockedReason: OPENTDB_CATEGORIES[c.id]?.length
            ? undefined
            : UNAVAILABLE_REASON[c.id] ?? 'Open Trivia DB has no counterpart for this category.',
        })),
        packs: listPacks(deps.contentDir),
        batches: deps.drafts.list().map((b) => ({
          id: b.id,
          created: b.created,
          category: b.category,
          audience: b.audience,
          model: b.model,
          costCents: b.costCents,
          total: b.questions.length,
          pending: b.questions.filter((q) => q.status === 'pending').length,
          approved: b.questions.filter((q) => q.status === 'approved').length,
        })),
      });
      return true;
    }

    // --- generate, then independently verify, then park for review
    if (path === '/api/author/generate' && req.method === 'POST') {
      const body = await readJson<GenerateRequest>(req);
      const bank = deps.bank();
      const existing = packPrompts(deps.contentDir);
      const model = body.model ?? DEFAULT_MODEL;

      let questions: DraftQuestion[];
      let rejectedDuplicates: string[];
      let costCents = 0;
      const notes: string[] = [];

      if (body.source === 'opentdb') {
        // An import arrives with no reveal line, so the fact-writing pass is
        // not optional here the way verification is elsewhere: without it the
        // batch cannot be published at all.
        const imported = await importQuestions(body, bank, existing);
        questions = imported.questions;
        rejectedDuplicates = imported.rejectedDuplicates;
        if (imported.difficultyCapped) {
          notes.push(
            'Open Trivia DB has no difficulty 4. The slots that asked for one hold its hardest instead.',
          );
        }

        const category = bank.categoryById.get(body.category);
        const prepared = await writeFacts(
          questions,
          { name: category?.name ?? body.category, blurb: category?.blurb ?? '' },
          model,
        );
        questions = prepared.drafts;
        costCents += prepared.costCents;

        // Only verify what still has a chance. A question the fact pass already
        // flagged is rejected whatever the verifier thinks of it, so checking it
        // buys nothing and costs output tokens on exactly the batches that went
        // worst - a category the source cannot fill pays twice for the news.
        const worthChecking = questions.filter((q) => !prepared.flags.has(q.id));
        if (worthChecking.length) {
          const verified = await verifyQuestions(worthChecking, model);
          costCents += verified.costCents;
          const byId = new Map(verified.drafts.map((d) => [d.id, d]));
          questions = questions.map((q) => byId.get(q.id) ?? q);
        }

        // Applied after verification on purpose. The fact pass is the only
        // thing that saw the original options against the house rule about
        // plausible distractors, and a verifier that likes the answer must not
        // be able to promote a question the fact pass rejected.
        questions = questions.map((q) => {
          const flag = prepared.flags.get(q.id);
          if (!flag) return q;
          return {
            ...q,
            status: 'rejected' as const,
            verdictNote: [q.verdictNote, flag].map((t) => t.trim()).filter(Boolean).join(' '),
          };
        });
      } else {
        const generated = await generateQuestions(body, bank, existing);
        questions = generated.questions;
        rejectedDuplicates = generated.rejectedDuplicates;
        costCents += generated.costCents;

        if (questions.length) {
          const verified = await verifyQuestions(questions, generated.model);
          questions = verified.drafts;
          costCents += verified.costCents;
        }
      }

      const batch: DraftBatch = {
        id: randomUUID(),
        created: new Date().toISOString(),
        audience: body.audience,
        category: body.category,
        requested: body.count,
        model,
        costCents: Math.round(costCents * 100) / 100,
        questions,
        rejectedDuplicates,
        source: body.source ?? 'claude',
        notes,
      };
      deps.drafts.save(batch);
      send(res, 200, batch);
      return true;
    }

    const batchMatch = /^\/api\/author\/batch\/([a-z0-9-]+)(\/[a-z]+)?$/i.exec(path);
    if (batchMatch) {
      const id = batchMatch[1]!;
      const action = batchMatch[2];
      const batch = deps.drafts.get(id);
      if (!batch) {
        send(res, 404, { error: 'That batch is no longer here.' });
        return true;
      }

      if (!action && req.method === 'GET') {
        send(res, 200, batch);
        return true;
      }

      if (!action && req.method === 'DELETE') {
        deps.drafts.remove(id);
        send(res, 200, { ok: true });
        return true;
      }

      // --- the reviewer's verdict, and any edits they made along the way
      if (action === '/review' && req.method === 'POST') {
        const body = await readJson<{
          updates: Array<{
            id: string;
            status?: 'pending' | 'approved' | 'rejected';
            prompt?: string;
            answer?: string;
            distractors?: string[];
            fact?: string;
            difficulty?: 1 | 2 | 3 | 4;
          }>;
        }>(req);

        for (const update of body.updates ?? []) {
          const question = batch.questions.find((q) => q.id === update.id);
          if (!question) continue;
          if (update.status) question.status = update.status;
          if (typeof update.prompt === 'string') question.prompt = update.prompt.trim();
          if (typeof update.answer === 'string') question.answer = update.answer.trim();
          if (Array.isArray(update.distractors)) {
            question.distractors = update.distractors.map((d) => String(d).trim()).filter(Boolean);
          }
          if (typeof update.fact === 'string') question.fact = update.fact.trim();
          if (update.difficulty) question.difficulty = update.difficulty;
        }
        deps.drafts.save(batch);
        send(res, 200, batch);
        return true;
      }

      // --- write approved questions to a pack file
      if (action === '/publish' && req.method === 'POST') {
        const body = await readJson<{
          name: string;
          reviewedBy: string;
          notes?: string;
          appendTo?: string;
          deleteBatch?: boolean;
        }>(req);

        const result = publishPack(deps.contentDir, {
          name: body.name,
          audience: batch.audience,
          reviewedBy: body.reviewedBy,
          notes: body.notes,
          model: batch.model,
          questions: batch.questions,
          appendTo: body.appendTo,
        });

        const reload = deps.reloadBank();
        if (body.deleteBatch !== false) deps.drafts.remove(batch.id);
        send(res, 200, { pack: result.meta, file: result.file, reload });
        return true;
      }
    }

    send(res, 404, { error: 'No such endpoint.' });
    return true;
  } catch (err) {
    send(res, 400, { error: describeError(err) });
    return true;
  }
}
