import type { Difficulty, GameConfig, Question } from '../../shared/protocol.js';
import type { Bank } from './content.js';

/** Fisher-Yates against an injectable RNG so tests can pin the order. */
export function shuffle<T>(items: T[], rnd: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * The display order for a question's four options.
 *
 * Content is authored answer-first, so without this every question would put
 * the right answer in slot A. Returns a permutation where position i holds
 * original index `order[i]`.
 */
export function choiceOrder(rnd: () => number = Math.random): number[] {
  return shuffle([0, 1, 2, 3], rnd);
}

export interface SelectionContext {
  bank: Bank;
  config: GameConfig;
  /** Asked already tonight. */
  usedTonight: Set<string>;
  /** Asked on recent nights, per config.avoidRecentNights. */
  usedRecently: Set<string>;
  rnd?: () => number;
}

/**
 * Whether a question is switched on for tonight.
 *
 * Core-bank questions (no pack) are always in play; a pack has to be selected
 * explicitly. Audience works the other way round — an untagged question suits
 * everyone, and only a question that declares a different audience is excluded.
 * Both defaults are chosen so that adding packs and audiences to an existing
 * install changes nothing until the MC asks for it.
 */
function inSelection(ctx: SelectionContext, q: Question): boolean {
  if (q.pack && !ctx.config.packs.includes(q.pack)) return false;
  if (ctx.config.audience && q.audience && q.audience !== ctx.config.audience) return false;
  return true;
}

function eligible(ctx: SelectionContext, pool: Question[], relaxed: boolean): Question[] {
  return pool.filter((q) => {
    if (!inSelection(ctx, q)) return false;
    if (ctx.usedTonight.has(q.id)) return false;
    if (!relaxed && ctx.usedRecently.has(q.id)) return false;
    return true;
  });
}

/**
 * Build one round: `count` questions from a category, matching the configured
 * difficulty template as closely as the bank allows.
 *
 * Falls back in two stages rather than failing: first it allows questions used
 * on a recent night, then it allows any difficulty. A half-empty category
 * should degrade the round, never abort the evening — the MC has a room full of
 * people waiting.
 */
export function pickRound(ctx: SelectionContext, categoryId: string, count: number): Question[] {
  const rnd = ctx.rnd ?? Math.random;
  const pool = ctx.bank.byCategory.get(categoryId) ?? [];
  const picked: Question[] = [];
  const taken = new Set<string>();

  const template: Difficulty[] = [];
  for (let i = 0; i < count; i++) {
    const mix = ctx.config.difficultyMix;
    template.push(mix[i % mix.length] ?? 2);
  }

  for (const relaxed of [false, true]) {
    const available = shuffle(eligible(ctx, pool, relaxed).filter((q) => !taken.has(q.id)), rnd);
    for (const wanted of template.slice(picked.length)) {
      // Prefer the exact difficulty, then the nearest one available.
      const match = available
        .filter((q) => !taken.has(q.id) && q.kind === 'choice')
        .sort((a, b) => Math.abs(a.difficulty - wanted) - Math.abs(b.difficulty - wanted))[0];
      if (!match) break;
      taken.add(match.id);
      picked.push(match);
    }
    if (picked.length >= count) break;
  }

  return picked.slice(0, count);
}

/** Choose categories for a block, never repeating one within the same block. */
export function pickCategories(ctx: SelectionContext, howMany: number, exclude: string[] = []): string[] {
  const allowed = ctx.config.categories.length
    ? ctx.config.categories
    : ctx.bank.categories.map((c) => c.id);

  const viable = allowed.filter((id) => {
    const pool = ctx.bank.byCategory.get(id) ?? [];
    if (exclude.includes(id)) return false;
    // Only offer a category that can actually fill a round of multiple choice.
    // Counting every kind here would let a tiebreaker-only category win the
    // draw and then produce an empty round.
    return eligible(ctx, pool, true).filter((q) => q.kind === 'choice').length >= ctx.config.questionsPerRound;
  });

  const chosen = shuffle(viable, ctx.rnd ?? Math.random).slice(0, howMany);
  // If the bank is too thin to avoid repeats, allow them rather than short-change the block.
  if (chosen.length < howMany) {
    for (const id of shuffle(allowed, ctx.rnd ?? Math.random)) {
      if (chosen.length >= howMany) break;
      if (!chosen.includes(id)) chosen.push(id);
    }
  }
  return chosen;
}

/** A numeric question for tiebreaks, if the bank has one left. */
export function pickNumeric(ctx: SelectionContext): Question | undefined {
  const pool = ctx.bank.questions.filter(
    (q) => q.kind === 'number' && !ctx.usedTonight.has(q.id) && inSelection(ctx, q),
  );
  return shuffle(pool, ctx.rnd ?? Math.random)[0];
}
