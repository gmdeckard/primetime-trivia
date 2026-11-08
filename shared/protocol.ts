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

/**
 * Shortest acceptable control password. Lives here because both login screens
 * gate their Unlock button on it and the server enforces it: three copies of a
 * bare 4 meant raising the floor would leave the buttons enabled for passwords
 * the server rejects.
 */
export const MIN_PASSWORD = 4;

export const PROTOCOL_VERSION = 1;

/**
 * Hierarchy, in the words the room uses:
 *
 *   a Night contains Games, a Game contains Rounds, a Round contains Questions.
 *
 * Ten questions is a Round, and a handful of Rounds is a Game. This used to
 * call the middle layer a Block, which nobody in a clubhouse has ever said out
 * loud: the MC says "last round" and "this game", and when the screen says
 * something else the MC has to translate it live.
 */
export type Phase =
  | 'lobby'
  | 'game_intro'
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
  | 'game_results'
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
  /** Pack this question came from. Absent means untagged, like the tiebreakers. */
  pack?: string;
}

// ---------------------------------------------------------------- config

export interface GameConfig {
  venueName: string;
  /**
   * Games the night is scheduled for. The night ends itself after the last
   * one rather than offering another, so an MC who set up three games does
   * not have to remember to stop.
   */
  gamesPerNight: number;
  roundsPerGame: number;
  questionsPerRound: number;
  secondsPerQuestion: number;
  /** What a correct answer is worth while the room is still reading. */
  questionPoints: number;
  /** Seconds at full value before the clock starts taking points off. */
  readSeconds: number;
  /** What a correct answer is still worth when the window closes. */
  minQuestionPoints: number;
  /** Big-screen sound: a bed in the lobby and the breaks, and the count-in. */
  music: boolean;
  /** A bed under a live question too. Its own switch because it is arguable. */
  musicUnderQuestion: boolean;
  /** Speak the run-up as well as playing it. */
  musicSpeakCountIn: boolean;
  /** Big-screen master volume, 0 to 1. */
  musicVolume: number;
  /** Minutes the room gets between rounds, counted down on every screen. */
  roundBreakMinutes: number;
  /** Minutes the room gets after a game closes. The longer one. */
  gameBreakMinutes: number;
  /**
   * Whether a break ends by itself.
   *
   * On, the clock runs out and the next round starts: the night runs itself
   * and the MC can be at the bar. Off, the clock still counts down and still
   * says what it is counting to, but the game waits for the MC's button at
   * zero. An MC who has to make an announcement wants off; an MC running a
   * quiet night wants on.
   */
  autoStartAfterBreak: boolean;
  /** Seconds a game or round intro card holds before the first question. */
  introSeconds: number;
  /**
   * Seconds the room gets to place a final wager.
   *
   * Zero means the betting window waits for the MC, which is what it always
   * did. Any other number puts a clock on it and closes the betting itself,
   * so a night set to run on its own does not stop dead at the one phase
   * that used to need a thumb. A team that has not bet when it closes has
   * bet nothing, and nothing is exactly what they win or lose.
   */
  wagerSeconds: number;
  /** Jeopardy-style wager to close each game. */
  finalWager: boolean;
  /** Host screen reads the question aloud via the browser's speech engine. */
  readAloud: boolean;
  /** Per-question difficulty template for a round, cycled if shorter. */
  difficultyMix: Difficulty[];
  /**
   * How a round draws its categories.
   *
   * 'mixed' is one question per category, categories shuffled, so ten
   * questions means ten different subjects and nobody sits out a round
   * because they know nothing about opera. 'single' is the old behaviour —
   * the whole round from one category, which suits a themed round and is
   * what makes a round intro card worth showing.
   */
  roundCategoryMode: 'mixed' | 'single';
  /** Category ids to draw from; empty means all of them. */
  categories: string[];
  /**
   * Run the question -> lock -> reveal -> next cycle on a clock instead of
   * three taps. The MC still owns every boundary that matters: starting a
   * game, moving between rounds, the wager. Only the inside of a round runs
   * itself, because that is the part where tapping competes with hosting.
   */
  autoAdvance: boolean;
  /** Beat between answers locking and the answer appearing. Builds the pause. */
  revealDelaySeconds: number;
  /** How long the answer and its fact stay up before the next question. */
  nextQuestionDelaySeconds: number;
  /** Pack ids switched on for tonight. Untagged questions need no pack. */
  packs: string[];
  /** Restrict to questions for this audience. Empty means no restriction. */
  audience: string;
}

/**
 * What a correct answer is worth right now, the Buzztime way.
 *
 * Full value while the room reads, then a straight slide to a floor as the
 * clock runs out. Difficulty no longer changes the number: every question is
 * worth the same, and what separates two teams who both knew it is how fast
 * they were sure. That is the point of the scale — at twenty to thirty points
 * a question the board filled with ties, and a night that ends tied is a night
 * the tiebreaker decides rather than the trivia.
 *
 * The floor sits well above zero on purpose. This room is 55 to 75, and a
 * correct answer arrived at slowly is still a correct answer; a game that pays
 * nothing for it stops being worth playing by the third round.
 *
 * Shared rather than server-only because a curve nobody can see is not a game
 * mechanic: the handsets show the number falling, and it has to be the same
 * number the scoring uses. Rounded to ten so it steps rather than flickers.
 */
/**
 * True when the game is sitting on a reveal that leads to another question.
 *
 * The run-up — the clock, the standings swap, the three ticks, "Get ready,
 * Set, Go" — is all built on this one idea, and it was written out separately
 * at each of those places. The last reveal of a round carries an
 * autoAdvanceAt exactly like every other one, so anything that checks only
 * for the timer counts the room in towards a scoreboard. Two of the three
 * call sites remembered to check `moreInRound`; the sound did not, and the
 * room got "Get ready, Set, Go" on its way into the break and again at the
 * end of the night. One predicate so they cannot drift apart again.
 *
 * `moreInRound` is optional on the wire, and absent is treated as "more to
 * come" to match what the screens already did.
 */
export function inRunUpToQuestion(state: {
  phase?: string;
  autoAdvanceAt?: number;
  held?: boolean;
  moreInRound?: boolean;
} | null | undefined): boolean {
  if (!state) return false;
  if (state.phase !== 'reveal') return false;
  if (!state.autoAdvanceAt) return false;
  if (state.held) return false;
  return state.moreInRound !== false;
}

export function pointsAt(elapsedMs: number, windowMs: number, config: GameConfig): number {
  const max = config.questionPoints;
  const min = Math.min(config.minQuestionPoints, max);
  if (!Number.isFinite(windowMs) || windowMs <= 0) return max;
  const readMs = Math.min(Math.max(0, config.readSeconds) * 1000, windowMs);
  const elapsed = Math.max(0, Math.min(Number.isFinite(elapsedMs) ? elapsedMs : 0, windowMs));
  if (elapsed <= readMs) return max;
  const decayMs = windowMs - readMs;
  if (decayMs <= 0) return max;
  const fallen = (elapsed - readMs) / decayMs;
  return Math.round((max - (max - min) * fallen) / 10) * 10;
}

export const DEFAULT_CONFIG: GameConfig = {
  venueName: 'PrimeTime Trivia',
  // Three games is a two-and-a-bit hour night: a game is two rounds of ten
  // plus the wager, about forty minutes with its break. The night stops
  // itself after the last one.
  gamesPerNight: 3,
  // Two rounds of ten, which is the shape of the evening: ten questions, a
  // five minute break, ten more, then the wager closes the game and the room
  // gets the long break.
  roundsPerGame: 2,
  questionsPerRound: 10,
  // 20s is the bar-trivia and seatback norm, and it is what makes a visible
  // countdown feel like one. The accessibility work is done by 19px body text
  // and 84px targets, not by a long clock; a 35s window mostly produced dead
  // air. Since the window now always runs to its deadline rather than ending
  // on the last tap, this number is the whole beat between questions.
  secondsPerQuestion: 20,
  // Buzztime's number, and it is the right one: a thousand is wide enough that
  // two teams who both knew the answer almost never land on the same score.
  questionPoints: 1000,
  // Long enough to read the prompt and all four options before anything is at
  // stake. Much below this and the fast reader wins, not the one who knows it.
  readSeconds: 5,
  // The floor at the buzzer: a fifth of full value, never nothing.
  minQuestionPoints: 200,
  // Off until a night in the room says otherwise. Sound on the big screen is
  // the kind of thing that is charming for ten minutes and wearing by the
  // third round, so it starts silent and the MC turns it on.
  music: false,
  // Separate switch, and the more arguable one: a bed under a live question
  // competes with the MC's microphone in a room where some of the audience
  // wear hearing aids. Worth trying, not worth defaulting to.
  musicUnderQuestion: false,
  musicSpeakCountIn: false,
  musicVolume: 0.35,
  // Long enough to get to the bar and back. The engine counts these down for
  // real now, so the number on the big screen is a clock and not a claim.
  roundBreakMinutes: 5,
  gameBreakMinutes: 10,
  // On, because the thing that actually goes wrong on a night is a break that
  // never ends: the MC gets talking to a table and twenty minutes go by. The
  // clock is visible on every screen either way, so nobody is surprised by it.
  autoStartAfterBreak: true,
  // Long enough to say "round three, here we go" over it.
  introSeconds: 8,
  // Long enough to decide and tap, short enough that the room does not cool
  // off. The sum is small: most tables know whether they are going all in
  // before the screen finishes asking.
  wagerSeconds: 40,
  finalWager: true,
  readAloud: false,
  // Medium-hard by design: a warm-up, a climb, and three that should make the
  // room argue. Flat-easy rounds are what make educated players stop coming.
  //
  // Must be at least as long as questionsPerRound. The template is cycled when
  // it is shorter, so an 8-long mix in a 10-question round would end every
  // round on its two easiest questions.
  difficultyMix: [2, 2, 3, 3, 4, 3, 3, 4, 3, 4],
  // One question per category, shuffled. Ten questions on one subject means
  // nine of them are dead air for whoever does not follow that subject, and
  // in a mixed room that is most of it.
  roundCategoryMode: 'mixed',
  categories: [],
  autoAdvance: true,
  revealDelaySeconds: 4,
  // Long enough to read the fun fact aloud and let the room react.
  nextQuestionDelaySeconds: 10,
  // Every pack that ships, because with nothing enabled a night draws from the
  // tiebreakers alone. This listed `adult1` only, which quietly left the
  // thousand questions of adult2 out of every fresh night: the screen said
  // "the core bank is always in play" and the core bank, for the adult room,
  // is exactly nothing. The MC can still run one pack on its own for a themed
  // night. A pack added later is off until it is switched on, which is the
  // point of the list being explicit.
  packs: ['adult1', 'adult2', 'kids1'],
  // Not empty. Empty means no filter, which would let a set written for
  // another age group into a normal night the moment one existed. 35-75 is
  // the adult bank: someone at the older end of that range was in their
  // twenties in 1990, so one group covers both ends of the room.
  audience: '35-75',
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
  /**
   * This question's own category, named for the screen.
   *
   * It used to be enough to say it once on the round intro card, because a
   * round was one category. In a mixed round every question is a different
   * subject, and the room needs telling which one before it reads the prompt
   * — that is the beat an MC fills with "and now, geography".
   */
  categoryName: string;
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
    /** Full value of the question, so a player can see what the clock cost. */
    max: number;
    /** True when they answered inside the reading time and paid nothing. */
    full: boolean;
  }>;
  /** Share of teams that got it right, shown to make a hard question feel fair. */
  correctPct: number;
}

export interface RoundView {
  index: number;
  ofTotal: number;
  /** The round's own category, or '' for a mixed round. */
  categoryId: string;
  categoryName: string;
  blurb: string;
  /** True when this round draws one question per category. */
  mixed: boolean;
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
  game: { index: number; ofTotal: number | null };
  round?: RoundView;
  question?: QuestionView;
  /** Epoch ms. Clients render their own countdown from this. */
  deadline?: number;
  /** When the live question started, so a client can price it exactly. */
  startedAt?: number;
  /** Epoch ms the game will move itself on, when auto-advance is running. */
  autoAdvanceAt?: number;
  /**
   * True when what comes after this reveal is another question rather than the
   * end of the round. The run-up clock says "Next question"; on the last
   * question of a round that is a lie, and the room notices when the promised
   * question turns out to be a scoreboard.
   */
  moreInRound?: boolean;
  /**
   * Epoch ms the current break is over.
   *
   * Set on both break phases whether or not the break ends itself, because
   * the room asking "how long have we got" is the problem being solved, and
   * that question does not depend on who presses the button at zero.
   */
  breakEndsAt?: number;
  /** Epoch ms the betting window closes, when one is running. */
  wagerEndsAt?: number;
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
  join: { url: string; ssid?: string; ssidAlt?: string; wifiPassword?: string; qrSvg: string };
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
  /**
   * The age groups the bank actually holds questions for, read off the
   * folders under content/questions.
   *
   * It used to be a hardcoded list in the control screen, which offered two
   * groups nobody had written a question for and would have gone on offering
   * them after somebody did. A folder is now the whole act of adding a group:
   * drop `content/questions/18-35/` in, and it appears here with its real
   * counts and no code change.
   */
  audiences: Array<{
    id: string;
    name: string;
    /** Unused questions this group can still draw on, in the current selection. */
    available: number;
    /** Categories it can fill a mixed round from. */
    categories: number;
  }>;
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
  | { t: 'join'; roomCode: string; name: string; kind: EntryKind; tableNo?: number }
  | { t: 'leave' }
  | { t: 'answer'; choiceIndex: number }
  | { t: 'answer_number'; value: number }
  | { t: 'set_wager'; amount: number }
  // control
  | { t: 'set_config'; patch: Partial<GameConfig> }
  | { t: 'start_game' }
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
