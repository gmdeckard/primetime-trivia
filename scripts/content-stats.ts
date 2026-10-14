#!/usr/bin/env tsx
/**
 * What the bank holds, and what it is short of.
 *
 * Mostly useful for deciding what to write next: the "nights of material"
 * figure is the number that tells a venue whether they can run weekly for a
 * season without repeating themselves.
 */
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../shared/protocol.js';
import { loadBank } from '../src/server/content.js';

const bank = loadBank(process.argv[2] ?? join(process.cwd(), 'content'));
const perBlock = DEFAULT_CONFIG.roundsPerBlock * DEFAULT_CONFIG.questionsPerRound;
const playable = bank.questions.filter((q) => q.kind === 'choice');

console.log(`\n  ${playable.length} multiple-choice questions, ${bank.questions.length - playable.length} numeric tiebreakers\n`);

const width = Math.max(...bank.categories.map((c) => c.name.length));
for (const cat of bank.categories) {
  const qs = bank.byCategory.get(cat.id) ?? [];
  const spread = [1, 2, 3, 4].map((d) => qs.filter((q) => q.difficulty === d).length);
  const rounds = Math.floor(qs.filter((q) => q.kind === 'choice').length / DEFAULT_CONFIG.questionsPerRound);
  const bar = '█'.repeat(Math.round(qs.length / 4)) || '·';
  console.log(
    `  ${cat.name.padEnd(width)}  ${String(qs.length).padStart(4)}  ` +
    `[${spread.join('/')}]  ${String(rounds).padStart(2)} rounds  ${bar}`,
  );
}

const blocks = Math.floor(playable.length / perBlock);
console.log(`\n  Difficulty spread shown as [d1/d2/d3/d4]`);
console.log(`  A block is ${DEFAULT_CONFIG.roundsPerBlock} x ${DEFAULT_CONFIG.questionsPerRound} = ${perBlock} questions`);
console.log(`  Enough for roughly ${blocks} blocks, or ${Math.floor(blocks / 2)} two-block evenings, with no repeats\n`);

const thin = bank.categories.filter((c) => (bank.byCategory.get(c.id) ?? []).filter((q) => q.kind === 'choice').length < DEFAULT_CONFIG.questionsPerRound * 2);
if (thin.length) {
  console.log('  Thinnest categories — the most useful place to contribute:');
  for (const cat of thin) console.log(`    ${cat.name}`);
  console.log('');
}
