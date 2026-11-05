# Easy Set One

A batch of 79 difficulty 1 and 2 questions, written 2026-11-05 to fill the easy
end of the adult bank, which held 21 difficulty-1 questions across 26
categories before it. It shipped as its own pack, `content/packs/easy1.yaml`,
and on 2026-11-05 it was folded into `adult1` and `adult2` and the pack file
was deleted.

## Why it was folded in

A pack is a thing the MC switches on in Setup. `easy1` sat next to the adult
sets as a fourth toggle, which meant the easy end of four categories was
reachable only if somebody remembered to turn it on. The questions were written
for the adult room, not for a themed night, so they belong in the decks the
adult room already plays.

`DEFAULT_CONFIG.packs` in `shared/protocol.ts` listed `easy1`, so a fresh night
did draw from it. That entry is gone with the pack.

## Where the 79 went

The split equalizes the difficulty-2 pool per category across the two decks,
rather than halving the batch. The shortage was not even: before the move
adult1 had one difficulty-2 consumer-electronics question against adult2's
seven, while in sports it was adult2 that was thin, 7 against 18. 44 went to
adult1 and 35 to adult2.

| Category | adult1 d2 before / after | adult2 d2 before / after |
|---|---|---|
| sports | 18 / 19 | 7 / 18 |
| invention-tech | 5 / 15 | 8 / 14 |
| consumer-electronics | 1 / 11 | 7 / 11 |
| computers-internet | 2 / 12 | 7 / 12 |

File totals after the move: adult1 sports 54, invention-tech 34,
consumer-electronics 20, computers-internet 27; adult2 sports 50,
invention-tech 43, consumer-electronics 41, computers-internet 41.

Bank-wide category totals did not change, because nothing was added or
dropped. `npm run validate` reports the same difficulty spread as before the
move, 1:49 2:560 3:937 4:539, which is the check that no question was lost or
duplicated on the way across.

## The difficulty-1 questions are still dormant

`DEFAULT_CONFIG.difficultyMix` is `[2,2,3,3,4,3,3,4,3,4]`. It never asks for
difficulty 1, so the 22 difficulty-1 questions in this batch are reached only
when the MC lowers the mix, or when a category runs so dry that the selector's
relaxed fallback takes any difficulty it can find. The 57 difficulty-2
questions are the ones this move actually put into play. Folding the batch in
did not make the bank easier by itself; it made the easy end available without
a second pack switched on.

## Provenance

- Generated with claude-opus-5 in a Claude Code session.
- Fact-checked by GPT-5 via Codex and by Claude Sonnet in a clean context. No
  human review.
- Some were seeded by topic from OpenTDB (opentdb.com, CC BY-SA 4.0) and then
  rewritten here with new distractors and new fact lines. The pack header did
  not record which ones, so the attribution is carried on the batch as a whole,
  in this file and in a comment above the folded-in block of each destination
  file.

## Id mapping

Ids were renumbered into each destination file's own scheme, so nothing in
those files looks imported. adult1's `invention-tech`,
`consumer-electronics` and `computers-internet` share one `inv-` number space
across the three files, which is why the adult1 tech ids run 033 to 071 rather
than restarting per file.

The fact-check passes above were run against the old ids, so this is the table
that connects their output to the questions as they now stand.

| Old id | New id | Deck | Difficulty | Category |
|---|---|---|---|---|
| easy1-001 | a2-spo-036 | adult2 | 1 | sports |
| easy1-002 | spo-041 | adult1 | 1 | sports |
| easy1-003 | a2-spo-037 | adult2 | 1 | sports |
| easy1-004 | spo-042 | adult1 | 1 | sports |
| easy1-005 | a2-spo-038 | adult2 | 1 | sports |
| easy1-006 | spo-043 | adult1 | 1 | sports |
| easy1-007 | a2-spo-039 | adult2 | 2 | sports |
| easy1-008 | a2-spo-040 | adult2 | 1 | sports |
| easy1-009 | a2-spo-041 | adult2 | 2 | sports |
| easy1-010 | a2-spo-042 | adult2 | 2 | sports |
| easy1-011 | a2-spo-043 | adult2 | 2 | sports |
| easy1-012 | a2-spo-044 | adult2 | 2 | sports |
| easy1-013 | a2-spo-045 | adult2 | 2 | sports |
| easy1-014 | spo-044 | adult1 | 2 | sports |
| easy1-015 | a2-spo-046 | adult2 | 2 | sports |
| easy1-016 | a2-spo-047 | adult2 | 2 | sports |
| easy1-017 | a2-spo-048 | adult2 | 2 | sports |
| easy1-018 | spo-045 | adult1 | 1 | sports |
| easy1-019 | a2-spo-049 | adult2 | 2 | sports |
| easy1-020 | a2-spo-050 | adult2 | 2 | sports |
| easy1-021 | inv-059 | adult1 | 1 | computers-internet |
| easy1-022 | inv-060 | adult1 | 2 | computers-internet |
| easy1-023 | a2-cmp-036 | adult2 | 2 | computers-internet |
| easy1-024 | a2-cmp-037 | adult2 | 1 | computers-internet |
| easy1-025 | inv-061 | adult1 | 1 | computers-internet |
| easy1-026 | inv-062 | adult1 | 2 | computers-internet |
| easy1-027 | inv-063 | adult1 | 2 | computers-internet |
| easy1-028 | a2-cmp-038 | adult2 | 2 | computers-internet |
| easy1-029 | inv-064 | adult1 | 2 | computers-internet |
| easy1-030 | inv-065 | adult1 | 2 | computers-internet |
| easy1-031 | a2-cmp-039 | adult2 | 2 | computers-internet |
| easy1-032 | inv-066 | adult1 | 2 | computers-internet |
| easy1-033 | inv-067 | adult1 | 2 | computers-internet |
| easy1-034 | a2-cmp-040 | adult2 | 2 | computers-internet |
| easy1-035 | inv-068 | adult1 | 1 | computers-internet |
| easy1-036 | inv-069 | adult1 | 2 | computers-internet |
| easy1-037 | inv-070 | adult1 | 2 | computers-internet |
| easy1-038 | a2-cmp-041 | adult2 | 2 | computers-internet |
| easy1-039 | inv-071 | adult1 | 2 | computers-internet |
| easy1-040 | inv-045 | adult1 | 2 | consumer-electronics |
| easy1-041 | inv-046 | adult1 | 1 | consumer-electronics |
| easy1-042 | a2-cel-036 | adult2 | 1 | consumer-electronics |
| easy1-043 | a2-cel-037 | adult2 | 2 | consumer-electronics |
| easy1-044 | inv-047 | adult1 | 2 | consumer-electronics |
| easy1-045 | inv-048 | adult1 | 2 | consumer-electronics |
| easy1-046 | inv-049 | adult1 | 2 | consumer-electronics |
| easy1-047 | a2-cel-038 | adult2 | 2 | consumer-electronics |
| easy1-048 | inv-050 | adult1 | 2 | consumer-electronics |
| easy1-049 | inv-051 | adult1 | 1 | consumer-electronics |
| easy1-050 | inv-052 | adult1 | 1 | consumer-electronics |
| easy1-051 | inv-053 | adult1 | 2 | consumer-electronics |
| easy1-052 | a2-cel-039 | adult2 | 2 | consumer-electronics |
| easy1-053 | a2-cel-040 | adult2 | 1 | consumer-electronics |
| easy1-054 | inv-054 | adult1 | 2 | consumer-electronics |
| easy1-055 | inv-055 | adult1 | 2 | consumer-electronics |
| easy1-056 | inv-056 | adult1 | 2 | consumer-electronics |
| easy1-057 | inv-057 | adult1 | 1 | consumer-electronics |
| easy1-058 | a2-cel-041 | adult2 | 2 | consumer-electronics |
| easy1-059 | inv-058 | adult1 | 2 | consumer-electronics |
| easy1-060 | a2-inv-036 | adult2 | 1 | invention-tech |
| easy1-061 | inv-033 | adult1 | 2 | invention-tech |
| easy1-062 | inv-034 | adult1 | 1 | invention-tech |
| easy1-063 | a2-inv-037 | adult2 | 1 | invention-tech |
| easy1-064 | a2-inv-038 | adult2 | 2 | invention-tech |
| easy1-065 | inv-035 | adult1 | 1 | invention-tech |
| easy1-066 | inv-036 | adult1 | 2 | invention-tech |
| easy1-067 | a2-inv-039 | adult2 | 2 | invention-tech |
| easy1-068 | inv-037 | adult1 | 2 | invention-tech |
| easy1-069 | inv-038 | adult1 | 2 | invention-tech |
| easy1-070 | a2-inv-040 | adult2 | 2 | invention-tech |
| easy1-071 | inv-039 | adult1 | 2 | invention-tech |
| easy1-072 | inv-040 | adult1 | 2 | invention-tech |
| easy1-073 | a2-inv-041 | adult2 | 2 | invention-tech |
| easy1-074 | inv-041 | adult1 | 2 | invention-tech |
| easy1-075 | a2-inv-042 | adult2 | 2 | invention-tech |
| easy1-076 | inv-042 | adult1 | 2 | invention-tech |
| easy1-077 | inv-043 | adult1 | 2 | invention-tech |
| easy1-078 | a2-inv-043 | adult2 | 2 | invention-tech |
| easy1-079 | inv-044 | adult1 | 2 | invention-tech |
