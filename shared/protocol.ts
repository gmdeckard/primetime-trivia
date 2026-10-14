/**
 * The wire contract between the server and the three clients.
 *
 * Design note: the server broadcasts a whole state snapshot on every
 * transition rather than diffs. A snapshot is a couple of kilobytes and a
 * trivia night has maybe 400 transitions, so diffing would buy nothing and
 * cost us the ability to reason about client state at a glance. It also means
 * a tablet that sleeps through three questions recovers correctly the instant
 * it reconnects, which matters more than bytes on the wire.
 */

export const PROTOCOL_VERSION = 1;

/** Hierarchy: a Night contains Blocks (~30 min each), each Block contains Rounds, each Round contains Questions. */
export type Phase =
  | 'lobby'
  | 'block_intro'
  | 'round_intro'
  | 'question'
  | 'locked'
  | 'reveal'
  | 'round_scores'
  | 'wager_bet'
  | 'wager_question'
  | 'wager_reveal'
  | 'tiebreak'
  | 'tiebreak_reveal'
  | 'block_results'
  | 'night_over';

export type Difficulty = 1 | 2 | 3 | 4;

export type RoundFormat =
  | 'standard'
  | 'picture'
  | 'name_that_year'
  | 'theme'
  | 'lightning';

export type AnswerKind = 'choice' | 'number';

// ---------------------------------------------------------------- content

export interface Category {
  id: string;
  name: string;
  blurb: string;
  /** Shown on the round intro card so players know what they're in for. */
  sample?: string;
}

export interface Question {
  id: string;
  category: string;
  difficulty: Difficulty;
  prompt: string;
  /** Four options for 'choice'; omitted for 'number'. */
  choices?: string[];
  answerIndex?: number;
  /** For numeric questions (tiebreakers): the exact value. */
  answerNumber?: number;
  /** Required. The reveal is where the conversation happens; a question
   *  without something interesting to say after it is not worth asking. */
  funFact: string;
  kind: AnswerKind;
  /** Relative path under content/images, e.g. "arts/guernica.jpg". */
  image?: string;
  /** Decade the answer belongs to, for era-balancing a round. */
  era?: string;
  tags?: string[];
  source?: string;
  license?: string;
  /** Who the question is pitched at. Absent means it suits any audience. */
  audience?: string;
  /** Pack this question came from. Absent means the curated core bank. */
  pack?: string;
}

// ---------------------------------------------------------------- config

export interface GameConfig {
  venueName: string;
  roundsPerBlock: number;
  questionsPerRound: number;
  secondsPerQuestion: number;
  speedBonus: boolean;
  speedBonusPoints: number;
  /** Jeopardy-style wager to close each block. */
  finalWager: boolean;
  /** Host screen reads the question aloud via the browser's speech engine. */
  readAloud: boolean;
  /** Per-question difficulty template for a round, cycled if shorter. */
  difficultyMix: Difficulty[];
  /** Category ids to draw from; empty means all of them. */
  categories: string[];
  /** Don't reuse a question asked within this many past nights. */
  avoidRecentNights: number;
  /**
   * Run the question -> lock -> reveal -> next cycle on a clock instead of
   * three taps. The MC still owns every boundary that matters: starting a
   * block, moving between rounds, the wager. Only the inside of a round runs
   * itself, because that is the part where tapping competes with hosting.
   */
  autoAdvance: boolean;
  /** Beat between answers locking and the answer appearing. Builds the pause. */
  revealDelaySeconds: number;
  /** How long the answer and its fact stay up before the next question. */
  nextQuestionDelaySeconds: number;
  /** Pack ids switched on for tonight. The core bank is always available. */
  packs: string[];
  /** Restrict to questions for this audience. Empty means no restriction. */
  audience: string;
}

/**
 * Stepped speed bands, as a share of the configured bonus.
 *
 * Shared rather than server-only because a band nobody can see is not a game
 * mechanic. The player's screen shows what a correct answer is worth right
 * now, and it has to step at exactly the same places the scoring does.
 */
export const SPEED_BANDS: ReadonlyArray<{ under: number; share: number }> = [
  { under: 0.4, share: 1 },
  { under: 0.7, share: 0.5 },
];

/** Share of the speed bonus earned, from elapsed as a fraction of the window. */
export function speedShareAt(elapsed: number): number {
  if (!Number.isFinite(elapsed)) return 0;
  const f = Math.max(0, elapsed);
  for (const band of SPEED_BANDS) {
    if (f < band.under) return band.share;
  }
  return 0;
}

/** What a correct answer is worth at this moment, speed bonus included. */
export function pointsAvailable(base: number, config: GameConfig, elapsed: number): number {
  if (!config.speedBonus) return base;
  return base + Math.round(config.speedBonusPoints * speedShareAt(elapsed));
}

export const POINTS_BY_DIFFICULTY: Record<Difficulty, number> = {
  1: 10,
  2: 15,
  3: 20,
  4: 30,
};

export const DEFAULT_CONFIG: GameConfig = {
  venueName: 'PrimeTime Trivia',
  // Two rounds of ten, which is the shape of the evening: ten questions, a
  // short break, ten more, then the wager closes the block and the room gets
  // a long break. Both boundaries already stop and wait for the MC.
  roundsPerBlock: 2,
  questionsPerRound: 10,
  // 20s is the bar-trivia and seatback norm, and it is what makes a visible
  // countdown feel like one. The accessibility work is done by 19px body text
  // and 84px targets, not by a long clock: a 35s window mostly produced dead
  // air, because the question auto-locks as soon as every team has answered.
  secondsPerQuestion: 20,
  speedBonus: true,
  // Paid in stepped bands (see SPEED_BANDS above), so at difficulty 3
  // a decisive answer scores 30, a considered one 25, and a last-second one
  // the base 20. Big enough to feel, too small to beat knowing the answer.
  speedBonusPoints: 10,
  finalWager: true,
  readAloud: false,
  // Medium-hard by design: a warm-up, a climb, and three that should make the
  // room argue. Flat-easy rounds are what make educated players stop coming.
  //
  // Must be at least as long as questionsPerRound. The template is cycled when
  // it is shorter, so an 8-long mix in a 10-question round would end every
  // round on its two easiest questions.
  difficultyMix: [2, 2, 3, 3, 4, 3, 3, 4, 3, 4],
  categories: [],
  autoAdvance: true,
  revealDelaySeconds: 4,
  // Long enough to read the fun fact aloud and let the room react.
  nextQuestionDelaySeconds: 10,
  avoidRecentNights: 8,
  packs: [],
  // Not empty. Empty means no filter, which would let a set written for
  // another age group into a normal night the moment one existed. The core
  // bank is tagged 55-75, so this default is the bank as it has always been.
  audience: '55-75',
};

// ---------------------------------------------------------------- views

/**
 * One entry in the game: a single player or a team sharing one device.
 *
 * There is no joining an existing entry. One device is one entry, which is the
 * only model that survives a hundred people arriving at once — nobody has to
 * find their partner in a list, and a dead tablet takes out one entry rather
 * than stranding a teammate.
 */
export type EntryKind = 'solo' | 'team';

export interface TeamView {
  id: string;
  /** The handle they chose. Players are free to stay anonymous. */
  name: string;
  kind: EntryKind;
  tableNo?: number;
  score: number;
  connected: boolean;
}

export interface ScoreRow {
  teamId: string;
  name: string;
  score: number;
  /** Change from the previous scoreboard, for the animated delta. */
  delta: number;
  rank: number;
}

export interface QuestionView {
  prompt: string;
  choices?: string[];
  kind: AnswerKind;
  image?: string;
  difficulty: Difficulty;
  points: number;
  /** 1-based position within the round. */
  position: number;
  ofTotal: number;
}

export interface RevealView {
  answerIndex?: number;
  answerNumber?: number;
  answerText: string;
  funFact: string;
  /** Per-team outcome, for the host screen's result strip. */
  outcomes: Array<{
    teamId: string;
    name: string;
    choiceIndex?: number;
    numberAnswer?: number;
    correct: boolean;
    awarded: number;
    /** Speed-band points inside `awarded`, so a player sees what pace earned. */
    bonus: number;
    speedBonus: boolean;
  }>;
  /** Share of teams that got it right, shown to make a hard question feel fair. */
  correctPct: number;
}

export interface RoundView {
  index: number;
  ofTotal: number;
  categoryId: string;
  categoryName: string;
  blurb: string;
  format: RoundFormat;
  /** For 'theme' rounds, revealed only at the end of the round. */
  theme?: string;
}

/** The shared core every role receives. */
export interface BaseState {
  protocol: number;
  phase: Phase;
  roomCode: string;
  venueName: string;
  config: GameConfig;
  /**
   * Every entry. Sent to the host and MC, who display them; omitted for
   * players, who would otherwise each receive ninety-nine rows they never
   * render. `entryCount` is what the player screens actually use.
   */
  teams: TeamView[];
  entryCount: number;
  /** Top of the table, plus the player's own row on the player projection. */
  scoreboard: ScoreRow[];
  block: { index: number; ofTotal: number | null };
  round?: RoundView;
  question?: QuestionView;
  /** Epoch ms. Clients render their own countdown from this. */
  deadline?: number;
  /** Epoch ms the game will move itself on, when auto-advance is running. */
  autoAdvanceAt?: number;
  /** True when the MC has paused auto-advance to talk. */
  held: boolean;
  /** Entry ids that have locked an answer. Host and MC only — see `teams`. */
  answeredTeamIds: string[];
  /** How many have answered, which is all a player screen needs. */
  answeredCount: number;
  reveal?: RevealView;
  message?: string;
}

export interface HostState extends BaseState {
  role: 'host';
  join: { url: string; ssid?: string; qrSvg: string };
}

export interface ControlState extends BaseState {
  role: 'control';
  /** The control view always sees the answer — that's its whole job. */
  answerKey?: { index?: number; number?: number; text: string; funFact: string };
  /** One-line peek at what's next so the MC can set it up verbally. */
  upNext?: string;
  roster: Array<{ teamId: string; players: Array<{ id: string; name: string; connected: boolean }> }>;
  bank: { total: number; availableInSelection: number; usedTonight: number };
  /** Packs found on disk, so the MC can switch them on for the night. */
  packs: Array<{ id: string; name: string; audience: string; questionCount: number; origin: string }>;
  warnings: string[];
}

export interface PlayerState extends BaseState {
  role: 'player';
  me: {
    playerId: string;
    name: string;
    kind?: EntryKind;
    teamId?: string;
    teamName?: string;
    /** Where this entry currently sits, so a player sees it without the full table. */
    rank?: number;
    score?: number;
    /** This team's locked answer for the current question. */
    choiceIndex?: number;
    numberAnswer?: number;
    /** Who on the team picked it, so a partner isn't confused. */
    chosenBy?: string;
    wager?: number;
    maxWager: number;
  };
}

export type GameState = HostState | ControlState | PlayerState;

// ---------------------------------------------------------------- messages

export type ClientMessage =
  // player
  | { t: 'hello'; role: 'player' | 'host' | 'control'; playerId?: string; token?: string }
  | { t: 'join'; name: string; kind: EntryKind; tableNo?: number }
  | { t: 'leave' }
  | { t: 'answer'; choiceIndex: number }
  | { t: 'answer_number'; value: number }
  | { t: 'set_wager'; amount: number }
  // control
  | { t: 'set_config'; patch: Partial<GameConfig> }
  | { t: 'start_block' }
  | { t: 'advance' }
  | { t: 'reveal' }
  | { t: 'lock_now' }
  | { t: 'extend_timer'; seconds: number }
  | { t: 'skip_question' }
  | { t: 'replace_question' }
  | { t: 'adjust_score'; teamId: string; delta: number; note?: string }
  | { t: 'rename_team'; teamId: string; name: string }
  | { t: 'remove_team'; teamId: string }
  | { t: 'set_round_category'; roundIndex: number; categoryId: string }
  | { t: 'hold'; held: boolean }
  | { t: 'start_tiebreak' }
  | { t: 'end_night' }
  | { t: 'reset_night' }
  | { t: 'say'; message: string };

export type ServerMessage =
  | { t: 'state'; state: GameState }
  | { t: 'identity'; playerId: string; token: string }
  | { t: 'error'; message: string }
  | { t: 'toast'; message: string };
