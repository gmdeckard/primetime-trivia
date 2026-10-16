import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Durable state is three small JSON files plus an append-only event log.
 *
 * `night.json`    the live game, rewritten on every transition so a closed lid
 *                 or a yanked power cord costs at most the current question.
 * `rotation.json` the deck of unasked questions per category. This is what
 *                 keeps a venue running weekly from serving the same question
 *                 twice before it has served all the others, so it outlives
 *                 the night, the process and Reset everything.
 * `history.json`  question ids asked on past nights. A record now rather than
 *                 a rule: the rotation makes the stronger promise, and two
 *                 overlapping no-repeat rules could only disagree in the
 *                 direction of blocking a question that was due.
 * `events.jsonl`  every transition, for post-hoc "which questions were too
 *                 hard" analysis. Nothing reads it at runtime.
 */

export interface NightHistoryEntry {
  nightId: string;
  startedAt: string;
  questionIds: string[];
}

export interface History {
  nights: NightHistoryEntry[];
}

export class Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private path(name: string) {
    return join(this.dir, name);
  }

  /** Write via temp file + rename so a crash mid-write can't truncate the file. */
  private writeAtomic(name: string, data: unknown) {
    const target = this.path(name);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, target);
  }

  private readJson<T>(name: string, fallback: T): T {
    const target = this.path(name);
    if (!existsSync(target)) return fallback;
    try {
      return JSON.parse(readFileSync(target, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  loadNight<T>(): T | null {
    return this.readJson<T | null>('night.json', null);
  }

  saveNight(state: unknown) {
    this.writeAtomic('night.json', state);
  }

  clearNight() {
    this.writeAtomic('night.json', null);
  }

  loadHistory(): History {
    return this.readJson<History>('history.json', { nights: [] });
  }

  /**
   * The question rotation: which cards are left in each category's deck.
   *
   * Separate from history.json, which is a log of nights, because this is
   * live state with a different lifetime — it outlives a night, survives
   * Reset everything, and is the thing that promises a regular they will not
   * see the same question twice until they have seen them all.
   */
  loadRotation<T>(): T | null {
    return this.readJson<T | null>('rotation.json', null);
  }

  saveRotation(rotation: unknown) {
    this.writeAtomic('rotation.json', rotation);
  }

  /** Record (or update) tonight's asked questions, keeping the last 52 nights. */
  recordNight(entry: NightHistoryEntry) {
    const history = this.loadHistory();
    const existing = history.nights.findIndex((n) => n.nightId === entry.nightId);
    if (existing >= 0) history.nights[existing] = entry;
    else history.nights.push(entry);
    history.nights = history.nights.slice(-52);
    this.writeAtomic('history.json', history);
  }

  logEvent(event: Record<string, unknown>) {
    try {
      appendFileSync(this.path('events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
    } catch {
      // Logging is best-effort; never let it break a live game.
    }
  }
}
