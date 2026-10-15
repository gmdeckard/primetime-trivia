import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, pointsAt, type GameConfig } from '../../shared/protocol.js';
import { scoreQuestion, type AnswerRecord } from './scoring.js';

/**
 * The curve decides how a night feels, and it is the one piece of scoring a
 * player argues with out loud. Two properties are worth protecting: that being
 * quick can never beat knowing the answer, and that a correct answer always
 * pays something. A floor of zero turns the back half of every round into
 * nothing worth playing for, which is the opposite of the point.
 */

const WINDOW = 20_000;

function cfg(over: Partial<GameConfig> = {}): GameConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

function answer(teamId: string, choiceIndex: number, elapsedMs: number): AnswerRecord {
  return { teamId, choiceIndex, elapsedMs, byPlayerId: `p-${teamId}` };
}

test('the reading time is free, and the slide starts the moment it ends', () => {
  const c = cfg();
  assert.equal(pointsAt(0, WINDOW, c), 1000, 'answering instantly is full value');
  assert.equal(pointsAt(4_999, WINDOW, c), 1000, 'still inside the five seconds');
  assert.equal(pointsAt(5_000, WINDOW, c), 1000, 'the boundary itself is still free');
  assert.ok(pointsAt(5_500, WINDOW, c) < 1000, 'half a second later it has started falling');
});

test('the value falls to the floor at the buzzer and never below it', () => {
  const c = cfg();
  assert.equal(pointsAt(WINDOW, WINDOW, c), c.minQuestionPoints, 'the last instant is the floor');
  assert.equal(pointsAt(WINDOW * 2, WINDOW, c), c.minQuestionPoints, 'past the deadline is still the floor');
  assert.equal(pointsAt(-5_000, WINDOW, c), 1000, 'clock skew cannot mint more than full value');
});

test('the slide is monotonic: waiting never pays better than answering', () => {
  const c = cfg();
  let previous = Number.POSITIVE_INFINITY;
  for (let t = 0; t <= WINDOW; t += 250) {
    const value = pointsAt(t, WINDOW, c);
    assert.ok(value <= previous, `value rose at ${t}ms: ${value} after ${previous}`);
    previous = value;
  }
  assert.equal(previous, c.minQuestionPoints);
});

test('the halfway point of the slide is worth about halfway down', () => {
  const c = cfg();
  const readMs = c.readSeconds * 1000;
  const middle = pointsAt(readMs + (WINDOW - readMs) / 2, WINDOW, c);
  const expected = (c.questionPoints + c.minQuestionPoints) / 2;
  assert.ok(Math.abs(middle - expected) <= 10, `expected about ${expected}, got ${middle}`);
});

test('every value is a round ten, so the handsets step rather than flicker', () => {
  const c = cfg();
  for (let t = 0; t <= WINDOW; t += 137) {
    assert.equal(pointsAt(t, WINDOW, c) % 10, 0, `ragged value at ${t}ms`);
  }
});

test('a missing or zero window pays full value rather than dividing by zero', () => {
  const c = cfg();
  assert.equal(pointsAt(1_000, 0, c), 1000);
  assert.equal(pointsAt(1_000, -1, c), 1000);
  assert.equal(pointsAt(1_000, Number.NaN, c), 1000);
  assert.equal(pointsAt(Number.NaN, WINDOW, c), 1000, 'a nonsense elapsed is treated as instant');
});

test('granted time stretches the slide instead of skipping down it', () => {
  const c = cfg();
  // The MC adds ten seconds. A team answering at the same wall-clock moment
  // should be further UP the curve, not further down it.
  assert.ok(pointsAt(10_000, 30_000, c) > pointsAt(10_000, WINDOW, c));
});

test('a wrong answer scores nothing, however fast it was', () => {
  const awards = scoreQuestion([answer('quick', 2, 100)], 1, cfg(), WINDOW);
  assert.equal(awards[0]!.correct, false);
  assert.equal(awards[0]!.total, 0);
  assert.equal(awards[0]!.full, false, 'full value is a property of a right answer');
});

test('being quick cannot beat being right', () => {
  const awards = scoreQuestion(
    [answer('fast-and-wrong', 2, 0), answer('slow-and-right', 1, WINDOW)],
    1,
    cfg(),
    WINDOW,
  );
  const wrong = awards.find((a) => a.teamId === 'fast-and-wrong')!;
  const right = awards.find((a) => a.teamId === 'slow-and-right')!;
  assert.ok(right.total > wrong.total, 'the slowest correct answer still beats the fastest wrong one');
});

test('two teams who both knew it are separated by how fast they were sure', () => {
  const awards = scoreQuestion(
    [answer('decisive', 1, 2_000), answer('deliberate', 1, 16_000)],
    1,
    cfg(),
    WINDOW,
  );
  const decisive = awards.find((a) => a.teamId === 'decisive')!;
  const deliberate = awards.find((a) => a.teamId === 'deliberate')!;
  assert.ok(decisive.total > deliberate.total, 'this is the whole reason the scale changed');
  assert.ok(deliberate.total > 0, 'but the slow team still scores: they got it right');
  assert.equal(decisive.full, true, 'two seconds is inside the reading time');
  assert.equal(deliberate.full, false);
});

test('every award reports the full value, so a player can see what the clock cost', () => {
  const c = cfg();
  const awards = scoreQuestion([answer('a', 1, 12_000)], 1, c, WINDOW);
  assert.equal(awards[0]!.max, c.questionPoints);
  assert.ok(awards[0]!.total < awards[0]!.max);
});

test('a flat config turns the slide off without breaking anything', () => {
  // minQuestionPoints == questionPoints is how an MC would ask for pub rules.
  const c = cfg({ minQuestionPoints: 1000 });
  assert.equal(pointsAt(0, WINDOW, c), 1000);
  assert.equal(pointsAt(WINDOW, WINDOW, c), 1000);
});

test('a floor above the ceiling is clamped rather than paying extra', () => {
  const c = cfg({ questionPoints: 500, minQuestionPoints: 900 });
  assert.equal(pointsAt(WINDOW, WINDOW, c), 500, 'a misconfigured floor cannot exceed full value');
});

test('reading time longer than the window leaves every answer at full value', () => {
  const c = cfg({ readSeconds: 60 });
  assert.equal(pointsAt(0, WINDOW, c), 1000);
  assert.equal(pointsAt(WINDOW, WINDOW, c), 1000);
});
