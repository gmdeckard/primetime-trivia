import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadBank } from './content.js';
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

function freshEngine(config?: ConstructorParameters<typeof Engine>[2]) {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-test-'));
  dirs.push(dir);
  const engine = new Engine(bank, new Store(dir), config);
  engines.push(engine);
  return engine;
}

after(() => {
  // Order matters: a still-armed question timer would fire into a deleted
  // directory and surface as an unhandled ENOENT long after the test passed.
  for (const engine of engines) engine.dispose();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Seat `count` teams of two and return their ids. */
function seatTeams(engine: Engine, count: number) {
  const teams: Array<{ teamId: string; players: string[] }> = [];
  for (let i = 0; i < count; i++) {
    const a = engine.identify();
    const b = engine.identify();
    engine.createTeam(a.id, `Team ${i + 1}`, `Player ${i + 1}A`);
    const teamId = engine.snapshot().players[a.id]!.teamId!;
    engine.joinTeam(b.id, teamId, `Player ${i + 1}B`);
    teams.push({ teamId, players: [a.id, b.id] });
  }
  return teams;
}

test('content bank loads with no errors', () => {
  assert.equal(bank.issues.filter((i) => i.severity === 'error').length, 0);
  assert.ok(bank.questions.length > 300, `expected a usable bank, got ${bank.questions.length}`);
});

test('a team is capped at the configured size', () => {
  const engine = freshEngine({ teamSize: 2 });
  const [team] = seatTeams(engine, 1);
  const third = engine.identify();
  assert.throws(() => engine.joinTeam(third.id, team!.teamId, 'Gatecrasher'), /full/i);
});

test('duplicate team names are refused', () => {
  const engine = freshEngine();
  const a = engine.identify();
  const b = engine.identify();
  engine.createTeam(a.id, 'The Snowbirds', 'Ann');
  assert.throws(() => engine.createTeam(b.id, 'the snowbirds', 'Bob'), /taken/i);
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

test('either partner can change the team answer until the lock', () => {
  const engine = freshEngine();
  const teams = seatTeams(engine, 2);
  engine.startBlock();
  engine.advance();
  engine.advance();

  const [first, second] = teams[0]!.players as [string, string];
  engine.answer(first, 0);
  engine.answer(second, 2);
  const view = playerState(engine, first);
  assert.equal(view.me.choiceIndex, 2, 'the later tap should win');
  assert.equal(view.me.chosenBy, 'Player 1B', 'and the team should see who changed it');
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
  assert.ok(first.snapshot().autoAdvanceAt, 'a step was queued before the restart');
  first.dispose();

  const resumed = new Engine(bank, store, undefined, store.loadNight());
  engines.push(resumed);
  assert.equal(resumed.snapshot().autoAdvanceAt, undefined, 'the stale countdown must be dropped');
  assert.equal(resumed.snapshot().held, false);
  resumed.dispose();
});
