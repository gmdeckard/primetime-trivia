import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import type { Category, Difficulty, Question } from '../../shared/protocol.js';

/**
 * Content lives as YAML in content/ and is loaded into memory at boot.
 *
 * Why not a database: the entire bank at 5,000 questions is about 2 MB of
 * JavaScript objects, so there is nothing to gain from SQL, and YAML files
 * give us the thing a question bank actually needs — reviewable pull requests.
 * A reviewer can see that someone changed a date from 1944 to 1943; nobody can
 * review a diff of a binary .db file.
 *
 * The authoring shape deliberately does NOT use an answer index. Contributors
 * write `answer:` and `distractors:`, and we shuffle at serve time. Index-based
 * authoring produces silent off-by-one errors that survive review, and a fixed
 * order means the right answer sits in the same position every time it is asked.
 */

export interface ContentIssue {
  file: string;
  id?: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface Bank {
  categories: Category[];
  categoryById: Map<string, Category>;
  questions: Question[];
  byCategory: Map<string, Question[]>;
  issues: ContentIssue[];
}

interface RawQuestion {
  id?: unknown;
  difficulty?: unknown;
  prompt?: unknown;
  answer?: unknown;
  distractors?: unknown;
  answerNumber?: unknown;
  kind?: unknown;
  fact?: unknown;
  image?: unknown;
  era?: unknown;
  tags?: unknown;
  source?: unknown;
  license?: unknown;
}

const MAX_PROMPT = 240;

function walkYaml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkYaml(full));
    } else if (/\.ya?ml$/i.test(entry) && entry !== 'categories.yaml') {
      out.push(full);
    }
  }
  return out.sort();
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Like asString, but accepts a bare number.
 *
 * A contributor writing `answer: 1968` is doing the natural thing, and YAML
 * hands it to us as a number. Rejecting that would mean every year-based
 * question needed quotes, which is exactly the sort of papercut that makes
 * people stop sending questions.
 */
function asText(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return asString(v);
}

export function loadBank(contentDir: string): Bank {
  const issues: ContentIssue[] = [];
  const categories: Category[] = [];
  const categoryById = new Map<string, Category>();

  const catPath = join(contentDir, 'categories.yaml');
  if (!existsSync(catPath)) {
    issues.push({ file: 'categories.yaml', message: 'missing category registry', severity: 'error' });
  } else {
    const raw = parse(readFileSync(catPath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) {
      issues.push({ file: 'categories.yaml', message: 'expected a list of categories', severity: 'error' });
    } else {
      for (const entry of raw as Array<Record<string, unknown>>) {
        const id = asString(entry.id);
        const name = asString(entry.name);
        if (!id || !name) {
          issues.push({ file: 'categories.yaml', message: `category needs id and name: ${JSON.stringify(entry)}`, severity: 'error' });
          continue;
        }
        if (categoryById.has(id)) {
          issues.push({ file: 'categories.yaml', id, message: 'duplicate category id', severity: 'error' });
          continue;
        }
        const cat: Category = {
          id,
          name,
          blurb: asString(entry.blurb) ?? '',
          sample: asString(entry.sample),
        };
        categories.push(cat);
        categoryById.set(id, cat);
      }
    }
  }

  const questions: Question[] = [];
  const seenIds = new Set<string>();
  const seenPrompts = new Map<string, string>();

  for (const file of walkYaml(contentDir)) {
    const rel = relative(contentDir, file).split(sep).join('/');
    let doc: unknown;
    try {
      doc = parse(readFileSync(file, 'utf8'));
    } catch (err) {
      issues.push({ file: rel, message: `YAML parse error: ${(err as Error).message}`, severity: 'error' });
      continue;
    }
    if (!doc || typeof doc !== 'object') {
      issues.push({ file: rel, message: 'empty or malformed file', severity: 'error' });
      continue;
    }
    const { category, questions: list, pack, audience } = doc as {
      category?: unknown;
      questions?: unknown;
      pack?: Record<string, unknown>;
      audience?: unknown;
    };

    // A pack file carries its own header. Its id tags every question in it so
    // the MC can switch the whole pack on or off for a night.
    const packId = pack ? asString(pack.id) : undefined;
    if (pack && !packId) {
      issues.push({ file: rel, message: '`pack:` block needs an `id`', severity: 'error' });
      continue;
    }
    const fileAudience = asString(audience) ?? (pack ? asString(pack.audience) : undefined);

    // A file-level category is the default; a pack may span several, so each
    // question may name its own instead.
    const fileCategory = asString(category);
    if (!Array.isArray(list)) {
      issues.push({ file: rel, message: 'file needs a `questions:` list', severity: 'error' });
      continue;
    }

    for (const rawUnknown of list) {
      const raw = rawUnknown as RawQuestion & { category?: unknown; audience?: unknown };
      const categoryId = asString(raw.category) ?? fileCategory;
      const id = asString(raw.id);
      const prompt = asText(raw.prompt);
      const fact = asText(raw.fact);
      const kind = raw.kind === 'number' ? 'number' : 'choice';
      const fail = (message: string) => issues.push({ file: rel, id, message, severity: 'error' });

      if (!categoryId) {
        fail('needs a `category:` — set one on the file or on the question');
        continue;
      }
      if (!categoryById.has(categoryId)) {
        fail(`unknown category "${categoryId}" (add it to categories.yaml)`);
        continue;
      }
      if (!id) { fail('question is missing `id`'); continue; }
      if (seenIds.has(id)) { fail('duplicate question id'); continue; }
      if (!prompt) { fail('question is missing `prompt`'); continue; }
      if (!fact) { fail('question is missing `fact` (the reveal line is required)'); continue; }

      const difficulty = Number(raw.difficulty);
      if (![1, 2, 3, 4].includes(difficulty)) { fail('`difficulty` must be 1-4'); continue; }

      if (prompt.length > MAX_PROMPT) {
        issues.push({ file: rel, id, message: `prompt is ${prompt.length} chars; keep under ${MAX_PROMPT} so it fits the host screen at readable size`, severity: 'warning' });
      }

      const normalisedPrompt = prompt.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const clash = seenPrompts.get(normalisedPrompt);
      if (clash) {
        issues.push({ file: rel, id, message: `prompt duplicates ${clash}`, severity: 'warning' });
      } else {
        seenPrompts.set(normalisedPrompt, id);
      }

      const q: Question = {
        id,
        category: categoryId,
        difficulty: difficulty as Difficulty,
        prompt,
        funFact: fact,
        kind,
        image: asString(raw.image),
        era: asString(raw.era),
        tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(String) : undefined,
        source: asString(raw.source),
        license: asString(raw.license),
        audience: asString(raw.audience) ?? fileAudience,
        pack: packId,
      };

      if (kind === 'number') {
        const n = Number(raw.answerNumber);
        if (!Number.isFinite(n)) { fail('numeric question needs `answerNumber`'); continue; }
        q.answerNumber = n;
      } else {
        const answer = asText(raw.answer);
        const distractors = Array.isArray(raw.distractors)
          ? (raw.distractors as unknown[]).map((d) => asText(d)).filter((d): d is string => !!d)
          : [];
        if (!answer) { fail('question is missing `answer`'); continue; }
        if (distractors.length !== 3) {
          fail(`needs exactly 3 distractors, found ${distractors.length}`);
          continue;
        }
        const all = [answer, ...distractors];
        const lower = all.map((a) => a.toLowerCase());
        if (new Set(lower).size !== all.length) { fail('answer and distractors must all differ'); continue; }
        // Stored answer-first; shuffled per asking in the selector.
        q.choices = all;
        q.answerIndex = 0;
      }

      if (q.image) {
        const imgPath = join(contentDir, 'images', q.image);
        if (!existsSync(imgPath)) {
          issues.push({ file: rel, id, message: `image not found: images/${q.image}`, severity: 'warning' });
        }
      }

      seenIds.add(id);
      questions.push(q);
    }
  }

  const byCategory = new Map<string, Question[]>();
  for (const cat of categories) byCategory.set(cat.id, []);
  for (const q of questions) byCategory.get(q.category)!.push(q);

  for (const cat of categories) {
    const n = byCategory.get(cat.id)!.length;
    if (n === 0) {
      issues.push({ file: 'categories.yaml', id: cat.id, message: 'category has no questions', severity: 'warning' });
    }
  }

  return { categories, categoryById, questions, byCategory, issues };
}
