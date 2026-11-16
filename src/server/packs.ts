import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Audience, DraftQuestion, PackMeta } from '../../shared/packs.js';

/**
 * Reading and writing question packs on disk.
 *
 * A published pack is an ordinary content file with a `pack:` header, so the
 * normal loader, validator and review tooling all work on it unchanged. That
 * is deliberate: once a pack is written there is nothing special about it, and
 * a human can open it in a text editor and fix a typo without going near the
 * authoring screen.
 */

export function packsDir(contentDir: string): string {
  return join(contentDir, 'packs');
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'pack';
}

export function listPacks(contentDir: string): PackMeta[] {
  const dir = packsDir(contentDir);
  if (!existsSync(dir)) return [];
  const out: PackMeta[] = [];
  for (const entry of readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    try {
      const doc = parse(readFileSync(join(dir, entry), 'utf8')) as {
        pack?: Partial<PackMeta>;
        questions?: unknown[];
      };
      if (!doc?.pack?.id) continue;
      out.push({
        id: doc.pack.id,
        name: doc.pack.name ?? doc.pack.id,
        audience: (doc.pack.audience ?? 'any') as Audience,
        created: doc.pack.created ?? '',
        origin: doc.pack.origin ?? 'generated',
        model: doc.pack.model,
        reviewedBy: doc.pack.reviewedBy,
        notes: doc.pack.notes,
        questionCount: Array.isArray(doc.questions) ? doc.questions.length : 0,
      });
    } catch {
      // A malformed pack shouldn't stop the list rendering; the content
      // validator is what reports it properly.
    }
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

export function packPrompts(contentDir: string): string[] {
  const dir = packsDir(contentDir);
  if (!existsSync(dir)) return [];
  const prompts: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    try {
      const doc = parse(readFileSync(join(dir, entry), 'utf8')) as { questions?: Array<{ prompt?: unknown }> };
      for (const q of doc?.questions ?? []) {
        if (typeof q?.prompt === 'string') prompts.push(q.prompt);
      }
    } catch {
      /* ignore unreadable packs */
    }
  }
  return prompts;
}

export interface PublishRequest {
  name: string;
  audience: Audience;
  reviewedBy: string;
  notes?: string;
  model?: string;
  questions: DraftQuestion[];
  /** Append to this existing pack id instead of creating a new one. */
  appendTo?: string;
}

/**
 * Write approved drafts to a pack file.
 *
 * Only approved questions are written — the caller filters, and this checks
 * again. Two gates on the same rule is the right amount for the one thing in
 * this system that must never fail open.
 */
export function publishPack(contentDir: string, request: PublishRequest): { file: string; meta: PackMeta } {
  const approved = request.questions.filter((q) => q.status === 'approved');
  if (!approved.length) throw new Error('No approved questions to publish.');
  if (!request.reviewedBy.trim()) throw new Error('Record who reviewed these before publishing.');

  const dir = packsDir(contentDir);
  mkdirSync(dir, { recursive: true });

  const id = request.appendTo ?? slugify(request.name);
  const file = join(dir, `${id}.yaml`);

  let existingQuestions: unknown[] = [];
  let created = new Date().toISOString().slice(0, 10);
  if (existsSync(file)) {
    const doc = parse(readFileSync(file, 'utf8')) as { pack?: PackMeta; questions?: unknown[] };
    existingQuestions = Array.isArray(doc?.questions) ? doc.questions : [];
    if (doc?.pack?.created) created = doc.pack.created;
  }

  // Ids must be unique across the whole bank, so namespace them by pack and
  // continue the numbering rather than restarting at 1 on every append.
  const startAt = existingQuestions.length;
  const questions = approved.map((q, i) => ({
    id: `${id}-${String(startAt + i + 1).padStart(3, '0')}`,
    category: q.category,
    difficulty: q.difficulty,
    prompt: q.prompt,
    answer: q.answer,
    distractors: q.distractors,
    fact: q.fact,
    ...(q.era ? { era: q.era } : {}),
    ...(q.tags.length ? { tags: q.tags } : {}),
    // Attribution travels with the question, not just the pack header. A pack
    // can mix imported and written questions, and in a year the only way to
    // tell which is which is the question's own record of where it came from.
    ...(q.source ? { source: q.source } : {}),
    ...(q.license ? { license: q.license } : {}),
  }));

  const meta: PackMeta = {
    id,
    name: request.name.trim() || id,
    audience: request.audience,
    created,
    origin: 'generated',
    model: request.model,
    reviewedBy: request.reviewedBy.trim(),
    notes: request.notes?.trim() || undefined,
    questionCount: existingQuestions.length + questions.length,
  };

  const header = [
    `# ${meta.name}`,
    '#',
    `# Generated with ${meta.model ?? 'the Claude API'} and reviewed by ${meta.reviewedBy}.`,
    '# Every question here was approved by a person before it was written to this',
    '# file. Edit it like any other content file; `npm run validate` checks it.',
    '',
  ].join('\n');

  const body = stringify({
    pack: {
      id: meta.id,
      name: meta.name,
      audience: meta.audience,
      created: meta.created,
      origin: meta.origin,
      ...(meta.model ? { model: meta.model } : {}),
      reviewedBy: meta.reviewedBy,
      ...(meta.notes ? { notes: meta.notes } : {}),
    },
    questions: [...existingQuestions, ...questions],
  }, { lineWidth: 0 });

  writeFileSync(file, header + body, 'utf8');
  return { file, meta };
}
