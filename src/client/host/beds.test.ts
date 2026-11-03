import { strict as assert } from 'node:assert';
import test from 'node:test';
import { BED_VARIANTS, bedVariantByKey, hz, nightQuestionNumber, pickBedVariant, WAGER_BED_KEY } from './beds';

/** The shipped night: two rounds a game, ten questions a round. */
const NIGHT = { roundsPerGame: 2, questionsPerRound: 10 };

test('hz maps MIDI to the notes it says it does', () => {
  assert.equal(hz(69), 440);
  assert.equal(Math.round(hz(81)), 880);
  assert.equal(Math.round(hz(33)), 55);
});

test('the Think bed still plays the bass the room was tuned on', () => {
  // The pre-rotation bed's BASS_STEPS, as literal Hz. Adding beds, and later
  // removing the chord layers, was not supposed to change this figure.
  const think = bedVariantByKey('think');
  const bass = think.bass.map((m) => Number(hz(m).toFixed(2)));
  assert.deepEqual(bass, [
    55, 55, 82.41, 55, 65.41, 55, 82.41, 98,
    55, 55, 82.41, 110, 65.41, 98, 82.41, 73.42,
  ]);
  assert.equal(think.bpm, 116);
  assert.equal(think.bpmClimb, 20);
});

test('no bed carries a chord layer any more', () => {
  // The chords were removed because four of them under a twenty second
  // question read as one repeating tone. A bed that quietly grew a chord
  // field again would bring that back.
  for (const v of BED_VARIANTS) {
    for (const field of ['chords', 'stabFrom', 'comp', 'chord']) {
      assert.ok(!(field in v), `${v.key} has a ${field} again`);
    }
  }
});

test('every bed is shaped the way pump() reads it', () => {
  assert.ok(BED_VARIANTS.length >= 4, 'a rotation of fewer than four is barely a rotation');
  const keys = BED_VARIANTS.map((v) => v.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate keys would make a bed unreachable');
  for (const v of BED_VARIANTS) {
    assert.equal(v.bass.length, 16, `${v.key}: four bars of bass`);
    for (const pos of [...v.kick, ...v.clap]) {
      assert.ok(pos >= 0 && pos < 4, `${v.key}: ${pos} is outside the bar`);
    }
    assert.ok(v.kick.length > 0, `${v.key}: a bed with no kick has no pulse`);
    assert.ok(v.swing >= 0 && v.swing < 0.34, `${v.key}: swing past a third of a beat is a different time signature`);
    assert.ok(v.openHatBar === null || Number.isInteger(v.openHatBar), `${v.key}: open hat sits on a beat`);
  }
});

test('every bass figure stays inside the range a bass figure belongs in', () => {
  // Low enough to be a bass part, high enough that its harmonics survive a
  // soundbar. A step that wandered out of this range would be a typo in a
  // MIDI table, which is exactly the mistake MIDI numbers were chosen to
  // make visible.
  for (const v of BED_VARIANTS) {
    for (const m of v.bass) {
      const f = hz(m);
      assert.ok(f >= 30 && f <= 175, `${v.key}: bass step ${f.toFixed(1)}Hz is outside 30-175Hz`);
    }
  }
});

test('the bed changes every question and never repeats back to back', () => {
  for (let position = 1; position < 11; position++) {
    const a = pickBedVariant({ game: 1, round: 1, position, ...NIGHT });
    const b = pickBedVariant({ game: 1, round: 1, position: position + 1, ...NIGHT });
    assert.notEqual(a.key, b.key, `position ${position} and ${position + 1} share a bed`);
  }
});

test('the same question always gets the same bed', () => {
  // A reload of the big screen mid-question must not change the music.
  const at = { game: 1, round: 2, position: 7, ...NIGHT };
  const first = pickBedVariant(at).key;
  for (let i = 0; i < 20; i++) assert.equal(pickBedVariant(at).key, first);
});

test('a round break does not land the room back on the bed it left on', () => {
  // The audible case: round one ends on a bed, the room takes five minutes,
  // and round two opens on the same one.
  for (const perRound of [2, 4, 8, 10, 12]) {
    const night = { roundsPerGame: 2, questionsPerRound: perRound };
    const last = pickBedVariant({ game: 1, round: 1, position: perRound, ...night }).key;
    const next = pickBedVariant({ game: 1, round: 2, position: 1, ...night }).key;
    assert.notEqual(last, next, `${perRound} questions a round: round 2 opens on ${next} again`);
    // And the same across a game break.
    const lastOfGame = pickBedVariant({ game: 1, round: 2, position: perRound, ...night }).key;
    const firstOfNext = pickBedVariant({ game: 2, round: 1, position: 1, ...night }).key;
    assert.notEqual(lastOfGame, firstOfNext, `${perRound} questions a round: game 2 opens on ${firstOfNext} again`);
  }
});

test('every bed is used over a night, none more than its share', () => {
  const counts = new Map();
  for (let game = 1; game <= 3; game++) {
    for (let round = 1; round <= 2; round++) {
      for (let position = 1; position <= 10; position++) {
        const key = pickBedVariant({ game, round, position, ...NIGHT }).key;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  assert.equal(counts.size, BED_VARIANTS.length, `only ${[...counts.keys()].join(', ')} were played`);
  const share = 60 / BED_VARIANTS.length;
  for (const [key, n] of counts) assert.ok(Math.abs(n - share) <= 1, `${key} played ${n} of 60`);
});

test('the night opens on the bed the room was already tuned on', () => {
  assert.equal(pickBedVariant({ game: 1, round: 1, position: 1, ...NIGHT }).key, 'think');
  // And the order a night plays is the order the table reads, which is what
  // the rendered previews are numbered by.
  const played = [1, 2, 3, 4].map((position) => pickBedVariant({ game: 1, round: 1, position, ...NIGHT }).key);
  assert.deepEqual(played, BED_VARIANTS.map((v) => v.key));
});

test('the night counter runs straight through breaks', () => {
  assert.equal(nightQuestionNumber({ game: 1, round: 1, position: 1, ...NIGHT }), 1);
  assert.equal(nightQuestionNumber({ game: 1, round: 1, position: 10, ...NIGHT }), 10);
  assert.equal(nightQuestionNumber({ game: 1, round: 2, position: 1, ...NIGHT }), 11);
  assert.equal(nightQuestionNumber({ game: 2, round: 1, position: 1, ...NIGHT }), 21);
  // Nonsense in, something sane out: the host reads these off a state that is
  // briefly empty between phases.
  assert.equal(nightQuestionNumber({ game: 0, round: 0, position: 0, roundsPerGame: 0, questionsPerRound: 0 }), 0);
});

test('the wager gets its own bed whatever its position', () => {
  for (let position = 0; position < 5; position++) {
    assert.equal(pickBedVariant({ game: 1, round: 1, position, ...NIGHT, wager: true }).key, WAGER_BED_KEY);
  }
});

test('a bed is always returned, whatever the state says', () => {
  for (const at of [
    { game: 0, round: 0, position: 0, roundsPerGame: 0, questionsPerRound: 0 },
    { game: -1, round: -3, position: -7, roundsPerGame: -2, questionsPerRound: -5 },
    { game: 99, round: 12, position: 480, roundsPerGame: 12, questionsPerRound: 480 },
  ]) {
    assert.ok(BED_VARIANTS.includes(pickBedVariant(at)), `no bed for ${JSON.stringify(at)}`);
  }
  assert.equal(bedVariantByKey(undefined).key, 'think');
  assert.equal(bedVariantByKey('no-such-bed').key, 'think');
});
