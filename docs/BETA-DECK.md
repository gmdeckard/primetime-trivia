# The Beta Night Deck

One hundred questions written on 2026-11-07 for the clubhouse beta test, as
`content/packs/beta1.yaml`. Switch it on alone under Questions and set
questions per round to 10.

## Shape

Ten categories, ten questions each: `history-20c`, `american-history`,
`geography`, `sports`, `film-tv`, `music-popular`, `natural-world`,
`space-aviation`, `invention-tech`, `literature`.

Ten categories is the number that makes a mixed round clean. The selector draws
a round of ten from ten different categories, so at ten each no category is
asked twice in a round, and the deck holds ten full rounds. The Christmas deck
uses the same trick at six.

The difficulty spread copies `DEFAULT_CONFIG.difficultyMix`
(`[2,2,3,3,4,3,3,4,3,4]`) exactly: two difficulty 2, five difficulty 3 and
three difficulty 4 in every category, which is 20/50/30 across the deck. A
default night therefore draws this deck at the shape it was written for, which
is the point of running it as the beta.

No difficulty 1 questions, because the default mix never asks for one.

## Where the questions came from

Topics were seeded from OpenTDB (opentdb.com, CC BY-SA 4.0), pulling 50
questions from each of eleven of its categories, about 550 seeds in all. The
raw files are not kept in the repo.

**No OpenTDB text is in the deck.** Every prompt, answer, distractor set and
fact line was written here. The seeds were used as a list of subjects worth
asking about, which is the same way `docs/EASY-SET-ONE.md` records that batch
being built.

That was not a stylistic preference. OpenTDB's own text fails this project's
style guide on three counts, often all at once:

- **Era.** Its sports pool is mostly post-1995 European football and Formula
  One. Rule 3 in `docs/QUESTION-STYLE.md` stops at about 1995.
- **Distractors.** Real examples from the pull: "Sheep" as a wrong answer to a
  question about the Dead Sea Scrolls, "Barcelona" as a place in Cornwall.
  Rule 1 wants every distractor defensible.
- **Accuracy and form.** Typos in the prompts ("two young shepards"), and a lot
  of NOT-questions, which do not read well at 48 point from the back of a room.

So seeds that could not survive a rewrite were dropped rather than fixed, and
the thin categories were topped up from the same subject areas.

## Verification

Every question was checked against live sources, one at a time, before the deck
was committed. Three gates:

1. **`npm run validate`** — structural. Caught ten collisions with the existing
   bank: four exact duplicate prompts and six near-duplicates at 67% to 100% of
   the prompt. All ten were replaced, because a question the room has already
   played is not a test of anything.
2. **`npm run collide`** — giveaways. Caught one real in-deck fault: the fact
   line on `beta-059` named Syd Barrett, who is the answer to `beta-053`, two
   questions away in the same category. Rewritten. The deck now has zero in-deck
   giveaways. The 56 remaining cross-pack hits are `adult1`/`adult2` fact lines
   that mention a beta answer, which cannot fire on a night when only this pack
   is switched on.
3. **`npm run fact-check`** (offline passes) — found four, all fixed:
   - `beta-027` ranked something that re-ranks ("largest Muslim population")
     with no date. Anchored to 2020.
   - `beta-013`, `beta-066` and `beta-089` had reveal sentences that named their
     own distractors and granted them. Rewritten to keep the interesting part
     and drop the concession.

Then the live-source pass, question by question, against the relevant reference
article for each: is the marked answer right, is the fact line right, and is
exactly one option defensible. Twenty questions were corrected or replaced as a
result, one of them withdrawn outright. The substantive ones:

| Question | Problem | Resolution |
|---|---|---|
| `beta-050` | Sources put Kurt Russell's Star Wars audition at Han Solo, not Luke Skywalker. The seed said Luke. | Question withdrawn and replaced with Leone's Dollars trilogy |
| `beta-058` | "Hocus Pocus" is a 1971 record; 1973 is when it charted in America | Date moved out of the prompt and stated properly in the fact |
| `beta-082` | The fact credited Bohlin with the three-point belt outright; an American patent predates him by four years | Fact rewritten to say both |
| `beta-028` | The fact called Longyearbyen the northernmost town; Ny-Alesund is the northernmost civilian settlement | Both named correctly |
| `beta-052` | The cowbell credit could not be sourced | Replaced with the sourced story about the lyric |
| `beta-097` | The fact said Bilbo was asleep during Smaug's death; he is not in the chapter at all | Corrected |
| `beta-099` | The fact read as though Fleming's son was the ill one; it was Fleming | Corrected |
| `beta-071` | "weighs less than our moon" was true but useless | Given the real figure, about 3% of the moon |
| `beta-078` | The first animals in space flew in July 1946; 1947 is when a batch first came back alive | Both dates stated correctly |
| `beta-091` | The claim that Verne named the Nautilus after Fulton's submarine could not be sourced | Replaced with the novel's own description |
| `beta-018` | "Vicksburg did not celebrate the Fourth for decades" is repeated everywhere and sourced nowhere | Replaced with the Gettysburg timing |
| `beta-059` | "the only album made while Barrett was still writing" overstated it | Narrowed to what he wrote |
| `beta-002`, `beta-021`, `beta-065`, `beta-083`, `beta-089` | numbers stated more precisely than the sources support | Loosened or corrected to match |

Two claims the article pass could not settle were closed by search instead:
Delaware ratifying first on 7 December 1787, unanimously and five days ahead of
Pennsylvania, and Washington riding out at the head of roughly 13,000 militia in
1794, the only sitting president to do so.

**What this verification is not.** It is a documentary check against reference
articles, not a second model reading the deck cold, and no human has read these
hundred questions. `npm run fact-check --verify` (the model verifier) needs
`ANTHROPIC_API_KEY`, which is not set on this box, so that pass has not run.
`docs/AUTHORING.md` is explicit that generated questions are drafts until a
person approves them, and this deck has not had that. Read it before the night.

The pattern from `docs/FACT-CHECK.md` held up: the errors found were almost all
in the fact line, the part read aloud, rather than in the answer. One answer was
wrong out of a hundred.
