import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerateRequest } from '../../shared/packs.js';
import { loadBank } from './content.js';
import {
  ImportUnavailable,
  OPENTDB_CATEGORIES,
  UNAVAILABLE_REASON,
  importQuestions,
  shapeBatch,
  type SourceRow,
} from './trivia-db.js';

/**
 * Importing is the one path that puts text this project did not write in front
 * of a room. The tests that matter are the ones that stop it arriving as if it
 * had been: no reveal line, no claim to a difficulty the source cannot supply,
 * and no question already in the bank.
 */

const bank = loadBank('content');

function request(over: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    audience: '35-75',
    category: 'history-20c',
    count: 4,
    difficulties: [2, 3],
    source: 'opentdb',
    ...over,
  };
}

function row(over: Partial<SourceRow> = {}): SourceRow {
  return {
    type: 'multiple',
    difficulty: 'medium',
    question: 'Who signed the Treaty of Ghent?',
    correct_answer: 'John Quincy Adams',
    incorrect_answers: ['Henry Clay', 'Albert Gallatin', 'James Monroe'],
    ...over,
  };
}

/** A pool of distinct rows, so the difficulty fill has something to choose from. */
function pool(specs: Array<{ difficulty: string; n?: number }>): SourceRow[] {
  const out: SourceRow[] = [];
  for (const spec of specs) {
    for (let i = 0; i < (spec.n ?? 1); i++) {
      out.push(row({ difficulty: spec.difficulty, question: `${spec.difficulty} question ${i}?` }));
    }
  }
  return out;
}

test('a category with no counterpart is refused with the reason the screen shows', async () => {
  await assert.rejects(
    () => importQuestions(request({ category: 'military-history' }), bank),
    (err: Error) => {
      assert.ok(err instanceof ImportUnavailable);
      assert.equal(err.message, UNAVAILABLE_REASON['military-history']);
      return true;
    },
  );
});

test('every unmapped category has a reason written for it', () => {
  for (const category of bank.categories) {
    if (OPENTDB_CATEGORIES[category.id]?.length) continue;
    assert.ok(
      UNAVAILABLE_REASON[category.id],
      `${category.id} is not importable and has no explanation for the MC`,
    );
  }
});

test('imports arrive with no reveal line, so they cannot be published as they stand', () => {
  const result = shapeBatch(pool([{ difficulty: 'medium', n: 4 }]), request(), bank);
  assert.equal(result.questions.length, 4);
  for (const q of result.questions) {
    assert.equal(q.fact, '', 'an imported question must not pretend to have a reveal line');
    assert.equal(q.status, 'pending');
    assert.equal(q.verdict, 'unchecked');
  }
});

test('attribution and licence ride on every imported question', () => {
  const result = shapeBatch(pool([{ difficulty: 'easy', n: 2 }]), request({ count: 2 }), bank);
  for (const q of result.questions) {
    assert.match(q.source ?? '', /opentdb\.com/);
    assert.equal(q.license, 'CC BY-SA 4.0');
  }
});

test('the source cannot claim difficulty 4, and says so when one was asked for', () => {
  const asked4 = shapeBatch(
    pool([{ difficulty: 'hard', n: 4 }]),
    request({ difficulties: [4], count: 2 }),
    bank,
  );
  assert.equal(asked4.difficultyCapped, true);
  for (const q of asked4.questions) {
    assert.ok(q.difficulty <= 3, 'nothing imported may be labelled difficulty 4');
  }

  const asked3 = shapeBatch(
    pool([{ difficulty: 'hard', n: 4 }]),
    request({ difficulties: [3], count: 2 }),
    bank,
  );
  assert.equal(asked3.difficultyCapped, false);
});

test('the difficulty pattern is filled nearest-match', () => {
  const result = shapeBatch(
    pool([{ difficulty: 'easy', n: 3 }, { difficulty: 'hard', n: 3 }]),
    request({ difficulties: [1, 3], count: 4 }),
    bank,
  );
  assert.deepEqual(result.questions.map((q) => q.difficulty), [1, 3, 1, 3]);
});

test('a question already in the bank is dropped before the reviewer sees it', () => {
  const existing = bank.questions.find((q) => q.kind === 'choice')!;
  const result = shapeBatch(
    [row({ question: existing.prompt }), ...pool([{ difficulty: 'easy', n: 2 }])],
    request({ count: 3 }),
    bank,
  );
  assert.equal(result.rejectedDuplicates.length, 1);
  assert.equal(result.rejectedDuplicates[0], existing.prompt);
  assert.ok(!result.questions.some((q) => q.prompt === existing.prompt));
});

test('a question already in a pack is dropped too', () => {
  const result = shapeBatch(
    [row({ question: 'Borrowed already?' }), ...pool([{ difficulty: 'easy', n: 2 }])],
    request({ count: 3 }),
    bank,
    ['Borrowed already?'],
  );
  assert.deepEqual(result.rejectedDuplicates, ['Borrowed already?']);
});

test('the same prompt twice in one pool is only taken once', () => {
  const result = shapeBatch([row(), row(), row()], request({ count: 3 }), bank);
  assert.equal(result.questions.length, 1);
  assert.equal(result.rejectedDuplicates.length, 2);
});

test('malformed rows are skipped rather than handed on', () => {
  const result = shapeBatch(
    [
      row({ type: 'boolean' }),
      row({ question: 'Two wrong answers?', incorrect_answers: ['a', 'b'] }),
      row({ question: 'Blank answer?', correct_answer: '' }),
      // A distractor equal to the answer leaves a question with two right options.
      row({ question: 'Duplicate option?', incorrect_answers: ['Paris', 'paris', 'Rome'], correct_answer: 'Paris' }),
      row({ question: 'The only good one?' }),
    ],
    request({ count: 5 }),
    bank,
  );
  assert.deepEqual(result.questions.map((q) => q.prompt), ['The only good one?']);
});

test('percent-encoded text is decoded, and plain text is left alone', () => {
  const result = shapeBatch(
    [row({ question: 'What%20was%20Canada%27s%20first%20capital%3F', correct_answer: 'Kingston' })],
    request({ count: 1 }),
    bank,
  );
  assert.equal(result.questions[0]!.prompt, "What was Canada's first capital?");
  assert.equal(result.questions[0]!.answer, 'Kingston');
});

test('a batch never exceeds what the pool can honestly fill', () => {
  const result = shapeBatch(pool([{ difficulty: 'easy', n: 2 }]), request({ count: 20 }), bank);
  assert.equal(result.questions.length, 2);
});
