import { MAX_BATCH, type DraftQuestion, type GenerateRequest } from '../../shared/packs.js';
import type { Bank } from './content.js';
import { normalisePrompt } from './author.js';

/**
 * Importing questions from the Open Trivia Database.
 *
 * This exists to fill a thin category in a hurry. It is not a substitute for
 * the Claude path and the screen should never imply that it is.
 *
 * Three things about the source shape everything below.
 *
 * First, it supplies no reveal line, and `content.ts` requires one for every
 * question. So an import is only half a question until something writes the
 * fact — see `writeFacts` in author.ts. That is the real cost of this feature.
 *
 * Second, its difficulty labels do not mean what this project means. It files
 * "The Battle of Hastings was fought in which year?" under hard. Three labels
 * map onto 1-3 and nothing honestly reaches 4, so a request for difficulty 4
 * is filled with the hardest thing available and the batch says so rather
 * than relabelling someone else's easy question as this project's hardest.
 *
 * Third, its distractors are frequently indefensible by rule 1 of the house
 * style: 1066 against 911, 1204 and 1420 is not four plausible options. The
 * fact-writing pass flags those so the reviewer sees them before publishing,
 * and the default for a flagged question is rejected.
 */

const API = 'https://opentdb.com/api.php';

/** OpenTDB's own rate limit is one request per five seconds per IP. */
const REQUEST_SPACING_MS = 5_200;

/** The most OpenTDB will return in one request. */
const MAX_PER_REQUEST = 50;

/**
 * This project's categories mapped onto OpenTDB's twenty-four.
 *
 * Deliberately sparse. OpenTDB has no military history, no space, no
 * medicine and no explorers, and the temptation is to point those at
 * "General Knowledge" or at the nearest big category and let the reviewer
 * sort it out. That produces a geography question sitting in US States &
 * Places and a chemistry question in Physics & Chemistry that is actually
 * about hedgehogs. A category with no honest counterpart is better offered
 * as unavailable, which is why the screen greys it out and says why.
 *
 * `general` is never used as a fallback for the same reason.
 */
export const OPENTDB_CATEGORIES: Record<string, number[]> = {
  // Politics only, deliberately. OpenTDB's History category (23) spans every
  // period, so feeding it to a category named for one century returns the
  // other nineteen: a measured batch here came back as Marj Dabiq in 1516, the
  // French Revolution and the Second Mexican Empire, and the category gate
  // rejected all of it after the MC had paid for the reveal lines. Politics
  // (24) is where the twentieth century actually lives in this source -
  // Watergate, Chamberlain, Pinochet. History still feeds world-history below,
  // which is the category that wants it.
  'history-20c': [24],
  geography: [22],
  literature: [10],
  'arts-classical': [25],
  'natural-world': [17, 27],
  'physics-chemistry': [17],
  'world-affairs': [24],
  'film-tv': [11, 14],
  'music-popular': [12],
  sports: [21],
  'stage-musicals': [13],
  'world-history': [23],
  'computers-internet': [18],
  'consumer-electronics': [30],
  'invention-tech': [30],
  transportation: [28],
};

/** Why a category cannot be imported, for the screen to show in the tooltip. */
export const UNAVAILABLE_REASON: Record<string, string> = {
  'military-history': 'Open Trivia DB has no military category.',
  medicine: 'Open Trivia DB has no medicine category.',
  'space-aviation': 'Open Trivia DB has no space or aviation category.',
  'business-economics': 'Open Trivia DB has no business category.',
  'words-language': 'Open Trivia DB has no language category.',
  'food-drink': 'Open Trivia DB has no food category.',
  'us-places': 'Open Trivia DB geography is worldwide, so it cannot fill a US-only category.',
  'radio-comedy': 'Open Trivia DB has no radio or comedy category.',
  explorers: 'Open Trivia DB has no exploration category.',
  'american-history': 'Open Trivia DB history is worldwide, so it cannot fill a US-only category.',
  tiebreakers: 'Tiebreakers are numeric; this source only has multiple choice.',
  'xmas-history': 'Open Trivia DB has no Christmas categories.',
  'xmas-traditions': 'Open Trivia DB has no Christmas categories.',
  'xmas-animation': 'Open Trivia DB has no Christmas categories.',
  'xmas-carols': 'Open Trivia DB has no Christmas categories.',
  'xmas-movies': 'Open Trivia DB has no Christmas categories.',
  'xmas-stage': 'Open Trivia DB has no Christmas categories.',
};

export function importableCategories(): string[] {
  return Object.keys(OPENTDB_CATEGORIES);
}

export class ImportUnavailable extends Error {}

interface OpenTdbResult {
  type: string;
  difficulty: string;
  category: string;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}

interface OpenTdbResponse {
  response_code: number;
  results?: OpenTdbResult[];
}

/** OpenTDB's documented response codes, in the words the MC should see. */
function describeResponseCode(code: number): string {
  switch (code) {
    case 1:
      return 'Open Trivia DB has no questions left for that category. Try a different one, or fewer.';
    case 2:
      return 'Open Trivia DB rejected the request parameters.';
    case 3:
    case 4:
      return 'The Open Trivia DB session token expired. Try again.';
    case 5:
      return 'Open Trivia DB is rate limiting this address. Wait half a minute and try again.';
    default:
      return `Open Trivia DB returned an unexpected status (${code}).`;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One request per mapped OpenTDB category, spaced for their rate limit.
 *
 * Fetches the maximum and buckets difficulty locally rather than asking once
 * per difficulty. Their limit makes every extra request cost five seconds, and
 * a request per (category, difficulty) pair meant a six-question batch sat
 * there for half a minute. The larger pool also gives dedupe something to
 * work with when the bank already holds the obvious questions.
 */
async function fetchPool(categoryIds: number[], signal?: AbortSignal): Promise<OpenTdbResult[]> {
  const pool: OpenTdbResult[] = [];
  let firstError: string | undefined;

  for (const [i, id] of categoryIds.entries()) {
    if (i > 0) await sleep(REQUEST_SPACING_MS);

    const url = `${API}?amount=${MAX_PER_REQUEST}&category=${id}&type=multiple&encode=url3986`;
    let response: Response;
    try {
      response = await fetch(url, { signal, headers: { accept: 'application/json' } });
    } catch (err) {
      throw new ImportUnavailable(
        `Could not reach Open Trivia DB. Is this machine online? (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (!response.ok) {
      throw new ImportUnavailable(`Open Trivia DB returned HTTP ${response.status}.`);
    }

    const body = (await response.json()) as OpenTdbResponse;
    if (body.response_code !== 0 || !body.results?.length) {
      // One empty category is survivable when another mapped category filled
      // the pool; all of them empty is the error the MC needs to see.
      firstError ??= describeResponseCode(body.response_code);
      continue;
    }
    pool.push(...body.results);
  }

  if (!pool.length) throw new ImportUnavailable(firstError ?? 'Open Trivia DB returned nothing.');
  return pool;
}

/**
 * Their three labels on this project's four-point scale.
 *
 * Nothing maps to 4. Their "hard" is this project's 3 at best, and promoting
 * it would put a question the whole room knows in the slot reserved for the
 * one a few people get.
 */
function mapDifficulty(label: string): 1 | 2 | 3 {
  switch (label) {
    case 'easy':
      return 1;
    case 'hard':
      return 3;
    default:
      return 2;
  }
}

/** `encode=url3986` means every field comes back percent-encoded. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

/**
 * One row as OpenTDB returns it. Text fields arrive percent-encoded because
 * the request asks for `encode=url3986`; `decode` below undoes that, and
 * leaves plain text alone.
 */
export interface SourceRow {
  type: string;
  difficulty: string;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}

export interface ImportResult {
  questions: DraftQuestion[];
  rejectedDuplicates: string[];
  /** True when the MC asked for difficulty 4 and the source could not supply it. */
  difficultyCapped: boolean;
  /** How many the source offered before dedupe and filtering. */
  poolSize: number;
}

/**
 * Pull a batch from OpenTDB, shaped exactly like a generated one.
 *
 * Everything comes back with an empty `fact` and status 'pending'. The caller
 * is expected to run the fact-writing pass and then the existing verifier
 * before a human sees any of it.
 */
export async function importQuestions(
  request: GenerateRequest,
  bank: Bank,
  existingPackPrompts: string[] = [],
  signal?: AbortSignal,
): Promise<ImportResult> {
  const categoryIds = OPENTDB_CATEGORIES[request.category];
  if (!categoryIds?.length) {
    throw new ImportUnavailable(
      UNAVAILABLE_REASON[request.category] ??
        `Open Trivia DB has no counterpart for the category "${request.category}".`,
    );
  }
  if (!bank.categoryById.get(request.category)) {
    throw new Error(`Unknown category: ${request.category}`);
  }

  return shapeBatch(await fetchPool(categoryIds, signal), request, bank, existingPackPrompts);
}

/**
 * Turn a pool of source rows into drafts matching the requested shape.
 *
 * Separate from the fetch so the filtering, dedupe and difficulty fill can be
 * tested against a fixed pool rather than against whatever the internet feels
 * like returning today.
 */
export function shapeBatch(
  pool: SourceRow[],
  request: GenerateRequest,
  bank: Bank,
  existingPackPrompts: string[] = [],
): ImportResult {
  const count = Math.max(1, Math.min(MAX_BATCH, Math.round(request.count)));

  // Dedupe against the whole bank, not just this category: the same famous
  // fact turns up filed under History in one place and Politics in another.
  const seen = new Set([
    ...bank.questions.map((q) => normalisePrompt(q.prompt)),
    ...existingPackPrompts.map(normalisePrompt),
  ]);

  const rejectedDuplicates: string[] = [];
  const candidates: Array<{ difficulty: 1 | 2 | 3; draft: Omit<DraftQuestion, 'id'> }> = [];

  for (const raw of pool) {
    if (raw.type !== 'multiple') continue;

    const prompt = decode(raw.question);
    const answer = decode(raw.correct_answer);
    const distractors = raw.incorrect_answers.map(decode).filter(Boolean);

    if (!prompt || !answer) continue;
    if (distractors.length !== 3) continue;
    const options = [answer, ...distractors].map((o) => o.toLowerCase());
    if (new Set(options).size !== 4) continue;

    const key = normalisePrompt(prompt);
    if (seen.has(key)) {
      rejectedDuplicates.push(prompt);
      continue;
    }
    seen.add(key);

    const difficulty = mapDifficulty(raw.difficulty);
    candidates.push({
      difficulty,
      draft: {
        category: request.category,
        difficulty,
        prompt,
        answer,
        distractors,
        // Deliberately empty. The fact-writing pass fills it, and publishing
        // is impossible until something does.
        fact: '',
        era: '',
        tags: [],
        verdict: 'unchecked',
        verdictNote: '',
        suggestedAnswer: '',
        status: 'pending',
        source: 'Open Trivia Database (opentdb.com)',
        license: 'CC BY-SA 4.0',
      },
    });
  }

  // Fill the requested difficulty pattern, nearest-match, the same way
  // selector.ts fills a round from a thin category.
  const wanted = request.difficulties.length ? request.difficulties : [2, 3, 3, 4];
  const template = Array.from({ length: count }, (_, i) => wanted[i % wanted.length] ?? 2);
  const difficultyCapped = template.some((d) => d === 4) && !candidates.some((c) => c.difficulty >= 4);

  const remaining = [...candidates];
  const picked: DraftQuestion[] = [];
  for (const target of template) {
    if (!remaining.length) break;
    let bestIndex = 0;
    let bestGap = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const gap = Math.abs(remaining[i]!.difficulty - target);
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
      if (gap === 0) break;
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    picked.push({ id: `d${picked.length + 1}`, ...chosen!.draft });
  }

  return { questions: picked, rejectedDuplicates, difficultyCapped, poolSize: pool.length };
}
