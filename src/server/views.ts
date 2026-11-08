import {
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
  const cat = round.categoryId ? engine.getBank().categoryById.get(round.categoryId) : undefined;
  // A mixed round has no subject to name, so it gets one the screens can use
  // as a title instead of an empty line where the category used to be.
  const mixed = !round.categoryId;
  return {
    index: s.roundIndex + 1,
    ofTotal: s.rounds.length,
    categoryId: round.categoryId,
    categoryName: mixed ? 'Mixed bag' : cat?.name ?? round.categoryId,
    blurb: mixed ? 'A different category every question.' : cat?.blurb ?? '',
    mixed,
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
    points: s.config.questionPoints,
    position: current.position,
    ofTotal: current.ofTotal,
    categoryName: engine.getBank().categoryById.get(q.category)?.name ?? q.category,
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
      max: a.max,
      full: a.full,
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
  /**
   * Who is "in" on this beat.
   *
   * Normally that means who has locked an answer. While the betting window is
   * open there is no question to answer, and the thing the MC and the big
   * screen want to show is who has bet — so the same field carries the bets.
   * One concept, one field: the "12 of 20 in" line and the filled dots on the
   * big screen then work during betting without knowing anything new.
   */
  const answered =
    s.phase === 'wager_bet'
      ? Object.keys(s.wagerBets ?? {})
      : current
        ? Object.keys(current.answers)
        : [];

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
    // Withheld from a player who has no seat yet, because the code is what
    // buys the seat. Sending it to everyone who loads the page and then asking
    // them to type it back is a gate that opens itself. A seated player keeps
    // seeing it, so they can read it to the person next to them.
    roomCode: role === 'player' && !teamId ? '' : s.roomCode,
    venueName: s.config.venueName,
    config: s.config,
    teams: role === 'player' ? [] : teamViews(engine),
    entryCount: s.teamOrder.length,
    scoreboard: board,
    game: { index: s.gameIndex, ofTotal: Math.max(1, s.config.gamesPerNight) },
    round: roundView(engine),
    question: questionView(engine),
    // Withheld while paused: a countdown that keeps falling on twenty handsets
    // while the server's clock is stopped is worse than no countdown at all.
    deadline: current && !current.locked && !s.held ? current.deadline : undefined,
    startedAt: current && !current.locked && !s.held ? current.startedAt : undefined,
    autoAdvanceAt: s.autoAdvanceAt,
    moreInRound: engine.moreQuestionsInRound(),
    breakEndsAt: s.breakEndsAt,
    wagerEndsAt: s.wagerEndsAt,
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
  /** Second radio of the same access point, when it broadcasts under its own name. */
  ssidAlt?: string;
  /**
   * Shown in the clear on the big screen on purpose. It is a trivia night on a
   * router that carries nothing but this game, and a room of a hundred people
   * cannot be told a password one at a time.
   */
  wifiPassword?: string;
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

  const bank = engine.getBank();

  // One line of lookahead so the MC can introduce the next question verbally
  // instead of reading it cold off the screen.
  const round = s.rounds[s.roundIndex];
  let upNext: string | undefined;
  if (round) {
    const nextId = round.questionIds[round.cursor + (s.phase === 'reveal' || s.phase === 'locked' ? 1 : 0)];
    const next = nextId ? engine.question(nextId) : undefined;
    // The category leads, because in a mixed round it is the thing the MC says
    // out loud before reading the question.
    const nextCat = next ? bank.categoryById.get(next.category)?.name ?? next.category : '';
    upNext = next ? `${nextCat} · D${next.difficulty} · ${next.prompt}` : 'End of round';
  }

  const allowed = s.config.categories.length ? s.config.categories : bank.categories.map((c) => c.id);

  /** Everything a given age group could still be asked tonight. */
  const usableFor = (audience: string) =>
    bank.questions.filter((question) => {
      if (question.kind !== 'choice') return false;
      if (!allowed.includes(question.category)) return false;
      if (s.askedQuestionIds.includes(question.id)) return false;
      if (question.pack && !s.config.packs.includes(question.pack)) return false;
      if (audience && question.audience && question.audience !== audience) return false;
      return true;
    });

  const countFor = (id: string) => {
    const usable = usableFor(id);
    return {
      id,
      name: audienceName(id),
      available: usable.length,
      categories: new Set(usable.map((q) => q.category)).size,
    };
  };

  const availableInSelection = usableFor(s.config.audience).length;

  /**
   * The age groups the bank holds something for, plus the one that means no
   * filter at all. Counted against the night's current selection so the MC
   * sees what switching would actually give them, not what the folder holds
   * in principle.
   */
  const groupIds = new Set<string>();
  for (const question of bank.questions) if (question.audience) groupIds.add(question.audience);
  // Sorted by the age they start at, not as strings: a plain sort puts
  // "8-12" after "35-75", so the kids came last in a list of numbers that
  // otherwise climbs.
  const startsAt = (id: string) => Number(/^(\d+)/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const audiences = [...groupIds]
    .sort((a, b) => startsAt(a) - startsAt(b) || a.localeCompare(b))
    .map((id) => countFor(id))
    // Every group the bank holds questions for is offered, even one whose
    // count is currently zero. This used to drop a group with nothing left in
    // the selected packs, which was fine while the kids' bank carried no pack
    // and could not be switched off. Now that it can, dropping it made the
    // group disappear from the picker the moment its pack went off, and the
    // only switch that could bring it back was the one inside the group you
    // could no longer select. The count tells the MC it is empty; the list
    // keeps the way back.
    .concat(countFor(''));

  const warnings: string[] = [];
  const needed = s.config.roundsPerGame * s.config.questionsPerRound;
  // Every multiple-choice question belongs to a pack, so a group with all of
  // its packs switched off has nothing but the shared tiebreakers. That used
  // to be reachable in two taps and the only hint was the question count
  // dropping to fifteen.
  //
  // Asked against the whole bank rather than `availableInSelection`, which
  // also reaches zero when a long night has used everything up. That is a
  // different problem and telling the MC to switch a set on would not fix it.
  const anySet = bank.questions.some((q) =>
    q.kind === 'choice' &&
    (!q.pack || s.config.packs.includes(q.pack)) &&
    (!s.config.audience || !q.audience || q.audience === s.config.audience));
  if (!anySet) {
    warnings.push(
      `No question set is switched on for ${audienceName(s.config.audience)}, so a night has ` +
        `nothing to ask. Switch one on under Questions.`,
    );
  } else if (availableInSelection < needed) {
    warnings.push(`Only ${availableInSelection} unused questions in the selected categories — a full game needs ${needed}.`);
  }
  if (s.config.roundCategoryMode === 'mixed') {
    // A mixed round takes one question from each of `questionsPerRound`
    // different categories, so a night cut down to four categories cannot
    // make a round of ten distinct subjects. It still plays — it comes round
    // again and takes a second from each — but the MC should know why.
    //
    // Counted for the chosen age group, not for the bank. Counting the bank
    // meant a kids night, which has eight categories written for it, reported
    // the adults' twenty-four and never warned about anything.
    const usable = new Set(usableFor(s.config.audience).map((q) => q.category)).size;
    if (usable < s.config.questionsPerRound) {
      warnings.push(
        `${audienceName(s.config.audience)} has ${usable} categories in play, so a round of ` +
          `${s.config.questionsPerRound} will ask some of them twice.`,
      );
    }
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
      name: packName(question.pack),
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
    audiences,
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
      maxWager: team ? Math.max(team.score, s.config.questionPoints) : 0,
    },
  };
}

/**
 * An age group's id as something to put on a button.
 *
 * The ids are folder names, and a folder name is a range: `8-12`, `35-75`.
 * Anything that is not a range is shown as written, so a group called
 * `family` arrives as "Family" rather than being mangled into a number.
 */
export function audienceName(id: string): string {
  if (!id) return 'No filter';
  const range = /^(\d+)-(\d+)$/.exec(id);
  if (!range) return id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');
  const [, from, to] = range;
  // Anybody under about eighteen is a child, and "8 to 12" on its own reads
  // as a difficulty band rather than an age group on a screen full of other
  // numbers.
  return Number(to) <= 17 ? `Kids ${from} to ${to}` : `${from} to ${to}`;
}

/**
 * A pack id as something to put on a toggle.
 *
 * The ids are file-safe slugs and the screen was showing them raw, so the MC
 * read "adult1". The batches are numbered, so they get named as sets; anything
 * else is shown with its hyphens opened out.
 */
export function packName(id: string): string {
  const batch = /^(adult|kids)(\d+)$/.exec(id);
  if (batch) return `${batch[1] === 'kids' ? 'Kids' : 'Adult'} set ${batch[2]}`;
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');
}
