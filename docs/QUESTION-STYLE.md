# Writing questions

The audience is the whole design constraint. Assume a room of people aged 55 to
75 who are retired but not remotely retiring: most hold a bachelor's degree,
many hold advanced degrees, roughly a third are military veterans, and between
them they have been to most of the countries you can name.

They do not want to be flattered. A round of easy questions is not gentle, it
is boring, and the people you most want in the room are the first to notice.

## The five rules

**1. Every distractor must be defensible.**

This is the single most important rule and the one most commercial question
banks ignore. If three options are obviously wrong, the question tests nothing.

```yaml
# Bad — nobody with a pulse picks the other three
prompt: Which general commanded the Afrika Korps?
answer: Erwin Rommel
distractors: [Napoleon Bonaparte, Dwight Eisenhower, Genghis Khan]

# Good — all four are plausible German generals of the period
prompt: Which general commanded the Afrika Korps?
answer: Erwin Rommel
distractors: [Heinz Guderian, Gerd von Rundstedt, Albert Kesselring]
```

A good test: could a reasonably well-read person argue briefly for each option
before settling? If not, rewrite the distractors.

**2. The `fact` is the point, not a footnote.**

The reveal is where the room talks to each other — someone says "I was
stationed there", someone else disagrees about the date. That conversation is
the actual product, and the game exists to produce it. A question with nothing
interesting to say afterwards is not worth asking, which is why `fact` is a
required field.

Good facts do one of these:

- explain why the wrong answers were tempting (`Doby followed him into the
  American League eleven weeks later`)
- add the detail that makes it memorable (`fewer than 6,000 ever returned home`)
- note the common misconception (`the first flag was judged too small`)

**3. Nothing after about 1995.**

Players born 1950-1970 were aged 10-25 between roughly 1961 and 1996, which is
the sweet spot. Later references are not unfair so much as uninteresting — they
reward having had a teenager in the house rather than having paid attention.

**4. Keep the prompt under about 200 characters.**

It has to be readable at 48 point from the back of a clubhouse. The validator
warns past 240. One clause is better than two.

**5. Set the difficulty honestly.**

| | Meaning | Share of bank |
|---|---|---|
| 1 | Nearly everyone in the room knows this | keep rare |
| 2 | Most will know it; a warm-up | common |
| 3 | Half the room, and they will argue | common |
| 4 | A few will know; the rest can reason toward it | common |

A difficulty 4 should still be *reachable*. "Which Dutch city's bridge was the
furthest objective of Market Garden" is hard but a well-read player can work it
out. "What was the serial number of the lead aircraft" is not hard, it is
trivia in the pejorative sense. If the only route to the answer is having
memorised it, drop the question.

## Format

One file per category under `content/questions/`, named after the category.
Files can be split further if they get long — the loader reads every `.yaml`
under `content/` and only cares about the `category:` key inside.

```yaml
category: geography

questions:
  - id: geo-001              # unique across the whole bank; prefix by category
    difficulty: 2            # 1-4
    prompt: Which is the only sea with no coastline?
    answer: The Sargasso Sea
    distractors: [The Coral Sea, The Bering Sea, The Andaman Sea]   # exactly 3
    fact: It is bounded by ocean currents rather than land.
    era: 1940s               # optional; the decade the answer belongs to
    tags: [wwii, pacific]    # optional
    image: arts/guernica.jpg # optional, relative to content/images/
    source: ...              # optional, see provenance below
```

Numeric tiebreakers use a different shape and live in
`content/questions/tiebreakers.yaml`:

```yaml
  - id: tie-001
    kind: number
    difficulty: 3
    prompt: In what year was the Brooklyn Bridge opened to traffic?
    answerNumber: 1883
    fact: It took fourteen years to build.
```

A good tiebreaker is one nobody knows exactly but an educated guess gets close
to. If a team could simply know it, it is a normal question.

## YAML will bite you

Question text is full of the punctuation YAML reserves. Three cases break:

```yaml
fact: "Star Wars" was renamed in 1981        # leading quote ends the scalar early
fact: He added Episode IV: A New Hope        # ": " starts a nested mapping
answer: C# minor                             # " #" starts a comment
distractors: [Close Encounters, 2001: A Space Odyssey, ...]   # same colon problem
```

Don't memorise this. Run:

```bash
npm run fix:content
```

It wraps only the values that need it and leaves the rest alone, so the diff
stays reviewable. `npm run validate` fails if anything is still unsafe.

## Provenance

Please write questions yourself, or draw them from general knowledge and
reference material you can cite. Do not paste from commercial quiz books,
trivia apps or question-bank sites — those compilations are someone's
copyrighted work, and an open-source project that ships them is a problem for
everyone downstream.

If a question comes from a specific source, record it:

```yaml
    source: NASA Apollo 11 mission report
    license: public-domain
```

## Before you open a pull request

```bash
npm run fix:content   # repair quoting
npm run validate      # errors must be zero
```

The validator checks for duplicate ids, duplicate prompts, missing facts,
wrong distractor counts, unknown categories, overlong prompts and missing
images. It prints the category and difficulty spread so you can see what the
bank is short of — which is usually the most useful thing to contribute.
