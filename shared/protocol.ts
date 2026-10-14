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
  /** Couples play as 2; tables play as 4. Caps members per team. */
  teamSize: 2 | 4;
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
  /** Pack ids switched on for tonight. The core bank is always available. */
  packs: string[];
  /** Restrict to questions for this audience. Empty means no restriction. */
  audience: string;
}

export const POINTS_BY_DIFFICULTY: Record<Difficulty, number> = {
  1: 10,
  2: 15,
  3: 20,
  4: 30,
};

export const DEFAULT_CONFIG: GameConfig = {
  venueName: 'PrimeTime Trivia',
  teamSize: 2,
  roundsPerBlock: 3,
  questionsPerRound: 8,
  secondsPerQuestion: 35,
  speedBonus: true,
  speedBonusPoints: 5,
  finalWager: true,
  readAloud: false,
  // Medium-hard by design: a warm-up, a climb, and two that should make the
  // room argue. Flat-easy rounds are what make educated players stop coming.
  difficultyMix: [2, 2, 3, 3, 4, 3, 3, 4],
  categories: [],
  avoidRecentNights: 8,
  packs: [],
  audience: '',
};

// ---------------------------------------------------------------- views

export interface TeamView {
  id: string;
  name: string;
  tableNo?: number;
  score: number;
  members: string[];
  /** Full for this night's team size. */
  full: boolean;
  connected: number;
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
  teams: TeamView[];
  scoreboard: ScoreRow[];
  block: { index: number; ofTotal: number | null };
  round?: RoundView;
  question?: QuestionView;
  /** Epoch ms. Clients render their own countdown from this. */
  deadline?: number;
  /** Team ids that have locked something in, for the "6 of 8 answered" strip. */
  answeredTeamIds: string[];
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
    teamId?: string;
    teamName?: string;
    /** This team's locked answer for the current question. */
    choiceIndex?: number;
    numberAnswer?: number;
    /** Who on the team picked it, so a partner isn't confused. */
    chosenBy?: string;
    wager?: number;
    maxWager: number;
  };
  /** Teams available to join in the lobby. */
  openTeams: Array<{ id: string; name: string; members: string[]; full: boolean }>;
}

export type GameState = HostState | ControlState | PlayerState;

// ---------------------------------------------------------------- messages

export type ClientMessage =
  // player
  | { t: 'hello'; role: 'player' | 'host' | 'control'; playerId?: string; token?: string }
  | { t: 'create_team'; name: string; playerName: string; tableNo?: number }
  | { t: 'join_team'; teamId: string; name: string }
  | { t: 'leave_team' }
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
  | { t: 'start_tiebreak' }
  | { t: 'end_night' }
  | { t: 'reset_night' }
  | { t: 'say'; message: string };

export type ServerMessage =
  | { t: 'state'; state: GameState }
  | { t: 'identity'; playerId: string; token: string }
  | { t: 'error'; message: string }
  | { t: 'toast'; message: string };
