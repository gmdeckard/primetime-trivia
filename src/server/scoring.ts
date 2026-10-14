import { POINTS_BY_DIFFICULTY, speedShareAt, type Difficulty, type GameConfig } from '../../shared/protocol.js';

export interface AnswerRecord {
  teamId: string;
  choiceIndex?: number;
  numberAnswer?: number;
  /** ms since the question was shown */
  elapsedMs: number;
  byPlayerId: string;
}

export interface Award {
  teamId: string;
  correct: boolean;
  base: number;
  bonus: number;
  total: number;
  speedBonus: boolean;
}

export function basePoints(difficulty: Difficulty): number {
  return POINTS_BY_DIFFICULTY[difficulty];
}

/**
 * The bands themselves live in shared/protocol.ts, because the player's screen
 * has to step the displayed value at exactly the same thresholds the scoring
 * uses. See SPEED_BANDS there for why they step rather than slide.
 */
/** The share of the speed bonus an answer at `elapsedMs` earns. */
export function speedShare(elapsedMs: number, windowMs: number): number {
  // A missing or nonsensical window must not hand out free points.
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;
  return speedShareAt(Math.max(0, elapsedMs) / windowMs);
}

/**
 * Score one question for every team that answered.
 *
 * `windowMs` is the real width of the question — `deadline - startedAt`, not
 * the configured seconds — so that time the MC grants mid-question widens the
 * bands for everyone instead of quietly penalising the teams who had already
 * answered.
 *
 * Unlike the first-in bonus this replaced, the band does not depend on what
 * anyone else did: a team that was the only one to get it right still earns
 * its band, because the band rewards answering decisively, not winning a race.
 */
export function scoreQuestion(
  answers: AnswerRecord[],
  correctIndex: number | undefined,
  difficulty: Difficulty,
  config: GameConfig,
  windowMs: number,
): Award[] {
  const base = basePoints(difficulty);

  return answers.map((a) => {
    const correct = a.choiceIndex === correctIndex;
    const share = correct && config.speedBonus ? speedShare(a.elapsedMs, windowMs) : 0;
    const bonus = Math.round(config.speedBonusPoints * share);
    return {
      teamId: a.teamId,
      correct,
      base: correct ? base : 0,
      bonus,
      total: (correct ? base : 0) + bonus,
      speedBonus: bonus > 0,
    };
  });
}

/** Jeopardy rules: a correct answer wins the wager, a wrong one loses it. */
export function scoreWager(correct: boolean, wager: number): number {
  return correct ? wager : -wager;
}

/**
 * Closest guess wins a numeric tiebreak. Ties on distance are broken by who
 * answered first, which is the only defensible rule left at that point.
 */
export function rankNumeric(answers: AnswerRecord[], target: number): string[] {
  return answers
    .filter((a) => typeof a.numberAnswer === 'number')
    .slice()
    .sort((a, b) => {
      const da = Math.abs(a.numberAnswer! - target);
      const db = Math.abs(b.numberAnswer! - target);
      return da === db ? a.elapsedMs - b.elapsedMs : da - db;
    })
    .map((a) => a.teamId);
}
