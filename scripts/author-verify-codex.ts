#!/usr/bin/env tsx
/**
 * Fact-check a draft batch with GPT-5, through the Codex CLI.
 *
 * `verifyQuestions` in src/server/author.ts already does an independent pass,
 * but it calls the same model family that wrote the questions, and the
 * fact-check script says so itself: "it shares training data with whatever
 * wrote the questions, so a clean result is a filter, not a guarantee."
 *
 * This closes that gap as far as it can be closed — a different vendor's model,
 * with no sight of the prompt that generated the questions or the reasoning
 * behind them. It is handed the claims cold and asked to break them.
 *
 *   npx tsx scripts/author-verify-codex.ts --batch easy1-sports-01
 *   npx tsx scripts/author-verify-codex.ts --all
 *   npx tsx scripts/author-verify-codex.ts --all --dry-run    print the prompt only
 *
 * Verdicts are written back into the draft file using the same three values
 * and the same rule as the built-in pass: anything not `correct` becomes
 * `rejected`, so the default is never "ships unless someone notices".
 *
 * Codex runs read-only and is never given the repository to read. It gets the
 * questions on stdin and nothing else.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DraftStore } from '../src/server/drafts.js';
import type { DraftBatch, DraftQuestion } from '../shared/packs.js';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dataDir = process.env.PRIMETIME_DATA ?? join(process.cwd(), 'data');
const drafts = new DraftStore(dataDir);
const dryRun = has('--dry-run');

const one = flag('--batch');
const batches: DraftBatch[] = one
  ? (drafts.get(one) ? [drafts.get(one)!] : [])
  : has('--all')
    ? drafts.list()
    : [];

if (!batches.length) {
  console.error('\n  Need --batch <id> or --all, and at least one draft batch must exist.\n');
  process.exit(2);
}

const INSTRUCTIONS = `You are fact-checking multiple-choice trivia questions before they are read aloud
in a live quiz to an audience of well-educated American adults aged 35 to 75. Many
hold advanced degrees. They will notice an error and they will say so.

Judge each question independently and be strict. For each one decide:
  1. Is the option marked correct actually correct?
  2. Is EXACTLY ONE option defensible? If a knowledgeable player could argue for
     another option, that is a failure, not a quibble.
  3. Is the stated fact accurate? Check every claim in it, including ones the
     question did not need to make.
  4. Is the claim stable, or will it go out of date? An unanchored superlative
     ("the fastest", "the most") is a claim about today and may already be wrong.

The stated fact is read aloud AFTER the answer has already been revealed to the
room, so a fact that restates or explains its own answer is CORRECT and normal.
Do not flag that. Judge the fact only on whether it is true and will stay true.

Return "correct" ONLY if all of the above are clean. Return "suspect" if anything
is arguable, imprecise, ambiguous or likely to drift. Return "wrong" if the marked
answer is factually incorrect or the stated fact is false.

Reply with NOTHING but a JSON array, one object per question, in the same order:
[{"index":0,"verdict":"correct|suspect|wrong","note":"one sentence, empty if correct","suggestedAnswer":"what you believe the answer is, empty unless you disagree"}]
Do not wrap it in markdown. Do not add commentary before or after.`;

function listing(batch: DraftBatch): string {
  return batch.questions
    .map((d, i) => {
      const options = [d.answer, ...d.distractors];
      return [
        `[${i}] ${d.prompt}`,
        `    options: ${options.join(' | ')}`,
        `    marked correct: ${d.answer}`,
        `    stated fact: ${d.fact}`,
      ].join('\n');
    })
    .join('\n\n');
}

/** Pull the JSON array out of whatever else Codex printed around it. */
function extractJson(out: string): unknown {
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no JSON array in the reply');
  return JSON.parse(out.slice(start, end + 1));
}

interface Result {
  index: number;
  verdict: DraftQuestion['verdict'];
  note?: string;
  suggestedAnswer?: string;
}

let failed = 0;

for (const batch of batches) {
  const prompt = `${INSTRUCTIONS}\n\nCheck these ${batch.questions.length} questions:\n\n${listing(batch)}`;

  if (dryRun) {
    console.log(`\n===== ${batch.id} =====\n${prompt}\n`);
    continue;
  }

  console.log(`\n  ${batch.id}: asking GPT-5 to check ${batch.questions.length} question(s)...`);
  const run = spawnSync('codex', ['exec', '-', '--sandbox', 'read-only'], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 900_000,
  });

  if (run.error || run.status !== 0) {
    // Print what codex actually said. Reporting only the exit code hides the
    // difference between a timeout, a bad flag and a spent usage limit, and
    // the batch is left unchecked either way — which is easy to read as clean.
    console.error(`    codex failed: ${run.error?.message ?? `exit ${run.status}`}`);
    for (const line of `${run.stderr ?? ''}${run.stdout ?? ''}`
      .split('\n')
      .filter((l) => /error|limit|denied|unauthor/i.test(l))
      .slice(0, 5)) {
      console.error(`      ${line.trim()}`);
    }
    failed += 1;
    continue;
  }

  let results: Result[];
  try {
    results = extractJson(run.stdout) as Result[];
  } catch (err) {
    console.error(`    could not read the reply: ${(err as Error).message}`);
    failed += 1;
    continue;
  }

  const byIndex = new Map(results.map((r) => [r.index, r]));
  let missing = 0;
  batch.questions = batch.questions.map((q, i) => {
    const r = byIndex.get(i);
    if (!r || !['correct', 'suspect', 'wrong'].includes(r.verdict)) {
      // No verdict is not a pass. Leaving it unchecked keeps it out of
      // --verdict correct, so it has to be read by a person either way.
      missing += 1;
      return { ...q, verdict: 'unchecked' as const, status: 'pending' as const };
    }
    return {
      ...q,
      verdict: r.verdict,
      verdictNote: (r.note ?? '').trim(),
      suggestedAnswer: (r.suggestedAnswer ?? '').trim(),
      status: r.verdict === 'correct' ? ('pending' as const) : ('rejected' as const),
    };
  });

  // Record who checked it, so the pack header does not imply the built-in pass.
  batch.model = `${batch.model} · verified by gpt-5 (codex)`;
  drafts.save(batch);

  const tally = (v: DraftQuestion['verdict']) => batch.questions.filter((q) => q.verdict === v).length;
  console.log(
    `    ${tally('correct')} correct, ${tally('suspect')} suspect, ${tally('wrong')} wrong` +
      (missing ? `, ${missing} with no verdict returned` : ''),
  );
  for (const q of batch.questions) {
    if (q.verdict === 'correct' || q.verdict === 'unchecked') continue;
    console.log(`      [${q.id}] ${q.verdict.toUpperCase()}: ${q.prompt}`);
    if (q.verdictNote) console.log(`           ${q.verdictNote}`);
    if (q.suggestedAnswer) console.log(`           GPT-5 would answer: ${q.suggestedAnswer}`);
  }
}

if (!dryRun) {
  console.log('');
  console.log('  Verdicts written. Suspect and wrong are already marked rejected.');
  console.log('  Next: read the flagged ones, then approve with author-publish.ts.');
  console.log('');
}
process.exit(failed ? 1 : 0);
