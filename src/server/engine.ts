import { randomUUID, randomInt } from 'node:crypto';
import {
  DEFAULT_CONFIG,
  POINTS_BY_DIFFICULTY,
  type Difficulty,
  type GameConfig,
  type Phase,
  type Question,
  type RoundFormat,
} from '../../shared/protocol.js';
import type { Bank } from './content.js';
import { choiceOrder, pickCategories, pickNumeric, pickRound, type SelectionContext } from './selector.js';
import { rankNumeric, scoreQuestion, scoreWager, type AnswerRecord, type Award } from './scoring.js';
import type { Store } from './store.js';

/**
 * The authoritative game state machine.
 *
 * Everything the clients see is derived from this object, and it is JSON
 * serialisable on purpose: the whole thing is written to disk after every
 * transition, so a laptop that sleeps mid-round comes back exactly where it
 * was. Clients hold no authoritative state at all — a tablet that misses
 * three messages is correct again the moment it reconnects.
 *
 * Time is the one thing clients compute locally. The server sets an absolute
 * `deadline` and each device animates its own countdown toward it, which
 * avoids streaming a tick to twenty tablets and keeps the bar smooth on a
 * flaky connection.
 */

export interface PlayerRec {
  id: string;
  name: string;
  token: string;
  teamId?: string;
  connected: boolean;
  lastSeen: number;
}

export interface TeamRec {
  id: string;
  name: string;
  tableNo?: number;
  score: number;
  createdAt: number;
}

export interface AnswerRec extends AnswerRecord {}

export interface CurrentQuestion {
  questionId: string;
  /** Display slot i shows the authored option at index order[i]. */
  order: number[];
  startedAt: number;
  deadline: number;
  locked: boolean;
  answers: Record<string, AnswerRec>;
  position: number;
  ofTotal: number;
  awards?: Award[];
  /** Extra seconds the host granted, for the control-view log. */
  extendedBy: number;
}

export interface RoundRec {
  categoryId: string;
  format: RoundFormat;
  questionIds: string[];
  cursor: number;
}

export interface NightState {
  nightId: string;
  roomCode: string;
  createdAt: string;
  config: GameConfig;
  phase: Phase;
  blockIndex: number;
  rounds: RoundRec[];
  roundIndex: number;
  current?: CurrentQuestion;
  wagerBets?: Record<string, number>;
  players: Record<string, PlayerRec>;
  teams: Record<string, TeamRec>;
  teamOrder: string[];
  askedQuestionIds: string[];
  /** Score snapshot from the last scoreboard shown, for the delta column. */
  prevScores: Record<string, number>;
  tiebreakTeamIds?: string[];
  message?: string;
}

const ROOM_WORDS = ['BLUE', 'GOLD', 'SAGE', 'MESA', 'PALM', 'RUBY', 'JADE', 'OPAL', 'CORAL', 'AMBER'];

function makeRoomCode(): string {
  const word = ROOM_WORDS[randomInt(ROOM_WORDS.length)]!;
  return `${word}-${randomInt(2, 10)}`;
}

/** Phases where a countdown is running and answers are being taken. */
const LIVE_PHASES: Phase[] = ['question', 'wager_question', 'tiebreak'];

export class Engine {
  private state: NightState;
  private timer: NodeJS.Timeout | undefined;
  private listeners = new Set<() => void>();

  constructor(
    private bank: Bank,
    private readonly store: Store,
    config?: Partial<GameConfig>,
    resume?: NightState | null,
  ) {
    if (resume && resume.nightId) {
      this.state = resume;
      // Nothing is mid-flight after a restart; park on the current question
      // rather than scoring answers against a deadline that passed while the
      // laptop was asleep.
      if (this.state.current && !this.state.current.locked && LIVE_PHASES.includes(this.state.phase)) {
        this.state.current.locked = true;
        this.state.phase = this.state.phase === 'question' ? 'locked' : this.state.phase;
        this.state.message = 'Resumed after a restart — answers for this question were locked.';
      }
      for (const p of Object.values(this.state.players)) p.connected = false;
    } else {
      this.state = this.freshNight(config);
    }
  }

  // ------------------------------------------------------------ lifecycle

  private freshNight(config?: Partial<GameConfig>): NightState {
    return {
      nightId: randomUUID(),
      roomCode: makeRoomCode(),
      createdAt: new Date().toISOString(),
      config: { ...DEFAULT_CONFIG, ...config },
      phase: 'lobby',
      blockIndex: 0,
      rounds: [],
      roundIndex: 0,
      players: {},
      teams: {},
      teamOrder: [],
      askedQuestionIds: [],
      prevScores: {},
    };
  }

  snapshot(): NightState {
    return this.state;
  }

  getBank(): Bank {
    return this.bank;
  }

  /**
   * Swap in a freshly loaded bank, e.g. after a pack is published.
   *
   * Refused mid-game: the current question, the round ahead and the asked list
   * all point into the old bank, and quietly replacing it under a live round is
   * a way to make a question vanish from the screen in front of the room.
   */
  replaceBank(bank: Bank): { ok: boolean; message: string } {
    if (this.state.phase !== 'lobby' && this.state.phase !== 'night_over') {
      return { ok: false, message: 'New questions are on disk; they will be available once this night ends.' };
    }
    this.bank = bank;
    this.commit({ kind: 'bank_reloaded', questions: bank.questions.length });
    return { ok: true, message: `Reloaded — ${bank.questions.length} questions now available.` };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Persist, log, and push a new snapshot to every connected client. */
  private commit(event?: Record<string, unknown>) {
    this.store.saveNight(this.state);
    this.store.recordNight({
      nightId: this.state.nightId,
      startedAt: this.state.createdAt,
      questionIds: this.state.askedQuestionIds,
    });
    if (event) this.store.logEvent({ nightId: this.state.nightId, phase: this.state.phase, ...event });
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------ players

  /** Reconnect by token if we recognise it, otherwise mint a new player. */
  identify(playerId?: string, token?: string): PlayerRec {
    if (playerId && token) {
      const existing = this.state.players[playerId];
      if (existing && existing.token === token) {
        existing.connected = true;
        existing.lastSeen = Date.now();
        return existing;
      }
    }
    const player: PlayerRec = {
      id: randomUUID(),
      name: '',
      token: randomUUID(),
      connected: true,
      lastSeen: Date.now(),
    };
    this.state.players[player.id] = player;
    return player;
  }

  setConnected(playerId: string, connected: boolean) {
    const p = this.state.players[playerId];
    if (!p) return;
    p.connected = connected;
    p.lastSeen = Date.now();
    this.commit();
  }

  private teamMembers(teamId: string): PlayerRec[] {
    return Object.values(this.state.players).filter((p) => p.teamId === teamId);
  }

  createTeam(playerId: string, name: string, playerName: string, tableNo?: number): void {
    const player = this.state.players[playerId];
    if (!player) throw new Error('unknown player');
    const clean = name.trim().slice(0, 28);
    if (!clean) throw new Error('Your team needs a name.');
    if (this.state.teamOrder.length >= 40) throw new Error('This night is full at 40 teams.');
    const taken = Object.values(this.state.teams).some((t) => t.name.toLowerCase() === clean.toLowerCase());
    if (taken) throw new Error('That team name is taken — try another.');

    const team: TeamRec = { id: randomUUID(), name: clean, tableNo, score: 0, createdAt: Date.now() };
    this.state.teams[team.id] = team;
    this.state.teamOrder.push(team.id);
    player.name = playerName.trim().slice(0, 24);
    player.teamId = team.id;
    this.commit({ kind: 'team_created', teamId: team.id, name: clean });
  }

  joinTeam(playerId: string, teamId: string, name: string): void {
    const player = this.state.players[playerId];
    const team = this.state.teams[teamId];
    if (!player) throw new Error('unknown player');
    if (!team) throw new Error('That team is no longer there.');
    if (this.teamMembers(teamId).length >= this.state.config.teamSize) {
      throw new Error(`${team.name} is full.`);
    }
    player.name = name.trim().slice(0, 24);
    player.teamId = teamId;
    this.commit({ kind: 'team_joined', teamId, playerId });
  }

  leaveTeam(playerId: string): void {
    const player = this.state.players[playerId];
    if (!player?.teamId) return;
    const teamId = player.teamId;
    player.teamId = undefined;
    // Drop an empty team only in the lobby; mid-game it keeps its score so a
    // player whose tablet died can rejoin and find the team still standing.
    if (this.state.phase === 'lobby' && this.teamMembers(teamId).length === 0) {
      delete this.state.teams[teamId];
      this.state.teamOrder = this.state.teamOrder.filter((id) => id !== teamId);
    }
    this.commit({ kind: 'team_left', teamId, playerId });
  }

  renameTeam(teamId: string, name: string) {
    const team = this.state.teams[teamId];
    if (!team) return;
    team.name = name.trim().slice(0, 28) || team.name;
    this.commit({ kind: 'team_renamed', teamId });
  }

  removeTeam(teamId: string) {
    delete this.state.teams[teamId];
    this.state.teamOrder = this.state.teamOrder.filter((id) => id !== teamId);
    for (const p of Object.values(this.state.players)) if (p.teamId === teamId) p.teamId = undefined;
    if (this.state.current) delete this.state.current.answers[teamId];
    this.commit({ kind: 'team_removed', teamId });
  }

  adjustScore(teamId: string, delta: number, note?: string) {
    const team = this.state.teams[teamId];
    if (!team) return;
    team.score += Math.round(delta);
    this.commit({ kind: 'score_adjusted', teamId, delta, note });
  }

  // ------------------------------------------------------------ config

  setConfig(patch: Partial<GameConfig>) {
    // Changing the shape of a block mid-block would leave rounds half-built,
    // so structural keys are lobby-only. Pacing keys stay live because an MC
    // reads the room and speeds up or slows down as they go.
    const structural: Array<keyof GameConfig> = ['roundsPerBlock', 'questionsPerRound', 'teamSize', 'difficultyMix', 'categories'];
    const next = { ...this.state.config };
    for (const [key, value] of Object.entries(patch) as Array<[keyof GameConfig, never]>) {
      if (this.state.phase !== 'lobby' && structural.includes(key)) continue;
      next[key] = value;
    }
    this.state.config = next;
    this.commit({ kind: 'config_changed', patch });
  }

  // ------------------------------------------------------------ selection

  private selectionContext(): SelectionContext {
    return {
      bank: this.bank,
      config: this.state.config,
      usedTonight: new Set(this.state.askedQuestionIds),
      usedRecently: this.store.recentlyUsed(this.state.config.avoidRecentNights, this.state.nightId),
    };
  }

  question(id: string): Question | undefined {
    return this.bank.questions.find((q) => q.id === id);
  }

  currentQuestion(): Question | undefined {
    return this.state.current ? this.question(this.state.current.questionId) : undefined;
  }

  /** Display index of the correct option, after shuffling. */
  correctDisplayIndex(): number | undefined {
    const q = this.currentQuestion();
    if (!q || !this.state.current || q.kind !== 'choice') return undefined;
    return this.state.current.order.indexOf(q.answerIndex ?? 0);
  }

  displayChoices(): string[] | undefined {
    const q = this.currentQuestion();
    if (!q?.choices || !this.state.current) return undefined;
    return this.state.current.order.map((i) => q.choices![i]!);
  }

  private buildBlock() {
    const ctx = this.selectionContext();
    const categoryIds = pickCategories(ctx, this.state.config.roundsPerBlock);
    this.state.rounds = categoryIds.map((categoryId) => {
      const questions = pickRound(ctx, categoryId, this.state.config.questionsPerRound);
      for (const q of questions) ctx.usedTonight.add(q.id);
      const hasImages = questions.some((q) => q.image);
      return {
        categoryId,
        format: hasImages ? 'picture' : 'standard',
        questionIds: questions.map((q) => q.id),
        cursor: 0,
      } satisfies RoundRec;
    });
    this.state.roundIndex = 0;
  }

  /** Swap a round's category before it starts, for an MC reading the room. */
  setRoundCategory(roundIndex: number, categoryId: string) {
    const round = this.state.rounds[roundIndex];
    if (!round || roundIndex < this.state.roundIndex) return;
    const ctx = this.selectionContext();
    const questions = pickRound(ctx, categoryId, this.state.config.questionsPerRound);
    if (!questions.length) throw new Error('No questions left in that category.');
    round.categoryId = categoryId;
    round.questionIds = questions.map((q) => q.id);
    round.format = questions.some((q) => q.image) ? 'picture' : 'standard';
    round.cursor = 0;
    this.commit({ kind: 'round_category_set', roundIndex, categoryId });
  }

  // ------------------------------------------------------------ timing

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private armTimer() {
    this.clearTimer();
    if (!this.state.current || this.state.current.locked) return;
    const ms = Math.max(0, this.state.current.deadline - Date.now());
    this.timer = setTimeout(() => this.lockNow('timer'), ms);
  }

  extendTimer(seconds: number) {
    const current = this.state.current;
    if (!current || current.locked) return;
    current.deadline += seconds * 1000;
    current.extendedBy += seconds;
    this.armTimer();
    this.commit({ kind: 'timer_extended', seconds });
  }

  // ------------------------------------------------------------ questions

  private startQuestion(questionId: string, seconds: number, position: number, ofTotal: number) {
    const now = Date.now();
    this.state.current = {
      questionId,
      order: choiceOrder(),
      startedAt: now,
      deadline: now + seconds * 1000,
      locked: false,
      answers: {},
      position,
      ofTotal,
      extendedBy: 0,
    };
    if (!this.state.askedQuestionIds.includes(questionId)) {
      this.state.askedQuestionIds.push(questionId);
    }
    this.armTimer();
  }

  private activeTeamIds(): string[] {
    if (this.state.phase === 'tiebreak' && this.state.tiebreakTeamIds) return this.state.tiebreakTeamIds;
    return this.state.teamOrder.filter((id) => this.state.teams[id]);
  }

  answer(playerId: string, choiceIndex: number) {
    const player = this.state.players[playerId];
    const current = this.state.current;
    if (!player?.teamId || !current || current.locked) return;
    if (this.state.phase !== 'question' && this.state.phase !== 'wager_question') return;
    if (choiceIndex < 0 || choiceIndex > 3) return;
    if (!this.activeTeamIds().includes(player.teamId)) return;

    // A team has one answer. Any member may change it until the lock, which is
    // what actually happens at a table: one person taps, their partner says
    // "no, it's the other one". The name of whoever last touched it is shown
    // back to the team so that conversation has a referent.
    current.answers[player.teamId] = {
      teamId: player.teamId,
      choiceIndex,
      elapsedMs: Date.now() - current.startedAt,
      byPlayerId: playerId,
    };
    this.maybeAutoLock();
    this.commit({ kind: 'answer', teamId: player.teamId, choiceIndex });
  }

  answerNumber(playerId: string, value: number) {
    const player = this.state.players[playerId];
    const current = this.state.current;
    if (!player?.teamId || !current || current.locked) return;
    if (this.state.phase !== 'tiebreak') return;
    if (!Number.isFinite(value)) return;
    if (!this.activeTeamIds().includes(player.teamId)) return;

    current.answers[player.teamId] = {
      teamId: player.teamId,
      numberAnswer: Math.round(value),
      elapsedMs: Date.now() - current.startedAt,
      byPlayerId: playerId,
    };
    this.maybeAutoLock();
    this.commit({ kind: 'answer_number', teamId: player.teamId, value });
  }

  setWager(playerId: string, amount: number) {
    const player = this.state.players[playerId];
    if (!player?.teamId || this.state.phase !== 'wager_bet') return;
    const team = this.state.teams[player.teamId];
    if (!team) return;
    this.state.wagerBets ??= {};
    // A negative amount means "let me rethink this", which clears the bet
    // rather than betting zero — those are different intentions.
    if (amount < 0) {
      delete this.state.wagerBets[player.teamId];
      this.commit({ kind: 'wager_cleared', teamId: player.teamId });
      return;
    }
    // A team with nothing on the board can still bet a floor amount, otherwise
    // the last-place table has no reason to still be sitting there.
    const ceiling = Math.max(team.score, POINTS_BY_DIFFICULTY[4]);
    this.state.wagerBets[player.teamId] = Math.max(0, Math.min(Math.round(amount), ceiling));
    this.commit({ kind: 'wager_set', teamId: player.teamId, amount });
  }

  /** Lock as soon as every team that could answer has. No point waiting. */
  private maybeAutoLock() {
    const current = this.state.current;
    if (!current || current.locked) return;
    const active = this.activeTeamIds();
    if (active.length === 0) return;
    if (active.every((id) => current.answers[id])) this.lockNow('all_answered');
  }

  lockNow(reason: 'timer' | 'all_answered' | 'host' = 'host') {
    const current = this.state.current;
    if (!current || current.locked) return;
    this.clearTimer();
    current.locked = true;

    const q = this.question(current.questionId);
    const answers = Object.values(current.answers);

    if (this.state.phase === 'question' && q) {
      current.awards = scoreQuestion(answers, this.correctDisplayIndex(), q.difficulty, this.state.config);
      for (const award of current.awards) {
        const team = this.state.teams[award.teamId];
        if (team) team.score += award.total;
      }
      this.state.phase = 'locked';
    } else if (this.state.phase === 'wager_question' && q) {
      const correctIndex = this.correctDisplayIndex();
      current.awards = answers.map((a) => {
        const correct = a.choiceIndex === correctIndex;
        const bet = this.state.wagerBets?.[a.teamId] ?? 0;
        const total = scoreWager(correct, bet);
        return { teamId: a.teamId, correct, base: total, bonus: 0, total, speedBonus: false };
      });
      // A team that never answered loses its wager — the bet was the commitment.
      for (const teamId of this.activeTeamIds()) {
        if (current.answers[teamId]) continue;
        const bet = this.state.wagerBets?.[teamId] ?? 0;
        if (bet) current.awards.push({ teamId, correct: false, base: -bet, bonus: 0, total: -bet, speedBonus: false });
      }
      for (const award of current.awards) {
        const team = this.state.teams[award.teamId];
        if (team) team.score += award.total;
      }
      this.state.phase = 'wager_reveal';
    } else if (this.state.phase === 'tiebreak' && q) {
      const order = rankNumeric(answers, q.answerNumber ?? 0);
      const winner = order[0];
      current.awards = this.activeTeamIds().map((teamId) => ({
        teamId,
        correct: teamId === winner,
        base: 0,
        bonus: 0,
        // One point is enough to break the tie without distorting the night.
        total: teamId === winner ? 1 : 0,
        speedBonus: false,
      }));
      for (const award of current.awards) {
        const team = this.state.teams[award.teamId];
        if (team) team.score += award.total;
      }
      this.state.phase = 'tiebreak_reveal';
    }

    this.commit({ kind: 'locked', reason, questionId: current.questionId });
  }

  /** Discard the current question without scoring — for a typo or a dud. */
  skipQuestion() {
    if (!this.state.current) return;
    this.clearTimer();
    const round = this.state.rounds[this.state.roundIndex];
    const skipped = this.state.current.questionId;
    this.state.current = undefined;
    if (round && this.state.phase !== 'wager_question' && this.state.phase !== 'tiebreak') {
      round.cursor += 1;
      this.state.phase = 'round_intro';
      this.advance();
    }
    this.store.logEvent({ nightId: this.state.nightId, kind: 'question_skipped', questionId: skipped });
  }

  /** Same slot, different question. Used when the room has clearly seen one before. */
  replaceQuestion() {
    const round = this.state.rounds[this.state.roundIndex];
    if (!round || !this.state.current) return;
    const ctx = this.selectionContext();
    const replacement = pickRound(ctx, round.categoryId, 1)[0];
    if (!replacement) throw new Error('No unused questions left in this category.');
    round.questionIds[round.cursor] = replacement.id;
    this.startQuestion(replacement.id, this.state.config.secondsPerQuestion, round.cursor + 1, round.questionIds.length);
    this.state.phase = 'question';
    this.commit({ kind: 'question_replaced', questionId: replacement.id });
  }

  // ------------------------------------------------------------ flow

  startBlock() {
    if (!this.state.teamOrder.length) throw new Error('No teams have joined yet.');
    this.state.blockIndex += 1;
    this.buildBlock();
    this.state.wagerBets = undefined;
    this.state.current = undefined;
    this.state.tiebreakTeamIds = undefined;
    this.state.phase = 'block_intro';
    this.commit({ kind: 'block_started', blockIndex: this.state.blockIndex });
  }

  /** The MC's one big button. Every phase knows what comes next. */
  advance() {
    const s = this.state;
    switch (s.phase) {
      case 'lobby':
        this.startBlock();
        return;

      case 'block_intro':
        s.prevScores = Object.fromEntries(s.teamOrder.map((id) => [id, s.teams[id]?.score ?? 0]));
        s.phase = 'round_intro';
        this.commit({ kind: 'advance' });
        return;

      case 'round_intro':
      case 'reveal': {
        const round = s.rounds[s.roundIndex];
        if (!round) return;
        if (s.phase === 'reveal') round.cursor += 1;
        const nextId = round.questionIds[round.cursor];
        if (!nextId) {
          s.current = undefined;
          s.phase = 'round_scores';
          this.commit({ kind: 'round_finished', roundIndex: s.roundIndex });
          return;
        }
        this.startQuestion(nextId, s.config.secondsPerQuestion, round.cursor + 1, round.questionIds.length);
        s.phase = 'question';
        this.commit({ kind: 'question_started', questionId: nextId });
        return;
      }

      case 'question':
        // Treat "next" during a live question as "answers in".
        this.lockNow('host');
        return;

      case 'locked':
        s.phase = 'reveal';
        this.commit({ kind: 'revealed' });
        return;

      case 'round_scores': {
        if (s.roundIndex + 1 < s.rounds.length) {
          s.roundIndex += 1;
          // Rebase the deltas so the next scoreboard reports that round alone.
          s.prevScores = Object.fromEntries(s.teamOrder.map((id) => [id, s.teams[id]?.score ?? 0]));
          s.phase = 'round_intro';
          this.commit({ kind: 'advance' });
          return;
        }
        if (s.config.finalWager) {
          s.wagerBets = {};
          s.phase = 'wager_bet';
          this.commit({ kind: 'wager_betting' });
          return;
        }
        s.phase = 'block_results';
        this.commit({ kind: 'block_finished' });
        return;
      }

      case 'wager_bet': {
        const ctx = this.selectionContext();
        const allowed = s.config.categories.length ? s.config.categories : this.bank.categories.map((c) => c.id);
        // The closing question should be a genuinely hard one from anywhere in
        // the selected categories, not another pull from the last round.
        const pool = this.bank.questions.filter(
          (q) => q.kind === 'choice' && allowed.includes(q.category) && !ctx.usedTonight.has(q.id) && q.difficulty >= 3,
        );
        const chosen = pool[randomInt(Math.max(1, pool.length))] ?? pickRound(ctx, allowed[0]!, 1)[0];
        if (!chosen) throw new Error('No question available for the final wager.');
        this.startQuestion(chosen.id, Math.round(s.config.secondsPerQuestion * 1.5), 1, 1);
        s.phase = 'wager_question';
        this.commit({ kind: 'wager_question', questionId: chosen.id });
        return;
      }

      case 'wager_question':
        this.lockNow('host');
        return;

      case 'wager_reveal':
        s.phase = 'block_results';
        this.commit({ kind: 'block_finished' });
        return;

      case 'tiebreak':
        this.lockNow('host');
        return;

      case 'tiebreak_reveal':
        s.tiebreakTeamIds = undefined;
        s.current = undefined;
        s.phase = 'block_results';
        this.commit({ kind: 'tiebreak_finished' });
        return;

      case 'block_results':
        // Another 30-minute block, same teams, scores carried.
        this.startBlock();
        return;

      case 'night_over':
        return;
    }
  }

  reveal() {
    if (this.state.phase === 'locked') this.advance();
  }

  /** Numeric sudden death between whoever is tied at the top. */
  startTiebreak() {
    const top = this.scoreRows();
    if (!top.length) return;
    const best = top[0]!.score;
    const tied = top.filter((r) => r.score === best).map((r) => r.teamId);
    if (tied.length < 2) throw new Error('Nothing to break — there is a clear winner.');
    const q = pickNumeric(this.selectionContext());
    if (!q) throw new Error('No numeric tiebreak questions left in the bank.');
    this.state.tiebreakTeamIds = tied;
    this.startQuestion(q.id, this.state.config.secondsPerQuestion, 1, 1);
    this.state.phase = 'tiebreak';
    this.commit({ kind: 'tiebreak_started', teams: tied });
  }

  endNight() {
    this.clearTimer();
    this.state.phase = 'night_over';
    this.state.current = undefined;
    this.commit({ kind: 'night_over' });
  }

  /** Fresh night, same server. Teams and scores are cleared. */
  resetNight() {
    this.clearTimer();
    const config = this.state.config;
    this.state = this.freshNight(config);
    this.store.clearNight();
    this.commit({ kind: 'night_reset' });
  }

  say(message: string) {
    this.state.message = message.trim().slice(0, 160) || undefined;
    this.commit({ kind: 'message', message });
  }

  // ------------------------------------------------------------ derived

  scoreRows() {
    const rows = this.state.teamOrder
      .map((id) => this.state.teams[id])
      .filter((t): t is TeamRec => !!t)
      .map((t) => ({
        teamId: t.id,
        name: t.name,
        score: t.score,
        delta: t.score - (this.state.prevScores[t.id] ?? t.score),
        rank: 0,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    let rank = 0;
    let lastScore: number | undefined;
    rows.forEach((row, i) => {
      if (row.score !== lastScore) {
        rank = i + 1;
        lastScore = row.score;
      }
      row.rank = rank;
    });
    return rows;
  }

  membersOf(teamId: string): string[] {
    return this.teamMembers(teamId)
      .map((p) => p.name || 'Guest')
      .sort();
  }

  difficultyOf(questionId: string): Difficulty {
    return this.question(questionId)?.difficulty ?? 2;
  }

  dispose() {
    this.clearTimer();
  }
}
