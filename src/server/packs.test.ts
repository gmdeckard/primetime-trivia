import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parse } from 'yaml';
import type { DraftQuestion } from '../../shared/packs.js';
import { loadBank } from './content.js';
import { listPacks, publishPack, slugify } from './packs.js';

/**
 * The publish gate is the one place in this system that must never fail open.
 * Everything else can be wrong in a recoverable way; a question that reaches a
 * pack without a human approving it is read out to a room as fact.
 */

const dirs: string[] = [];
function tempContent(): string {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-packs-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function draft(id: string, status: DraftQuestion['status'], prompt = `Question ${id}?`): DraftQuestion {
  return {
    id,
    category: 'geography',
    difficulty: 2,
    prompt,
    answer: 'Right',
    distractors: ['Wrong one', 'Wrong two', 'Wrong three'],
    fact: 'Something worth saying afterwards.',
    era: '1960s',
    tags: ['test'],
    verdict: 'correct',
    verdictNote: '',
    suggestedAnswer: '',
    status,
  };
}

test('only approved questions are written to a pack', () => {
  const dir = tempContent();
  const { file } = publishPack(dir, {
    name: 'Mixed Batch',
    audience: '55-75',
    reviewedBy: 'Gary',
    questions: [
      draft('d1', 'approved', 'Approved one?'),
      draft('d2', 'rejected', 'Rejected one?'),
      draft('d3', 'pending', 'Never reviewed?'),
      draft('d4', 'approved', 'Approved two?'),
    ],
  });

  const doc = parse(readFileSync(file, 'utf8')) as { questions: Array<{ prompt: string }> };
  const prompts = doc.questions.map((q) => q.prompt);
  assert.deepEqual(prompts, ['Approved one?', 'Approved two?']);
  assert.ok(!prompts.some((p) => p.includes('Rejected')), 'a rejected question reached the file');
  assert.ok(!prompts.some((p) => p.includes('Never reviewed')), 'an unreviewed question reached the file');
});

test('publishing with nothing approved is refused', () => {
  const dir = tempContent();
  assert.throws(
    () => publishPack(dir, {
      name: 'Empty',
      audience: '55-75',
      reviewedBy: 'Gary',
      questions: [draft('d1', 'pending'), draft('d2', 'rejected')],
    }),
    /no approved questions/i,
  );
});

test('publishing without a named reviewer is refused', () => {
  const dir = tempContent();
  assert.throws(
    () => publishPack(dir, {
      name: 'Anonymous',
      audience: '55-75',
      reviewedBy: '   ',
      questions: [draft('d1', 'approved')],
    }),
    /who reviewed/i,
  );
});

test('a published pack loads cleanly and carries its pack id and audience', () => {
  const dir = tempContent();
  // The loader needs a category registry to validate against.
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'categories.yaml'),
    '- id: geography\n  name: World Geography\n  blurb: Places.\n',
    'utf8',
  );

  publishPack(dir, {
    name: 'Desert Round',
    audience: '55-75',
    reviewedBy: 'Gary',
    model: 'claude-opus-5-5',
    questions: [draft('d1', 'approved', 'Which desert covers northern Africa?')],
  });

  const bank = loadBank(dir);
  assert.equal(bank.issues.filter((i) => i.severity === 'error').length, 0, JSON.stringify(bank.issues));
  assert.equal(bank.questions.length, 1);
  const question = bank.questions[0]!;
  assert.equal(question.pack, 'desert-round');
  assert.equal(question.audience, '55-75');
  assert.equal(question.category, 'geography');
  // Authored answer-first, like every other content file.
  assert.equal(question.answerIndex, 0);
  assert.equal(question.choices?.length, 4);

  const packs = listPacks(dir);
  assert.equal(packs.length, 1);
  assert.equal(packs[0]!.reviewedBy, 'Gary');
  assert.equal(packs[0]!.questionCount, 1);
});

test('appending to a pack keeps ids unique', () => {
  const dir = tempContent();
  publishPack(dir, {
    name: 'Growing',
    audience: 'any',
    reviewedBy: 'Gary',
    questions: [draft('a', 'approved', 'First?')],
  });
  const { file } = publishPack(dir, {
    name: 'Growing',
    audience: 'any',
    reviewedBy: 'Gary',
    appendTo: 'growing',
    questions: [draft('b', 'approved', 'Second?')],
  });

  const doc = parse(readFileSync(file, 'utf8')) as { questions: Array<{ id: string }> };
  const ids = doc.questions.map((q) => q.id);
  assert.deepEqual(ids, ['growing-001', 'growing-002']);
  assert.equal(new Set(ids).size, ids.length);
});

test('slugify produces a safe file stem', () => {
  assert.equal(slugify('Sixties Music!'), 'sixties-music');
  assert.equal(slugify('  ../../etc/passwd  '), 'etc-passwd');
  assert.equal(slugify('!!!'), 'pack');
});
