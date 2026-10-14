import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, pointsAvailable, type GameConfig } from '../../shared/protocol.js';
import { basePoints, scoreQuestion, speedShare, type AnswerRecord } from './scoring.js';

/**
 * The speed bands decide how a night feels, and they are the one piece of
 * scoring a player can argue with out loud. The property worth protecting is
 * not the exact band widths — it is that speed only ever adds to a correct
 * answer and can never out-score knowing the thing.
 */

const WINDOW = 20_000;

function cfg(over: Partial<GameConfig> = {}): GameConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

function answer(teamId: string, choiceIndex: number, elapsedMs: number): AnswerRecord {
  return { teamId, choiceIndex, elapsedMs, byPlayerId: `p-${teamId}` };
}

test('speedShare steps at the band edges and never goes negative', () => {
  assert.equal(speedShare(0, WINDOW), 1);
  assert.equal(speedShare(7_999, WINDOW), 1, 'just inside the 40% band is full');
  assert.equal(speedShare(8_000, WINDOW), 0.5, 'exactly 40% has stepped down');
  assert.equal(speedShare(13_999, WINDOW), 0.5);
  assert.equal(speedShare(14_000, WINDOW), 0, 'exactly 70% earns nothing');
  assert.equal(speedShare(WINDOW, WINDOW), 0);
  assert.equal(speedShare(WINDOW * 2, WINDOW), 0, 'past the deadline is still just zero');
  assert.equal(speedShare(-5_000, WINDOW), 1, 'clock skew cannot mint a negative fraction');
});

test('a missing or zero window pays no bonus rather than dividing by zero', () => {
  assert.equal(speedShare(1_000, 0), 0);
  assert.equal(speedShare(1_000, -1), 0);
  assert.equal(speedShare(1_000, Number.NaN), 0);
});

test('base points are identical at every speed; only the bonus moves', () => {
  const base = basePoints(3);
  const awards = scoreQuestion(
    [answer('fast', 1, 1_000), answer('middling', 1, 10_000), answer('slow', 1, 19_000)],
    1,
    3,
    cfg({ speedBonusPoints: 10 }),
    WINDOW,
  );

  for (const a of awards) assert.equal(a.base, base, `${a.teamId} kept full base points`);
  assert.deepEqual(
    awards.map((a) => a.total),
    [base + 10, base + 5, base],
  );
  assert.deepEqual(
    awards.map((a) => a.speedBonus),
    [true, true, false],
  );
});

test('a slow correct answer beats a fast wrong one', () => {
  const [slowRight, fastWrong] = scoreQuestion(
    [answer('slow', 1, 19_500), answer('quick', 2, 200)],
    1,
    2,
    cfg(),
    WINDOW,
  );

  assert.equal(fastWrong!.total, 0, 'speed earns nothing without the right answer');
  assert.ok(slowRight!.total > fastWrong!.total);
});

test('the only correct team still earns its band', () => {
  // The first-in bonus this replaced needed someone to beat. A band does not:
  // it rewards answering decisively, which is true of a lone right answer too.
  const [only] = scoreQuestion([answer('alone', 0, 500)], 0, 4, cfg({ speedBonusPoints: 10 }), WINDOW);
  assert.equal(only!.bonus, 10);
  assert.equal(only!.total, basePoints(4) + 10);
});

test('speedBonus off pays base points at any pace', () => {
  const awards = scoreQuestion(
    [answer('fast', 1, 100), answer('slow', 1, 19_000)],
    1,
    3,
    cfg({ speedBonus: false }),
    WINDOW,
  );
  for (const a of awards) {
    assert.equal(a.bonus, 0);
    assert.equal(a.speedBonus, false);
    assert.equal(a.total, basePoints(3));
  }
});

test('host-granted time widens the bands rather than penalising early answers', () => {
  const at12s = [answer('team', 1, 12_000)];
  const tight = scoreQuestion(at12s, 1, 3, cfg({ speedBonusPoints: 10 }), WINDOW);
  // The MC added 15s, so the same answer now sits inside the full band.
  const extended = scoreQuestion(at12s, 1, 3, cfg({ speedBonusPoints: 10 }), WINDOW + 15_000);

  assert.equal(tight[0]!.bonus, 5);
  assert.equal(extended[0]!.bonus, 10);
});

test('an unanswered-but-recorded wrong choice scores zero, bonus included', () => {
  const [wrong] = scoreQuestion([answer('t', 3, 100)], 0, 1, cfg(), WINDOW);
  assert.deepEqual({ base: wrong!.base, bonus: wrong!.bonus, total: wrong!.total }, { base: 0, bonus: 0, total: 0 });
});

test('the displayed value and the awarded value step at the same places', () => {
  // The player's screen computes from an elapsed fraction and the scorer from
  // milliseconds. If these two ever drift apart the game lies to the room.
  const config = cfg({ speedBonusPoints: 10 });
  const base = basePoints(3);

  for (const elapsedMs of [0, 3_000, 7_999, 8_000, 11_000, 13_999, 14_000, 19_000, WINDOW]) {
    const displayed = pointsAvailable(base, config, elapsedMs / WINDOW);
    const [awarded] = scoreQuestion([answer('t', 1, elapsedMs)], 1, 3, config, WINDOW);
    assert.equal(displayed, awarded!.total, `drift at ${elapsedMs}ms`);
  }
});
