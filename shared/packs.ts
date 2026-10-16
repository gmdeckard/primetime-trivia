/**
 * Question packs: optional bundles of questions the MC can switch on for a
 * night, alongside the curated core bank.
 *
 * Packs exist because the core bank is aimed squarely at one audience. A pack
 * lets a venue add "1970s Television" or a set pitched at a younger crowd
 * without anyone editing the questions that ship with the project.
 *
 * A generated pack is just a file. Nothing about it is special at game time —
 * by the time the engine sees a question it has already been through human
 * review, so the runtime has no idea where it came from and no reason to care.
 */

/** Who the questions are pitched at. Drives era weighting during generation. */
export type Audience = '35-75' | '18-35' | '8-12' | 'family' | 'any';

export const AUDIENCES: Array<{ id: Audience; name: string; blurb: string }> = [
  { id: '35-75', name: '35 to 75', blurb: 'Formative years roughly 1961-2010. The core audience.' },
  { id: '18-35', name: '18 to 35', blurb: 'Formative years roughly 2000 onward.' },
  { id: '8-12', name: 'Kids 8 to 12', blurb: 'Primary and middle school. Nothing that needs adult life experience.' },
  { id: 'family', name: 'All ages', blurb: 'Mixed groups with children present. Nothing era-dependent.' },
  { id: 'any', name: 'No preference', blurb: 'General knowledge with no era weighting.' },
];

export interface PackMeta {
  id: string;
  name: string;
  audience: Audience;
  /** ISO date the pack was published. */
  created: string;
  /** 'curated' ships with the project; 'generated' came from the author screen. */
  origin: 'curated' | 'generated';
  /** Model used, when generated. Recorded for provenance, not for runtime. */
  model?: string;
  /** Who approved the questions. Required for generated packs. */
  reviewedBy?: string;
  notes?: string;
  questionCount: number;
}

/** A generated question awaiting human review. Never reaches a game in this state. */
export interface DraftQuestion {
  id: string;
  category: string;
  difficulty: 1 | 2 | 3 | 4;
  prompt: string;
  answer: string;
  distractors: string[];
  fact: string;
  era: string;
  tags: string[];
  /** Result of the independent verification pass. */
  verdict: 'correct' | 'suspect' | 'wrong' | 'unchecked';
  verdictNote: string;
  /** What the verifier thought the answer should be, when it disagreed. */
  suggestedAnswer: string;
  /** Set by the reviewer. Only 'approved' drafts can be published. */
  status: 'pending' | 'approved' | 'rejected';
}

export interface DraftBatch {
  id: string;
  created: string;
  audience: Audience;
  category: string;
  requested: number;
  model: string;
  /** Rough cost of the generate + verify calls, in US cents. */
  costCents: number;
  questions: DraftQuestion[];
  /** Prompts the model produced that duplicated something already in the bank. */
  rejectedDuplicates: string[];
}

export interface GenerateRequest {
  audience: Audience;
  category: string;
  /** How many to ask for. Capped server-side. */
  count: number;
  /** Difficulty spread, same 1-4 scale as the core bank. */
  difficulties: Array<1 | 2 | 3 | 4>;
  /** Free-text steer, e.g. "focus on the Apollo programme". Optional. */
  guidance?: string;
  model?: string;
}

export const MAX_BATCH = 20;
