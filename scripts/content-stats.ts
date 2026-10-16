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
 * Reported for ONE age group at a time, because that is how a night is
 * drawn. Pooling every group gave a headline capacity nobody could ever play:
 * a 55-75 night cannot use the questions in content/questions/8-12, so
 * counting them made the bank look a third healthier than it is.
 *
 *   npx tsx scripts/content-stats.ts [contentDir] [--games-per-night N]
 *   npx tsx scripts/content-stats.ts --audience 8-12
 *   npx tsx scripts/content-stats.ts --audience all     every group, in turn
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

/** Reads `--name value` as a string, and marks both positions as consumed. */
function strFlag(name: string, fallback: string): string {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  consumed.add(i);
  consumed.add(i + 1);
  return args[i + 1] ?? fallback;
}

/** Games in a night. Defaults to whatever the config ships with. */
const gamesPerNight = numFlag('--games-per-night', DEFAULT_CONFIG.gamesPerNight);
const wantAudience = strFlag('--audience', DEFAULT_CONFIG.audience);
const targetNights = args.includes('--nights') ? numFlag('--nights', 0) : undefined;
const contentDir =
  args.find((a, i) => !consumed.has(i) && !a.startsWith('--')) ?? join(process.cwd(), 'content');

const { roundsPerGame, questionsPerRound, difficultyMix } = DEFAULT_CONFIG;
const perGame = roundsPerGame * questionsPerRound;
const roundsPerNight = roundsPerGame * gamesPerNight;

// The mix is cycled when it is shorter than the round, exactly as the engine
// does it, so this reflects what a round will really ask for.
const template: Difficulty[] = Array.from(
  { length: questionsPerRound },
  (_, i) => difficultyMix[i % difficultyMix.length] ?? 2,
);
const needPerRound = new Map<Difficulty, number>();
for (const d of template) needPerRound.set(d, (needPerRound.get(d) ?? 0) + 1);

const bank = loadBank(contentDir);
if (!bank.questions.length) {
  console.error(`  No questions found in ${contentDir} — is that the right directory?`);
  process.exit(1);
}

/**
 * The questions one age group can actually be asked.
 *
 * Untagged questions (the shared folder) are in play for everybody, which is
 * the same rule the selector uses.
 */
const forAudience = (audience: string) =>
  bank.questions.filter((q) => !audience || !q.audience || q.audience === audience);

const groupIds = [...new Set(bank.questions.map((q) => q.audience).filter((a): a is string => !!a))].sort(
  (a, b) => Number(/^(\d+)/.exec(a)?.[1] ?? 0) - Number(/^(\d+)/.exec(b)?.[1] ?? 0),
);
const audiences = wantAudience === 'all' ? groupIds : [wantAudience];
if (wantAudience !== 'all' && wantAudience && !groupIds.includes(wantAudience)) {
  console.error(`\n  Nothing is written for "${wantAudience}". The bank has: ${groupIds.join(', ')}\n`);
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

function report(audience: string) {
const mine = forAudience(audience);
const playable = mine.filter((q) => q.kind === 'choice');
const label = audience || 'every group at once';

console.log(`\n  ${label.toUpperCase()}`);
console.log(`  ${playable.length} multiple-choice questions, ${mine.length - playable.length} numeric tiebreakers\n`);

const width = Math.max(...bank.categories.map((c) => c.name.length));
const rows = bank.categories
  .map((cat) => ({ cat, qs: mine.filter((q) => q.category === cat.id) }))
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
console.log(`  A game is ${roundsPerGame} x ${questionsPerRound} = ${perGame} questions; a night is ${gamesPerNight} games = ${roundsPerNight} rounds`);
console.log(`  Raw total would stretch to ${Math.floor(playable.length / (perGame * gamesPerNight))} nights.`);
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

// A mixed round wants one question from each of ten different categories,
// which is a different shape of shortage from "not enough hard ones".
const withAny = rows.filter((r) => r.qs.some((q) => q.kind === 'choice')).length;
if (withAny < questionsPerRound) {
  console.log(
    `\n  Only ${withAny} categories have anything for ${label}, so a mixed round of ` +
      `${questionsPerRound} will ask ${questionsPerRound - withAny} of them twice.`,
  );
}

const thin = rows.filter((r) => r.qs.some((q) => q.kind === 'choice') && r.rounds < 2);
if (thin.length) {
  console.log('\n  Thinnest at the real mix — the most useful place to contribute:');
  for (const r of thin) console.log(`    ${r.cat.name.padEnd(width)}  ${r.rounds.toFixed(1)} rounds, short on difficulty ${r.binding}`);
}
console.log('');
}

for (const audience of audiences) report(audience);
