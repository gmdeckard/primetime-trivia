#!/usr/bin/env tsx
/**
 * Review drafts from `author-batch.ts` and publish the approved ones.
 *
 * Split from the batch runner on purpose. Generating costs money and touches
 * the network; publishing writes content that will be read aloud to a room.
 * They are different kinds of risk and they get different commands, so that
 * neither can happen as a side effect of the other.
 *
 *   npx tsx scripts/author-publish.ts --report                 every pending batch
 *   npx tsx scripts/author-publish.ts --report --batch <id>    one batch, in full
 *   npx tsx scripts/author-publish.ts --approve <id> --ids 1,4,7
 *   npx tsx scripts/author-publish.ts --approve <id> --verdict correct
 *   npx tsx scripts/author-publish.ts --reject <id> --ids 2
 *   npx tsx scripts/author-publish.ts --publish --name "Easy set 1" \
 *       --reviewed-by "..." [--append-to beta1] [--notes "..."]
 *
 * The verifier has already set anything it doubted to `rejected`, so --verdict
 * correct is not a way of skipping review: it approves the questions that
 * passed an independent check, and the suspect ones still have to be read.
 */
import { join } from 'node:path';
import { loadBank } from '../src/server/content.js';
import { DraftStore } from '../src/server/drafts.js';
import { publishPack } from '../src/server/packs.js';
import type { Audience, DraftBatch, DraftQuestion } from '../shared/packs.js';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const contentDir = flag('--content') ?? join(process.cwd(), 'content');
const dataDir = process.env.PRIMETIME_DATA ?? join(process.cwd(), 'data');
const drafts = new DraftStore(dataDir);
const bank = loadBank(contentDir);
const categoryName = (id: string) => bank.categoryById.get(id)?.name ?? id;

/** Draft ids inside a batch are `d1`, `d2`, ...; accept either `d4` or `4`. */
function parseIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/^\d+$/.test(s) ? `d${s}` : s)),
  );
}

function show(batch: DraftBatch, full: boolean) {
  const tally = (v: DraftQuestion['verdict']) => batch.questions.filter((q) => q.verdict === v).length;
  const st = (s: DraftQuestion['status']) => batch.questions.filter((q) => q.status === s).length;
  console.log('');
  console.log(`  ${batch.id}`);
  console.log(
    `    ${categoryName(batch.category)} · ${batch.questions.length} draft(s) · ${batch.model} · ` +
      `$${(batch.costCents / 100).toFixed(2)} · ${batch.created.slice(0, 16).replace('T', ' ')}`,
  );
  console.log(
    `    verdicts: ${tally('correct')} correct, ${tally('suspect')} suspect, ${tally('wrong')} wrong` +
      `    status: ${st('approved')} approved, ${st('pending')} pending, ${st('rejected')} rejected`,
  );
  if (!full) return;
  for (const q of batch.questions) {
    const mark = q.status === 'approved' ? '+' : q.status === 'rejected' ? '-' : ' ';
    console.log('');
    console.log(`    ${mark} [${q.id}] d${q.difficulty}${q.era ? ` · ${q.era}` : ''}  (${q.verdict}, ${q.status})`);
    console.log(`      Q: ${q.prompt}`);
    console.log(`      A: ${q.answer}`);
    console.log(`      x: ${q.distractors.join(' | ')}`);
    console.log(`      f: ${q.fact}`);
    if (q.verdictNote) console.log(`      ! ${q.verdictNote}`);
    if (q.suggestedAnswer) console.log(`      ? verifier would answer: ${q.suggestedAnswer}`);
  }
  if (batch.rejectedDuplicates.length) {
    console.log(`\n    ${batch.rejectedDuplicates.length} duplicate(s) rejected before review:`);
    for (const p of batch.rejectedDuplicates) console.log(`      - ${p}`);
  }
}

// ----------------------------------------------------------------- report

if (has('--report') || args.length === 0) {
  const one = flag('--batch');
  const all = drafts.list();
  if (!all.length) {
    console.log('\n  No drafts. Run author-batch.ts first.\n');
    process.exit(0);
  }
  const chosen = one ? all.filter((b) => b.id === one) : all;
  if (one && !chosen.length) {
    console.error(`\n  No draft batch "${one}".\n`);
    process.exit(2);
  }
  for (const batch of chosen) show(batch, !!one || has('--full'));
  if (!one && !has('--full')) {
    const n = all.reduce((t, b) => t + b.questions.length, 0);
    const approved = all.reduce((t, b) => t + b.questions.filter((q) => q.status === 'approved').length, 0);
    const spent = all.reduce((t, b) => t + b.costCents, 0);
    console.log('');
    console.log(`  ${all.length} batch(es), ${n} draft(s), ${approved} approved. Spent $${(spent / 100).toFixed(2)}.`);
    console.log('  Add --full for every question, or --batch <id> for one.');
  }
  console.log('');
  process.exit(0);
}

// --------------------------------------------------------- approve / reject

const approveId = flag('--approve');
const rejectId = flag('--reject');
if (approveId || rejectId) {
  const id = (approveId ?? rejectId)!;
  const status: DraftQuestion['status'] = approveId ? 'approved' : 'rejected';
  const batch = drafts.get(id);
  if (!batch) {
    console.error(`\n  No draft batch "${id}".\n`);
    process.exit(2);
  }
  const ids = parseIds(flag('--ids'));
  const verdict = flag('--verdict');
  if (!ids.size && !verdict) {
    console.error('\n  Need --ids <list> or --verdict <correct|suspect|wrong>.\n');
    process.exit(2);
  }

  let changed = 0;
  batch.questions = batch.questions.map((q) => {
    const hit = ids.size ? ids.has(q.id) : q.verdict === verdict;
    if (!hit || q.status === status) return q;
    changed += 1;
    return { ...q, status };
  });
  drafts.save(batch);
  console.log(`\n  ${changed} draft(s) marked ${status} in ${id}.\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- publish

if (has('--publish')) {
  const name = flag('--name');
  const reviewedBy = flag('--reviewed-by');
  if (!name || !reviewedBy) {
    console.error('\n  --publish needs --name "..." and --reviewed-by "...".\n');
    process.exit(2);
  }
  const all = drafts.list();
  const contributing = all.filter((b) => b.questions.some((q) => q.status === 'approved'));
  const approved = contributing.flatMap((b) => b.questions.filter((q) => q.status === 'approved'));
  if (!approved.length) {
    console.error('\n  Nothing is approved yet. Review first.\n');
    process.exit(1);
  }

  const audiences = new Set(contributing.map((b) => b.audience));
  if (audiences.size > 1) {
    // A pack carries one audience in its header, and that header is what the
    // loader uses to keep a kids' set out of an adult night.
    console.error(`\n  Those drafts span ${[...audiences].join(', ')}. Publish one audience at a time.\n`);
    process.exit(2);
  }
  const audience = [...audiences][0] as Audience;
  const models = [...new Set(contributing.map((b) => b.model))];

  const { file, meta } = publishPack(contentDir, {
    name,
    audience,
    reviewedBy,
    notes: flag('--notes'),
    model: models.join(', '),
    questions: approved,
    appendTo: flag('--append-to'),
  });

  console.log('');
  console.log(`  Wrote ${approved.length} question(s) to ${file}`);
  console.log(`  Pack "${meta.id}" now holds ${meta.questionCount} question(s), audience ${meta.audience}.`);

  // Published questions are taken out of the draft store, because publishPack
  // appends: leaving them would make a second --publish write them again. Only
  // the published ones, though. A batch where some drafts are still pending
  // keeps those — deleting the whole batch would throw away unreviewed work,
  // silently, at the moment the reviewer was being told everything went well.
  if (has('--keep-drafts')) {
    console.log(`  --keep-drafts, so ${contributing.length} batch(es) are still in the store intact.`);
    console.log('  Re-running --publish would append the same questions a second time.');
  } else {
    let emptied = 0;
    let kept = 0;
    for (const b of contributing) {
      const left = b.questions.filter((q) => q.status !== 'approved');
      if (!left.length) {
        drafts.remove(b.id);
        emptied += 1;
        continue;
      }
      drafts.save({ ...b, questions: left });
      kept += left.length;
    }
    console.log(`  Cleared ${emptied} fully published batch(es) from the draft store.`);
    if (kept) console.log(`  Kept ${kept} unapproved draft(s) that were in those batches.`);
  }

  const pending = all
    .filter((b) => !contributing.includes(b))
    .reduce((t, b) => t + b.questions.length, 0);
  if (pending) console.log(`  ${pending} draft(s) in other batches are still unapproved.`);

  console.log('');
  console.log(`  Next: npm run validate && npm run collide -- --pack ${meta.id}`);
  console.log(`  Then add "${meta.id}" to DEFAULT_CONFIG.packs so a fresh night draws from it.`);
  console.log('');
  process.exit(0);
}

console.error('\n  Nothing to do. See the comment at the top of this file.\n');
process.exit(2);
