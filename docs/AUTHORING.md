# Writing question packs with the Claude API

The `/author` screen generates questions, fact-checks them independently, and
puts them in front of you for review. Approved questions get written to a
**pack** — an ordinary content file the MC can switch on for a night.

## The rule this is built around

**Generated questions are drafts until a person approves them.** There is no
path from the model to a live game that does not go through a human pressing
approve, and there is a test asserting it.

This is not caution for its own sake. A model will state a wrong date with
complete confidence, and the audience this project is built for — educated,
widely read, often with direct experience of the period — will catch it. One
wrong answer read out as fact costs more than a hundred missing questions.

Three gates sit between generation and a game:

1. **Structural rejection.** Missing fields, wrong number of distractors,
   duplicate options, and near-duplicates of questions already in the bank are
   dropped before you see them.
2. **An independent fact-check.** A second API call is given the question cold
   — no sight of the prompt that produced it, no reasoning to agree with — and
   asked whether the marked answer is actually right, whether exactly one
   option is defensible, and whether the stated fact is accurate. Anything it
   marks `suspect` or `wrong` **arrives already rejected**, so a distracted
   reviewer produces a smaller pack rather than a wrong one.
3. **You.** Read each question, approve what you'd be happy saying out loud.

## Setup

Generation needs internet and an API key. **The game needs neither** — write
packs at home in October, play them offline in the clubhouse in January.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Then open the **Question editor** address the server prints and enter the host
password — the same one the MC controls use.

Without a key the screen loads and says so rather than failing obscurely.

## Writing a batch

Pick an audience, a category, how many, and a difficulty shape.

**Audience** sets the era the questions are pitched at. The adult packs are
built for 35-75, whose formative years span roughly 1961-2010. Choosing another
audience shifts that window; `All ages` drops era weighting entirely.

**Model.** Opus 5.5 by default — it is the most accurate, and accuracy is the
whole game here. Sonnet and Haiku are offered and cost less; expect to reject
more of what they write. The screen estimates the batch cost before you commit
(both calls, roughly 10-15¢ for ten questions on Opus).

**Anything specific** is a free-text steer: *focus on the Apollo programme*,
*avoid anything about aircraft*, *lean British*.

The existing questions in that category are sent along so the model writes
around them instead of rediscovering the same twenty famous facts every time.

## Reviewing

Each draft shows the question, the four options with the answer marked, the
fact, and the fact-checker's verdict. The left border tells you at a glance:

| Border | Meaning |
|---|---|
| Green | The fact-check agreed. Starts **pending**, waiting on you. |
| Amber | Suspect — ambiguous or arguable. Starts **rejected**. |
| Red | Wrong — the fact-check believes the answer is incorrect. Starts **rejected**. |

You can **edit** anything before approving — fix a date, tighten a prompt,
replace a weak distractor. Edits save as you make them, so a review survives
closing the laptop.

Trust the amber flags. A question the checker found arguable will be the one
somebody disputes in the room.

## Publishing

Name the pack, record who reviewed it, and publish. Approved questions are
written to `content/packs/<slug>.yaml` and the bank reloads if no game is in
progress. You can also append to an existing pack.

The file records the model and the reviewer, because a year from now somebody
will want to know where a question came from.

A published pack is an ordinary content file — open it in a text editor, fix a
typo, run `npm run validate`. Nothing about it is special at game time.

## Using a pack

In the MC controls, under Setup, the packs written for the selected age group
appear as toggles, and at least one has to be on: every multiple-choice
question belongs to a pack, so switching them all off leaves the shared
tiebreakers and nothing to ask. Questions tagged for a different age group are
filtered out, which is why packs for the other groups are not shown.

## Costs

Two calls per batch — one to write, one to check. Ten questions on Opus 5.5
runs around 10-15¢. The screen shows an estimate before you generate and the
actual spend afterwards. Nothing calls the API unless you press the button.

## What this deliberately does not do

- **Generate during a game.** The runtime has no API dependency and no network
  requirement at all.
- **Auto-approve anything.** Not even questions the fact-check passed cleanly.
- **Replace writing questions yourself.** The best questions in the bank are
  hand-written. This makes the tedious part faster — inventing three plausible
  distractors for a fact you already know — not the judgment part.
