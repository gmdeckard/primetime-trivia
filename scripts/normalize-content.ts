#!/usr/bin/env tsx
/**
 * Quote question text that YAML would otherwise misread, in place.
 *
 * Three traps catch almost every contributor, because the text of a trivia
 * question is full of exactly the punctuation YAML reserves:
 *
 *   fact: "Star Wars" was renamed in 1981      -> leading quote starts a scalar
 *   fact: He added Episode IV: A New Hope      -> ": " starts a nested mapping
 *   answer: C# minor                           -> " #" starts a comment
 *
 * Rather than ask people to remember that, run this. It wraps only the values
 * that need it and leaves everything else untouched, so the diff stays small
 * and reviewable.
 *
 *   npx tsx scripts/normalize-content.ts            # fix in place
 *   npx tsx scripts/normalize-content.ts --check     # report only, non-zero exit
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KEYS = ['prompt', 'fact', 'answer'];
const LINE = new RegExp(`^(\\s+)(${KEYS.join('|')}):\\s+(.+?)\\s*$`);

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...yamlFiles(full));
    else if (/\.ya?ml$/i.test(entry)) out.push(full);
  }
  return out;
}

/** True when the value is already one complete, properly closed quoted scalar. */
function isFullyQuoted(value: string): boolean {
  const q = value[0];
  if (q !== '"' && q !== "'") return false;
  if (value.length < 2 || !value.endsWith(q)) return false;
  // Walk the body to be sure the closing quote really is the closing one, and
  // not the end of an inner quoted phrase followed by more prose. A doubled
  // quote is YAML's own escape and does not close the scalar.
  let i = 1;
  while (i < value.length) {
    if (value[i] === q) {
      if (value[i + 1] === q) { i += 2; continue; }
      return i === value.length - 1;
    }
    i += 1;
  }
  return false;
}

function needsQuoting(value: string): boolean {
  if (isFullyQuoted(value)) return false;
  // A value that merely opens with a quote is the worst case: YAML reads the
  // quoted phrase as the whole scalar and then chokes on the rest of the line.
  if (value.startsWith('"') || value.startsWith("'")) return true;
  return value.includes(': ') || value.includes(' #') || value.endsWith(':') || value.startsWith('[');
}

const checkOnly = process.argv.includes('--check');
const contentDir = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1])
  ?? join(process.cwd(), 'content');

let touched = 0;
const changedFiles: string[] = [];

for (const file of yamlFiles(contentDir)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let changed = false;
  const out = lines.map((line) => {
    const m = LINE.exec(line);
    if (!m) return line;
    const [, indent, key, value] = m as unknown as [string, string, string, string];
    // A flow sequence is a legitimate YAML value, not prose to be quoted.
    if (key === 'answer' && value.startsWith('[')) return line;
    if (!needsQuoting(value)) return line;
    changed = true;
    touched += 1;
    return `${indent}${key}: '${value.replace(/'/g, "''")}'`;
  });
  if (changed) {
    changedFiles.push(file);
    if (!checkOnly) writeFileSync(file, out.join('\n'), 'utf8');
  }
}

if (!touched) {
  console.log('  All question text is already safely quoted.');
  process.exit(0);
}

console.log(`  ${checkOnly ? 'Would quote' : 'Quoted'} ${touched} value(s) in ${changedFiles.length} file(s):`);
for (const file of changedFiles) console.log(`    ${file}`);
if (checkOnly) {
  console.log('\n  Run `npm run fix:content` to apply.');
  process.exit(1);
}
