#!/usr/bin/env tsx
/**
 * Find questions that give each other away.
 *
 * `npm run validate` catches a question that duplicates another. This catches
 * the quieter thing: two questions that are not duplicates at all, but where
 * asking one hands the room the answer to the other.
 *
 *   npm run collide                    the whole bank
 *   npm run collide -- --pack adult2   just a new batch, against everything
 *   npm run collide -- --strict        exit non-zero if anything is found
 *
 * Two passes.
 *
 * GIVEAWAY is the one that caught real bugs. A reveal is a sentence read aloud
 * to the room, and the bank's reveals are generous — they name neighbouring
 * facts to give the MC something to say. Which means a reveal routinely states
 * another question's answer outright. Two drafted questions had to be thrown
 * away for exactly this: spa-002's reveal says "Apollo 8 was the first crewed
 * flight around the moon", and spa-027's says "Skylab was the American station
 * of the 1970s". Both would have been fine questions on their own. Both were
 * already answered, out loud, by a question that could come up the same night.
 *
 * SHARED ANSWER is softer. Two questions with the same answer are not a fault
 * — "which country has the longest coastline" and "which country has the most
 * lakes" are both Canada and both worth asking — but a pair that shares an
 * answer AND most of its wording is one question written twice, and the
 * duplicate checker misses it whenever the two answers are phrased
 * differently. That is how "The Miami Dolphins" and "The 1972 Miami Dolphins"
 * sat in the bank as separate questions.
 *
 * Neither pass edits anything. Expect roughly a third of the giveaway hits to
 * be real: the rest are the same word in a different sense — a question
 * answered "Herring" against a reveal mentioning a converted herring boat, or
 * "The Endurance" against a battle that was a symbol of French endurance. A
 * tool that puts ninety lines in front of a person instead of nine hundred
 * questions is doing its job; one that is never wrong would also never have
 * found "Apollo 8 was the first crewed flight around the moon".
 */
import { join } from 'node:path';
import { loadBank } from '../src/server/content.js';
import type { Question } from '../shared/protocol.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyPack = flag('--pack');
const strict = args.includes('--strict');
const contentDir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  ?? join(process.cwd(), 'content');

const bank = loadBank(contentDir);
const choice = bank.questions.filter((q) => q.kind === 'choice' && q.choices);
const answerOf = (q: Question) => q.choices![q.answerIndex ?? 0]!;

/**
 * Whether two questions can turn up on the same night.
 *
 * Different age groups never meet, so they cannot give each other away. Packs
 * are the opposite: the MC may switch several on at once, so two packs are
 * treated as able to meet. Tiebreakers and anything else untagged meet
 * everything.
 */
const canMeet = (a: Question, b: Question) =>
  !a.audience || !b.audience || a.audience === b.audience;

/** Words that carry identity, as opposed to grammar. */
const GRAMMAR = new Set('the a an of in on at to for and or is was were be by with from'.split(' '));
const stem = (w: string) => w.replace(/(ies|es|s)$/, '');
const terms = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w.length >= 3 && !GRAMMAR.has(w)).map(stem);

let found = 0;

// ------------------------------------------------------------- giveaway

/**
 * A pack is checked in both directions.
 *
 * The first version only asked whether something already in the bank gave away
 * a question in the new batch. Run it the other way and the new batch turned
 * out to be naming adult1's answers out loud: a reveal about the C language
 * mentioning Bell Labs, a prompt about Mackenzie mentioning Lewis and Clark.
 * Fourteen of those were sitting in one batch.
 */
const inPack = (q: Question, other: Question) =>
  !onlyPack || q.pack === onlyPack || other.pack === onlyPack;

console.log(
  `\n  Checking ${onlyPack ? `pack ${onlyPack} both ways against` : ''} ` +
    `all ${choice.length} question(s) in the bank.\n`,
);

/**
 * Answers too ordinary to be a leak.
 *
 * A question answered "Three" is not given away by a reveal that happens to
 * contain the word three. The first version of this matched on shared terms
 * and reported nine hundred of those.
 */
const ORDINARY = new Set(
  ('one two three four five six seven eight nine ten eleven twelve twenty fifty hundred ' +
   'yes no true false red blue green black white gold water salt sugar rice bread milk ' +
   'north south east west left right summer winter spring autumn').split(' '),
);

/** The answer as it would be read out, for a verbatim search. */
const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const giveaways: string[] = [];
for (const q of choice) {
  const answer = plain(answerOf(q)).replace(/^(the|a|an) /, '');
  // Short answers collide by accident; a six-character phrase is about where
  // a verbatim match stops being a coincidence.
  if (answer.length < 6 || ORDINARY.has(answer)) continue;

  const said = new RegExp(`\\b${answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const sayers = choice.filter((other) => {
    if (other.id === q.id || !canMeet(q, other) || !inPack(q, other)) return false;
    // Only what is read out counts. A distractor naming another answer is a
    // milder and different problem.
    // Whole words only. Substring matching reported "Fender" inside
    // "defenders" and "Herring" inside "herringbone".
    return said.test(`${plain(other.prompt)} ${plain(other.funFact)}`);
  });

  // A term the bank mentions constantly is not a leak. "France" is the answer
  // to one question and turns up in thirty reveals; nobody hearing one of them
  // has been handed the Louisiana Purchase. A term that appears once or twice
  // is a different matter: that is how "Apollo 8 was the first crewed flight
  // around the moon" sat in the bank as a reveal while Apollo 8 was being
  // drafted as an answer.
  if (!sayers.length || sayers.length > 2) continue;

  for (const other of sayers) {
    giveaways.push(
      `  ${q.id} [${q.category}] "${answerOf(q)}"\n` +
        `    said aloud by ${other.id} [${other.category}]: "${other.funFact.trim()}"`,
    );
  }
}

if (giveaways.length) {
  console.log(`  ANSWERS GIVEN AWAY BY ANOTHER QUESTION  (${giveaways.length})`);
  console.log('  ' + '─'.repeat(70));
  for (const line of giveaways) console.log(line);
  found += giveaways.length;
} else {
  console.log('  No answer is stated by another question that could share a night with it.');
}

// --------------------------------------------------------- shared answer

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/^(the|a|an) /, '').trim();

const byAnswer = new Map<string, Question[]>();
for (const q of choice) {
  const k = `${q.audience ?? ''}::${norm(answerOf(q))}`;
  (byAnswer.get(k) ?? byAnswer.set(k, []).get(k)!).push(q);
}

const twins: string[] = [];
for (const group of byAnswer.values()) {
  if (group.length < 2) continue;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i]!, b = group[j]!;
      if (onlyPack && a.pack !== onlyPack && b.pack !== onlyPack) continue;
      const A = new Set(terms(a.prompt)), B = new Set(terms(b.prompt));
      const shared = [...A].filter((w) => B.has(w)).length;
      const sim = shared / (A.size + B.size - shared);
      if (sim < 0.3) continue;
      twins.push(
        `  ${a.id} / ${b.id} — both answer "${answerOf(a)}", ${Math.round(sim * 100)}% shared wording\n` +
          `    ${a.prompt}\n    ${b.prompt}`,
      );
    }
  }
}

console.log('');
if (twins.length) {
  console.log(`  SAME ANSWER, SIMILAR WORDING  (${twins.length})`);
  console.log('  ' + '─'.repeat(70));
  for (const line of twins) console.log(line);
  found += twins.length;
} else {
  console.log('  No two questions share an answer and most of their wording.');
}

// ------------------------------------------------- answer reused in category

/**
 * The same answer twice in one category, however differently it is worded.
 *
 * The pass above only reports a pair that shares an answer AND most of its
 * wording, which misses the fault that actually keeps happening when a new
 * batch is written next to an old one: reaching for the same obvious answer
 * in completely different words. A category with Jack Benny as the answer to
 * two questions will ask about him twice in a night sooner or later, and the
 * deck cannot help because both are legitimately due.
 */
const inCategory = new Map<string, Question[]>();
for (const q of choice) {
  const k = `${q.audience ?? ''}::${q.category}::${norm(answerOf(q))}`;
  (inCategory.get(k) ?? inCategory.set(k, []).get(k)!).push(q);
}

const reused: string[] = [];
for (const group of inCategory.values()) {
  if (group.length < 2) continue;
  if (onlyPack && !group.some((q) => q.pack === onlyPack)) continue;
  reused.push(
    `  "${answerOf(group[0]!)}" in ${group[0]!.category}\n` +
      group.map((q) => `    ${q.id} [${q.pack ?? 'core'}] ${q.prompt}`).join('\n'),
  );
}

console.log('');
if (reused.length) {
  console.log(`  SAME ANSWER TWICE IN ONE CATEGORY  (${reused.length})`);
  console.log('  ' + '─'.repeat(70));
  for (const line of reused) console.log(line);
  found += reused.length;
} else {
  console.log('  No answer is used twice within a single category.');
}

console.log(`\n  ${found} to look at. Nothing was changed.\n`);
if (strict && found) process.exit(1);
