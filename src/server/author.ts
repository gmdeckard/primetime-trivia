import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { MAX_BATCH, type Audience, type DraftQuestion, type GenerateRequest } from '../../shared/packs.js';
import type { Bank } from './content.js';

/**
 * Question generation, via the Claude API.
 *
 * Two things shape this module.
 *
 * First, it is an authoring tool, not part of the game. It needs internet and
 * an API key; the game needs neither. Generation happens at a kitchen table
 * before the season, never in the clubhouse.
 *
 * Second, nothing it produces is trusted. Every batch goes through an
 * independent verification pass and then a human, because a model will state a
 * wrong date with total confidence and this audience will catch it. The
 * verification pass is given the question cold, with no sight of the reasoning
 * that produced it, so it is checking the claim rather than agreeing with
 * itself.
 */

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Models worth offering, with list prices so the screen can estimate a batch. */
export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', inPerM: 4, outPerM: 20, blurb: 'Most capable. Best factual accuracy.' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', inPerM: 2, outPerM: 10, blurb: 'Faster and cheaper; check its work harder.' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', inPerM: 0.1, outPerM: 0.5, blurb: 'Cheapest. Expect more to be rejected.' },
] as const;

/**
 * Era guidance per audience. Someone aged 55-75 was between 10 and 25 roughly
 * between 1961 and 1996, and that window is where trivia lands hardest.
 */
const ERA_HINT: Record<Audience, string> = {
  '55-75': 'Players are 55 to 75, so their formative years ran roughly 1961-1996. Weight toward that window. Nothing that requires knowledge of anything after about 1995.',
  '35-55': 'Players are 35 to 55, so their formative years ran roughly 1981-2016. Weight toward that window.',
  '18-35': 'Players are 18 to 35, so their formative years ran roughly 1998 onward. Weight toward that window.',
  '8-12': 'Players are children of 8 to 12. Keep subject matter to what is taught at school or met in ordinary life: animals, space, the body, geography, sport, food, words. Nothing that needs adult experience, nothing frightening, and no alcohol, war casualties or politics.',
  family: 'Mixed ages including children. Avoid anything era-dependent, and keep subject matter suitable for all ages.',
  any: 'No particular era weighting. General knowledge across all periods.',
};

const SYSTEM = `You write multiple-choice trivia questions for a live pub-style quiz.

The audience is educated adults. Many hold advanced degrees. They are there to
be challenged, and they notice condescension immediately. A question they all
get right is wasted; a question nobody can reason toward is just annoying.

Rules, in order of importance:

1. ALL THREE DISTRACTORS MUST BE GENUINELY PLAUSIBLE. This is the rule that
   matters most and the one most question banks get wrong. If a well-read
   person could eliminate an option in under a second, it is a bad distractor.
   Distractors should be the same kind of thing as the answer: if the answer is
   a German general, the distractors are other German generals of the period.

2. EXACTLY ONE OPTION IS DEFENSIBLY CORRECT. No "most historians agree"
   ambiguity, no two options that are both arguably right, no trick phrasing.
   If a knowledgeable player could argue for a second option, rewrite it.

3. THE FACT IS REQUIRED AND IS THE POINT. After the reveal, the host reads one
   or two sentences that make the question worth having asked: why the wrong
   answers were tempting, the detail that makes it memorable, or the common
   misconception. A question with nothing interesting to say afterwards should
   not exist.

4. ONLY WELL-ESTABLISHED FACTS. Prefer things that are documented and settled.
   Do not invent statistics, dates, quotes or attributions. If you are not
   confident a fact is correct, write a different question instead. It is much
   better to return fewer questions than to return a wrong one.

5. KEEP THE PROMPT UNDER 200 CHARACTERS. It is read from a projector at the far
   end of a room. One clause beats two.

Difficulty, on a 1-4 scale:
  1 - nearly everyone in the room knows it
  2 - most will know it; a warm-up
  3 - about half the room, and they will argue about it
  4 - a few will know it outright; the rest can reason their way there

A difficulty 4 must still be reachable by reasoning. "Which Dutch city's bridge
was the furthest objective of Market Garden" is good. "What was the serial
number of the lead aircraft" is not — that is memorisation, not knowledge.`;

const GeneratedQuestion = z.object({
  prompt: z.string().describe('The question, under 200 characters.'),
  answer: z.string().describe('The single correct option.'),
  distractors: z.array(z.string()).describe('Exactly three plausible wrong options.'),
  fact: z.string().describe('One or two sentences read aloud after the reveal.'),
  difficulty: z.number().int().describe('1 to 4.'),
  era: z.string().describe('Decade the answer belongs to, e.g. "1960s". Empty string if not era-specific.'),
  tags: z.array(z.string()).describe('A few lowercase topic tags.'),
});

const GeneratedBatch = z.object({
  questions: z.array(GeneratedQuestion),
});

const VerificationResult = z.object({
  index: z.number().int().describe('Index of the question being judged, from the list given.'),
  verdict: z.enum(['correct', 'suspect', 'wrong']).describe(
    'correct = the marked answer is right and the others are clearly wrong. ' +
    'suspect = ambiguous, arguable, or a distractor that could also be defended. ' +
    'wrong = the marked answer is factually incorrect.',
  ),
  note: z.string().describe('One sentence explaining the verdict. Empty if plainly correct.'),
  suggestedAnswer: z.string().describe('The answer you believe is correct, if you disagree. Empty otherwise.'),
});

const VerificationBatch = z.object({
  results: z.array(VerificationResult),
});

export class MissingCredentials extends Error {
  constructor() {
    super(
      'No Anthropic credentials found. Set ANTHROPIC_API_KEY in the environment ' +
      'where you start the server, then reload this page.',
    );
  }
}

export function hasCredentials(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function client(): Anthropic {
  if (!hasCredentials()) throw new MissingCredentials();
  return new Anthropic();
}

function priceOf(modelId: string) {
  return MODELS.find((m) => m.id === modelId) ?? MODELS[0];
}

function centsFor(modelId: string, inputTokens: number, outputTokens: number): number {
  const price = priceOf(modelId);
  const dollars = (inputTokens / 1_000_000) * price.inPerM + (outputTokens / 1_000_000) * price.outPerM;
  return Math.round(dollars * 100 * 100) / 100;
}

/** Same normalisation the content validator uses, so dedupe agrees across both. */
export function normalisePrompt(prompt: string): string {
  return prompt.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface GenerateResult {
  questions: DraftQuestion[];
  rejectedDuplicates: string[];
  costCents: number;
  model: string;
}

export async function generateQuestions(
  request: GenerateRequest,
  bank: Bank,
  existingPackPrompts: string[] = [],
): Promise<GenerateResult> {
  const anthropic = client();
  const model = request.model ?? DEFAULT_MODEL;
  const count = Math.max(1, Math.min(MAX_BATCH, Math.round(request.count)));
  const category = bank.categoryById.get(request.category);
  if (!category) throw new Error(`Unknown category: ${request.category}`);

  // Show the model what already exists so it writes around it rather than
  // rediscovering the same twenty famous facts every batch.
  const samePool = bank.byCategory.get(request.category) ?? [];
  const existing = [...samePool.map((q) => q.prompt), ...existingPackPrompts];
  const sample = existing.slice(-120);

  const difficulties = request.difficulties.length ? request.difficulties : [2, 3, 3, 4];
  const wanted = Array.from({ length: count }, (_, i) => difficulties[i % difficulties.length]);

  const userPrompt = [
    `Category: ${category.name} — ${category.blurb}`,
    `Audience: ${ERA_HINT[request.audience]}`,
    '',
    `Write ${count} questions with this difficulty spread, in order: ${wanted.join(', ')}.`,
    request.guidance ? `\nExtra steer from the host: ${request.guidance}` : '',
    '',
    sample.length
      ? `These questions already exist in this category. Do not duplicate them or ask the same fact a different way:\n${sample.map((p) => `- ${p}`).join('\n')}`
      : '',
    '',
    'Return fewer than requested rather than include anything you are not confident is factually correct.',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await anthropic.messages.parse({
    model,
    max_tokens: 16000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
    output_config: {
      format: zodOutputFormat(GeneratedBatch),
      effort: 'high',
    },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`The model declined this request (${response.stop_details?.category ?? 'unspecified'}).`);
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('The model returned a response that did not match the expected shape.');

  const seen = new Set(existing.map(normalisePrompt));
  const rejectedDuplicates: string[] = [];
  const drafts: DraftQuestion[] = [];

  for (const raw of parsed.questions) {
    const prompt = raw.prompt.trim();
    const answer = raw.answer.trim();
    const distractors = raw.distractors.map((d) => d.trim()).filter(Boolean);

    // Structural rejects. These are cheap to check and not worth a human's time.
    if (!prompt || !answer || !raw.fact.trim()) continue;
    if (distractors.length !== 3) continue;
    const options = [answer, ...distractors].map((o) => o.toLowerCase());
    if (new Set(options).size !== 4) continue;

    const key = normalisePrompt(prompt);
    if (seen.has(key)) {
      rejectedDuplicates.push(prompt);
      continue;
    }
    seen.add(key);

    const difficulty = Math.min(4, Math.max(1, Math.round(raw.difficulty))) as 1 | 2 | 3 | 4;
    drafts.push({
      id: `d${drafts.length + 1}`,
      category: request.category,
      difficulty,
      prompt,
      answer,
      distractors,
      fact: raw.fact.trim(),
      era: raw.era.trim(),
      tags: raw.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
      verdict: 'unchecked',
      verdictNote: '',
      suggestedAnswer: '',
      status: 'pending',
    });
  }

  return {
    questions: drafts,
    rejectedDuplicates,
    model,
    costCents: centsFor(model, response.usage.input_tokens, response.usage.output_tokens),
  };
}

/**
 * Independent fact-check of a batch.
 *
 * Deliberately a separate request with no sight of the generation prompt or the
 * reasoning behind the questions — it is asked to judge the claims cold. A
 * verifier that can see why the question was written tends to agree with it.
 */
export async function verifyQuestions(
  drafts: DraftQuestion[],
  model = DEFAULT_MODEL,
): Promise<{ drafts: DraftQuestion[]; costCents: number }> {
  if (!drafts.length) return { drafts, costCents: 0 };
  const anthropic = client();

  const listing = drafts
    .map((d, i) => {
      const options = [d.answer, ...d.distractors];
      return [
        `[${i}] ${d.prompt}`,
        `    options: ${options.join(' | ')}`,
        `    marked correct: ${d.answer}`,
        `    stated fact: ${d.fact}`,
      ].join('\n');
    })
    .join('\n\n');

  const response = await anthropic.messages.parse({
    model,
    max_tokens: 16000,
    system:
      'You are fact-checking trivia questions before they are used in a live quiz ' +
      'in front of a well-educated audience. For each question, judge independently ' +
      'whether the option marked correct is actually correct, whether exactly one ' +
      'option is defensible, and whether the stated fact is accurate. ' +
      'Be strict. A question that is merely arguable should be marked suspect, not ' +
      'correct. You are the last check before a room of retired professionals sees ' +
      'this, and they will notice an error. Return one result for every question.',
    messages: [{ role: 'user', content: `Check these ${drafts.length} questions:\n\n${listing}` }],
    output_config: {
      format: zodOutputFormat(VerificationBatch),
      effort: 'high',
    },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to verify this batch.');
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Verification returned an unexpected shape.');

  const byIndex = new Map(parsed.results.map((r) => [r.index, r]));
  const checked = drafts.map((draft, i) => {
    const result = byIndex.get(i);
    if (!result) return draft;
    return {
      ...draft,
      verdict: result.verdict,
      verdictNote: result.note.trim(),
      suggestedAnswer: result.suggestedAnswer.trim(),
      // Anything the verifier doubted starts life rejected. The reviewer can
      // still approve it, but the default must never be "ships unless noticed".
      status: result.verdict === 'correct' ? ('pending' as const) : ('rejected' as const),
    };
  });

  return {
    drafts: checked,
    costCents: centsFor(model, response.usage.input_tokens, response.usage.output_tokens),
  };
}

export function describeError(err: unknown): string {
  if (err instanceof MissingCredentials) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return 'That API key was rejected. Check ANTHROPIC_API_KEY.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the API. Wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the API. Is this machine online?';
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
