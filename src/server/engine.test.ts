import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DEFAULT_CONFIG } from '../../shared/protocol.js';
import { loadBank } from './content.js';
import { rankLanAddresses } from './lan.js';
import { Engine } from './engine.js';
import { Store } from './store.js';
import { controlState, playerState } from './views.js';

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
    engine.join(device.id, `Entry ${i + 1}`, i % 2 === 0 ? 'team' : 'solo');
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
  engine.join(a.id, 'Ace', 'solo');
  engine.join(b.id, 'Deuce', 'solo');
  const s = engine.snapshot();
  assert.equal(s.teamOrder.length, 2, 'each device gets its own row');
  assert.notEqual(s.players[a.id]!.teamId, s.players[b.id]!.teamId);
});

test('rejoining from the same device keeps the entry and its score', () => {
  const engine = freshEngine();
  const device = engine.identify();
  engine.join(device.id, 'Ace', 'solo');
  const teamId = engine.snapshot().players[device.id]!.teamId!;
  engine.adjustScore(teamId, 40);

  engine.join(device.id, 'Ace of Spades', 'team');
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
  engine.join(a.id, 'The Snowbirds', 'team');
  assert.throws(() => engine.join(b.id, 'the snowbirds', 'solo'), /already using/i);
});

test('the correct answer is not always in the same slot', () => {
  const engine = freshEngine();
  seatTeams(engine, 2);
  const positions = new Set<number>();
  for (let i = 0; i < 40; i++) {
    engine.startBlock();
    engine.advance(); // block_intro -> round_intro
    engine.advance(); // -> question
    const index = engine.correctDisplayIndex();
    assert.ok(index !== undefined && index >= 0 && index <= 3);
    positions.add(index);
  }
  // Authored answer-first, so without shuffling this would only ever be {0}.
  assert.ok(positions.size > 1, `answer always landed in slot(s) ${[...positions]}`);
});

test('a full block runs start to finish and produces a winner', () => {
  const engine = freshEngine({ roundsPerBlock: 2, questionsPerRound: 3, finalWager: true });
  const teams = seatTeams(engine, 3);

  engine.startBlock();
  assert.equal(engine.snapshot().phase, 'block_intro');

  let guard = 0;
  while (engine.snapshot().phase !== 'block_results' && guard++ < 200) {
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

  assert.ok(guard < 200, 'the block never reached block_results');
  const board = engine.scoreRows();
  assert.equal(board.length, 3);
  assert.equal(board[0]!.teamId, teams[0]!.teamId, 'the always-correct team should lead');
  assert.ok(board[0]!.score > board[1]!.score);
});

test('answering locks automatically once every team is in', () => {
  const engine = freshEngine({ questionsPerRound: 3 });
  const teams = seatTeams(engine, 2);
  engine.startBlock();
  engine.advance();
  engine.advance();
  assert.equal(engine.snapshot().phase, 'question');

  engine.answer(teams[0]!.players[0]!, 0);
  assert.equal(engine.snapshot().phase, 'question', 'should still be live with one team outstanding');
  engine.answer(teams[1]!.players[0]!, 1);
  assert.equal(engine.snapshot().phase, 'locked', 'should lock once everyone has answered');
});

test('an answer can be changed until the lock', () => {
  const engine = freshEngine();
  const teams = seatTeams(engine, 2);
  engine.startBlock();
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
  const engine = freshEngine({ roundsPerBlock: 1, questionsPerRound: 1, finalWager: true });
  const teams = seatTeams(engine, 2);
  engine.startBlock();
  engine.advance(); // round_intro
  engine.advance(); // question
  const correct = engine.correctDisplayIndex()!;
  for (const team of teams) engine.answer(team.players[0]!, correct);
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
  assert.equal(engine.snapshot().phase, 'wager_reveal');

  assert.equal(scoreOf(teams[0]!.teamId), beforeA + 15, 'a correct wager should be added');
  assert.equal(scoreOf(teams[1]!.teamId), beforeB - 15, 'a wrong wager should be subtracted');
});

test('clearing a wager is distinct from betting nothing', () => {
  const engine = freshEngine({ roundsPerBlock: 1, questionsPerRound: 1 });
  const teams = seatTeams(engine, 2);
  engine.startBlock();
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
  const engine = freshEngine({ roundsPerBlock: 3, questionsPerRound: 8 });
  seatTeams(engine, 2);
  for (let block = 0; block < 4; block++) {
    engine.startBlock();
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
  engine.startBlock();
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
  engine.startBlock();
  engine.advance();
  engine.advance();
  const view = controlState(engine);
  assert.ok(view.answerKey, 'the MC needs the answer while the question is live');
  assert.ok(view.answerKey!.text.length > 0);
  assert.equal(view.answerKey!.index, engine.correctDisplayIndex());
});

test('a tie at the top can be broken', () => {
  const engine = freshEngine({ roundsPerBlock: 1, questionsPerRound: 1, finalWager: false });
  const teams = seatTeams(engine, 2);
  engine.startBlock();
  engine.advance();
  engine.advance();
  const correct = engine.correctDisplayIndex()!;
  for (const team of teams) engine.answer(team.players[0]!, correct);
  engine.advance();
  engine.advance();
  engine.advance();
  assert.equal(engine.snapshot().phase, 'block_results');

  const rows = engine.scoreRows();
  // Both answered correctly; with the speed bonus they may differ by that much.
  if (rows[0]!.score === rows[1]!.score) {
    engine.startTiebreak();
    assert.equal(engine.snapshot().phase, 'tiebreak');
    engine.answerNumber(teams[0]!.players[0]!, 1);
    engine.answerNumber(teams[1]!.players[0]!, 999999);
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
  engine.startBlock();
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
  engine.startBlock();
  engine.setConfig({ questionsPerRound: 2, secondsPerQuestion: 20 });
  const config = engine.snapshot().config;
  assert.equal(config.questionsPerRound, 8, 'round shape must not change mid-block');
  assert.equal(config.secondsPerQuestion, 20, 'but pacing should still be adjustable');
});

test('starting a block with nobody seated is refused', () => {
  const engine = freshEngine();
  assert.throws(() => engine.startBlock(), /no teams/i);
});

// --------------------------------------------------------------- auto-advance

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seat teams and drive to the first live question. */
function toFirstQuestion(engine: Engine, teams = 2) {
  const seated = seatTeams(engine, teams);
  engine.startBlock();
  engine.advance(); // block_intro -> round_intro
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

  // Everyone answers, which locks the question immediately.
  for (const team of teams) engine.answer(team.players[0]!, 0);
  assert.equal(engine.snapshot().phase, 'locked');
  assert.ok(engine.snapshot().autoAdvanceAt, 'a reveal should be queued');

  await wait(900);
  assert.equal(engine.snapshot().phase, 'reveal', 'should have revealed by itself');
  assert.ok(engine.snapshot().autoAdvanceAt, 'the next question should be queued');

  await wait(900);
  assert.equal(engine.snapshot().phase, 'question', 'should have moved on by itself');
  assert.equal(engine.snapshot().current?.position, 2, 'and be on the second question');
});

test('auto-advance stops at the end of a round so the MC can talk', async () => {
  const engine = freshEngine({
    questionsPerRound: 1,
    autoAdvance: true,
    revealDelaySeconds: 0.6,
    nextQuestionDelaySeconds: 0.6,
  });
  const teams = toFirstQuestion(engine);
  for (const team of teams) engine.answer(team.players[0]!, 0);

  await wait(900);
  assert.equal(engine.snapshot().phase, 'reveal');
  assert.equal(
    engine.snapshot().autoAdvanceAt,
    undefined,
    'the last question of a round must not queue another step',
  );

  await wait(900);
  assert.equal(engine.snapshot().phase, 'reveal', 'should still be waiting on the MC');
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

  assert.equal(engine.snapshot().phase, 'locked');
  assert.equal(engine.snapshot().autoAdvanceAt, undefined);
  await wait(700);
  assert.equal(engine.snapshot().phase, 'locked', 'nothing should move without the MC');
});

test('a resumed night does not fire a countdown that expired while it slept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-auto-'));
  dirs.push(dir);
  const store = new Store(dir);
  const first = new Engine(bank, store, { questionsPerRound: 3, autoAdvance: true, revealDelaySeconds: 60 });
  engines.push(first);
  const teams = toFirstQuestion(first);
  for (const team of teams) first.answer(team.players[0]!, 0);
  const before = first.snapshot().autoAdvanceAt;
  assert.ok(before, 'a step was queued before the restart');
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
  delete (onDisk.config as Record<string, unknown>).speedBonusPoints;
  const resumed = freshEngine(undefined, onDisk);
  assert.equal(resumed.snapshot().config.speedBonusPoints, DEFAULT_CONFIG.speedBonusPoints);
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
});
