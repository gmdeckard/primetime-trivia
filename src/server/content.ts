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

/**
 * The folder a question file sits in names the age group it was written for.
 *
 * `content/questions/8-12/kids1/geography.yaml` is geography for children, and
 * `content/questions/35-75/adult1/geography.yaml` is geography for the main
 * room.
 * Before this, both lived in one flat folder and the age group was a key
 * inside the file, which meant the kids' geography and the adults' geography
 * were the same file name apart and told apart only by reading them. Worse,
 * the two age sets were each one enormous file spanning eight categories,
 * so the only way to find the kids' sports questions was to scroll.
 *
 * `shared/` is the exception and names no age group: what is in it is
 * untagged and therefore in play whichever group the MC picks. The numeric
 * tiebreakers live there, because a tie has to be breakable on any night.
 *
 * A file deeper than one folder keeps the top one, so `55-75/history/wars.yaml`
 * is still 55-75. A file directly in `questions/` is untagged unless it says
 * otherwise, which is what packs and any legacy layout rely on.
 */
const SHARED_FOLDER = 'shared';

export function audienceFromPath(relPath: string): string | undefined {
  const parts = relPath.split('/');
  if (parts[0] !== 'questions' || parts.length < 3) return undefined;
  const folder = parts[1]!;
  return folder === SHARED_FOLDER ? undefined : folder;
}

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

  /**
   * Every question names a category, and every category has to be declared
   * here. That makes this one file able to invalidate the entire bank: lose
   * it, or mistype it, and all 919 questions report "unknown category" while
   * the one line that explains why scrolls off the top of the log.
   *
   * So it is read defensively and its failure is reported as what it is.
   */
  const catPath = join(contentDir, 'categories.yaml');
  if (!existsSync(catPath)) {
    issues.push({
      file: 'categories.yaml',
      message: `missing category registry — expected it at ${catPath}`,
      severity: 'error',
    });
  } else {
    let raw: unknown;
    try {
      raw = parse(readFileSync(catPath, 'utf8')) as unknown;
    } catch (err) {
      // Previously this threw straight out of loadBank, so a stray tab in the
      // registry took the server down with a YAML stack trace instead of a
      // sentence naming the file.
      issues.push({
        file: 'categories.yaml',
        message: `YAML parse error: ${(err as Error).message}`,
        severity: 'error',
      });
      raw = undefined;
    }
    if (raw === null || raw === undefined) {
      issues.push({ file: 'categories.yaml', message: 'the category registry is empty', severity: 'error' });
    } else if (!Array.isArray(raw)) {
      issues.push({
        file: 'categories.yaml',
        message: `expected a list of categories, found ${typeof raw}`,
        severity: 'error',
      });
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

  /**
   * With no categories, every single question is about to be rejected for
   * naming one. Reporting that per question buries the cause under hundreds
   * of identical lines, which is exactly how this failed in front of a room:
   * the log said "unknown category" nine hundred times and the sentence that
   * mattered was the first one, long since scrolled past.
   */
  const registryFailed = categoryById.size === 0;
  if (registryFailed) {
    issues.push({
      file: 'categories.yaml',
      message:
        'no categories loaded, so every question will be rejected — fix this file first, ' +
        'the errors below are all downstream of it',
      severity: 'error',
    });
  }

  const questions: Question[] = [];
  const seenIds = new Set<string>();
  const fileById = new Map<string, string>();

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
    // The folder wins over nothing, and loses to anything the file says.
    // Explicit beats implicit: a file that names its own audience is making a
    // deliberate statement, and silently overruling it from the directory name
    // would be the kind of magic that costs an hour to find.
    const fileAudience =
      asString(audience) ?? (pack ? asString(pack.audience) : undefined) ?? audienceFromPath(rel);

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
        // Silent when the registry itself failed: one cause, one message.
        if (!registryFailed) fail(`unknown category "${categoryId}" (add it to categories.yaml)`);
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
      fileById.set(q.id, rel);
      questions.push(q);
    }
  }

  findDuplicates(questions, fileById, issues);

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

/**
 * Function words carry no signal about what a question is asking, so they are
 * dropped before two prompts are compared. Deliberately short: words like
 * "first", "last" and "only" are exactly what distinguishes one question about
 * a subject from another, and must survive.
 */
const STOPWORDS = new Set(
  ('a an the of in on at to for from by with as is are was were be been did does do ' +
   'which what who whom whose where when how and or but if then than that this these those ' +
   'it its his her their there here you your we our they them he she').split(' '),
);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Three ways a question repeats itself, and they are not the same mistake.
 *
 * An identical prompt is a slip. An identical fact is the same question in a
 * different hat — the reveal is the thing the room actually hears, so two
 * questions that end in the same sentence are one question. Both are errors:
 * the bank is written in long sessions and a warning scrolls past.
 *
 * The third is the one that reaches a live night. Nobody writes the same
 * sentence twice, but "which organ produces insulin" and "insulin is produced
 * by which organ" are the same question, and only show up as a shared answer
 * plus heavy word overlap. That stays a warning, because the test is a
 * heuristic and a false positive should not block a night's content.
 */
function findDuplicates(
  questions: Question[],
  fileById: Map<string, string>,
  issues: ContentIssue[],
): void {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const at = (id: string) => fileById.get(id) ?? 'unknown';

  const audienceOf = new Map(questions.map((q) => [q.id, q.audience ?? '']));

  /**
   * Whether two questions can turn up in the same night.
   *
   * An untagged question serves every age group, so it meets everything. Two
   * questions tagged for different groups never meet, which is the point of
   * the tags: a kids set and the main bank are allowed to ask the same thing.
   * The exception is the MC picking No filter, which puts the whole bank in
   * play at once. That is real, but it is a deliberate choice for a mixed
   * night, so a collision there is worth a warning and not a blocked build.
   */
  const canMeet = (a: string, b: string): boolean => {
    const x = audienceOf.get(a) ?? '';
    const y = audienceOf.get(b) ?? '';
    return !x || !y || x === y;
  };

  const seenPrompt = new Map<string, string>();
  const seenFact = new Map<string, string>();
  const byAnswer = new Map<string, Array<{ id: string; words: Set<string> }>>();

  for (const q of questions) {
    const p = norm(q.prompt);
    const clash = seenPrompt.get(p);
    if (clash) {
      const meets = canMeet(q.id, clash);
      issues.push({
        file: at(q.id),
        id: q.id,
        message: meets
          ? `prompt duplicates ${clash}`
          : `prompt duplicates ${clash}, written for another age group (collides only under No filter)`,
        severity: meets ? 'error' : 'warning',
      });
    } else {
      seenPrompt.set(p, q.id);
    }

    const f = norm(q.funFact);
    const factClash = seenFact.get(f);
    if (factClash) {
      const meets = canMeet(q.id, factClash);
      issues.push({
        file: at(q.id),
        id: q.id,
        message: meets
          ? `fact duplicates ${factClash}`
          : `fact duplicates ${factClash}, written for another age group`,
        severity: meets ? 'error' : 'warning',
      });
    } else {
      seenFact.set(f, q.id);
    }

    // Grouped by answer so the near-duplicate scan stays linear in practice:
    // two questions with different answers are different questions.
    const answer = q.choices?.[q.answerIndex ?? 0] ?? (q.answerNumber !== undefined ? String(q.answerNumber) : '');
    if (!answer) continue;
    const key = norm(answer);
    const group = byAnswer.get(key) ?? [];
    const words = significantWords(q.prompt);
    for (const other of group) {
      // Different age groups never share a night, so they cannot repeat.
      if (!canMeet(q.id, other.id)) continue;
      // 0.4, not 0.6. At 0.6 three genuine repeats slipped through, all of
      // them the same question asked in different words. The cost of being
      // wrong is asymmetric: a false positive is one glance by a human, a
      // miss is the same question twice in front of a room. One known false
      // positive at this setting is "eleven players" in soccer and American
      // football, which share an answer and a shape but are different
      // questions. That is the trade, taken deliberately.
      const score = overlap(words, other.words);
      if (score >= 0.4) {
        issues.push({
          file: at(q.id),
          id: q.id,
          message: `looks like ${other.id}: same answer and ${Math.round(score * 100)}% of the prompt`,
          severity: 'warning',
        });
      }
    }
    group.push({ id: q.id, words });
    byAnswer.set(key, group);
  }
}
