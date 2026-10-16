#!/usr/bin/env tsx
/**
 * Audit the question bank for claims that are wrong, or that will go wrong.
 *
 * This reports. It never edits a question. The output is a list for a human to
 * work through, because every category of finding here has false positives and
 * a bank edited by a script nobody read is worse than one with a known error
 * in it.
 *
 *   npx tsx scripts/fact-check.ts                      drift only, free, offline
 *   npx tsx scripts/fact-check.ts --verify             also run the model verifier (costs money)
 *   npx tsx scripts/fact-check.ts --verify --category sports
 *   npx tsx scripts/fact-check.ts --verify --limit 50 --batch 25
 *
 * Two passes, because the bank has two different problems.
 *
 * CONCESSION is offline too, and finds the failure this bank kept producing:
 * a reveal sentence that names one of its own distractors and grants it. The
 * sentence is usually true, which is why it survived review. The question is
 * the thing that is wrong.
 *
 * DRIFT is offline, deterministic and free. A superlative anchored to a date —
 * "the first to gross a billion, in 1997" — is history and cannot change. An
 * unanchored one — "which country has the most people" — is a claim about
 * today, and that particular one changed in 2023. The room will not know the
 * question is four years old; they will know the answer is wrong.
 *
 * VERIFY is the model verifier the authoring pipeline already uses, pointed at
 * the whole bank instead of one new batch. It costs money and it is not proof:
 * it shares training data with whatever wrote the questions, so a clean result
 * is a filter, not a guarantee. It earns its place because it is the only
 * thing here that scales to every question and reads the claim rather than
 * the shape of it.
 *
 * A Wikidata pass was built first and removed. Comparing a year stated in a
 * question against the dates Wikidata holds for the answer is the wrong
 * comparison — Lindbergh's birth year has nothing to do with the year of the
 * flight — and the entity search resolved "Mercury" to a film. Only seven
 * questions in this bank answer with a bare year, which is the one case where
 * the comparison would have been sound, and that is not worth a network pass.
 */
import { join } from 'node:path';
import { loadBank } from '../src/server/content.js';
import { hasCredentials, verifyQuestions, DEFAULT_MODEL } from '../src/server/author.js';
import type { DraftQuestion } from '../shared/packs.js';
import type { Question } from '../shared/protocol.js';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const contentDir = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'))
  ?? join(process.cwd(), 'content');
const onlyCategory = flag('--category');
const limit = Number(flag('--limit') ?? '0') || 0;
// Drift is free and offline, so it always runs; --verify adds the paid pass.
const runDrift = !has('--no-drift');
const runVerify = has('--verify');
const batchSize = Number(flag('--batch') ?? '25') || 25;

interface Finding {
  level: 'wrong' | 'review';
  kind: string;
  q: Question;
  detail: string;
}
const findings: Finding[] = [];
const add = (level: Finding['level'], kind: string, q: Question, detail: string) =>
  findings.push({ level, kind, q, detail });

// ---------------------------------------------------------------- drift

/** Words whose truth is a snapshot of now rather than a fact about the past. */
const SUPERLATIVE =
  /\b(most|largest|biggest|longest|tallest|highest|smallest|shortest|fastest|oldest|newest|youngest|richest|best-?selling|deepest|widest|busiest|heaviest|only)\b/i;
/** A year, a decade, or a past-tense frame that pins a claim to a moment. */
const ANCHORED =
  /\b(1[0-9]{3}|20[0-2][0-9])\b|\b(was|were|did|had|became|won|built|wrote|first\s+to\b|in\s+the\s+\d{4}s|ancient|medieval|BC|AD)\b/i;
/** Explicitly about the present, which is the strongest drift signal there is. */
const PRESENT_TENSE = /\b(is|are|has|have|does|remains|currently|today|still)\b/i;

const text = (q: Question) => `${q.prompt} ${q.funFact}`;

/**
 * A superlative is only a drift risk if the thing it ranks can move.
 *
 * The longest river in the United States and the only state beginning with two
 * vowels are superlatives, and neither will ever change. Flagging them buries
 * the handful that matter, which is how a checker ends up switched off. These
 * are the domains that genuinely re-rank: people, money, buildings, records
 * and usage. Roughly ordered by how fast they move.
 */
const MUTABLE: Array<{ re: RegExp; pace: string }> = [
  { re: /\b(richest|wealthiest|net worth|highest-?paid|market value|most valuable)\b/i, pace: 'changes yearly' },
  { re: /\b(tallest|biggest) (building|tower|skyscraper|structure)\b/i, pace: 'changes every few years' },
  { re: /\b(best-?selling|highest-?grossing|most streamed|most watched|most downloaded)\b/i, pace: 'changes with each hit' },
  { re: /\b(population|populous|most people|inhabitants)\b/i, pace: 'changes over years' },
  { re: /\b(largest|biggest) (city|country|economy|company|airline|bank|airport|employer)\b/i, pace: 'changes over years' },
  { re: /\b(fastest|world record|record holder|most (olympic|gold) medals|most wins|most goals)\b/i, pace: 'changes with the next competition' },
  { re: /\b(most (native )?speakers|most spoken|preferred by most|most common (name|surname))\b/i, pace: 'changes slowly' },
  { re: /\b(busiest|most visited|most popular)\b/i, pace: 'changes over years' },
];

function driftPass(questions: Question[]) {
  for (const q of questions) {
    const sup = SUPERLATIVE.exec(q.prompt);
    if (!sup) continue;
    // A claim with a date in it is a claim about that date. It is as true now
    // as it was when it was written, so it is not drift.
    if (ANCHORED.test(q.prompt)) continue;
    if (!PRESENT_TENSE.test(q.prompt)) continue;
    const mutable = MUTABLE.find((m) => m.re.test(q.prompt));
    if (!mutable) continue;
    add(
      'review',
      'drift',
      q,
      `ranks something that re-ranks (${mutable.pace}), and states it in the present with ` +
        `no date — true when written, not necessarily true on the night`,
    );
  }
}

// ------------------------------------------------------------- concession

/**
 * Words a sentence uses when it is granting something to the other side.
 *
 * "The Antonine Wall is ALSO real." "American Tobacco was BROKEN UP THE SAME
 * YEAR." These are the author, three months later, remembering that the
 * question is not as clean as it looks and writing the caveat into the one
 * place nobody checks.
 */
const CONCESSION =
  /\b(also|too|as well|both|the same (year|time|day|way)|equally|likewise|as did|did too|are real|is real|was real|count(s|ed)? (too|as well))\b/i;

/**
 * Grammar words only.
 *
 * This list was much longer and included the nouns that turn up in option
 * text — wall, company, band, film, awards. That was backwards: stripping
 * them reduced "Band Aid" to "aid", which then matched a sentence about Farm
 * Aid and reported a concession nobody had made. A distractor is identified
 * by ALL of its words, so the only safe things to drop are the words that
 * carry no identity at all.
 */
const GRAMMAR = new Set('the a an of in on at to for and or'.split(' '));

/** Distinctive words in a phrase: what actually names the thing. */
function distinctive(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length >= 3 && !GRAMMAR.has(w));
}

/** Loose stem so "Obies" matches "Obie" and "barrels" matches "barrel". */
const stem = (w: string) => w.replace(/(ies|es|s)$/, '');

/**
 * A fact that names one of its own distractors.
 *
 * This is the failure the bank kept producing, and it is not really a fact
 * problem. A question is written, a distractor turns out to be defensible
 * too, and instead of fixing the question the author adds a sentence to the
 * reveal admitting it. The sentence is true. The question is still wrong, and
 * now the MC reads the admission out loud to a room that just lost points on
 * it.
 *
 * So this flags the fact and tells you to look at the PROMPT. Nearly every
 * hit is a prompt that does not say enough to exclude the distractor:
 * "which wall did the Romans build across northern Britain" has two correct
 * answers, and no sentence appended afterwards can fix that.
 *
 * Mentioning a distractor is not automatically wrong — "not to be confused
 * with X" is a good reveal line — so this reports and never edits. The
 * concession words raise it from a mention to a likely admission.
 *
 * Expect a fixed question to keep tripping this, and do not chase it. The
 * repair for "which company was broken up in 1911" is to put the qualifier
 * in the prompt — "which OIL company" — and then say in the reveal why the
 * qualifier is there: "American Tobacco was broken up the same year, which
 * is why the question says oil." That is the shape of a question that has
 * been dealt with, and it reads to this check exactly like the shape of one
 * that has not. Roughly four in five hits are a reveal legitimately
 * contrasting with a distractor; the check exists to put twenty questions in
 * front of a person rather than nine hundred.
 */
function concessionPass(questions: Question[]) {
  for (const q of questions) {
    if (q.kind !== 'choice' || !q.choices) continue;
    const answerIndex = q.answerIndex ?? 0;
    // Sentence by sentence. A fact may contrast with a distractor in one
    // breath and concede something unrelated in the next; only a concession
    // sitting in the same sentence as the distractor is making a claim about
    // that distractor.
    const sentences = q.funFact.split(/(?<=[.!?])\s+/).filter(Boolean);

    for (const [i, choice] of q.choices.entries()) {
      if (i === answerIndex) continue;
      const words = distinctive(choice).map(stem);
      if (!words.length) continue;

      for (const sentence of sentences) {
        const here = new Set(distinctive(sentence).map(stem));
        // Every distinctive word of the distractor has to appear, so "The
        // Obie Awards" needs "obie" and not merely "awards".
        if (!words.every((w) => here.has(w))) continue;
        if (!CONCESSION.test(sentence)) continue;
        add(
          'wrong',
          'concedes',
          q,
          `the reveal grants "${choice}", which is on the board as a wrong answer: ` +
            `"${sentence.trim()}" — the fix is almost always in the PROMPT, which probably ` +
            `admits more than one right answer`,
        );
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- report

function report(stats?: { checked: number; costCents: number; failed: number }) {
  const byKind = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind)!.push(f);
  }

  const titles: Record<string, string> = {
    drift: 'Will go out of date — present-tense superlative with no date',
    concedes: 'The reveal argues with its own answer — check the prompt, not the fact',
    wrong: 'The verifier says the marked answer is wrong',
    suspect: 'The verifier says this is arguable, or a distractor is defensible too',
  };

  for (const [kind, list] of byKind) {
    console.log(`\n${titles[kind] ?? kind}  (${list.length})`);
    console.log('─'.repeat(72));
    for (const f of list) {
      console.log(`  ${f.q.id}  [${f.q.category}]`);
      console.log(`    ${f.q.prompt}`);
      console.log(`    answer: ${f.q.choices?.[f.q.answerIndex ?? 0] ?? '—'}`);
      console.log(`    ${f.detail}`);
    }
  }

  console.log('\n' + '═'.repeat(72));
  if (!findings.length) console.log('  Nothing flagged.');
  else console.log(`  ${findings.length} to review.`);
  if (stats) {
    console.log(
      `  Verifier: ${stats.checked} questions checked, ${stats.failed} in batches that failed ` +
        `(unchecked, not passed). Cost ${(stats.costCents / 100).toFixed(2)} USD.`,
    );
    console.log('  A second model agreeing is not proof. Treat a clean result as a filter,');
    console.log('  not a guarantee — it shares training data with whatever wrote the question.');
  }
  console.log('  Nothing was changed. Every line above is a question for a human.');
  console.log('═'.repeat(72) + '\n');
}

// ---------------------------------------------------------------- main

const bank = loadBank(contentDir);
let questions = bank.questions.filter((q) => q.kind === 'choice');
if (onlyCategory) questions = questions.filter((q) => q.category === onlyCategory);
if (limit) questions = questions.slice(0, limit);

console.log(`Checking ${questions.length} questions from ${contentDir}`);
if (runDrift) {
  driftPass(questions);
  concessionPass(questions);
}

let stats: { checked: number; costCents: number; failed: number } | undefined;
if (runVerify) {
  if (!hasCredentials()) {
    console.error('\n  --verify needs ANTHROPIC_API_KEY. The offline drift pass ran anyway.\n');
  } else {
    stats = { checked: 0, costCents: 0, failed: 0 };
    const batches = Math.ceil(questions.length / batchSize);
    for (let b = 0; b < batches; b++) {
      const slice = questions.slice(b * batchSize, (b + 1) * batchSize);
      // The verifier takes drafts, so the bank is shaped into them. It never
      // sees why a question was written — that is the point of it.
      const drafts = slice.map((q) => ({
        prompt: q.prompt,
        answer: q.choices?.[q.answerIndex ?? 0] ?? '',
        distractors: (q.choices ?? []).filter((_, i) => i !== q.answerIndex),
        fact: q.funFact,
        difficulty: q.difficulty,
        category: q.category,
        verdict: 'unchecked' as const,
        verdictNote: '',
        suggestedAnswer: '',
        status: 'pending' as const,
      })) as unknown as DraftQuestion[];

      process.stdout.write(`  batch ${b + 1}/${batches} (${slice.length})… `);
      try {
        const out = await verifyQuestions(drafts, DEFAULT_MODEL);
        stats.costCents += out.costCents;
        out.drafts.forEach((d, i) => {
          const q = slice[i]!;
          stats!.checked++;
          if (d.verdict === 'wrong' || d.verdict === 'suspect') {
            add(d.verdict === 'wrong' ? 'wrong' : 'review', d.verdict, q,
              `${d.verdictNote}${d.suggestedAnswer ? ` — suggests: ${d.suggestedAnswer}` : ''}`);
          }
        });
        console.log(`done, ${(stats.costCents / 100).toFixed(2)} USD so far`);
      } catch (err) {
        stats.failed += slice.length;
        console.log(`FAILED: ${(err as Error).message}`);
      }
    }
  }
}

report(stats);
