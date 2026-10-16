#!/usr/bin/env tsx
/**
 * Content check, for CI and for contributors before they open a pull request.
 *
 * Exits non-zero on any error so a bad question can't land on a branch that
 * someone then runs in front of a room of a hundred people.
 */
import { join } from 'node:path';
import { loadBank } from '../src/server/content.js';

const contentDir = process.argv[2] ?? join(process.cwd(), 'content');
const bank = loadBank(contentDir);

const errors = bank.issues.filter((i) => i.severity === 'error');
const warnings = bank.issues.filter((i) => i.severity === 'warning');

for (const issue of [...errors, ...warnings]) {
  const tag = issue.severity === 'error' ? 'ERROR' : 'warn ';
  console.log(`${tag}  ${issue.file}${issue.id ? ` [${issue.id}]` : ''}  ${issue.message}`);
}

console.log('');
console.log(`  ${bank.questions.length} questions across ${bank.categories.length} categories`);

/**
 * Per age group, because that is the unit a night is actually drawn from.
 *
 * A bank-wide total hides the thing that matters: a mixed round wants one
 * question from each of ten different categories, so a group with six
 * categories written for it will ask some of them twice however healthy the
 * headline count looks. That used to be invisible until a night was running.
 */
const groups = new Map<string, typeof bank.questions>();
for (const q of bank.questions) {
  const key = q.audience ?? '(every group)';
  const list = groups.get(key) ?? [];
  list.push(q);
  groups.set(key, list);
}

console.log('');
for (const [group, list] of [...groups].sort()) {
  const choice = list.filter((q) => q.kind === 'choice');
  const cats = new Set(choice.map((q) => q.category));
  if (!choice.length) {
    // The shared folder today is tiebreakers only, and "0 categories" reads
    // like something is missing rather than like it is doing its job.
    console.log(`  ${group.padEnd(14)} ${String(list.length).padStart(4)} numeric tiebreakers, in play on every night`);
    continue;
  }
  const thin = cats.size < 10 ? `  — a round of 10 repeats ${10 - cats.size} categories` : '';
  console.log(`  ${group.padEnd(14)} ${String(list.length).padStart(4)} questions · ${cats.size} categories${thin}`);
}

console.log('');
const counts = bank.categories
  .map((c) => ({ name: c.name, n: (bank.byCategory.get(c.id) ?? []).length }))
  .sort((a, b) => b.n - a.n);
for (const row of counts) {
  console.log(`    ${String(row.n).padStart(4)}  ${row.name}`);
}

const byDifficulty = [1, 2, 3, 4].map((d) => bank.questions.filter((q) => q.difficulty === d).length);
console.log(`  difficulty spread  1:${byDifficulty[0]}  2:${byDifficulty[1]}  3:${byDifficulty[2]}  4:${byDifficulty[3]}`);
console.log(`  ${errors.length} error(s), ${warnings.length} warning(s)`);
console.log('');

process.exit(errors.length ? 1 : 0);
