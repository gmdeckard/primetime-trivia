import {
  POINTS_BY_DIFFICULTY,
  PROTOCOL_VERSION,
  type BaseState,
  type ControlState,
  type HostState,
  type PlayerState,
  type QuestionView,
  type RevealView,
  type RoundView,
  type TeamView,
} from '../../shared/protocol.js';
import type { Engine } from './engine.js';

/**
 * Projections of the authoritative state, one per role.
 *
 * The important rule lives here: the player and host projections never carry
 * the answer key before the reveal. Filtering in the client would be a
 * five-second cheat for anyone who opens dev tools, and in a room full of
 * retired engineers somebody absolutely will.
 */

const REVEAL_PHASES = new Set(['reveal', 'wager_reveal', 'tiebreak_reveal']);

function teamViews(engine: Engine): TeamView[] {
  const s = engine.snapshot();
  return s.teamOrder
    .map((id) => s.teams[id])
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      tableNo: t.tableNo,
      score: t.score,
      connected: engine.isConnected(t.id),
    }));
}

/**
 * How much of the table a player's device receives.
 *
 * The host and the MC render every entry, so they get the lot. A player
 * renders the top of the table and their own position, so that is all they are
 * sent. At a hundred devices the difference is the whole bandwidth story: the
 * full state would be ~25 KB to every device on every transition, several
 * hundred times a night, over a clubhouse access point.
 */
const PLAYER_BOARD_ROWS = 12;

function roundView(engine: Engine): RoundView | undefined {
  const s = engine.snapshot();
  const round = s.rounds[s.roundIndex];
  if (!round) return undefined;
  const cat = engine.getBank().categoryById.get(round.categoryId);
  return {
    index: s.roundIndex + 1,
    ofTotal: s.rounds.length,
    categoryId: round.categoryId,
    categoryName: cat?.name ?? round.categoryId,
    blurb: cat?.blurb ?? '',
    format: round.format,
  };
}

function questionView(engine: Engine): QuestionView | undefined {
  const s = engine.snapshot();
  const current = s.current;
  const q = engine.currentQuestion();
  if (!current || !q) return undefined;
  return {
    prompt: q.prompt,
    choices: engine.displayChoices(),
    kind: q.kind,
    image: q.image,
    difficulty: q.difficulty,
    points: POINTS_BY_DIFFICULTY[q.difficulty],
    position: current.position,
    ofTotal: current.ofTotal,
  };
}

/**
 * The reveal, scoped to who is asking.
 *
 * `outcomes` has a row per entry, and a player's screen renders exactly one of
 * them: their own. Sending all hundred to all hundred devices was the single
 * largest payload in the game, and it grew quadratically with the room.
 */
function revealView(engine: Engine, onlyTeamId?: string): RevealView | undefined {
  const s = engine.snapshot();
  if (!REVEAL_PHASES.has(s.phase)) return undefined;
  const current = s.current;
  const q = engine.currentQuestion();
  if (!current || !q) return undefined;

  const correctIndex = engine.correctDisplayIndex();
  const choices = engine.displayChoices();
  const answerText =
    q.kind === 'number'
      ? String(q.answerNumber ?? '')
      : choices?.[correctIndex ?? 0] ?? '';

  const awards = current.awards ?? [];
  const outcomes = awards.map((a) => {
    const answer = current.answers[a.teamId];
    return {
      teamId: a.teamId,
      name: s.teams[a.teamId]?.name ?? 'Team',
      choiceIndex: answer?.choiceIndex,
      numberAnswer: answer?.numberAnswer,
      correct: a.correct,
      awarded: a.total,
      bonus: a.bonus,
      speedBonus: a.speedBonus,
    };
  });

  const answered = outcomes.length;
  const correctPct = answered
    ? Math.round((outcomes.filter((o) => o.correct).length / answered) * 100)
    : 0;

  return {
    answerIndex: q.kind === 'choice' ? correctIndex : undefined,
    answerNumber: q.answerNumber,
    answerText,
    funFact: q.funFact,
    // The percentage is computed from everyone first, then the list is cut.
    outcomes: onlyTeamId ? outcomes.filter((o) => o.teamId === onlyTeamId) : outcomes,
    correctPct,
  };
}

function baseState(engine: Engine, role: 'host' | 'control' | 'player', teamId?: string): BaseState {
  const s = engine.snapshot();
  const current = s.current;
  const everyone = engine.scoreRows();
  const answered = current ? Object.keys(current.answers) : [];

  let board = everyone;
  if (role === 'player') {
    board = everyone.slice(0, PLAYER_BOARD_ROWS);
    // Always include their own row, even when they are ninety-third.
    if (teamId && !board.some((r) => r.teamId === teamId)) {
      const mine = everyone.find((r) => r.teamId === teamId);
      if (mine) board = [...board, mine];
    }
  }

  return {
    protocol: PROTOCOL_VERSION,
    phase: s.phase,
    roomCode: s.roomCode,
    venueName: s.config.venueName,
    config: s.config,
    teams: role === 'player' ? [] : teamViews(engine),
    entryCount: s.teamOrder.length,
    scoreboard: board,
    block: { index: s.blockIndex, ofTotal: null },
    round: roundView(engine),
    question: questionView(engine),
    deadline: current && !current.locked ? current.deadline : undefined,
    autoAdvanceAt: s.autoAdvanceAt,
    held: !!s.held,
    answeredTeamIds: role === 'player' ? [] : answered,
    // Withheld from players on purpose. "80 of 100 have answered" is pressure
    // on whoever is still thinking, and this audience does not need a clock on
    // top of a clock. It also keeps a player's state unchanged while everyone
    // else answers, so their device receives nothing until something that
    // actually concerns them happens.
    answeredCount: role === 'player' ? 0 : answered.length,
    reveal: revealView(engine, role === 'player' ? (teamId ?? 'none') : undefined),
    message: s.message,
  };
}

export interface JoinInfo {
  url: string;
  ssid?: string;
  qrSvg: string;
}

export function hostState(engine: Engine, join: JoinInfo): HostState {
  return { ...baseState(engine, 'host'), role: 'host', join };
}

export function controlState(engine: Engine): ControlState {
  const s = engine.snapshot();
  const base = baseState(engine, 'control');
  const q = engine.currentQuestion();
  const choices = engine.displayChoices();
  const correctIndex = engine.correctDisplayIndex();

  const answerKey = q
    ? {
        index: correctIndex,
        number: q.answerNumber,
        text: q.kind === 'number' ? String(q.answerNumber ?? '') : choices?.[correctIndex ?? 0] ?? '',
        funFact: q.funFact,
      }
    : undefined;

  // One line of lookahead so the MC can introduce the next question verbally
  // instead of reading it cold off the screen.
  const round = s.rounds[s.roundIndex];
  let upNext: string | undefined;
  if (round) {
    const nextId = round.questionIds[round.cursor + (s.phase === 'reveal' || s.phase === 'locked' ? 1 : 0)];
    const next = nextId ? engine.question(nextId) : undefined;
    upNext = next ? `D${next.difficulty} · ${next.prompt}` : 'End of round';
  }

  const bank = engine.getBank();
  const allowed = s.config.categories.length ? s.config.categories : bank.categories.map((c) => c.id);
  const availableInSelection = bank.questions.filter((question) => {
    if (!allowed.includes(question.category)) return false;
    if (s.askedQuestionIds.includes(question.id)) return false;
    if (question.pack && !s.config.packs.includes(question.pack)) return false;
    if (s.config.audience && question.audience && question.audience !== s.config.audience) return false;
    return true;
  }).length;

  const warnings: string[] = [];
  const needed = s.config.roundsPerBlock * s.config.questionsPerRound;
  if (availableInSelection < needed) {
    warnings.push(`Only ${availableInSelection} unused questions in the selected categories — a full block needs ${needed}.`);
  }
  for (const issue of bank.issues.filter((i) => i.severity === 'error').slice(0, 3)) {
    warnings.push(`Content error in ${issue.file}: ${issue.message}`);
  }
  const unassigned = Object.values(s.players).filter((p) => p.connected && !p.teamId).length;
  if (unassigned && s.phase !== 'lobby') {
    warnings.push(`${unassigned} connected ${unassigned === 1 ? 'person has' : 'people have'} no team.`);
  }

  const packs = new Map<string, { id: string; name: string; audience: string; questionCount: number; origin: string }>();
  for (const question of bank.questions) {
    if (!question.pack) continue;
    const existing = packs.get(question.pack);
    if (existing) existing.questionCount += 1;
    else packs.set(question.pack, {
      id: question.pack,
      name: question.pack,
      audience: question.audience ?? 'any',
      questionCount: 1,
      origin: 'pack',
    });
  }

  return {
    ...base,
    role: 'control',
    answerKey,
    packs: [...packs.values()].sort((a, b) => a.name.localeCompare(b.name)),
    upNext,
    roster: s.teamOrder.map((teamId) => ({
      teamId,
      players: [{
        id: s.teams[teamId]?.ownerId ?? teamId,
        name: s.teams[teamId]?.name ?? 'Entry',
        connected: engine.isConnected(teamId),
      }],
    })),
    bank: {
      total: bank.questions.length,
      availableInSelection,
      usedTonight: s.askedQuestionIds.length,
    },
    warnings,
  };
}

export function playerState(engine: Engine, playerId: string): PlayerState {
  const s = engine.snapshot();
  const player = s.players[playerId];
  const teamId = player?.teamId;
  const base = baseState(engine, 'player', teamId);
  const team = teamId ? s.teams[teamId] : undefined;
  const answer = teamId && s.current ? s.current.answers[teamId] : undefined;
  const mine = teamId ? engine.scoreRows().find((r) => r.teamId === teamId) : undefined;

  return {
    ...base,
    role: 'player',
    me: {
      playerId,
      name: player?.name ?? '',
      kind: team?.kind,
      teamId,
      teamName: team?.name,
      rank: mine?.rank,
      score: mine?.score,
      choiceIndex: answer?.choiceIndex,
      numberAnswer: answer?.numberAnswer,
      wager: teamId ? s.wagerBets?.[teamId] : undefined,
      maxWager: team ? Math.max(team.score, POINTS_BY_DIFFICULTY[4]) : 0,
    },
  };
}
