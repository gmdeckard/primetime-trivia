import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DEFAULT_CONFIG, inRunUpToQuestion } from '../../shared/protocol.js';
import { loadBank } from './content.js';
import {
  hasNoReachableAddress,
  hasOnlyUnusableAddresses,
  isLinkLocalAddress,
  rankLanAddresses,
  rankLanCandidates,
  isVirtualInterface,
  candidateNote,
  isWsl,
} from './lan.js';
import { Engine, normalizeRoomCode } from './engine.js';
import { Store } from './store.js';
import { controlState, hostState, playerState } from './views.js';

/**
 * These tests play actual games. The engine is a state machine with a lot of
 * edges, and the failure mode we care about is not a type error — it is an MC
 * standing in front of ninety people with a button that does nothing.
 */

const bank = loadBank(join(process.cwd(), 'content'));
const dirs: string[] = [];
const engines: Engine[] = [];

function freshEngine(
  config?: ConstructorParameters<typeof Engine>[2],
  resume?: ConstructorParameters<typeof Engine>[3],
) {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-test-'));
  dirs.push(dir);
  const engine = new Engine(bank, new Store(dir), config, resume);
  engines.push(engine);
  return engine;
}

after(() => {
  // Order matters: a still-armed question timer would fire into a deleted
  // directory and surface as an unhandled ENOENT long after the test passed.
  for (const engine of engines) engine.dispose();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Seat `count` entries — one device each — and return their ids. */
function seatTeams(engine: Engine, count: number) {
  const teams: Array<{ teamId: string; players: string[] }> = [];
  for (let i = 0; i < count; i++) {
    const device = engine.identify();
    engine.join(device.id, engine.snapshot().roomCode, `Entry ${i + 1}`, i % 2 === 0 ? 'team' : 'solo');
    teams.push({ teamId: engine.snapshot().players[device.id]!.teamId!, players: [device.id] });
  }
  return teams;
}

test('content bank loads with no errors', () => {
  assert.equal(bank.issues.filter((i) => i.severity === 'error').length, 0);
  assert.ok(bank.questions.length > 300, `expected a usable bank, got ${bank.questions.length}`);
});

test('one device is one entry — a second device is its own entry', () => {
  const engine = freshEngine();
  const a = engine.identify();
  const b = engine.identify();
  engine.join(a.id, engine.snapshot().roomCode, 'Ace', 'solo');
  engine.join(b.id, engine.snapshot().roomCode, 'Deuce', 'solo');
  const s = engine.snapshot();
  assert.equal(s.teamOrder.length, 2, 'each device gets its own row');
  assert.notEqual(s.players[a.id]!.teamId, s.players[b.id]!.teamId);
});

test('rejoining from the same device keeps the entry and its score', () => {
  const engine = freshEngine();
  const device = engine.identify();
  engine.join(device.id, engine.snapshot().roomCode, 'Ace', 'solo');
  const teamId = engine.snapshot().players[device.id]!.teamId!;
  engine.adjustScore(teamId, 40);

  engine.join(device.id, engine.snapshot().roomCode, 'Ace of Spades', 'team');
  const s = engine.snapshot();
  assert.equal(s.teamOrder.length, 1, 'renaming must not create a second entry');
  assert.equal(s.teams[teamId]!.score, 40, 'the score must survive');
  assert.equal(s.teams[teamId]!.name, 'Ace of Spades');
  assert.equal(s.teams[teamId]!.kind, 'team');
});

test('duplicate names are refused', () => {
  const engine = freshEngine();
  const a = engine.identify();
  const b = engine.identify();
  engine.join(a.id, engine.snapshot().roomCode, 'The Snowbirds', 'team');
  assert.throws(() => engine.join(b.id, engine.snapshot().roomCode, 'the snowbirds', 'solo'), /already using/i);
});

test('a seat needs the room code', () => {
  // The whole point. The server answers on a public hostname now, so reaching
  // it proves nothing; reading the code off the big screen proves you are in
  // the room. Before this, identify() handed a seat to anyone who asked.
  const engine = freshEngine();
  const stranger = engine.identify();
  assert.throws(
    () => engine.join(stranger.id, 'falcon-9', 'Gatecrasher', 'solo'),
    /not right/i,
  );
  assert.throws(
    () => engine.join(stranger.id, '', 'Gatecrasher', 'solo'),
    /Enter the room code/i,
  );
  assert.equal(engine.snapshot().teamOrder.length, 0, 'nobody is seated by a bad code');
  assert.equal(engine.snapshot().players[stranger.id]!.teamId, undefined);
});

test('the room code forgives how it was typed', () => {
  // Someone reads it off a screen across a room. Case, spaces and the hyphen
  // are not the test; being in the room is.
  const engine = freshEngine();
  const real = engine.snapshot().roomCode; // e.g. falcon-7
  const spelt = [real.toUpperCase(), real.replace('-', ' '), real.replace('-', ''), ` ${real} `];
  for (const [i, typed] of spelt.entries()) {
    const device = engine.identify();
    engine.join(device.id, typed, `Entry ${i}`, 'solo');
    assert.ok(engine.snapshot().players[device.id]!.teamId, `"${typed}" should be accepted`);
  }
  assert.equal(engine.snapshot().teamOrder.length, spelt.length);
});

test('normalizeRoomCode keeps only what the code means', () => {
  assert.equal(normalizeRoomCode('FALCON-7'), 'falcon7');
  assert.equal(normalizeRoomCode(' falcon 7 '), 'falcon7');
  assert.equal(normalizeRoomCode('falcon_7'), 'falcon7');
  assert.equal(normalizeRoomCode(''), '');
  // Not so forgiving that a different code passes.
  assert.notEqual(normalizeRoomCode('falcon-7'), normalizeRoomCode('falcon-8'));
});

test('a seated device is past the gate', () => {
  // join() is also the rename path. Someone who already holds a seat has
  // already proved they are in the room; asking again would gate the wrong
  // thing. (The current UI drops the seat first, so this is the guard, not
  // the happy path.)
  const engine = freshEngine();
  const device = engine.identify();
  engine.join(device.id, engine.snapshot().roomCode, 'Ace', 'solo');
  engine.join(device.id, 'nonsense', 'Ace of Spades', 'solo');
  const teamId = engine.snapshot().players[device.id]!.teamId!;
  assert.equal(engine.snapshot().teams[teamId]!.name, 'Ace of Spades');
});

test('the room code is withheld from a player who has no seat', () => {
  // Sending the code to everyone who loads the page and then asking them to
  // type it back is a gate that opens itself.
  const engine = freshEngine();
  const device = engine.identify();
  const before = playerState(engine, device.id);
  assert.equal(before.roomCode, '', 'a seatless player must not be told the code');

  engine.join(device.id, engine.snapshot().roomCode, 'Ace', 'solo');
  const after = playerState(engine, device.id);
  assert.equal(after.roomCode, engine.snapshot().roomCode, 'a seated player can read it out');

  // The MC and the big screen always need it: one says it, the other shows it.
  const join = { url: 'http://x', qrSvg: '' };
  assert.equal(hostState(engine, join).roomCode, engine.snapshot().roomCode);
  assert.equal(controlState(engine).roomCode, engine.snapshot().roomCode);
});

test('the correct answer is not always in the same slot', () => {
  const engine = freshEngine();
  seatTeams(engine, 2);
  const positions = new Set<number>();
  for (let i = 0; i < 40; i++) {
    engine.startGame();
    engine.advance(); // game_intro -> round_intro
    engine.advance(); // -> question
    const index = engine.correctDisplayIndex();
    assert.ok(index !== undefined && index >= 0 && index <= 3);
    positions.add(index);
  }
  // Authored answer-first, so without shuffling this would only ever be {0}.
  assert.ok(positions.size > 1, `answer always landed in slot(s) ${[...positions]}`);
});

test('a full block runs start to finish and produces a winner', () => {
  const engine = freshEngine({ roundsPerGame: 2, questionsPerRound: 3, finalWager: true });
  const teams = seatTeams(engine, 3);

  engine.startGame();
  assert.equal(engine.snapshot().phase, 'game_intro');

  let guard = 0;
  while (engine.snapshot().phase !== 'game_results' && guard++ < 200) {
    const phase = engine.snapshot().phase;

    if (phase === 'question' || phase === 'wager_question') {
      // First team always right, second always wrong, third abstains.
      const correct = engine.correctDisplayIndex()!;
      engine.answer(teams[0]!.players[0]!, correct);
      engine.answer(teams[1]!.players[0]!, (correct + 1) % 4);
    } else if (phase === 'wager_bet') {
      for (const team of teams) engine.setWager(team.players[0]!, 20);
    }
    engine.advance();
  }

  assert.ok(guard < 200, 'the block never reached game_results');
  const board = engine.scoreRows();
  assert.equal(board.length, 3);
  assert.equal(board[0]!.teamId, teams[0]!.teamId, 'the always-correct team should lead');
  assert.ok(board[0]!.score > board[1]!.score);
});

test('the window runs its full length even once every team is in', async () => {
  const engine = freshEngine({ questionsPerRound: 3, secondsPerQuestion: 0.5 });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();
  assert.equal(engine.snapshot().phase, 'question');

  engine.answer(teams[0]!.players[0]!, 0);
  engine.answer(teams[1]!.players[0]!, 1);
  // The old behaviour locked right here. A table that answers in three seconds
  // must not pull the reveal onto a table still reading the prompt, so the
  // clock, not the last tap, ends the question.
  assert.equal(engine.snapshot().phase, 'question', 'everyone being in must not cut the clock short');

  await wait(700);
  assert.equal(engine.snapshot().phase, 'locked', 'the clock should have closed it');
});

/*
 * Value: protects=a night interrupted during the final wager or a tiebreak can
 *   still be finished by the MC;
 *   fails_when=the resume path parks one of those phases as locked without
 *   moving it on — advance() then calls lockNow(), which returns immediately on
 *   a locked question without committing, so the big button does nothing and
 *   the only ways out are End night or Reset;
 *   why_new=every existing resume test covers the plain question phase, which
 *   is the one phase the old code did remap; seam=none;
 *   no_claim=says nothing about scoring the interrupted wager, which is
 *   deliberately voided rather than guessed at.
 */
test('a night interrupted during the final wager can still be finished', () => {
  const engine = freshEngine({ roundsPerGame: 1, questionsPerRound: 1, finalWager: true });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance(); // round_intro
  engine.advance(); // question
  engine.lockNow('host');
  engine.advance(); // reveal
  engine.advance(); // round_scores
  engine.advance(); // wager_bet
  for (const team of teams) engine.setWager(team.players[0]!, 10);
  engine.advance(); // wager_question
  assert.equal(engine.snapshot().phase, 'wager_question');
  for (const team of teams) engine.answer(team.players[0]!, engine.correctDisplayIndex()!);

  // The power goes out with the closing question on screen.
  const onDisk = JSON.parse(JSON.stringify(engine.snapshot()));
  const resumed = freshEngine(undefined, onDisk);
  assert.equal(resumed.snapshot().phase, 'wager_reveal', 'the wager has to land somewhere it can leave');
  assert.ok(resumed.snapshot().message, 'and the MC should be told what happened to the bets');

  const before = resumed.snapshot().phase;
  resumed.advance();
  assert.notEqual(resumed.snapshot().phase, before, "the MC's button must actually do something");
});

test('a night interrupted during a tiebreak can still be finished', () => {
  const engine = freshEngine({ roundsPerGame: 1, questionsPerRound: 1, finalWager: false });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.startTiebreak();
  assert.equal(engine.snapshot().phase, 'tiebreak');
  engine.answerNumber(teams[0]!.players[0]!, 5);

  const onDisk = JSON.parse(JSON.stringify(engine.snapshot()));
  const resumed = freshEngine(undefined, onDisk);
  assert.equal(resumed.snapshot().phase, 'tiebreak_reveal', 'sudden death has to resolve to something');
  const before = resumed.snapshot().phase;
  resumed.advance();
  assert.notEqual(resumed.snapshot().phase, before, "the MC's button must actually do something");
});

/*
 * Value: protects=the speed band a team already earned, when someone taps the
 *   same letter again;
 *   fails_when=answer() goes back to overwriting elapsedMs unconditionally — a
 *   double-tap or a nervous re-confirm then silently costs the whole stepped
 *   bonus, with nothing on the handset to explain it;
 *   why_new=no test taps the same choice twice, and the window now stays open
 *   for its full length with copy inviting a re-tap; seam=none;
 *   no_claim=says nothing about changing to a different letter, which is timed
 *   afresh on purpose.
 */
test('re-tapping the same answer keeps the time the team earned', async () => {
  const engine = freshEngine({ questionsPerRound: 3 });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();

  const device = teams[0]!.players[0]!;
  const teamId = teams[0]!.teamId;
  engine.answer(device, 1);
  const first = engine.snapshot().current!.answers[teamId]!.elapsedMs;

  await wait(60);
  engine.answer(device, 1); // the same letter, tapped again to be sure
  assert.equal(engine.snapshot().current!.answers[teamId]!.elapsedMs, first, 'a re-tap is not a new answer');

  await wait(60);
  engine.answer(device, 2); // a real change of mind is timed afresh
  assert.ok(engine.snapshot().current!.answers[teamId]!.elapsedMs > first, 'changing your mind costs what it costs');
});

/*
 * Value: protects=a paused round really stops, including a question already on
 *   screen, and gives the paused time back rather than eating it;
 *   fails_when=setHeld goes back to only clearing the auto-advance timer — the
 *   question then locks on its original deadline while the MC is dealing with
 *   whatever interrupted them, and the room loses the answer and the points;
 *   why_new=every existing hold test pauses in the gap between questions,
 *   which is the one case the old code handled; seam=none;
 *   no_claim=says nothing about pausing a wager or a tiebreak.
 */
test('pausing stops a live question, and resuming gives the time back', async () => {
  const engine = freshEngine({ questionsPerRound: 3, secondsPerQuestion: 0.6, autoAdvance: false });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();
  assert.equal(engine.snapshot().phase, 'question');
  const before = engine.snapshot().current!.deadline;

  engine.setHeld(true);
  await wait(500);
  assert.equal(engine.snapshot().phase, 'question', 'a paused question must not lock on its old clock');

  // And the room cannot answer into a round the MC has stopped.
  engine.answer(teams[0]!.players[0]!, 1);
  assert.equal(engine.snapshot().current!.answers[teams[0]!.teamId], undefined, 'paused means paused at the tables too');

  engine.setHeld(false);
  const after = engine.snapshot().current!;
  assert.ok(after.deadline > before, 'the paused time is owed back');
  assert.ok(
    Math.abs((after.deadline - after.startedAt) - 600) < 120,
    `the window must keep its width, got ${after.deadline - after.startedAt}ms`,
  );

  engine.answer(teams[0]!.players[0]!, 1);
  assert.ok(engine.snapshot().current!.answers[teams[0]!.teamId], 'and answering works again');

  await wait(800);
  assert.equal(engine.snapshot().phase, 'locked', 'the restarted clock still closes it');
});

/*
 * Value: protects=the screens clearing their own banner;
 *   fails_when=startQuestion stops resetting state.message — the resume
 *   notice, which says "answers for THIS question were locked", then stays on
 *   the big screen and in every player's hand through the rest of the night,
 *   because nothing else clears it and the only control is a button the MC has
 *   to go looking for;
 *   why_new=the resume tests check the phase and the timer, never the banner,
 *   and this was reported from a real night; seam=none;
 *   no_claim=says nothing about how long an MC announcement should live.
 */
test('a banner does not outlive the question it describes', () => {
  const first = freshEngine({ questionsPerRound: 3 });
  seatTeams(first, 2);
  while (first.snapshot().phase !== 'question') first.advance();
  const onDisk = JSON.parse(JSON.stringify(first.snapshot()));

  const resumed = freshEngine(undefined, onDisk);
  assert.ok(resumed.snapshot().message, 'the restart notice should be up at first');

  // The MC carries on. The next question makes that sentence false.
  resumed.advance();
  resumed.advance();
  assert.equal(resumed.snapshot().phase, 'question');
  assert.equal(resumed.snapshot().message, undefined, 'the banner must come down by itself');
});

test('an MC announcement lasts the break and no longer', () => {
  const engine = freshEngine({ questionsPerRound: 3 });
  seatTeams(engine, 2);
  engine.startGame();
  engine.say('Short break — back in ten minutes.');
  assert.ok(engine.snapshot().message, 'it should be up while the room is away');

  engine.advance();
  engine.advance();
  assert.equal(engine.snapshot().phase, 'question');
  assert.equal(engine.snapshot().message, undefined, 'and gone once play resumes');
});

test('the MC can still close a question early', () => {
  const engine = freshEngine({ questionsPerRound: 3 });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();

  for (const team of teams) engine.answer(team.players[0]!, 0);
  engine.lockNow();
  assert.equal(engine.snapshot().phase, 'locked', 'Lock now is the escape hatch for a room that is visibly done');
});

/*
 * Value: protects=the clock still closes the final wager when every bet and
 *   every answer is already in, now that the last tap no longer ends a window;
 *   fails_when=armTimer is skipped for the wager question, or lockNow's
 *   wager_question branch stops paying out on a 'timer' lock, which would leave
 *   the night parked on the closing question with every table waiting;
 *   why_new=no test drives the wager to its end without the MC's thumb — the
 *   existing wager test calls advance() to lock, and the removed maybeAutoLock
 *   used to be the fallback here; seam=none;
 *   no_claim=says nothing about which question the wager draws or how the
 *   speed bands are paid.
 */
test('the clock closes the final wager without the MC', async () => {
  const engine = freshEngine({
    roundsPerGame: 1,
    questionsPerRound: 1,
    finalWager: true,
    secondsPerQuestion: 0.4,
    autoAdvance: false,
  });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance(); // -> round_intro
  engine.advance(); // -> question
  engine.lockNow('host');
  engine.advance(); // -> reveal
  engine.advance(); // -> round_scores
  engine.advance(); // -> wager_bet
  assert.equal(engine.snapshot().phase, 'wager_bet');

  const scoreOf = (teamId: string) => engine.scoreRows().find((r) => r.teamId === teamId)!.score;
  for (const team of teams) engine.setWager(team.players[0]!, 10);
  engine.advance(); // -> wager_question
  assert.equal(engine.snapshot().phase, 'wager_question');

  const correct = engine.correctDisplayIndex()!;
  const before = scoreOf(teams[0]!.teamId);
  for (const team of teams) engine.answer(team.players[0]!, correct);
  assert.equal(engine.snapshot().phase, 'wager_question', 'every bet being in must not end the wager early');

  // The wager window is 1.5x the question length, rounded to whole seconds.
  await wait(1400);
  assert.equal(engine.snapshot().phase, 'wager_reveal', 'the clock has to close the closing question');
  assert.equal(scoreOf(teams[0]!.teamId), before + 10, 'and a timer lock must still pay the wager out');
});

/*
 * Value: protects=a numeric tiebreak also ends on its own clock, and the point
 *   is still awarded when it does;
 *   fails_when=startQuestion stops arming the clock for a tiebreak, or
 *   lockNow's tiebreak branch only ranks answers on a host lock — either way
 *   sudden death would sit unresolved in front of the room;
 *   why_new=the existing tiebreak test locks with advance() and is conditional
 *   on the speed bonus leaving the top two level, so the clock path through
 *   rankNumeric is never exercised; seam=none;
 *   no_claim=says nothing about who wins a tie on distance.
 */
test('the clock closes a tiebreak without the MC', async () => {
  const engine = freshEngine({ secondsPerQuestion: 0.4, autoAdvance: false });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  // Nobody has scored yet, so both entries are tied at the top.
  engine.startTiebreak();
  assert.equal(engine.snapshot().phase, 'tiebreak');

  engine.answerNumber(teams[0]!.players[0]!, 1);
  engine.answerNumber(teams[1]!.players[0]!, 999999);
  assert.equal(engine.snapshot().phase, 'tiebreak', 'both guesses being in must not end sudden death early');

  await wait(700);
  assert.equal(engine.snapshot().phase, 'tiebreak_reveal', 'the clock has to resolve the tiebreak');
  const rows = engine.scoreRows();
  assert.notEqual(rows[0]!.score, rows[1]!.score, 'and a timer lock must still award the deciding point');
});

/*
 * Value: protects=the MC's "+15 seconds" really holds the question open, and a
 *   room that answers nothing at all still closes on the clock;
 *   fails_when=extendTimer stops re-arming the clock (the old early lock used
 *   to cover for that whenever every team had answered), or lockNow refuses to
 *   close a question with no answers on it — both of which stop the night dead;
 *   why_new=extendTimer has no engine-level test at all, and no test locks a
 *   question with an empty answer set; seam=none;
 *   no_claim=says nothing about how the widened window reshapes the speed
 *   bands, which scoring.test.ts already covers.
 */
test('granted time holds the question open, and a silent room still locks', async () => {
  const engine = freshEngine({ questionsPerRound: 3, secondsPerQuestion: 0.4, autoAdvance: false });
  seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();
  assert.equal(engine.snapshot().phase, 'question');

  engine.extendTimer(0.6); // the room is still reading; the window is now ~1s
  assert.equal(engine.snapshot().current!.extendedBy, 0.6, 'the control log should show what was granted');

  await wait(600);
  assert.equal(engine.snapshot().phase, 'question', 'granted time must actually hold the question open');

  await wait(700);
  assert.equal(engine.snapshot().phase, 'locked', 'with nobody answering, the clock still has to close it');
  assert.deepEqual(engine.snapshot().current!.awards, [], 'a silent room scores nothing rather than failing to lock');
});

test('an answer can be changed until the lock', () => {
  const engine = freshEngine();
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();

  const device = teams[0]!.players[0]!;
  engine.answer(device, 0);
  engine.answer(device, 2);
  assert.equal(playerState(engine, device).me.choiceIndex, 2, 'the later tap should win');
});

test('a player is sent the top of the table plus their own row, not all hundred', () => {
  const engine = freshEngine();
  const teams = seatTeams(engine, 40);
  // Push one entry to the bottom so it falls outside the top slice.
  teams.forEach((t, i) => engine.adjustScore(t.teamId, (teams.length - i) * 10));
  const last = teams[teams.length - 1]!;

  const view = playerState(engine, last.players[0]!);
  assert.ok(view.scoreboard.length < teams.length, 'the full table must not be sent to a player');
  assert.ok(
    view.scoreboard.some((r) => r.teamId === last.teamId),
    "a player's own row must always be included, however far down they are",
  );
  assert.equal(view.entryCount, 40, 'but they should still see how many are playing');
  assert.equal(view.teams.length, 0, 'the entry list is for the host and MC only');
});

test('a wrong final wager subtracts the bet', () => {
  const engine = freshEngine({ roundsPerGame: 1, questionsPerRound: 1, finalWager: true });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance(); // round_intro
  engine.advance(); // question
  const correct = engine.correctDisplayIndex()!;
  for (const team of teams) engine.answer(team.players[0]!, correct);
  engine.advance(); // answers in
  engine.advance(); // reveal
  engine.advance(); // round_scores
  assert.equal(engine.snapshot().phase, 'round_scores');

  const scoreOf = (teamId: string) => engine.scoreRows().find((r) => r.teamId === teamId)!.score;
  const beforeA = scoreOf(teams[0]!.teamId);
  const beforeB = scoreOf(teams[1]!.teamId);
  engine.advance(); // wager_bet
  assert.equal(engine.snapshot().phase, 'wager_bet');
  engine.setWager(teams[0]!.players[0]!, 15);
  engine.setWager(teams[1]!.players[0]!, 15);
  engine.advance(); // wager_question

  const wagerCorrect = engine.correctDisplayIndex()!;
  engine.answer(teams[0]!.players[0]!, wagerCorrect);
  engine.answer(teams[1]!.players[0]!, (wagerCorrect + 1) % 4);
  engine.advance(); // answers in
  assert.equal(engine.snapshot().phase, 'wager_reveal');

  assert.equal(scoreOf(teams[0]!.teamId), beforeA + 15, 'a correct wager should be added');
  assert.equal(scoreOf(teams[1]!.teamId), beforeB - 15, 'a wrong wager should be subtracted');
});

test('clearing a wager is distinct from betting nothing', () => {
  const engine = freshEngine({ roundsPerGame: 1, questionsPerRound: 1 });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();
  engine.lockNow('host');
  engine.advance();
  engine.advance();
  engine.advance();
  assert.equal(engine.snapshot().phase, 'wager_bet');

  const player = teams[0]!.players[0]!;
  engine.setWager(player, 25);
  assert.equal(playerState(engine, player).me.wager, 25);
  engine.setWager(player, -1);
  assert.equal(playerState(engine, player).me.wager, undefined, 'a cleared wager should be unset, not zero');
});

test('no question repeats within a night', () => {
  const engine = freshEngine({ roundsPerGame: 3, questionsPerRound: 8 });
  seatTeams(engine, 2);
  for (let block = 0; block < 4; block++) {
    engine.startGame();
    const ids = engine.snapshot().rounds.flatMap((r) => r.questionIds);
    const seen = new Set(ids);
    assert.equal(seen.size, ids.length, `block ${block + 1} drew a duplicate question`);
  }
  const asked = engine.snapshot().askedQuestionIds;
  assert.equal(new Set(asked).size, asked.length, 'the night-long asked list has duplicates');
});

test('the player view never leaks the answer before the reveal', () => {
  const engine = freshEngine();
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();

  const live = playerState(engine, teams[0]!.players[0]!);
  assert.equal(live.reveal, undefined, 'a live question must not carry a reveal');
  assert.ok(live.question, 'but it must carry the question');
  assert.ok(!JSON.stringify(live).includes('funFact'), 'the fun fact betrays the answer and must be withheld');

  engine.lockNow('host');
  engine.advance();
  const revealed = playerState(engine, teams[0]!.players[0]!);
  assert.ok(revealed.reveal, 'after the reveal the answer should be present');
  assert.ok(revealed.reveal!.answerText.length > 0);
});

test('the control view always sees the answer key', () => {
  const engine = freshEngine();
  seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();
  const view = controlState(engine);
  assert.ok(view.answerKey, 'the MC needs the answer while the question is live');
  assert.ok(view.answerKey!.text.length > 0);
  assert.equal(view.answerKey!.index, engine.correctDisplayIndex());
});

test('a tie at the top can be broken', () => {
  const engine = freshEngine({ roundsPerGame: 1, questionsPerRound: 1, finalWager: false });
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();
  const correct = engine.correctDisplayIndex()!;
  for (const team of teams) engine.answer(team.players[0]!, correct);
  engine.advance(); // answers in
  engine.advance();
  engine.advance();
  engine.advance();
  assert.equal(engine.snapshot().phase, 'game_results');

  const rows = engine.scoreRows();
  // Both answered correctly; with the speed bonus they may differ by that much.
  if (rows[0]!.score === rows[1]!.score) {
    engine.startTiebreak();
    assert.equal(engine.snapshot().phase, 'tiebreak');
    engine.answerNumber(teams[0]!.players[0]!, 1);
    engine.answerNumber(teams[1]!.players[0]!, 999999);
    engine.advance(); // answers in
    assert.equal(engine.snapshot().phase, 'tiebreak_reveal');
    const after = engine.scoreRows();
    assert.notEqual(after[0]!.score, after[1]!.score, 'the tiebreak should separate them');
  } else {
    assert.throws(() => engine.startTiebreak(), /clear winner/i);
  }
});

test('the night survives a restart mid-question', () => {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-resume-'));
  dirs.push(dir);
  const store = new Store(dir);
  const engine = freshEngineWith(store);
  const teams = seatTeams(engine, 2);
  engine.startGame();
  engine.advance();
  engine.advance();
  engine.answer(teams[0]!.players[0]!, 0);
  const expectedScoreTeams = engine.snapshot().teamOrder.length;
  engine.dispose();

  const resumed = new Engine(bank, store, undefined, store.loadNight());
  engines.push(resumed);
  assert.equal(resumed.snapshot().teamOrder.length, expectedScoreTeams, 'teams should come back');
  assert.equal(resumed.snapshot().phase, 'locked', 'a question in flight should be parked, not scored against a stale clock');
  assert.ok(resumed.snapshot().message, 'and the MC should be told what happened');
  resumed.dispose();

  function freshEngineWith(s: Store) {
    const e = new Engine(bank, s, undefined, null);
    engines.push(e);
    return e;
  }
});

test('structural config changes are refused mid-block', () => {
  const engine = freshEngine({ questionsPerRound: 8 });
  seatTeams(engine, 2);
  engine.startGame();
  engine.setConfig({ questionsPerRound: 2, secondsPerQuestion: 20 });
  const config = engine.snapshot().config;
  assert.equal(config.questionsPerRound, 8, 'round shape must not change mid-block');
  assert.equal(config.secondsPerQuestion, 20, 'but pacing should still be adjustable');
});

test('starting a block with nobody seated is refused', () => {
  const engine = freshEngine();
  assert.throws(() => engine.startGame(), /no teams/i);
});

// --------------------------------------------------------------- auto-advance

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seat teams and drive to the first live question. */
function toFirstQuestion(engine: Engine, teams = 2) {
  const seated = seatTeams(engine, teams);
  engine.startGame();
  engine.advance(); // game_intro -> round_intro
  engine.advance(); // -> question
  return seated;
}

test('auto-advance walks lock -> reveal -> next question on its own', async () => {
  const engine = freshEngine({
    questionsPerRound: 3,
    autoAdvance: true,
    revealDelaySeconds: 0.6,
    nextQuestionDelaySeconds: 0.6,
  });
  const teams = toFirstQuestion(engine);

  // Everyone answers and the clock closes the question, which is the only way
  // it now ends without the MC.
  for (const team of teams) engine.answer(team.players[0]!, 0);
  engine.lockNow('timer');
  assert.equal(engine.snapshot().phase, 'locked');
  assert.ok(engine.snapshot().autoAdvanceAt, 'a reveal should be queued');

  await wait(900);
  assert.equal(engine.snapshot().phase, 'reveal', 'should have revealed by itself');
  assert.ok(engine.snapshot().autoAdvanceAt, 'the next question should be queued');

  await wait(900);
  assert.equal(engine.snapshot().phase, 'question', 'should have moved on by itself');
  assert.equal(engine.snapshot().current?.position, 2, 'and be on the second question');
});

test('the last reveal of a round rolls into the scoreboard by itself', async () => {
  // This used to stop here on purpose, back when every round boundary waited
  // for the MC. A night set up to run itself ran one round and then sat on an
  // answer until somebody noticed. The stop the MC wants is the break, which
  // the scoreboard arms, and which they can set to wait for them.
  const engine = freshEngine({
    questionsPerRound: 1,
    roundsPerGame: 2,
    autoAdvance: true,
    revealDelaySeconds: 0.6,
    nextQuestionDelaySeconds: 0.6,
    roundBreakMinutes: 5,
    autoStartAfterBreak: false,
  });
  const teams = toFirstQuestion(engine);
  for (const team of teams) engine.answer(team.players[0]!, 0);
  engine.lockNow('timer');

  await wait(900);
  assert.equal(engine.snapshot().phase, 'reveal');
  assert.ok(engine.snapshot().autoAdvanceAt, 'the last reveal of a round still queues its next step');

  await wait(900);
  const s = engine.snapshot();
  assert.equal(s.phase, 'round_scores', 'it reaches the scoreboard without a thumb');
  assert.ok(s.breakEndsAt, 'and the break is on the clock');
  assert.equal(s.autoAdvanceAt, undefined, 'but a manual break is where it waits for the MC');
});

test('a reveal says what actually comes next', () => {
  const engine = freshEngine({ questionsPerRound: 2, roundsPerGame: 1, finalWager: false });
  const teams = toFirstQuestion(engine);
  for (const team of teams) engine.answer(team.players[0]!, 0);
  engine.lockNow('host');
  engine.advance(); // -> reveal, with another question behind it
  assert.equal(controlState(engine).moreInRound, true);

  engine.advance(); // -> question 2
  engine.lockNow('host');
  engine.advance(); // -> reveal, last in the round
  assert.equal(
    controlState(engine).moreInRound,
    false,
    'the run-up must not promise a question that is really a scoreboard',
  );
});

test('the run-up never counts the room in towards a break or the end of the night', () => {
  // The bug this pins: "Get ready, Set, Go" played on the way into the break
  // and again at the end of the night. The last reveal of a round carries an
  // autoAdvanceAt exactly like every other one, so anything keyed only on the
  // timer promises a question that is really a scoreboard.
  const engine = freshEngine({ questionsPerRound: 2, roundsPerGame: 2, finalWager: false });
  const teams = toFirstQuestion(engine);

  const toReveal = () => {
    for (const team of teams) engine.answer(team.players[0]!, 0);
    engine.lockNow('host');
    engine.advance();
    assert.equal(engine.snapshot().phase, 'reveal');
    return hostState(engine, { url: 'http://x', qrSvg: '' });
  };

  // Mid-round: a question really is next, so the run-up is honest.
  assert.equal(inRunUpToQuestion(toReveal()), true, 'mid-round the count-in belongs');

  // Last question of round 1. Next is the scoreboard and the break.
  engine.advance();
  assert.equal(
    inRunUpToQuestion(toReveal()),
    false,
    'no count-in on the way into the break',
  );

  // Through the break and into round 2.
  while (engine.snapshot().phase !== 'question') engine.advance();
  assert.equal(inRunUpToQuestion(toReveal()), true, 'round 2 counts in again');

  // Last question of the last round: the end of the night.
  engine.advance();
  const last = toReveal();
  assert.equal(last.moreInRound, false);
  assert.equal(inRunUpToQuestion(last), false, 'no count-in at the end of the night');
});

test('the run-up predicate holds back on a pause and off a reveal', () => {
  // A held game is silent on purpose: the pause exists because something
  // interrupted the night.
  const base = { phase: 'reveal', autoAdvanceAt: 1, held: false, moreInRound: true };
  assert.equal(inRunUpToQuestion(base), true);
  assert.equal(inRunUpToQuestion({ ...base, held: true }), false, 'paused is silent');
  assert.equal(inRunUpToQuestion({ ...base, autoAdvanceAt: undefined }), false, 'no timer, no run-up');
  assert.equal(inRunUpToQuestion({ ...base, phase: 'round_scores' }), false);
  assert.equal(inRunUpToQuestion({ ...base, phase: 'wager_reveal' }), false, 'the wager has its own beat');
  assert.equal(inRunUpToQuestion(undefined), false, 'before the first state arrives');
  // Absent on the wire means "more to come", matching what the screens did
  // before this was one predicate.
  assert.equal(inRunUpToQuestion({ ...base, moreInRound: undefined }), true);
});

test('hold parks auto-advance, releasing picks it back up', async () => {
  const engine = freshEngine({
    questionsPerRound: 3,
    autoAdvance: true,
    revealDelaySeconds: 0.6,
    nextQuestionDelaySeconds: 0.6,
  });
  const teams = toFirstQuestion(engine);
  for (const team of teams) engine.answer(team.players[0]!, 0);
  engine.lockNow('timer');

  engine.setHeld(true);
  assert.equal(engine.snapshot().autoAdvanceAt, undefined, 'hold should cancel the pending step');
  await wait(900);
  assert.equal(engine.snapshot().phase, 'locked', 'held means held');

  engine.setHeld(false);
  assert.ok(engine.snapshot().autoAdvanceAt, 'releasing should re-arm');
  await wait(900);
  assert.equal(engine.snapshot().phase, 'reveal');
});

test('a manual advance cancels the queued one, so nothing double-fires', async () => {
  const engine = freshEngine({
    questionsPerRound: 4,
    autoAdvance: true,
    revealDelaySeconds: 5,
    nextQuestionDelaySeconds: 5,
  });
  const teams = toFirstQuestion(engine);
  for (const team of teams) engine.answer(team.players[0]!, 0);
  engine.lockNow('timer');

  engine.advance(); // MC reveals early
  assert.equal(engine.snapshot().phase, 'reveal');
  engine.advance(); // MC moves on early
  assert.equal(engine.snapshot().phase, 'question');
  assert.equal(engine.snapshot().current?.position, 2);

  // The original 5s timers must not still be out there waiting to skip a question.
  await wait(700);
  assert.equal(engine.snapshot().current?.position, 2, 'a stale timer skipped a question');
});

test('auto-advance off leaves every step to the MC', async () => {
  const engine = freshEngine({ questionsPerRound: 3, autoAdvance: false });
  const teams = toFirstQuestion(engine);
  for (const team of teams) engine.answer(team.players[0]!, 0);
  engine.lockNow('timer');

  assert.equal(engine.snapshot().phase, 'locked');
  assert.equal(engine.snapshot().autoAdvanceAt, undefined);
  await wait(700);
  assert.equal(engine.snapshot().phase, 'locked', 'nothing should move without the MC');
});

test('a resumed night does not fire a countdown that expired while it slept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-auto-'));
  dirs.push(dir);
  const store = new Store(dir);
  const first = new Engine(bank, store, { questionsPerRound: 3, autoAdvance: true, revealDelaySeconds: 60 });
  engines.push(first);
  const teams = toFirstQuestion(first);
  for (const team of teams) first.answer(team.players[0]!, 0);
  first.lockNow('timer');
  const before = first.snapshot().autoAdvanceAt;
  assert.ok(before, 'a step was queued before the restart');
  // The restart has to land in a later millisecond than the lock, or a carried
  // over deadline and a freshly measured one are the same number by accident.
  await wait(20);
  first.dispose();

  const resumed = new Engine(bank, store, undefined, store.loadNight());
  engines.push(resumed);
  const after = resumed.snapshot().autoAdvanceAt;
  // The stale deadline must not survive, or the night jumps a step the instant
  // it comes back. But it must not simply be dropped either: that left the
  // game parked on a locked question waiting for a thumb after every restart,
  // which is what the clubhouse box actually did all day. Drop the old one,
  // queue a fresh one.
  assert.ok(after, 'a resumed night must queue its next step');
  assert.notEqual(after, before, 'the expired countdown must not be carried over');
  assert.ok(after! > Date.now() + 1000, 'the new countdown must be measured from now');
  assert.equal(resumed.snapshot().held, false);
  resumed.dispose();
});

/**
 * Three bugs found on real hardware after a day of deploys, all of them
 * invisible to every test above because the tests build a night and play it
 * inside one process. The box in the clubhouse does not work like that: it
 * gets restarted, and it keeps the night it was in the middle of.
 */

test('a night resumed after a restart keeps running itself', () => {
  const first = freshEngine({ secondsPerQuestion: 1, revealDelaySeconds: 1, nextQuestionDelaySeconds: 1 });
  seatTeams(first, 2);
  while (first.snapshot().phase !== 'question') first.advance();
  const onDisk = JSON.parse(JSON.stringify(first.snapshot()));

  const resumed = freshEngine(undefined, onDisk);
  // The question is parked locked, which is correct: its deadline expired
  // while the machine was off. What was missing is anything to carry on from
  // there, so the night sat waiting for the MC on every single restart.
  assert.equal(resumed.snapshot().phase, 'locked');
  assert.ok(resumed.snapshot().autoAdvanceAt, 'resumed night should have the next step queued');
});

test('a night resumed from an older build gains settings added since', () => {
  const engine = freshEngine();
  const onDisk = JSON.parse(JSON.stringify(engine.snapshot()));
  delete (onDisk.config as Record<string, unknown>).questionPoints;
  const resumed = freshEngine(undefined, onDisk);
  assert.equal(resumed.snapshot().config.questionPoints, DEFAULT_CONFIG.questionPoints);
});

test('resetting the night restores current defaults and keeps the venue name', () => {
  const engine = freshEngine({ venueName: 'Del Pueblo', secondsPerQuestion: 35, questionsPerRound: 8 });
  seatTeams(engine, 2);
  engine.resetNight();
  const config = engine.snapshot().config;
  // This is the one that stranded a real box: a reset used to carry the stale
  // config forward, so a machine running since before an update could never
  // pick up a new clock or round length by any route available to the MC.
  assert.equal(config.secondsPerQuestion, DEFAULT_CONFIG.secondsPerQuestion);
  assert.equal(config.questionsPerRound, DEFAULT_CONFIG.questionsPerRound);
  assert.equal(config.venueName, 'Del Pueblo');
  assert.equal(Object.keys(engine.snapshot().teams).length, 0);
});

test('the USB rescue address never becomes the advertised join address', () => {
  // 192.168.55.1 is the Jetson's USB gadget bridge. It sorts into the same
  // band as the wifi address, so a stable sort was deciding which one went on
  // the big screen, and half the time the room would scan an address only a
  // cable can reach.
  const ranked = rankLanAddresses(['192.168.55.1', '192.168.12.12']);
  assert.equal(ranked[0], '192.168.12.12');
  assert.equal(ranked[1], '192.168.55.1', 'it stays available as the rescue path');
  assert.equal(rankLanAddresses(['169.254.9.9', '10.0.0.4'])[0], '10.0.0.4');

  // A Windows workstation with virtualisation installed carries addresses that
  // look exactly as plausible as the one the room can reach. VirtualBox's
  // host-only network and Windows Mobile Hotspot both sit in 192.168, so
  // without a penalty the join QR is a coin flip.
  assert.equal(rankLanAddresses(['192.168.56.1', '192.168.1.40'])[0], '192.168.1.40');
  assert.equal(rankLanAddresses(['192.168.137.1', '192.168.1.40'])[0], '192.168.1.40');
  assert.equal(
    rankLanAddresses(['192.168.56.1', '172.28.80.1', '192.168.1.40'])[0],
    '192.168.1.40',
    'the venue router beats both a host-only network and a WSL bridge',
  );
  // WSL's NAT gateway sits in the 10.x band, which otherwise outranks the
  // 172.x the VM actually uses, so it led the list and the banner advertised
  // the one address in the room that could never work.
  assert.equal(rankLanAddresses(['10.255.255.254', '192.168.12.109'])[0], '192.168.12.109');
});

test('the venue wifi beats a container bridge sharing its address band', () => {
  // The clubhouse hands out 172.16.0.x. Docker's default bridge is 172.17.0.1
  // and its user networks run up through 172.31, so band alone scores all
  // three the same and the winner is whatever order the OS listed adapters in.
  const picked = rankLanCandidates([
    { address: '172.17.0.1', iface: 'docker0' },
    { address: '172.18.0.1', iface: 'br-07a2c8b518df' },
    { address: '172.16.0.42', iface: 'wlp0s20f3' },
  ]);
  assert.equal(picked[0]?.address, '172.16.0.42', 'the adapter the room is on wins');
  // The bridges stay in the list as a last resort, as the USB rescue link does.
  assert.equal(picked.length, 3);

  // And the penalty clears the whole address scale, so a virtual adapter in a
  // better-looking band cannot rank its way back to the front.
  assert.equal(
    rankLanCandidates([
      { address: '192.168.1.5', iface: 'docker0' },
      { address: '172.16.0.42', iface: 'wlp0s20f3' },
    ])[0]?.address,
    '172.16.0.42',
  );
});

test('virtual adapters are told apart by name, and a real bridge is not', () => {
  for (const name of ['docker0', 'br-07a2c8b518df', 'veth1a7768f', 'virbr0', 'vboxnet0', 'tun0', 'wg0']) {
    assert.equal(isVirtualInterface(name), true, `${name} is virtual`);
  }
  // br0 is how a genuinely bridged LAN is named, and eth0 is the venue wifi
  // inside WSL. Matching either would discard the only usable address.
  for (const name of ['br0', 'eth0', 'wlp0s20f3', 'en0', 'Wi-Fi']) {
    assert.equal(isVirtualInterface(name), false, `${name} is real`);
  }
});

test('a venue genuinely on 172.16 is never labelled unreachable', () => {
  // The trap: 172.16-31 is both WSL's NAT range and a range real routers use.
  // Labelling the clubhouse's own address as WSL NAT would send the operator
  // picking around the one address that works.
  const venue = { address: '172.16.0.42', iface: 'eth0' };
  assert.equal(candidateNote(venue, [venue]), '', 'no warning without the NAT gateway present');

  // With the gateway alongside it, it really is WSL's private network.
  const gateway = { address: '10.255.255.254', iface: 'eth0' };
  const note = candidateNote(venue, [venue, gateway]);
  if (isWsl()) {
    assert.match(note, /WSL/, 'flagged when the NAT gateway is there too');
  } else {
    assert.equal(note, '', 'off WSL there is nothing to warn about');
  }

  // The notes that do not depend on the platform.
  assert.match(
    candidateNote({ address: '172.17.0.1', iface: 'docker0' }, []),
    /virtual adapter/,
  );
  assert.match(
    candidateNote({ address: '169.254.3.9', iface: 'wlp0s20f3' }, []),
    /no DHCP reply/,
  );
  assert.match(
    candidateNote({ address: '192.168.55.1', iface: 'l4tbr0' }, []),
    /USB rescue link/,
  );
  assert.equal(candidateNote({ address: '192.168.12.109', iface: 'wlp0s20f3' }, []), '');
});

test('a server nothing can reach says so instead of printing a join URL', () => {
  // WSL in its default NAT mode: a gateway on the loopback and the VM's own
  // private adapter. Everything looks healthy and no phone can join.
  assert.equal(hasNoReachableAddress(['10.255.255.254', '172.28.80.1']), true);

  // Mirrored mode, which is the fix: the real address shows up.
  assert.equal(hasNoReachableAddress(['10.255.255.254', '192.168.12.109']), false);

  // And a venue genuinely running on 172.16-31 must not be told its own
  // network is unreachable. Without the gateway present this is a real LAN.
  assert.equal(hasNoReachableAddress(['172.20.4.8']), false);
});

test('a laptop that never got a DHCP lease is told so, not handed a join URL', () => {
  // The Netgear night: the adapter asked for a lease, got nothing, and the OS
  // invented a 169.254 address. It is real, it is the only one, and it routes
  // nowhere. Advertise it and twenty phones scan a QR code that times out.
  assert.equal(isLinkLocalAddress('169.254.183.44'), true);
  assert.equal(isLinkLocalAddress('169.253.1.1'), false);
  assert.equal(isLinkLocalAddress('192.168.1.50'), false);

  assert.equal(hasOnlyUnusableAddresses(['169.254.183.44']), true);
  assert.equal(hasOnlyUnusableAddresses(['169.254.183.44', '169.254.9.9']), true);

  // One real address alongside it is a working night, not a broken one.
  assert.equal(hasOnlyUnusableAddresses(['169.254.183.44', '192.168.1.50']), false);

  // No addresses at all is a different message, already handled upstream.
  assert.equal(hasOnlyUnusableAddresses([]), false);

  // WSL NAT counts as unusable too, so the check covers both shapes; which
  // message gets printed is decided at the call site, because the fixes differ.
  assert.equal(hasOnlyUnusableAddresses(['10.255.255.254', '172.28.80.1']), true);
});

// ------------------------------------------------- mixed rounds and rotation

test('a mixed round asks one question per category', () => {
  const engine = freshEngine({ roundsPerGame: 2, questionsPerRound: 10, roundCategoryMode: 'mixed' });
  seatTeams(engine, 2);
  engine.startGame();
  const s = engine.snapshot();
  for (const round of s.rounds) {
    assert.equal(round.questionIds.length, 10, 'a mixed round still fills its ten slots');
    assert.equal(round.categoryId, '', 'a mixed round claims no category of its own');
    const categories = round.questionIds.map((id) => engine.question(id)!.category);
    assert.equal(new Set(categories).size, 10, `a mixed round repeated a category: ${categories.join(', ')}`);
  }
  // Across the whole game, not just within a round.
  const all = s.rounds.flatMap((r) => r.questionIds);
  assert.equal(new Set(all).size, all.length, 'a game drew the same question twice');
});

test('one question per round is still available for a themed round', () => {
  const engine = freshEngine({ roundsPerGame: 2, questionsPerRound: 8, roundCategoryMode: 'single' });
  seatTeams(engine, 2);
  engine.startGame();
  for (const round of engine.snapshot().rounds) {
    assert.ok(round.categoryId, 'a single-category round names its category');
    for (const id of round.questionIds) {
      assert.equal(engine.question(id)!.category, round.categoryId);
    }
  }
});

test('a mixed round keeps the difficulty ramp', () => {
  const engine = freshEngine({ roundsPerGame: 1, questionsPerRound: 10, roundCategoryMode: 'mixed' });
  seatTeams(engine, 2);
  engine.startGame();
  const ids = engine.snapshot().rounds[0]!.questionIds;
  const got = ids.map((id) => engine.question(id)!.difficulty);
  const wanted = DEFAULT_CONFIG.difficultyMix.slice(0, 10);
  // Not an equality check: a category may hold nothing at the wanted level,
  // and the deck's order comes first. What must hold is that the round is not
  // flat and tracks the template's shape.
  const drift = got.reduce((sum, d, i) => sum + Math.abs(d - wanted[i]!), 0) / got.length;
  assert.ok(drift <= 1, `the ramp drifted by ${drift.toFixed(2)} per question: ${got.join(',')}`);
});

test('no question comes back until its category has been all the way through', () => {
  // One category, so the deck is small enough to exhaust inside a test.
  const small = [...bank.byCategory.entries()]
    .map(([id, qs]) => ({ id, n: qs.filter((q) => q.kind === 'choice').length }))
    .filter((c) => c.n >= 8)
    .sort((a, b) => a.n - b.n)[0]!;

  const engine = freshEngine({
    roundsPerGame: 1,
    questionsPerRound: 4,
    roundCategoryMode: 'single',
    categories: [small.id],
    finalWager: false,
  });
  seatTeams(engine, 1);

  const dealt: string[] = [];
  // Each night is a fresh night on the same box, which is what resets
  // askedQuestionIds and leaves the rotation as the only thing promising
  // anything. Deal the whole category and one question past it.
  const nights = Math.ceil(small.n / 4) + 1;
  for (let n = 0; n < nights; n++) {
    engine.resetNight();
    seatTeams(engine, 1);
    engine.startGame();
    dealt.push(...engine.snapshot().rounds[0]!.questionIds);
  }

  const firstPass = dealt.slice(0, small.n);
  assert.equal(
    new Set(firstPass).size,
    firstPass.length,
    'a question repeated before the category was exhausted',
  );
  assert.ok(dealt.length > small.n, 'the test needs to deal past the end of the deck');
});

test('the rotation survives a restart and a reset of the night', () => {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-rot-'));
  dirs.push(dir);
  const config = {
    roundsPerGame: 1,
    questionsPerRound: 5,
    roundCategoryMode: 'mixed' as const,
    finalWager: false,
  };

  const first = new Engine(bank, new Store(dir), config);
  engines.push(first);
  seatTeams(first, 1);
  first.startGame();
  const before = first.snapshot().rounds[0]!.questionIds;
  first.dispose();

  // A new process on the same box, with the night thrown away.
  const second = new Engine(bank, new Store(dir), config);
  engines.push(second);
  second.resetNight();
  seatTeams(second, 1);
  second.startGame();
  const after = second.snapshot().rounds[0]!.questionIds;

  const repeated = after.filter((id) => before.includes(id));
  assert.deepEqual(repeated, [], `the deck was re-dealt across a restart: ${repeated.join(', ')}`);
});

// ------------------------------------------------------- breaks and the night

test('the break between rounds goes on the clock', () => {
  const engine = freshEngine({
    roundsPerGame: 2,
    questionsPerRound: 1,
    roundBreakMinutes: 5,
    autoStartAfterBreak: false,
    finalWager: false,
  });
  seatTeams(engine, 1);
  engine.startGame();
  engine.advance(); // game_intro -> round_intro
  engine.advance(); // -> question
  engine.lockNow('host');
  engine.advance(); // locked -> reveal
  engine.advance(); // reveal -> round_scores

  const s = engine.snapshot();
  assert.equal(s.phase, 'round_scores');
  assert.ok(s.breakEndsAt, 'a break between rounds has an end time');
  const minutes = (s.breakEndsAt! - Date.now()) / 60_000;
  assert.ok(minutes > 4.5 && minutes <= 5, `expected about five minutes, got ${minutes.toFixed(2)}`);
  // Off, so nothing is armed to press the button at zero.
  assert.equal(s.autoAdvanceAt, undefined, 'a manual break must not schedule itself');
});

test('a break ends itself when the MC asks it to', () => {
  const engine = freshEngine({
    roundsPerGame: 2,
    questionsPerRound: 1,
    // Six seconds, so the test watches a real break expire rather than mocking
    // the clock. The MC can type any number of minutes; the engine takes it.
    roundBreakMinutes: 0.1,
    autoStartAfterBreak: true,
    introSeconds: 0,
    finalWager: false,
  });
  seatTeams(engine, 1);
  engine.startGame();
  engine.advance();
  engine.advance();
  engine.lockNow('host');
  engine.advance();
  engine.advance(); // -> round_scores

  const s = engine.snapshot();
  assert.equal(s.phase, 'round_scores');
  assert.ok(s.autoAdvanceAt, 'an automatic break arms the next round');
  const seconds = (s.autoAdvanceAt! - Date.now()) / 1000;
  assert.ok(seconds > 4 && seconds <= 6, `expected about six seconds, got ${seconds.toFixed(1)}`);
});

test('the last round of a game runs into the wager, with no break announced', () => {
  const engine = freshEngine({
    roundsPerGame: 1,
    questionsPerRound: 1,
    finalWager: true,
    autoStartAfterBreak: false,
  });
  seatTeams(engine, 1);
  engine.startGame();
  engine.advance();
  engine.advance();
  engine.lockNow('host');
  engine.advance();
  engine.advance(); // -> round_scores

  const s = engine.snapshot();
  assert.equal(s.phase, 'round_scores');
  assert.equal(
    s.breakEndsAt,
    undefined,
    'the scoreboard before the final question must not promise the room a break',
  );
});

test('the game break is the long one', () => {
  const engine = freshEngine({
    gamesPerNight: 2,
    roundsPerGame: 1,
    questionsPerRound: 1,
    gameBreakMinutes: 10,
    finalWager: false,
  });
  seatTeams(engine, 1);
  engine.startGame();
  engine.advance();
  engine.advance();
  engine.lockNow('host');
  engine.advance();
  engine.advance(); // -> round_scores (last round, no break)
  engine.advance(); // -> game_results

  const s = engine.snapshot();
  assert.equal(s.phase, 'game_results');
  const minutes = (s.breakEndsAt! - Date.now()) / 60_000;
  assert.ok(minutes > 9.5 && minutes <= 10, `expected about ten minutes, got ${minutes.toFixed(2)}`);
});

test('the night ends itself after the last scheduled game', () => {
  const engine = freshEngine({
    gamesPerNight: 2,
    roundsPerGame: 1,
    questionsPerRound: 1,
    finalWager: false,
  });
  seatTeams(engine, 1);

  const playAGame = () => {
    engine.advance(); // lobby/game_results -> game_intro (startGame)
    engine.advance(); // -> round_intro
    engine.advance(); // -> question
    engine.lockNow('host');
    engine.advance(); // -> reveal
    engine.advance(); // -> round_scores
    engine.advance(); // -> game_results
  };

  playAGame();
  assert.equal(engine.snapshot().gameIndex, 1);
  assert.equal(engine.snapshot().phase, 'game_results');

  playAGame();
  assert.equal(engine.snapshot().gameIndex, 2);
  assert.equal(engine.snapshot().phase, 'game_results');

  engine.advance();
  assert.equal(engine.snapshot().phase, 'night_over', 'two games were scheduled, so the night is over');
  // And it stays over.
  engine.advance();
  assert.equal(engine.snapshot().phase, 'night_over');
});

test('an intro card moves itself on', () => {
  const engine = freshEngine({ roundsPerGame: 1, questionsPerRound: 1, introSeconds: 7 });
  seatTeams(engine, 1);
  engine.startGame();
  const s = engine.snapshot();
  assert.equal(s.phase, 'game_intro');
  const seconds = (s.autoAdvanceAt! - Date.now()) / 1000;
  assert.ok(seconds > 6 && seconds <= 7, `expected about seven seconds, got ${seconds.toFixed(1)}`);
});

test('a night resumed mid-break keeps the time the break had left', () => {
  const engine = freshEngine({
    roundsPerGame: 2,
    questionsPerRound: 1,
    roundBreakMinutes: 5,
    finalWager: false,
  });
  seatTeams(engine, 1);
  engine.startGame();
  engine.advance();
  engine.advance();
  engine.lockNow('host');
  engine.advance();
  engine.advance(); // -> round_scores
  const parked = JSON.parse(JSON.stringify(engine.snapshot()));

  const resumed = freshEngine(undefined, parked);
  const s = resumed.snapshot();
  assert.equal(s.phase, 'round_scores');
  assert.equal(s.breakEndsAt, parked.breakEndsAt, 'the break keeps its absolute end time across a restart');
  assert.ok(s.autoAdvanceAt, 'and it picks the countdown back up');
});

test('a night written by a build that said Block still runs', () => {
  const engine = freshEngine({ roundsPerGame: 2, questionsPerRound: 2 });
  seatTeams(engine, 1);
  engine.startGame();
  const parked = JSON.parse(JSON.stringify(engine.snapshot())) as Record<string, unknown>;

  // What an older build wrote: the old phase name and the old config keys.
  parked.phase = 'block_intro';
  const config = parked.config as Record<string, unknown>;
  config.roundsPerBlock = 3;
  config.blockBreakMinutes = 12;
  delete config.roundsPerGame;
  delete config.gameBreakMinutes;

  const resumed = freshEngine(undefined, parked as never);
  const s = resumed.snapshot();
  assert.equal(s.phase, 'game_intro', 'the old phase name is translated, not left unhandled');
  assert.equal(s.config.roundsPerGame, 3, 'the old setting carries over to its new name');
  assert.equal(s.config.gameBreakMinutes, 12);
  assert.equal((s.config as unknown as Record<string, unknown>).roundsPerBlock, undefined);

  // And the one big button still does something.
  resumed.advance();
  assert.equal(resumed.snapshot().phase, 'round_intro');
});

test('switching a round to one category is refused while rounds are mixed', () => {
  const engine = freshEngine({ roundsPerGame: 2, questionsPerRound: 4, roundCategoryMode: 'mixed' });
  seatTeams(engine, 1);
  engine.startGame();
  assert.throws(() => engine.setRoundCategory(1, bank.categories[0]!.id), /mixed/i);
});

test('swapping a question in a mixed round finds one anywhere in the selection', () => {
  const engine = freshEngine({ roundsPerGame: 1, questionsPerRound: 4, roundCategoryMode: 'mixed' });
  seatTeams(engine, 1);
  engine.startGame();
  engine.advance();
  engine.advance(); // -> question
  const was = engine.snapshot().current!.questionId;
  engine.replaceQuestion();
  const now = engine.snapshot().current!.questionId;
  assert.notEqual(now, was, 'the question on screen must actually change');
  assert.equal(engine.snapshot().phase, 'question');
});


// ------------------------------------------------- age groups and the deck

/** Play `nights` separate nights for one age group on the same box. */
function playNights(store: Store, audience: string, nights: number, perRound = 8) {
  const drawn: string[] = [];
  for (let n = 0; n < nights; n++) {
    const engine = new Engine(bank, store, {
      audience,
      roundCategoryMode: 'mixed',
      questionsPerRound: perRound,
      roundsPerGame: 1,
      finalWager: false,
    });
    engines.push(engine);
    const device = engine.identify();
    engine.join(device.id, engine.snapshot().roomCode, 'Entry', 'solo');
    engine.startGame();
    drawn.push(...engine.snapshot().rounds[0]!.questionIds);
  }
  return drawn;
}

test('a kids night never repeats until the kids bank is spent, then starts over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-kids-'));
  dirs.push(dir);
  const store = new Store(dir);

  // 80 questions are written for 8-12; ten nights of eight uses every one.
  const first = playNights(store, '8-12', 10);
  assert.equal(first.length, 80, 'every kids night should fill its round');
  assert.equal(new Set(first).size, 80, 'a question came back before the bank was spent');

  // The eleventh night is the one that used to break. The deck was keyed on
  // the category alone, so it still held hundreds of 55-75 cards the filter
  // rejected: never empty, so never reshuffled, so the round came back with
  // nothing in it at all.
  const eleventh = playNights(store, '8-12', 1);
  assert.equal(eleventh.length, 8, 'the night after the bank is spent must still fill');
});

test('one age group does not spend another age group\'s questions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-groups-'));
  dirs.push(dir);
  const store = new Store(dir);

  const kids = new Set(playNights(store, '8-12', 5));
  const adults = new Set(playNights(store, '35-75', 5));

  const audienceOf = (id: string) => bank.questions.find((q) => q.id === id)?.audience;
  for (const id of kids) assert.equal(audienceOf(id), '8-12', `a kids night drew ${id}`);
  for (const id of adults) assert.equal(audienceOf(id), '35-75', `an adult night drew ${id}`);

  // And the adults' nights in between must not have dealt from the kids' deck.
  const kidsAgain = playNights(store, '8-12', 5);
  const overlap = kidsAgain.filter((id) => kids.has(id));
  assert.deepEqual(overlap, [], `another group's night spent the kids' deck: ${overlap.join(', ')}`);
});

test('the shared folder stays in play whichever age group is picked', () => {
  // The numeric tiebreakers are the reason that folder exists: a tie at the
  // top has to be breakable on a kids night too.
  const untagged = bank.questions.filter((q) => !q.audience);
  assert.ok(untagged.length > 0, 'something should be written for every group');
  assert.ok(
    untagged.every((q) => q.kind === 'number'),
    'only the tiebreakers are age-neutral today; anything else here deserves a second look',
  );

  for (const audience of ['8-12', '35-75']) {
    const dir = mkdtempSync(join(tmpdir(), 'primetime-tie-'));
    dirs.push(dir);
    const engine = new Engine(bank, new Store(dir), { audience, questionsPerRound: 2, roundsPerGame: 1 });
    engines.push(engine);
    const a = engine.identify();
    const b = engine.identify();
    engine.join(a.id, engine.snapshot().roomCode, 'Ann', 'solo');
    engine.join(b.id, engine.snapshot().roomCode, 'Bob', 'solo');
    engine.startGame();
    engine.startTiebreak();
    assert.equal(engine.snapshot().phase, 'tiebreak', `no tiebreaker available on a ${audience} night`);
  }
});

test('the folder a question file sits in names its age group', () => {
  const kidsGeography = bank.questions.filter((q) => q.category === 'geography' && q.audience === '8-12');
  const adultGeography = bank.questions.filter((q) => q.category === 'geography' && q.audience === '35-75');
  assert.ok(kidsGeography.length > 0, 'content/questions/8-12/geography.yaml should load as 8-12');
  assert.ok(adultGeography.length > 0, 'content/questions/55-75/geography.yaml should load as 55-75');
  assert.equal(
    bank.questions.filter((q) => q.category === 'geography' && q.audience === undefined).length,
    0,
    'no geography question should be untagged now that the folders carry the group',
  );
});

// ------------------------------------------------------ the betting window

/** Play to the point where betting opens. */
function toWagerBet(engine: Engine) {
  const teams = seatTeams(engine, 3);
  engine.startGame();
  engine.advance(); // game_intro -> round_intro
  let guard = 0;
  while (engine.snapshot().phase !== 'wager_bet' && guard++ < 200) {
    if (engine.snapshot().phase === 'question') engine.lockNow('host');
    else engine.advance();
  }
  assert.equal(engine.snapshot().phase, 'wager_bet', 'never reached the betting window');
  return teams;
}

test('the betting window runs on a clock and closes itself', async () => {
  const engine = freshEngine({
    roundsPerGame: 1,
    questionsPerRound: 1,
    finalWager: true,
    wagerSeconds: 1,
    introSeconds: 0,
  });
  toWagerBet(engine);

  const s = engine.snapshot();
  assert.ok(s.wagerEndsAt, 'betting should have an end time');
  assert.ok(s.autoAdvanceAt, 'and should be armed to close itself');
  const seconds = (s.wagerEndsAt! - Date.now()) / 1000;
  assert.ok(seconds > 0 && seconds <= 1, `expected about a second, got ${seconds.toFixed(2)}`);

  await wait(1400);
  assert.equal(
    engine.snapshot().phase,
    'wager_question',
    'the night used to stop dead here until the MC noticed',
  );
  assert.equal(engine.snapshot().wagerEndsAt, undefined, 'the clock is spent once betting closes');
});

test('a betting window of zero waits for the MC, as it always did', () => {
  const engine = freshEngine({ roundsPerGame: 1, questionsPerRound: 1, finalWager: true, wagerSeconds: 0 });
  toWagerBet(engine);
  const s = engine.snapshot();
  assert.equal(s.wagerEndsAt, undefined, 'no clock');
  assert.equal(s.autoAdvanceAt, undefined, 'and nothing armed to press the button');
});

test('a team that never bets neither wins nor loses', async () => {
  const engine = freshEngine({
    roundsPerGame: 1,
    questionsPerRound: 1,
    finalWager: true,
    wagerSeconds: 1,
    introSeconds: 0,
  });
  const teams = toWagerBet(engine);
  const before = teams.map((t) => engine.snapshot().teams[t.teamId]!.score);

  // One team bets, one bets nothing explicitly, one never touches it.
  engine.setWager(teams[0]!.players[0]!, 100);
  engine.setWager(teams[1]!.players[0]!, 0);

  await wait(1400);
  assert.equal(engine.snapshot().phase, 'wager_question');

  // Nobody answers. The clock closes the question.
  engine.lockNow('host');
  const after = teams.map((t) => engine.snapshot().teams[t.teamId]!.score);

  assert.equal(after[0], before[0]! - 100, 'a team that bet and did not answer loses the bet');
  assert.equal(after[1], before[1], 'a team that bet nothing loses nothing');
  assert.equal(after[2], before[2], 'a team that never bet at all loses nothing');
});

test('pausing the betting gives the time back', async () => {
  const engine = freshEngine({
    roundsPerGame: 1,
    questionsPerRound: 1,
    finalWager: true,
    wagerSeconds: 30,
    introSeconds: 0,
  });
  toWagerBet(engine);
  const closesAt = engine.snapshot().wagerEndsAt!;

  engine.setHeld(true);
  assert.equal(engine.snapshot().autoAdvanceAt, undefined, 'a paused window is not counting');
  await wait(600);
  engine.setHeld(false);

  const owed = engine.snapshot().wagerEndsAt! - closesAt;
  assert.ok(owed >= 500, `the pause should be handed back, got ${owed}ms`);
  assert.ok(engine.snapshot().autoAdvanceAt, 'and the clock picks back up');
  assert.equal(engine.snapshot().phase, 'wager_bet');
});

test('betting is refused once the window has closed', async () => {
  const engine = freshEngine({
    roundsPerGame: 1,
    questionsPerRound: 1,
    finalWager: true,
    wagerSeconds: 1,
    introSeconds: 0,
  });
  const teams = toWagerBet(engine);
  await wait(1400);
  assert.equal(engine.snapshot().phase, 'wager_question');

  engine.setWager(teams[0]!.players[0]!, 500);
  assert.equal(
    engine.snapshot().wagerBets?.[teams[0]!.teamId],
    undefined,
    'a bet placed after the window shut must not count',
  );
});

test('the MC and the big screen can see who has bet', () => {
  const engine = freshEngine({ roundsPerGame: 1, questionsPerRound: 1, finalWager: true, wagerSeconds: 30 });
  const teams = toWagerBet(engine);
  assert.equal(controlState(engine).answeredCount, 0, 'nobody has bet yet');

  engine.setWager(teams[0]!.players[0]!, 250);
  const view = controlState(engine);
  assert.equal(view.answeredCount, 1);
  assert.deepEqual(view.answeredTeamIds, [teams[0]!.teamId], 'the bet should show as being in');
});

test('a restart while paused does not hand back the time it was down', async () => {
  const engine = freshEngine({
    roundsPerGame: 1,
    questionsPerRound: 1,
    finalWager: true,
    wagerSeconds: 30,
    introSeconds: 0,
  });
  toWagerBet(engine);
  engine.setHeld(true);
  const parked = JSON.parse(JSON.stringify(engine.snapshot()));
  assert.ok(parked.heldAt, 'the pause mark is written to disk with everything else');

  // The box goes down while paused and comes back some time later.
  await wait(300);
  const resumed = freshEngine(undefined, parked);
  assert.equal(resumed.snapshot().heldAt, undefined, 'the stale pause mark is cleared on resume');
  const closesAt = resumed.snapshot().wagerEndsAt!;

  // The next pause and release should hand back only that pause.
  resumed.setHeld(true);
  await wait(200);
  resumed.setHeld(false);
  const owed = resumed.snapshot().wagerEndsAt! - closesAt;
  assert.ok(owed < 2000, `only the real pause should be refunded, got ${owed}ms`);
});

test('the final answer moves on by itself', async () => {
  // The last beat in the game that queued nothing. Betting closes itself and
  // the final question runs on its own clock, and then the night used to sit
  // on the final answer until the MC noticed — which, at the moment the game
  // is decided, is the worst place in the night to stop.
  const engine = freshEngine({
    roundsPerGame: 1,
    questionsPerRound: 1,
    finalWager: true,
    wagerSeconds: 1,
    secondsPerQuestion: 1,
    nextQuestionDelaySeconds: 1,
    introSeconds: 0,
  });
  toWagerBet(engine);
  await wait(1400);
  assert.equal(engine.snapshot().phase, 'wager_question', 'betting closed itself');

  // The question's own clock locks it, which lands on the reveal.
  await wait(2000);
  assert.equal(engine.snapshot().phase, 'wager_reveal', 'the final question locked itself');
  assert.ok(engine.snapshot().autoAdvanceAt, 'and the reveal queued its own next step');

  await wait(1400);
  assert.equal(engine.snapshot().phase, 'game_results', 'the game closed without a thumb');
});
