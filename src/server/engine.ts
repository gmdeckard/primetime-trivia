import { randomUUID, randomInt } from 'node:crypto';
import {
  DEFAULT_CONFIG,
  type Difficulty,
  type EntryKind,
  type GameConfig,
  type Phase,
  type Question,
  type RoundFormat,
} from '../../shared/protocol.js';
import type { Bank } from './content.js';
import {
  choiceOrder,
  pickCategories,
  pickMixedRound,
  pickNumeric,
  pickRound,
  type SelectionContext,
} from './selector.js';
import { Rotation } from './rotation.js';
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
  kind: EntryKind;
  tableNo?: number;
  score: number;
  createdAt: number;
  /** The one device that owns this entry. */
  ownerId: string;
}

export interface AnswerRec extends AnswerRecord {}

export interface CurrentQuestion {
  questionId: string;
  /** Display slot i shows the authored option at index order[i]. */
  order: number[];
  startedAt: number;
  deadline: number;
  /** When the MC paused, if they did. The clock owes the room this back. */
  heldAt?: number;
  locked: boolean;
  answers: Record<string, AnswerRec>;
  position: number;
  ofTotal: number;
  awards?: Award[];
  /** Extra seconds the host granted, for the control-view log. */
  extendedBy: number;
}

export interface RoundRec {
  /** '' for a mixed round, where every question brings its own category. */
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
  gameIndex: number;
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
  /** Epoch ms the game will advance itself, when auto-advance is running. */
  autoAdvanceAt?: number;
  /** Epoch ms the break currently on screen runs out. */
  breakEndsAt?: number;
  /** Epoch ms the betting window closes, when one is running. */
  wagerEndsAt?: number;
  /**
   * When the MC paused something that is not a question — a break or the
   * betting window. The question clock keeps its own `heldAt` because it has
   * two ends to shift; these have one.
   */
  heldAt?: number;
  /** MC pressed Hold — auto-advance stays parked until they release it. */
  held?: boolean;
  message?: string;
}

const ROOM_WORDS = ['BLUE', 'GOLD', 'SAGE', 'MESA', 'PALM', 'RUBY', 'JADE', 'OPAL', 'CORAL', 'AMBER'];

function makeRoomCode(): string {
  const word = ROOM_WORDS[randomInt(ROOM_WORDS.length)]!;
  return `${word}-${randomInt(2, 10)}`;
}

/**
 * Fold a typed room code down to what it means.
 *
 * Someone reads "FALCON-7" off a screen thirty feet away and types "falcon 7",
 * "Falcon7" or "falcon_7". None of those is a wrong answer. The code exists to
 * prove you can see the big screen, not to test punctuation, so everything but
 * letters and digits comes out and the case goes with it.
 */
export function normalizeRoomCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Phases where a countdown is running and answers are being taken. */
const LIVE_PHASES: Phase[] = ['question', 'wager_question', 'tiebreak'];

/** The two phases that are a break: scoreboard up, clock running down. */
const BREAK_PHASES: Phase[] = ['round_scores', 'game_results'];

/**
 * Names this build has changed, and what they used to be called.
 *
 * A night is written to disk after every transition, so an update can land on
 * a box with a half-played night on it — and renaming Block to Game would have
 * resumed that night into a phase the state machine no longer has, where the
 * MC's one big button does nothing at all. Cheap to carry, so it is carried.
 */
const RENAMED_PHASES: Record<string, Phase> = {
  block_intro: 'game_intro',
  block_results: 'game_results',
};
const RENAMED_CONFIG: Record<string, keyof GameConfig> = {
  roundsPerBlock: 'roundsPerGame',
  blockBreakMinutes: 'gameBreakMinutes',
};

export class Engine {
  private state: NightState;
  /**
   * How many questions were in `askedQuestionIds` the last time history.json
   * was written. Starts at -1 so a resumed night records itself once.
   */
  private recordedQuestionCount = -1;
  private timer: NodeJS.Timeout | undefined;
  /** Drives auto-advance. Kept apart from `timer`, which is the answer clock. */
  private autoTimer: NodeJS.Timeout | undefined;
  private listeners = new Set<() => void>();
  /** The persistent question deck. Outlives the night and the process. */
  private rotation: Rotation;

  constructor(
    private bank: Bank,
    private readonly store: Store,
    config?: Partial<GameConfig>,
    resume?: NightState | null,
  ) {
    this.rotation = new Rotation(store);
    if (resume && resume.nightId) {
      this.state = resume;
      // A night written by an older build names things this one has renamed.
      // Translate before anything reads the phase, or the night resumes into a
      // state the machine has no case for.
      const renamedPhase = RENAMED_PHASES[this.state.phase as string];
      if (renamedPhase) this.state.phase = renamedPhase;
      const legacy = this.state.config as unknown as Record<string, unknown>;
      for (const [was, now] of Object.entries(RENAMED_CONFIG)) {
        if (legacy[was] !== undefined && legacy[now] === undefined) legacy[now] = legacy[was];
        delete legacy[was];
      }
      // Nothing is mid-flight after a restart; park on the current question
      // rather than scoring answers against a deadline that passed while the
      // laptop was asleep.
      if (this.state.current && !this.state.current.locked && LIVE_PHASES.includes(this.state.phase)) {
        this.state.current.locked = true;
        // Every live phase needs a phase it can advance OUT of. Parking a
        // wager or a tiebreak as locked while leaving its phase alone left
        // advance() calling lockNow(), which returns immediately on a locked
        // question without committing: the MC's one big button did nothing,
        // forever, and the night could only be abandoned.
        this.state.current.awards ??= [];
        if (this.state.phase === 'question') this.state.phase = 'locked';
        else if (this.state.phase === 'wager_question') this.state.phase = 'wager_reveal';
        else if (this.state.phase === 'tiebreak') this.state.phase = 'tiebreak_reveal';
        this.state.message =
          this.state.phase === 'wager_reveal'
            ? 'Resumed after a restart — the final wager was interrupted, so no bets were won or lost.'
            : 'Resumed after a restart — answers for this question were locked.';
      }
      this.state.autoAdvanceAt = undefined;
      // breakEndsAt is deliberately kept. It is an absolute time, so a break
      // interrupted by a restart resumes with the time it had left, and one
      // that ran out while the box was down is simply over. Clearing it would
      // either hand the room a second ten minutes or strand the night with a
      // clock that reads nothing.
      this.state.held = false;
      if (this.state.current) this.state.current.heldAt = undefined;
      // Both pause marks go with it. A box that went down while paused would
      // otherwise keep the moment it was paused at, and the next release —
      // possibly a day later — would hand the break or the betting window
      // back every second since.
      this.state.heldAt = undefined;
      for (const p of Object.values(this.state.players)) p.connected = false;
      // Settings added since this night started would otherwise be missing
      // outright. Existing values are left alone: changing the shape of a
      // block underneath a live round is the one thing worse than stale
      // pacing, which is why only absent keys are filled in here.
      this.state.config = { ...DEFAULT_CONFIG, ...this.state.config };
      // A night written before the bank became a pack has `packs: []` on disk,
      // and the merge above only fills keys that are absent — so it would come
      // back with every adult question filtered out and nothing to ask. If the
      // enabled packs cannot produce a single question, fall back to the
      // defaults rather than resume into an empty bank.
      //
      // Counted for the night's own age group, not for the bank. Counting the
      // bank was enough while the kids' questions carried no pack and so
      // survived any pack selection; now that they are `kids1`, a kids night
      // saved with `packs: ['adult1']` passes a bank-wide check on the adult
      // questions it can never ask and resumes with nothing.
      const { packs, audience } = this.state.config;
      const askable = this.bank.questions.some((q) =>
        q.kind === 'choice' &&
        (!q.pack || packs.includes(q.pack)) &&
        (!audience || !q.audience || q.audience === audience));
      if (!askable) {
        this.state.config.packs = [...DEFAULT_CONFIG.packs];
      }
      // Parking the question above is right, but nothing was left to restart
      // the clock, so the night stopped dead and waited for a thumb. Pick the
      // countdown back up exactly as releasing a hold does.
      this.resumeAutoAdvance();
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
      gameIndex: 0,
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
    // No-op unless a card was dealt since the last write.
    this.rotation.save();
    // history.json only ever changes when a question starts, but this ran a
    // read-parse-rewrite of it on every answer. That did not matter while a
    // question ended on the last tap; now the window stays open for its whole
    // length and invites changes of mind, so it is one write per tap per team.
    if (this.state.askedQuestionIds.length !== this.recordedQuestionCount) {
      this.recordedQuestionCount = this.state.askedQuestionIds.length;
      this.store.recordNight({
        nightId: this.state.nightId,
        startedAt: this.state.createdAt,
        questionIds: this.state.askedQuestionIds,
      });
    }
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

  /**
   * Whether this id still names a player on the night currently in progress.
   *
   * False is the interesting answer, and it means exactly one thing: the night
   * was reset under a device that is still connected. `resetNight()` builds a
   * whole new state, players and all, so every socket open at that moment is
   * holding an id for a player who no longer exists.
   */
  hasPlayer(playerId: string | undefined): boolean {
    return !!playerId && !!this.state.players[playerId];
  }

  /**
   * Whether what somebody typed is tonight's room code.
   *
   * The one place that comparison is made. `join()` asks it of a device taking
   * a seat and the socket handler asks it of a device that only wants to
   * watch; both mean "this person can read the big screen", so both have to
   * fold case, spaces and punctuation the same way or the same typing would
   * pass one door and fail the other.
   */
  roomCodeMatches(typed: string | undefined): boolean {
    const given = normalizeRoomCode(typed ?? '');
    return !!given && given === normalizeRoomCode(this.state.roomCode);
  }

  setConnected(playerId: string, connected: boolean) {
    const p = this.state.players[playerId];
    if (!p) return;
    p.connected = connected;
    p.lastSeen = Date.now();
    this.commit();
  }

  /**
   * Take a seat, if you can name the room. One device, one entry — no joining
   * someone else's.
   *
   * At a hundred people, picking your partner out of a list is slower and more
   * error-prone than just typing a handle, and a full lobby list is a payload
   * every device has to receive and render for no reason.
   */
  join(playerId: string, roomCode: string, name: string, kind: EntryKind, tableNo?: number): void {
    const player = this.state.players[playerId];
    if (!player) throw new Error('unknown player');

    // The gate. Reaching the server no longer means being in the room: it
    // answers on a public hostname, so a seat goes only to a device that can
    // read the code off the big screen. A device that already holds a seat is
    // already past the gate, and this method is also the rename path — asking
    // for the code again to change a name would be a gate on the wrong thing.
    if (!player.teamId) {
      if (!normalizeRoomCode(roomCode)) throw new Error('Enter the room code from the big screen.');
      if (!this.roomCodeMatches(roomCode)) {
        throw new Error('That room code is not right — it is on the big screen.');
      }
    }

    const clean = name.trim().slice(0, 28);
    if (!clean) throw new Error('Pick a name to play under.');
    if (this.state.teamOrder.length >= 200) throw new Error('This night is full.');

    const taken = Object.values(this.state.teams).some(
      (t) => t.id !== player.teamId && t.name.toLowerCase() === clean.toLowerCase(),
    );
    if (taken) throw new Error('Someone is already using that name — pick another.');

    // Rejoining after a reload keeps the same entry and its score.
    const existing = player.teamId ? this.state.teams[player.teamId] : undefined;
    if (existing) {
      existing.name = clean;
      existing.kind = kind;
      if (tableNo !== undefined) existing.tableNo = tableNo;
      player.name = clean;
      this.commit({ kind: 'entry_renamed', teamId: existing.id });
      return;
    }

    const team: TeamRec = {
      id: randomUUID(),
      name: clean,
      kind,
      tableNo,
      score: 0,
      createdAt: Date.now(),
      ownerId: playerId,
    };
    this.state.teams[team.id] = team;
    this.state.teamOrder.push(team.id);
    player.name = clean;
    player.teamId = team.id;
    this.commit({ kind: 'joined', teamId: team.id, entryKind: kind });
  }

  leave(playerId: string): void {
    const player = this.state.players[playerId];
    if (!player?.teamId) return;
    const teamId = player.teamId;
    player.teamId = undefined;
    // In the lobby a withdrawal is clean. Once play has started the entry keeps
    // its score, so a reconnecting device lands back on its own row.
    if (this.state.phase === 'lobby') {
      delete this.state.teams[teamId];
      this.state.teamOrder = this.state.teamOrder.filter((id) => id !== teamId);
    }
    this.commit({ kind: 'left', teamId });
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
    const structural: Array<keyof GameConfig> = [
      'roundsPerGame',
      'questionsPerRound',
      'difficultyMix',
      'categories',
      // Changing this mid-game would leave the rounds already built one way
      // and the rounds after them the other, and the round intro card would
      // promise a category the questions do not come from.
      'roundCategoryMode',
    ];
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
      // Empty, and the rotation is why. "Don't reuse anything from the last
      // eight nights" was the old promise; the deck's is "nothing comes back
      // until everything has been asked", which contains it. Two overlapping
      // rules would only ever disagree in the direction of blocking a
      // question the deck says is due.
      usedRecently: new Set(),
      rotation: this.rotation,
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

  private buildGame() {
    const ctx = this.selectionContext();
    const mixed = this.state.config.roundCategoryMode === 'mixed';

    if (mixed) {
      // No category draw at this level: every round is one question from each
      // of ten shuffled categories, so the round's identity is the ramp
      // through it rather than its subject.
      this.state.rounds = Array.from({ length: this.state.config.roundsPerGame }, () => {
        const questions = pickMixedRound(ctx, this.state.config.questionsPerRound);
        return {
          categoryId: '',
          format: questions.some((q) => q.image) ? 'picture' : 'standard',
          questionIds: questions.map((q) => q.id),
          cursor: 0,
        } satisfies RoundRec;
      });
    } else {
      const categoryIds = pickCategories(ctx, this.state.config.roundsPerGame);
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
    }
    this.state.roundIndex = 0;
    // The decks were dealt from while building this game; write them now so a
    // crash between here and the first question cannot deal them twice.
    this.rotation.save();
  }

  /** Swap a round's category before it starts, for an MC reading the room. */
  setRoundCategory(roundIndex: number, categoryId: string) {
    const round = this.state.rounds[roundIndex];
    if (!round || roundIndex < this.state.roundIndex) return;
    if (this.state.config.roundCategoryMode === 'mixed') {
      throw new Error('Rounds are mixed-category tonight. Switch to one category per round first.');
    }
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

  private clearAutoTimer() {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
    this.state.autoAdvanceAt = undefined;
  }

  /**
   * Put a break on the clock.
   *
   * The minutes were always on screen; what was missing is that they counted
   * for anything. A break that says five minutes and then waits indefinitely
   * for the MC is how a night loses twenty minutes between rounds, and the
   * room has no way to tell a long break from a broken game.
   *
   * The clock is set whether or not it ends the break itself, because the
   * question it answers — how long have we got — is the same either way.
   * `autoStartAfterBreak` only decides whether reaching zero presses the
   * button.
   */
  private beginBreak(minutes: number) {
    this.clearAutoTimer();
    const ms = Math.max(0, Math.round(minutes * 60_000));
    this.state.breakEndsAt = Date.now() + ms;
    if (this.state.config.autoStartAfterBreak && !this.state.held) this.scheduleAuto(ms / 1000);
  }

  /**
   * Put the betting window on a clock.
   *
   * Zero seconds means the MC closes it by hand, which is what this phase
   * always did. The clock is shown either way, because "how long have I got
   * to decide" is the question a table is actually asking.
   */
  private openWagerWindow() {
    this.clearAutoTimer();
    const seconds = Math.max(0, this.state.config.wagerSeconds);
    if (!seconds) {
      this.state.wagerEndsAt = undefined;
      return;
    }
    this.state.wagerEndsAt = Date.now() + seconds * 1000;
    if (!this.state.held) this.scheduleAuto(seconds);
  }

  /** Minutes due at the break the night is currently sitting on. */
  breakMinutes(): number {
    return this.state.phase === 'game_results'
      ? this.state.config.gameBreakMinutes
      : this.state.config.roundBreakMinutes;
  }

  /**
   * Queue the next automatic step.
   *
   * Only ever called for the two beats inside a round: answers locking, and the
   * answer being up. Everything else — starting a block, moving between rounds,
   * the wager, a tiebreak — stays on the MC's thumb, because those are the
   * moments they want to talk over.
   */
  private scheduleAuto(seconds: number) {
    this.clearAutoTimer();
    // Breaks and intros have their own switches. `autoAdvance` is about the
    // inside of a round — the lock, the reveal, the next question — and an MC
    // who taps through questions on purpose still wants the break to end by
    // itself.
    const insideARound = this.state.phase === 'locked' || this.state.phase === 'reveal';
    if (insideARound && !this.state.config.autoAdvance) return;
    if (this.state.held) return;
    const ms = Math.max(500, Math.round(seconds * 1000));
    this.state.autoAdvanceAt = Date.now() + ms;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = undefined;
      this.state.autoAdvanceAt = undefined;
      this.advance();
    }, ms);
  }

  /** True when advancing from the reveal leads to another question, not a scoreboard. */
  moreQuestionsInRound(): boolean {
    const round = this.state.rounds[this.state.roundIndex];
    return !!round && !!round.questionIds[round.cursor + 1];
  }

  /**
   * Pick the countdown back up from whatever beat we are sitting on.
   *
   * Used when releasing a hold and when resuming a night after a restart.
   * Both land mid-round with a phase that has a next step and no timer behind
   * it, and without this the game simply stops until someone presses a button.
   */
  private resumeAutoAdvance() {
    const s = this.state;
    if (s.phase === 'locked') this.scheduleAuto(s.config.revealDelaySeconds);
    else if (s.phase === 'reveal' || s.phase === 'wager_reveal') {
      this.scheduleAuto(s.config.nextQuestionDelaySeconds);
    }
    else if (s.phase === 'game_intro' || s.phase === 'round_intro') {
      this.scheduleAuto(s.config.introSeconds);
    } else if (s.phase === 'wager_bet' && s.wagerEndsAt) {
      // Whatever is left of the betting window, floored at a beat so a window
      // that expired while the box was down does not close in the same tick
      // as the reconnect, with a table halfway through deciding.
      this.scheduleAuto(Math.max(2000, s.wagerEndsAt - Date.now()) / 1000);
    } else if (BREAK_PHASES.includes(s.phase) && s.config.autoStartAfterBreak) {
      // Whatever is left of the break, floored at a beat so a break that
      // expired while the box was down does not fire inside the same tick as
      // the reconnect, with the screens still showing the last question.
      const left = s.breakEndsAt ? s.breakEndsAt - Date.now() : 0;
      this.scheduleAuto(Math.max(2000, left) / 1000);
    }
  }

  /**
   * Pause the round, or start it again.
   *
   * This used to stop only the gap between questions, which meant pausing with
   * a question on screen did nothing the room could see: the clock kept
   * running and the answer kept getting cheaper while the MC dealt with
   * whatever had interrupted them. It now freezes the question too, and gives
   * the time back on resume by shifting the whole window forward — both ends,
   * so the window keeps its width and an answer already in keeps the elapsed
   * time it earned.
   */
  setHeld(held: boolean) {
    const current = this.state.current;
    this.state.held = held;
    if (held) {
      this.clearAutoTimer();
      if (current && !current.locked) {
        current.heldAt = Date.now();
        this.clearTimer();
      }
      // The break and the betting window have one end to shift rather than
      // two, so they share a single mark. Without it a pause during betting
      // would eat the window: the deadline is absolute and would go on
      // passing while the room waited for the MC to finish talking.
      if (this.state.breakEndsAt || this.state.wagerEndsAt) this.state.heldAt = Date.now();
      this.commit({ kind: 'held' });
      return;
    }
    if (current && current.heldAt) {
      const owed = Date.now() - current.heldAt;
      current.startedAt += owed;
      current.deadline += owed;
      current.heldAt = undefined;
      this.armTimer();
    }
    if (this.state.heldAt) {
      const owed = Date.now() - this.state.heldAt;
      if (this.state.breakEndsAt) this.state.breakEndsAt += owed;
      if (this.state.wagerEndsAt) this.state.wagerEndsAt += owed;
      this.state.heldAt = undefined;
    }
    this.resumeAutoAdvance();
    this.commit({ kind: 'released' });
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
    // Any banner on the screens belongs to the question that has just ended.
    // "Answers for this question were locked" is false the moment a new one is
    // up, and nothing cleared it: it sat on the big screen and on every handset
    // until the MC found the Clear button. A break announcement has the same
    // life — it is for the break, and the next question ends the break.
    this.state.message = undefined;
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
    if (!player?.teamId || !current || current.locked || this.state.held) return;
    if (this.state.phase !== 'question' && this.state.phase !== 'wager_question') return;
    if (choiceIndex < 0 || choiceIndex > 3) return;
    if (!this.activeTeamIds().includes(player.teamId)) return;

    // A team has one answer. Any member may change it until the lock, which is
    // what actually happens at a table: one person taps, their partner says
    // "no, it's the other one". The name of whoever last touched it is shown
    // back to the team so that conversation has a referent.
    // Keep the moment the team first landed on THIS choice. The window now
    // stays open for its whole length and the handset invites a re-tap, so a
    // nervous second tap on the same letter must not cost the speed band.
    // Changing to a different letter is a real decision and is timed afresh.
    const held = current.answers[player.teamId];
    current.answers[player.teamId] = {
      teamId: player.teamId,
      choiceIndex,
      elapsedMs: held?.choiceIndex === choiceIndex ? held.elapsedMs : Date.now() - current.startedAt,
      byPlayerId: playerId,
    };
    // Deliberately no early lock here. The window always runs to its deadline,
    // even when every team is already in, so the beat between questions is the
    // same length for everyone in the room: a table that answers in three
    // seconds does not yank the reveal onto a table still reading the prompt,
    // and the speed bands are still paid from `elapsedMs`. The MC's Lock now
    // is the escape hatch when the room is visibly done.
    this.commit({ kind: 'answer', teamId: player.teamId, choiceIndex });
  }

  answerNumber(playerId: string, value: number) {
    const player = this.state.players[playerId];
    const current = this.state.current;
    if (!player?.teamId || !current || current.locked || this.state.held) return;
    if (this.state.phase !== 'tiebreak') return;
    if (!Number.isFinite(value)) return;
    if (!this.activeTeamIds().includes(player.teamId)) return;

    const rounded = Math.round(value);
    const heldNumber = current.answers[player.teamId];
    current.answers[player.teamId] = {
      teamId: player.teamId,
      numberAnswer: rounded,
      elapsedMs: heldNumber?.numberAnswer === rounded ? heldNumber.elapsedMs : Date.now() - current.startedAt,
      byPlayerId: playerId,
    };
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
    const ceiling = Math.max(team.score, this.state.config.questionPoints);
    this.state.wagerBets[player.teamId] = Math.max(0, Math.min(Math.round(amount), ceiling));
    this.commit({ kind: 'wager_set', teamId: player.teamId, amount });
  }

  lockNow(reason: 'timer' | 'host' = 'host') {
    const current = this.state.current;
    if (!current || current.locked) return;
    this.clearTimer();
    current.locked = true;

    const q = this.question(current.questionId);
    const answers = Object.values(current.answers);

    if (this.state.phase === 'question' && q) {
      // The real window, not the configured one, so host-granted time widens
      // the speed bands instead of penalising whoever answered before it.
      current.awards = scoreQuestion(
        answers,
        this.correctDisplayIndex(),
        this.state.config,
        current.deadline - current.startedAt,
      );
      for (const award of current.awards) {
        const team = this.state.teams[award.teamId];
        if (team) team.score += award.total;
      }
      this.state.phase = 'locked';
      this.scheduleAuto(this.state.config.revealDelaySeconds);
    } else if (this.state.phase === 'wager_question' && q) {
      const correctIndex = this.correctDisplayIndex();
      current.awards = answers.map((a) => {
        const correct = a.choiceIndex === correctIndex;
        const bet = this.state.wagerBets?.[a.teamId] ?? 0;
        const total = scoreWager(correct, bet);
        return { teamId: a.teamId, correct, total, max: bet, full: false };
      });
      // A team that never answered loses its wager — the bet was the commitment.
      for (const teamId of this.activeTeamIds()) {
        if (current.answers[teamId]) continue;
        const bet = this.state.wagerBets?.[teamId] ?? 0;
        if (bet) current.awards.push({ teamId, correct: false, total: -bet, max: bet, full: false });
      }
      for (const award of current.awards) {
        const team = this.state.teams[award.teamId];
        if (team) team.score += award.total;
      }
      this.state.phase = 'wager_reveal';
      // Queue the step out of it. This was the last beat in the game that
      // queued nothing: betting now closes itself and the final question runs
      // on its own clock, and then the night sat on the final answer forever
      // because nothing had been scheduled to leave it. Exactly the same
      // shape as the last reveal of a round, found the same way — by playing
      // a whole night with nobody touching it.
      this.scheduleAuto(this.state.config.nextQuestionDelaySeconds);
    } else if (this.state.phase === 'tiebreak' && q) {
      const order = rankNumeric(answers, q.answerNumber ?? 0);
      const winner = order[0];
      current.awards = this.activeTeamIds().map((teamId) => ({
        teamId,
        correct: teamId === winner,
        // One point is enough to break the tie without distorting the night,
        // and at a thousand a question it cannot change anything else.
        total: teamId === winner ? 1 : 0,
        max: 1,
        full: false,
      }));
      for (const award of current.awards) {
        const team = this.state.teams[award.teamId];
        if (team) team.score += award.total;
      }
      this.state.phase = 'tiebreak_reveal';
      // Deliberately queues nothing, and this is the one place that is right.
      // A tiebreak only exists because the MC started one, so the MC is
      // standing there; the moment two tables find out which of them won the
      // night is theirs to narrate, not a clock's. Every other reveal in the
      // game now moves on by itself.
      this.clearAutoTimer();
    }

    this.commit({ kind: 'locked', reason, questionId: current.questionId });
  }

  /** Discard the current question without scoring — for a typo or a dud. */
  skipQuestion() {
    if (!this.state.current) return;
    this.clearTimer();
    this.clearAutoTimer();
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
    // A mixed round has no category of its own, so the replacement comes from
    // anywhere in the selection. In a single-category round it stays in
    // category, because the round intro card just promised the room a subject.
    const replacement = round.categoryId
      ? pickRound(ctx, round.categoryId, 1)[0]
      : pickMixedRound(ctx, 1)[0];
    if (!replacement) throw new Error('No unused questions left in this category.');
    round.questionIds[round.cursor] = replacement.id;
    this.startQuestion(replacement.id, this.state.config.secondsPerQuestion, round.cursor + 1, round.questionIds.length);
    this.state.phase = 'question';
    this.commit({ kind: 'question_replaced', questionId: replacement.id });
  }

  // ------------------------------------------------------------ flow

  startGame() {
    if (!this.state.teamOrder.length) throw new Error('No teams have joined yet.');
    this.state.gameIndex += 1;
    this.buildGame();
    this.state.wagerBets = undefined;
    this.state.current = undefined;
    this.state.tiebreakTeamIds = undefined;
    this.state.breakEndsAt = undefined;
    this.state.wagerEndsAt = undefined;
    this.state.phase = 'game_intro';
    // The intro card is a beat, not a stop. It holds long enough for the MC to
    // say "game two, here we go" and then moves, which is what makes the rest
    // of the night runnable without a thumb on it.
    this.scheduleAuto(this.state.config.introSeconds);
    this.commit({ kind: 'game_started', gameIndex: this.state.gameIndex });
  }

  /** The MC's one big button. Every phase knows what comes next. */
  advance() {
    const s = this.state;
    // Whether this came from a thumb or the clock, any pending step is now spent.
    this.clearAutoTimer();
    switch (s.phase) {
      case 'lobby':
        this.startGame();
        return;

      case 'game_intro':
        s.prevScores = Object.fromEntries(s.teamOrder.map((id) => [id, s.teams[id]?.score ?? 0]));
        s.phase = 'round_intro';
        this.scheduleAuto(s.config.introSeconds);
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
          // Only a round with another round after it gets a break. The last
          // round of a game runs into the wager and then the long break, so
          // its scoreboard is a beat to read the standings, not a trip to the
          // bar — announcing five minutes there and then opening the betting
          // was the screens contradicting each other.
          if (s.roundIndex + 1 < s.rounds.length) this.beginBreak(s.config.roundBreakMinutes);
          else this.scheduleAuto(s.config.nextQuestionDelaySeconds);
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
        // Scheduled whether or not another question follows. This used to stop
        // at the last reveal of a round on purpose, back when a round boundary
        // always waited for the MC — which meant a night set up to run itself
        // ran one round and then sat on an answer until somebody noticed. The
        // scoreboard it moves to arms its own break, and that break is where
        // the MC gets their stop if they want one.
        this.scheduleAuto(s.config.nextQuestionDelaySeconds);
        this.commit({ kind: 'revealed' });
        return;

      case 'round_scores': {
        s.breakEndsAt = undefined;
        if (s.roundIndex + 1 < s.rounds.length) {
          s.roundIndex += 1;
          // Rebase the deltas so the next scoreboard reports that round alone.
          s.prevScores = Object.fromEntries(s.teamOrder.map((id) => [id, s.teams[id]?.score ?? 0]));
          s.phase = 'round_intro';
          this.scheduleAuto(s.config.introSeconds);
          this.commit({ kind: 'advance' });
          return;
        }
        if (s.config.finalWager) {
          s.wagerBets = {};
          s.phase = 'wager_bet';
          // Betting used to be the one beat that waited for a thumb, on the
          // grounds that a team caught mid-decision loses its whole stake.
          // In practice that stopped a night set to run itself at the most
          // visible moment of every game, and the MC had to notice. It gets a
          // clock like everything else now; a team that has not bet when it
          // closes has bet nothing, and wins and loses nothing. Set
          // wagerSeconds to 0 to go back to waiting.
          this.openWagerWindow();
          this.commit({ kind: 'wager_betting' });
          return;
        }
        s.phase = 'game_results';
        this.beginBreak(s.config.gameBreakMinutes);
        this.commit({ kind: 'game_finished' });
        return;
      }

      case 'wager_bet': {
        s.wagerEndsAt = undefined;
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
        s.phase = 'game_results';
        this.beginBreak(s.config.gameBreakMinutes);
        this.commit({ kind: 'game_finished' });
        return;

      case 'tiebreak':
        this.lockNow('host');
        return;

      case 'tiebreak_reveal':
        s.tiebreakTeamIds = undefined;
        s.current = undefined;
        s.phase = 'game_results';
        this.beginBreak(s.config.gameBreakMinutes);
        this.commit({ kind: 'tiebreak_finished' });
        return;

      case 'game_results':
        s.breakEndsAt = undefined;
        // The night knows how many games it is. It used to offer another one
        // forever, which meant the only way a night ended was the MC
        // remembering to end it — and the screens said "start another" when
        // the schedule was already done.
        if (s.gameIndex >= Math.max(1, s.config.gamesPerNight)) {
          this.endNight();
          return;
        }
        // Another game, same teams, scores carried.
        this.startGame();
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

  /**
   * Fresh night, same server. Teams and scores are cleared.
   *
   * The config is rebuilt from the current defaults rather than carried over.
   * It used to be carried, which meant a box that had been running since
   * before an update could never pick up a new question length, clock or
   * scoring rule — not even through Reset everything. Only the venue name
   * survives, because that is the one setting belonging to the room rather
   * than to the build.
   */
  resetNight() {
    this.clearTimer();
    this.clearAutoTimer();
    this.state = this.freshNight({ venueName: this.state.config.venueName });
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

  /** Whether the device behind an entry is currently connected. */
  isConnected(teamId: string): boolean {
    const team = this.state.teams[teamId];
    if (!team) return false;
    return !!this.state.players[team.ownerId]?.connected;
  }

  difficultyOf(questionId: string): Difficulty {
    return this.question(questionId)?.difficulty ?? 2;
  }

  dispose() {
    this.clearTimer();
    this.clearAutoTimer();
  }
}
