import type { Question } from '../../shared/protocol.js';
import type { Store } from './store.js';
import { shuffle } from './selector.js';

/**
 * The guarantee that no question comes back until the bank has been used up.
 *
 * `avoidRecentNights` was a weaker promise than it sounded: it looked at the
 * last eight nights and let anything older through, so the same question could
 * land twice in a season while a hundred others had never been asked. In a room
 * that comes back every week, the people who notice are the regulars — the ones
 * who were going to come anyway.
 *
 * This is a deck of cards per category instead. Deal off the top; when a deck
 * runs out, it is reshuffled from the whole category and dealing starts again.
 * That gives the property you actually want from a question bank: every
 * question gets asked once before any question gets asked twice.
 *
 * Per category rather than one deck for the bank, because a round draws one
 * question from each of ten categories. A single bank-wide deck would deal
 * whatever came next regardless of subject, which is the same as not shuffling
 * by category at all.
 *
 * And per AGE GROUP as well as per category, which is not an optimisation —
 * it is the difference between the kids' bank working and not working. The
 * same category holds questions for several groups, so one deck per category
 * mixed them: deal from `geography` on a kids night and most cards are adult
 * ones the filter rejects. They stay in the deck, correctly, because they
 * were not used. But then the deck is never empty, so it never reshuffles,
 * and once the eighty kids' questions are gone that category yields nothing
 * at all — measured, on the eleventh kids night, as a round of zero
 * questions. A deck per (group, category) empties when that group's cards
 * run out, which is exactly when it should start again.
 *
 * It lives in `data/rotation.json`, outside the night, because that is the
 * whole point: it has to survive resetting the night, restarting the server and
 * next Tuesday.
 */

export interface RotationFile {
  /** Remaining question ids per category, in the order they will be dealt. */
  decks: Record<string, string[]>;
  /**
   * Ids already dealt in the current cycle, per category.
   *
   * Needed to tell a question added to the bank last week from one asked last
   * week: both are in the category and in neither case are they in the deck.
   * Without this the selector cannot add new content to a part-dealt deck
   * without also putting every question it has already asked back in it.
   */
  dealt: Record<string, string[]>;
  /** How many times each category's deck has been exhausted and reshuffled. */
  cycles: Record<string, number>;
}

export const EMPTY_ROTATION: RotationFile = { decks: {}, dealt: {}, cycles: {} };

/**
 * The key a deck is filed under: the age group and the category together.
 *
 * Written as `8-12::geography` rather than nested maps so the file stays flat
 * and greppable — somebody debugging a night wants to open rotation.json and
 * read it. `*` is the group with no filter, which is its own deck: a night
 * run with every age group in play is genuinely a different sequence from a
 * adult night, and giving it its own deck keeps either from spending the
 * other's cards.
 */
export function deckKey(audience: string, categoryId: string): string {
  return `${audience || '*'}::${categoryId}`;
}

export class Rotation {
  private file: RotationFile;
  /** Ids dealt but not yet written, so a dry run cannot spend the deck. */
  private dirty = false;

  constructor(
    private readonly store: Store,
    private readonly rnd: () => number = Math.random,
  ) {
    const loaded = store.loadRotation<RotationFile>();
    this.file = {
      decks: { ...(loaded?.decks ?? {}) },
      dealt: { ...(loaded?.dealt ?? {}) },
      cycles: { ...(loaded?.cycles ?? {}) },
    };
  }

  /**
   * Deal the next question from a category, preferring a wanted difficulty.
   *
   * `eligible` is the caller's filter — tonight's packs, the audience, what has
   * already been asked this evening. A card the filter rejects is left in the
   * deck rather than burned: it is not that the question has been used, it is
   * that it does not belong in tonight's game.
   *
   * Difficulty is a preference, not a cut. The deck order is the rotation
   * promise and it comes first; within what is dealable we take the nearest
   * difficulty to the one the round template asked for. Reordering the whole
   * deck by difficulty would mean the easy questions in a category all got
   * asked in the first few weeks.
   */
  deal(
    audience: string,
    categoryId: string,
    pool: Question[],
    wanted: number | undefined,
    eligible: (q: Question) => boolean,
  ): Question | undefined {
    if (!pool.length) return undefined;
    const key = deckKey(audience, categoryId);
    const byId = new Map(pool.map((q) => [q.id, q]));
    let deck = this.ensureDeck(key, pool);

    // Two passes at most: the current deck, then one freshly reshuffled. A
    // third would mean the filter rejects everything in the category, and
    // reshuffling forever is how a selector becomes an infinite loop in front
    // of a room.
    for (let attempt = 0; attempt < 2; attempt++) {
      const dealable = deck
        .map((id, position) => ({ id, position, q: byId.get(id) }))
        .filter((c): c is { id: string; position: number; q: Question } => !!c.q && eligible(c.q));

      if (dealable.length) {
        const best = wanted === undefined
          ? dealable[0]!
          : dealable.slice().sort(
              (a, b) =>
                Math.abs(a.q.difficulty - wanted) - Math.abs(b.q.difficulty - wanted) ||
                a.position - b.position,
            )[0]!;
        this.file.decks[key] = deck.filter((id) => id !== best.id);
        this.file.dealt[key] = [...(this.file.dealt[key] ?? []), best.id];
        this.dirty = true;
        return best.q;
      }

      // Nothing in the deck can be used tonight. If there are cards left they
      // are all filtered out, so a reshuffle changes nothing; only an empty
      // deck is worth refilling.
      if (deck.length) return undefined;
      deck = this.reshuffle(key, pool);
    }
    return undefined;
  }

  /** Cards left in a deck, for the MC's "how much is left" line. */
  remaining(audience: string, categoryId: string, pool: Question[]): number {
    return this.ensureDeck(deckKey(audience, categoryId), pool).length;
  }

  /** Times this group's cards in this category have been through once. */
  cycles(audience: string, categoryId: string): number {
    return this.file.cycles[deckKey(audience, categoryId)] ?? 0;
  }

  /** Persist. Called from the engine's commit, so a crash costs one question. */
  save() {
    if (!this.dirty) return;
    this.store.saveRotation(this.file);
    this.dirty = false;
  }

  /** Start every category over. The MC's "we have new people, reuse it all". */
  reset() {
    this.file = { decks: {}, dealt: {}, cycles: {} };
    this.dirty = true;
    this.save();
  }

  /**
   * The deck for a category, created or topped up as needed.
   *
   * Questions added to the bank since the deck was built are appended in
   * shuffled order rather than triggering a reshuffle. Reshuffling on every
   * content change would reset the rotation every time someone wrote a
   * question, which is the one thing this file exists to prevent. Ids that
   * have left the bank are dropped.
   */
  private ensureDeck(key: string, pool: Question[]): string[] {
    const live = new Set(pool.map((q) => q.id));
    const existing = this.file.decks[key];
    if (!existing) return this.reshuffle(key, pool);

    const kept = existing.filter((id) => live.has(id));
    const inDeck = new Set(kept);
    const alreadyDealt = new Set(this.file.dealt[key] ?? []);
    const fresh = pool.filter((q) => !inDeck.has(q.id) && !alreadyDealt.has(q.id)).map((q) => q.id);

    if (kept.length !== existing.length || fresh.length) {
      // New questions join the part of the deck still to be dealt, not the
      // front of it, so they are not all asked the week they are written.
      this.file.decks[key] = shuffle([...kept, ...fresh], this.rnd);
      this.dirty = true;
    }
    return this.file.decks[key]!;
  }

  private reshuffle(key: string, pool: Question[]): string[] {
    const deck = shuffle(pool.map((q) => q.id), this.rnd);
    this.file.decks[key] = deck;
    this.file.dealt[key] = [];
    this.file.cycles[key] = (this.file.cycles[key] ?? 0) + 1;
    this.dirty = true;
    return deck;
  }
}
