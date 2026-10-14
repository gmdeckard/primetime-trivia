import { POINTS_BY_DIFFICULTY, type Difficulty, type GameConfig } from '../../shared/protocol.js';

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
 * Score one question for every team that answered.
 *
 * The speed bonus goes to the single fastest correct answer only. An
 * everyone-gets-a-sliding-scale model sounds fairer but in practice it turns
 * every question into a reaction test, which punishes eyesight rather than
 * knowledge. One modest bonus for first-in keeps the urgency without letting
 * reaction time decide the night.
 */
export function scoreQuestion(
  answers: AnswerRecord[],
  correctIndex: number | undefined,
  difficulty: Difficulty,
  config: GameConfig,
): Award[] {
  const base = basePoints(difficulty);
  const correctAnswers = answers.filter((a) => a.choiceIndex === correctIndex);
  let fastestTeamId: string | undefined;
  if (config.speedBonus && correctAnswers.length > 1) {
    fastestTeamId = correctAnswers.reduce((best, a) => (a.elapsedMs < best.elapsedMs ? a : best)).teamId;
  }

  return answers.map((a) => {
    const correct = a.choiceIndex === correctIndex;
    const speedBonus = correct && a.teamId === fastestTeamId;
    const bonus = speedBonus ? config.speedBonusPoints : 0;
    return {
      teamId: a.teamId,
      correct,
      base: correct ? base : 0,
      bonus,
      total: (correct ? base : 0) + bonus,
      speedBonus,
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
