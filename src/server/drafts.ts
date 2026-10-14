import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { DraftBatch } from '../../shared/packs.js';

/**
 * Draft batches live on disk so a review can be interrupted.
 *
 * Reviewing twenty questions properly takes a while, and the reviewer will
 * close the laptop halfway through. Keeping batches as files means they are
 * still there tomorrow, and means an unfinished review can't quietly turn into
 * published questions.
 */
export class DraftStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'drafts');
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string): string {
    // Ids are server-generated, but never build a path from caller input
    // without pinning the shape first.
    if (!/^[a-z0-9-]{1,64}$/i.test(id)) throw new Error('Bad draft id.');
    return join(this.dir, `${id}.json`);
  }

  save(batch: DraftBatch): void {
    const target = this.path(batch.id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(batch, null, 2), 'utf8');
    renameSync(tmp, target);
  }

  get(id: string): DraftBatch | null {
    const target = this.path(id);
    if (!existsSync(target)) return null;
    try {
      return JSON.parse(readFileSync(target, 'utf8')) as DraftBatch;
    } catch {
      return null;
    }
  }

  list(): DraftBatch[] {
    if (!existsSync(this.dir)) return [];
    const out: DraftBatch[] = [];
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, entry), 'utf8')) as DraftBatch);
      } catch {
        /* skip unreadable batches */
      }
    }
    return out.sort((a, b) => b.created.localeCompare(a.created));
  }

  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }
}
