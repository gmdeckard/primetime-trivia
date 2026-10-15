import { pointsAt, type GameConfig } from '../../shared/protocol.js';

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
  /** What this answer actually earned. */
  total: number;
  /** The question's full value, for showing what the clock cost. */
  max: number;
  /** True when the answer landed inside the reading time and paid nothing. */
  full: boolean;
}

/**
 * Score one question for every team that answered.
 *
 * `windowMs` is the real width of the question — `deadline - startedAt`, not
 * the configured seconds — so time the MC grants mid-question stretches the
 * slide for everyone instead of quietly penalising whoever already answered.
 *
 * The value does not depend on what anyone else did: a team that was the only
 * one to get it right earns exactly what the clock said, because this rewards
 * being sure quickly, not winning a race.
 */
export function scoreQuestion(
  answers: AnswerRecord[],
  correctIndex: number | undefined,
  config: GameConfig,
  windowMs: number,
): Award[] {
  return answers.map((a) => {
    const correct = a.choiceIndex === correctIndex;
    const earned = pointsAt(a.elapsedMs, windowMs, config);
    return {
      teamId: a.teamId,
      correct,
      total: correct ? earned : 0,
      max: config.questionPoints,
      full: correct && earned >= config.questionPoints,
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
