import type { Difficulty, GameConfig, Question } from '../../shared/protocol.js';
import type { Bank } from './content.js';
import type { Rotation } from './rotation.js';

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
  /**
   * Asked on recent nights. The engine always supplies a rotation and leaves
   * this empty; it survives for a caller building a selection without one.
   */
  usedRecently: Set<string>;
  /**
   * The persistent deck per category. When present it decides which question
   * comes next, and `usedRecently` stops mattering: a deck that deals every
   * question once before dealing any twice is a strictly stronger promise
   * than avoiding the last eight nights.
   */
  rotation?: Rotation;
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

/** The round's difficulty ramp, cycled when the template is shorter. */
export function difficultyTemplate(config: GameConfig, count: number): Difficulty[] {
  const mix = config.difficultyMix;
  return Array.from({ length: count }, (_, i) => mix[i % mix.length] ?? 2);
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
  const pool = (ctx.bank.byCategory.get(categoryId) ?? []).filter((q) => q.kind === 'choice');
  const template = difficultyTemplate(ctx.config, count);

  // With a rotation in hand the deck decides the order, and the promise it
  // makes is the stronger one: every question before any repeat.
  if (ctx.rotation) {
    const picked: Question[] = [];
    for (const wanted of template) {
      const q = ctx.rotation.deal(categoryId, pool, wanted, (cand) => dealable(ctx, cand));
      if (!q) break;
      ctx.usedTonight.add(q.id);
      picked.push(q);
    }
    return picked;
  }

  const picked: Question[] = [];
  const taken = new Set<string>();
  for (const relaxed of [false, true]) {
    const available = shuffle(eligible(ctx, pool, relaxed).filter((q) => !taken.has(q.id)), rnd);
    for (const wanted of template.slice(picked.length)) {
      // Prefer the exact difficulty, then the nearest one available.
      const match = available
        .filter((q) => !taken.has(q.id))
        .sort((a, b) => Math.abs(a.difficulty - wanted) - Math.abs(b.difficulty - wanted))[0];
      if (!match) break;
      taken.add(match.id);
      picked.push(match);
    }
    if (picked.length >= count) break;
  }

  return picked.slice(0, count);
}

/** Whether a question can be dealt tonight, ignoring the deck's own order. */
function dealable(ctx: SelectionContext, q: Question): boolean {
  return q.kind === 'choice' && inSelection(ctx, q) && !ctx.usedTonight.has(q.id);
}

/**
 * Build one round of `count` questions, each from a different category.
 *
 * This is the default shape of a round now. Ten questions on one subject is
 * ten minutes in which the people who do not follow that subject have nothing
 * to do but watch, and in a mixed room that is most of the room most of the
 * time. One question each from ten shuffled categories keeps everybody in it,
 * and the difficulty ramp still runs across the round.
 *
 * Categories are drawn without repeating until there are none left to draw,
 * which is the same promise the question deck makes one level down. If the
 * selection has fewer categories than the round has questions — a night cut
 * down to three categories, or a thin pack — it comes back round and takes a
 * second from each rather than handing back a short round.
 */
export function pickMixedRound(ctx: SelectionContext, count: number): Question[] {
  const rnd = ctx.rnd ?? Math.random;
  const template = difficultyTemplate(ctx.config, count);
  const allowed = ctx.config.categories.length
    ? ctx.config.categories
    : ctx.bank.categories.map((c) => c.id);

  const poolFor = (id: string) => (ctx.bank.byCategory.get(id) ?? []).filter((q) => q.kind === 'choice');
  // A category only has to offer one usable question to be worth a slot here,
  // which is the whole reason a mixed round reaches content a single-category
  // round never could: a category with four questions in it was unusable.
  let queue = shuffle(allowed.filter((id) => poolFor(id).some((q) => dealable(ctx, q))), rnd);

  const picked: Question[] = [];
  const exhausted = new Set<string>();
  for (const wanted of template) {
    let chosen: Question | undefined;
    // Walk the shuffled queue until a category yields. A pass that yields
    // nothing anywhere means the selection is spent, so stop rather than spin.
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      if (exhausted.has(id)) continue;
      const pool = poolFor(id);
      const q = ctx.rotation
        ? ctx.rotation.deal(id, pool, wanted, (cand) => dealable(ctx, cand))
        : shuffle(pool.filter((cand) => dealable(ctx, cand)), rnd).sort(
            (a, b) => Math.abs(a.difficulty - wanted) - Math.abs(b.difficulty - wanted),
          )[0];
      if (!q) {
        exhausted.add(id);
        continue;
      }
      queue = [...queue.slice(0, i), ...queue.slice(i + 1), id];
      chosen = q;
      break;
    }
    if (!chosen) break;
    ctx.usedTonight.add(chosen.id);
    picked.push(chosen);
  }
  return picked;
}

/** Choose categories for a game, never repeating one within the same game. */
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
  // If the bank is too thin to avoid repeats, allow them rather than short-change the game.
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
