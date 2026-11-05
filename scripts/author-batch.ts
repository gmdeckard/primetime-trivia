#!/usr/bin/env tsx
/**
 * Drive the authoring pipeline from the command line, a plan file at a time.
 *
 * The generate-and-verify flow already exists in `src/server/author.ts`, but
 * its only caller was the browser UI, which asks for one batch and then waits
 * for a person to work through it. Filling a gap of a couple of hundred
 * questions that way is an evening of clicking.
 *
 * So this is the same two calls in a loop, with the plan in a file so the run
 * is reviewable before it spends anything and repeatable after it fails.
 * Nothing here publishes: every batch lands in the draft store as drafts, and
 * `author-publish.ts` is the only thing that can write content.
 *
 *   npx tsx scripts/author-batch.ts --plan plan.json --dry-run   free, offline
 *   npx tsx scripts/author-batch.ts --plan plan.json             costs money
 *
 * Resumable, because a run of a dozen batches will fail in the middle one day:
 * a batch whose draft file already exists is skipped, so the same command picks
 * up where it stopped rather than paying for the first half twice.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadBank } from '../src/server/content.js';
import { DraftStore } from '../src/server/drafts.js';
import { packPrompts } from '../src/server/packs.js';
import {
  DEFAULT_MODEL,
  MODELS,
  describeError,
  generateQuestions,
  hasCredentials,
  verifyQuestions,
} from '../src/server/author.js';
import { MAX_BATCH, type Audience, type DraftBatch, type DraftQuestion } from '../shared/packs.js';

interface PlannedBatch {
  category: string;
  count: number;
  difficulties: Array<1 | 2 | 3 | 4>;
  guidance?: string;
}

interface Plan {
  /** The pack these drafts are destined for. Used to name draft batches. */
  packId: string;
  audience: Audience;
  model?: string;
  batches: PlannedBatch[];
}

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const planPath = flag('--plan');
if (!planPath) {
  console.error('  Need --plan <file>. See the comment at the top of this file.');
  process.exit(2);
}
const dryRun = has('--dry-run');
const contentDir = flag('--content') ?? join(process.cwd(), 'content');
const dataDir = process.env.PRIMETIME_DATA ?? join(process.cwd(), 'data');

const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan;
const model = flag('--model') ?? plan.model ?? DEFAULT_MODEL;
if (!MODELS.some((m) => m.id === model)) {
  console.error(`  Unknown model "${model}". Known: ${MODELS.map((m) => m.id).join(', ')}`);
  process.exit(2);
}

const bank = loadBank(contentDir);
const bankErrors = bank.issues.filter((i) => i.severity === 'error');
if (bankErrors.length) {
  // Generating against a bank that does not load means asking the model to
  // write around questions it cannot see, which is how a batch comes back full
  // of things the bank already has.
  console.error(`  The bank has ${bankErrors.length} error(s); fix those first (npm run validate).`);
  process.exit(1);
}

for (const b of plan.batches) {
  if (!bank.categoryById.has(b.category)) {
    console.error(`  Plan names unknown category "${b.category}".`);
    process.exit(2);
  }
  if (b.count < 1 || b.count > MAX_BATCH) {
    console.error(`  Batch for ${b.category} asks for ${b.count}; the cap is ${MAX_BATCH}.`);
    process.exit(2);
  }
}

const total = plan.batches.reduce((n, b) => n + b.count, 0);
const priced = MODELS.find((m) => m.id === model)!;

console.log('');
console.log(`  Plan: ${plan.batches.length} batch(es), ${total} question(s) requested`);
console.log(`  Pack: ${plan.packId}    audience: ${plan.audience}    model: ${model}`);
console.log('');
console.log('  ' + 'category'.padEnd(26) + 'ask   difficulties');
for (const b of plan.batches) {
  const name = bank.categoryById.get(b.category)!.name;
  console.log('  ' + name.padEnd(26) + String(b.count).padStart(3) + '   ' + b.difficulties.join(','));
}

/**
 * A rough price before anything is spent.
 *
 * Deliberately crude. The generate call's input is the system prompt plus up to
 * 120 existing prompts; its output is the batch plus however much the model
 * thinks at `effort: 'high'`, and that last term dominates and cannot be known
 * from here. The pipeline reports real cents per call, so the first batch
 * replaces this guess with a measurement.
 */
const estInPerBatch = 3_000;
const estOutPerBatch = 9_000;
const estCents =
  plan.batches.length *
  ((estInPerBatch / 1_000_000) * priced.inPerM * 100 * 2 +
    (estOutPerBatch / 1_000_000) * priced.outPerM * 100 * 2);
console.log('');
console.log(
  `  Rough estimate: $${(estCents / 100).toFixed(2)} for generate + verify across ${plan.batches.length} batch(es).`,
);
console.log('  That is a guess at reasoning tokens; the run prints real cost per batch.');

if (dryRun) {
  console.log('\n  --dry-run, so nothing was called and nothing was spent.\n');
  process.exit(0);
}

if (!hasCredentials()) {
  console.error('\n  No credentials. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) and run again.\n');
  process.exit(1);
}

const drafts = new DraftStore(dataDir);

/**
 * Prompts to tell the model are already taken.
 *
 * `generateQuestions` seeds this from the bank itself, but only for the
 * category it is writing. Two batches in the same category in one run would
 * otherwise see identical context and come back with the same twenty famous
 * facts, so drafts produced earlier in this run are added as they appear —
 * along with anything already in the draft store, which is what makes a
 * resumed run pick up rather than repeat.
 */
const taken = new Map<string, string[]>();
for (const batch of drafts.list()) {
  const list = taken.get(batch.category) ?? [];
  for (const q of batch.questions) list.push(q.prompt);
  taken.set(batch.category, list);
}
const publishedPackPrompts = packPrompts(contentDir);

let spentCents = 0;
let produced = 0;
const failures: string[] = [];

for (const [i, b] of plan.batches.entries()) {
  const id = `${plan.packId}-${b.category}-${String(i + 1).padStart(2, '0')}`;
  const label = `[${i + 1}/${plan.batches.length}] ${bank.categoryById.get(b.category)!.name}`;

  const already = drafts.get(id);
  if (already) {
    console.log(`\n  ${label}: already drafted as ${id} (${already.questions.length} question(s)) — skipping.`);
    produced += already.questions.length;
    continue;
  }

  console.log(`\n  ${label}: generating ${b.count}...`);
  try {
    const gen = await generateQuestions(
      {
        audience: plan.audience,
        category: b.category,
        count: b.count,
        difficulties: b.difficulties,
        guidance: b.guidance,
        model,
      },
      bank,
      [...publishedPackPrompts, ...(taken.get(b.category) ?? [])],
    );
    spentCents += gen.costCents;

    if (!gen.questions.length) {
      console.log(`    nothing usable came back (${gen.rejectedDuplicates.length} duplicate(s) rejected).`);
      failures.push(`${id}: empty batch`);
      continue;
    }
    console.log(
      `    ${gen.questions.length} draft(s), ${gen.rejectedDuplicates.length} duplicate(s) rejected. Verifying...`,
    );

    const checked = await verifyQuestions(gen.questions, model);
    spentCents += checked.costCents;

    const tally = (v: DraftQuestion['verdict']) => checked.drafts.filter((d) => d.verdict === v).length;
    console.log(
      `    verdicts: ${tally('correct')} correct, ${tally('suspect')} suspect, ` +
        `${tally('wrong')} wrong, ${tally('unchecked')} unchecked`,
    );

    const batch: DraftBatch = {
      id,
      created: new Date().toISOString(),
      audience: plan.audience,
      category: b.category,
      requested: b.count,
      model,
      costCents: gen.costCents + checked.costCents,
      questions: checked.drafts,
      rejectedDuplicates: gen.rejectedDuplicates,
    };
    drafts.save(batch);
    produced += checked.drafts.length;

    const list = taken.get(b.category) ?? [];
    for (const q of checked.drafts) list.push(q.prompt);
    taken.set(b.category, list);

    console.log(`    saved ${id}  (this batch: $${(batch.costCents / 100).toFixed(2)})`);
  } catch (err) {
    // One category failing should not cost the rest of the run. The batch has
    // no draft file, so re-running the same command retries only this one.
    console.error(`    FAILED: ${describeError(err)}`);
    failures.push(`${id}: ${describeError(err)}`);
  }
}

console.log('');
console.log(`  ${produced} draft(s) in the store. Spent $${(spentCents / 100).toFixed(2)}.`);
if (failures.length) {
  console.log(`  ${failures.length} batch(es) failed — re-run the same command to retry only those:`);
  for (const f of failures) console.log(`    ${f}`);
}
console.log('  Nothing is published. Next: npx tsx scripts/author-publish.ts --report');
console.log('');
process.exit(failures.length ? 1 : 0);
