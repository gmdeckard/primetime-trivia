#!/usr/bin/env tsx
/**
 * What the bank holds, and what it is short of.
 *
 * The number that matters is not how many questions exist. It is how many
 * rounds can be built at the configured difficulty mix, which is always
 * smaller and is what the room actually experiences. A category with thirty
 * questions but four at difficulty 3 cannot fill a round that asks for five
 * of them, and the selector quietly substitutes easier questions rather than
 * failing — so a bank that looks healthy plays flat.
 *
 *   npx tsx scripts/content-stats.ts [contentDir] [--blocks-per-night N]
 */
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Difficulty } from '../shared/protocol.js';
import { loadBank } from '../src/server/content.js';

const args = process.argv.slice(2);

/** Reads `--name value`, and marks both positions as consumed. */
const consumed = new Set<number>();
function numFlag(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  consumed.add(i);
  consumed.add(i + 1);
  const n = Number(args[i + 1]);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`  ${name} needs a positive number, got ${args[i + 1] ?? '(nothing)'}`);
    process.exit(1);
  }
  return n;
}

const blocksPerNight = numFlag('--blocks-per-night', 3);
const targetNights = args.includes('--nights') ? numFlag('--nights', 0) : undefined;
const contentDir =
  args.find((a, i) => !consumed.has(i) && !a.startsWith('--')) ?? join(process.cwd(), 'content');

const { roundsPerBlock, questionsPerRound, difficultyMix } = DEFAULT_CONFIG;
const perBlock = roundsPerBlock * questionsPerRound;
const roundsPerNight = roundsPerBlock * blocksPerNight;

// The mix is cycled when it is shorter than the round, exactly as the engine
// does it, so this reflects what a round will really ask for.
const template: Difficulty[] = Array.from(
  { length: questionsPerRound },
  (_, i) => difficultyMix[i % difficultyMix.length] ?? 2,
);
const needPerRound = new Map<Difficulty, number>();
for (const d of template) needPerRound.set(d, (needPerRound.get(d) ?? 0) + 1);

const bank = loadBank(contentDir);
const playable = bank.questions.filter((q) => q.kind === 'choice');
if (!bank.questions.length) {
  console.error(`  No questions found in ${contentDir} — is that the right directory?`);
  process.exit(1);
}

/** Rounds a pool can fill at the real mix: whichever difficulty runs out first. */
function trueRounds(qs: { difficulty: number; kind: string }[]): { rounds: number; binding: Difficulty } {
  let rounds = Infinity;
  let binding: Difficulty = 2;
  for (const [d, need] of needPerRound) {
    const have = qs.filter((q) => q.kind === 'choice' && q.difficulty === d).length;
    const capacity = have / need;
    if (capacity < rounds) {
      rounds = capacity;
      binding = d;
    }
  }
  return { rounds: Number.isFinite(rounds) ? rounds : 0, binding };
}

console.log(`\n  ${playable.length} multiple-choice questions, ${bank.questions.length - playable.length} numeric tiebreakers\n`);

const width = Math.max(...bank.categories.map((c) => c.name.length));
const rows = bank.categories
  .map((cat) => ({ cat, qs: bank.byCategory.get(cat.id) ?? [] }))
  .map((r) => ({ ...r, ...trueRounds(r.qs) }))
  .sort((a, b) => b.rounds - a.rounds);

let totalRounds = 0;
for (const { cat, qs, rounds, binding } of rows) {
  const spread = [1, 2, 3, 4].map((d) => qs.filter((q) => q.difficulty === d).length);
  const choice = qs.filter((q) => q.kind === 'choice').length;
  if (choice) totalRounds += rounds;
  const bar = '█'.repeat(Math.round(rounds * 2)) || '·';
  // A category needs a full round's worth before the selector will offer it.
  const flag = choice && choice < questionsPerRound ? ' (not drawn)' : '';
  console.log(
    `  ${cat.name.padEnd(width)}  ${String(qs.length).padStart(4)}  ` +
    `[${spread.join('/')}]  ${rounds.toFixed(1).padStart(5)} rounds  ` +
    `${choice ? `short on d${binding}` : 'numeric'}${flag}`.padEnd(22) + bar,
  );
}

const nights = totalRounds / roundsPerNight;
console.log(`\n  Difficulty spread shown as [d1/d2/d3/d4]`);
console.log(`  A round asks for ${[...needPerRound].sort().map(([d, n]) => `${n}xd${d}`).join(' + ')}`);
console.log(`  A block is ${roundsPerBlock} x ${questionsPerRound} = ${perBlock} questions; a night is ${blocksPerNight} blocks = ${roundsPerNight} rounds`);
console.log(`  Raw total would stretch to ${Math.floor(playable.length / (perBlock * blocksPerNight))} nights.`);
console.log(`  At the real mix it is ${totalRounds.toFixed(0)} rounds, or ${nights.toFixed(1)} nights, with no repeats.\n`);

// What to write next, stated in questions rather than vibes. Pass --nights to
// size the gap against a season rather than a single evening.
console.log(`  Each night consumes:`);
for (const [d, need] of [...needPerRound].sort()) {
  const have = playable.filter((q) => q.difficulty === d).length;
  const perNight = roundsPerNight * need;
  const gap = targetNights ? Math.max(0, perNight * targetNights - have) : 0;
  const short = targetNights ? `  short ${gap} for ${targetNights} nights` : '';
  console.log(`    difficulty ${d}: ${String(perNight).padStart(2)} per night, pool ${have}${short}`);
}

const thin = rows.filter((r) => r.qs.some((q) => q.kind === 'choice') && r.rounds < 2);
if (thin.length) {
  console.log('\n  Thinnest at the real mix — the most useful place to contribute:');
  for (const r of thin) console.log(`    ${r.cat.name.padEnd(width)}  ${r.rounds.toFixed(1)} rounds, short on difficulty ${r.binding}`);
}
console.log('');
