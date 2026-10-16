# Architecture

## Shape

```
  content/*.yaml ──load+validate at boot──▶  Bank (in memory)
                                               │
  ┌────────────────────────────────────────────┼─────────────────────┐
  │                      Engine (state machine)│                     │
  │   phases · teams · scoring · selection     │                     │
  └────────────┬───────────────────────────────┴──────────┬──────────┘
               │ snapshot after every transition          │ onChange
               ▼                                          ▼
         data/night.json                      views.ts ── three projections
         data/history.json                        │  host / control / player
         data/events.jsonl                        ▼
                                          websocket broadcast
```

One process, one in-memory game, one websocket. The server is authoritative
about everything except the countdown animation.

## Decisions

**No database.** The entire question bank at 5,000 questions is about 2 MB of
plain objects, so SQL buys nothing, and `better-sqlite3` would mean native
compilation — which means a laptop that needs Python and build tools before
`npm install` works. For a tool a volunteer sets up on a clubhouse machine,
that is a real cost against no benefit. Durable state is three small files in
`data/`.

**Content as YAML, not a packaged database.** The bank's value is that it grows
by pull request, and a reviewer needs to see that someone changed a date from
1944 to 1943. Nobody can review a diff of a binary file.

**Content is authored answer-first and shuffled at serve time.** There is no
answer index in the file format. Index-based authoring produces off-by-one
errors that survive review, and a fixed order would put the correct answer in
slot A every time. `selector.ts` generates a fresh permutation per asking.

**Whole-state snapshots, not diffs.** A snapshot is a couple of kilobytes and a
night has maybe 400 transitions. Diffing would save nothing measurable and cost
us the property that matters: a tablet that sleeps through three questions is
correct again the instant it reconnects, with no replay logic.

**Three server-side projections, not client-side filtering.** `views.ts` builds
separate host, control and player states. The player and host states do not
contain the answer key before the reveal — not in a hidden field, not anywhere.
Filtering in the client would be a five-second cheat for anyone who opens dev
tools, and in a room of retired engineers somebody will.

**Absolute deadlines, local countdowns.** The server sets `deadline` as an
epoch milliseconds value and each device animates toward it with
`requestAnimationFrame`. Streaming ticks to twenty tablets over a saturated
clubhouse access point would be both wasteful and jerky. Clock skew does not
matter because the server also enforces the lock.

**Persist on every transition.** `store.ts` writes `night.json` via a temp file
and `rename`, so a crash mid-write cannot truncate it. On restart the engine
parks any in-flight question as locked rather than scoring answers against a
deadline that expired while the laptop was asleep, and tells the MC it did so.

## Files

| File | Responsibility |
|---|---|
| `shared/protocol.ts` | The wire contract. Both sides import it. |
| `src/server/content.ts` | Load and validate YAML into a `Bank`. |
| `src/server/selector.ts` | Pick categories and questions; shuffle options. |
| `src/server/scoring.ts` | Points, speed bonus, wagers, numeric ranking. |
| `src/server/engine.ts` | The state machine. All mutation lives here. |
| `src/server/views.ts` | Role projections. The answer-key boundary. |
| `src/server/store.ts` | Atomic JSON persistence and night history. |
| `src/server/http.ts` | Static serving, `/api`, control password. |
| `src/server/lan.ts` | Work out the address players should type. |
| `src/server/index.ts` | Boot, websocket wiring, role gating. |
| `src/client/shared/` | Styles, socket hook, countdown, shared components. |
| `src/client/{player,host,control}` | The three screens. |

## Phases

A night contains games, a game contains rounds, a round contains questions.
Those are the words the MC says out loud, so they are the words in the code:
the middle layer used to be called a block, which nobody in a clubhouse has
ever said.

```
lobby ─▶ game_intro ─▶ round_intro ─▶ question ─▶ locked ─▶ reveal ─┐
                           ▲                                       │
                           └───────── more questions ◀─────────────┘
                                             │ round over
                                             ▼
                           round_scores ─▶ more rounds? ─▶ round_intro
                            (5 min break)    │ last round
                                             ▼
                      wager_bet ─▶ wager_question ─▶ wager_reveal
                                             │
                                             ▼
                      game_results ─▶ another game? ─▶ game_intro
                       (10 min break)  │              (scores carry)
                                       │ that was gamesPerNight
                                       ▼
                                   night_over

    tiebreak ─▶ tiebreak_reveal   (entered from game_results on a tie)
```

`engine.advance()` is the MC's single button: every phase knows what comes
next. `primaryAction()` in the control view maps each phase to the label and
hint shown on that button.

Every one of those arrows can also be taken by a clock rather than a thumb.
Inside a round that is `autoAdvance`; at the intros it is `introSeconds`; at
the two breaks it is `autoStartAfterBreak`; at the betting window it is
`wagerSeconds`. The break clock is set whether or not it ends the break
itself, because the room's question is how long they have, and that does not
depend on who presses the button at zero.

`wager_bet` was the last beat that waited for a thumb, on the grounds that a
team caught mid-decision loses its whole stake. That reasoning was wrong about
the stake — a team that has not bet has bet nothing, and wins and loses
nothing — and it stopped a night set to run itself at the most visible moment
of every game, where somebody had to notice. It now closes on `wagerSeconds`
(default 40, 0 to wait for the MC).

Two clocks are shifted rather than restarted when the MC pauses: the question
window moves both of its ends, and the break and betting windows move their
single end by what the pause took. A pause that ate the betting window would
be the MC taking the room's decision away from them.

## Picking questions

Two decisions, one level apart.

**Which categories a round draws from.** The default is `mixed`: one question
from each of `questionsPerRound` shuffled categories, so ten questions means
ten subjects. Ten questions on one subject is ten minutes in which anyone who
does not follow that subject has nothing to do, and in a mixed room that is
most of the room. `single` is still there for a themed round, and it is what
makes the round intro card worth showing.

**Which question comes out of a category.** `src/server/rotation.ts` keeps a
deck of cards in `data/rotation.json`: deal off the top, and when a deck runs
out reshuffle it. That gives the property a question bank actually needs —
every question gets asked once before any question gets asked twice — and it
survives a server restart, a new night, and Reset everything, because the
regulars it protects come back every week. `avoidRecentNights` only ever
looked at the last eight nights, which let a question repeat in a season while
a hundred others had never been asked.

A deck is keyed by **age group and category together**, filed as
`8-12::geography`, and is built from only the questions that group can be
asked. Both halves of that are load-bearing. Keyed on the category alone, one
deck held every group's questions, so a kids night dealt from a `geography`
deck that was mostly 55-75 cards: they were filtered out correctly, and left
in the deck correctly, which meant the deck could never empty, so it never
reshuffled — and once the eighty kids' questions were gone, that category
yielded nothing. Measured: the eleventh kids night drew a round of zero
questions. The file stays flat and greppable on purpose, because somebody
debugging a night wants to open it and read it.

## Where questions live

```
content/questions/
  55-75/         geography.yaml, sports.yaml, …
  35-55/
  8-12/
  shared/        tiebreakers.yaml
```

**The folder names the age group**, and `loadBank` tags every question in it
accordingly (`audienceFromPath` in `src/server/content.ts`). A file may still
name its own `audience:` and that wins, because explicit beats implicit, but
nothing in the bank needs to any more.

`shared/` names no group: what is in it is untagged, and an untagged question
is in play whoever is playing. The numeric tiebreakers live there because a
tie at the top has to be breakable on a kids night too. That used to be
achieved by being the one file in the bank with no `audience:` key, which
worked and explained itself to nobody.

Before this, every category was one flat file and the two age sets were each
one enormous file spanning eight categories, so the kids' sports questions
were somewhere in the middle of `age-8-12.yaml`. Adding an age group is now
adding a folder: the server reports the groups it finds, with live counts, and
the MC's setup screen lists them without a code change.

**How much material each group has is the number that matters**, and it is not
the headline count. A default night asks 60 questions, so:

| group  | questions | nights before anything repeats |
|--------|-----------|--------------------------------|
| 55-75  | 744       | about 12 — a weekly night runs a season |
| 35-55  | 80        | 1.3 — the second night repeats |
| 8-12   | 80        | 1.3 — the second night repeats |

The no-repeat machinery works for all three; two of the folders are simply too
thin to have anything to promise. `npm run validate` and `npm run stats
--audience all` both report this per group, and the MC's setup screen says it
on the age-group button, because "80 questions" reads as plenty and is one and
a bit nights.

## Security model

The threat is not an attacker, it is a curious guest. The host screen displays
an address; somebody will try `/control` on their phone.

- The control view requires the host password, exchanged for a bearer token.
  Both sides are SHA-256'd and the digests compared with `timingSafeEqual`, so
  the check is constant-time at any length. (An earlier version padded to 16
  bytes and sliced, which meant only the first 16 characters had to match.)
- The password is set on the server and is stable across games: from
  `PRIMETIME_PASSWORD`, else `data/control-password`, else the deprecated
  `PRIMETIME_PIN`, else generated once and written to that file. There is no
  unconfigured failure mode on purpose — a box that will not start an hour
  before trivia is worse than a password nobody chose, and a generated one is
  written down, so it is still stable and still editable.
- Issued tokens are kept in `data/control-tokens.json`, keyed by a hash of the
  password, so restarting the server does not sign the MC out but changing the
  password does.
- Control messages are rejected server-side if the socket did not authenticate
  as control, so a player cannot drive the game by crafting a websocket frame.
  There is an integration test for exactly this.
- Static paths are resolved and checked against their root, so `/media/../..`
  cannot escape the content directory.
- Player identity is a random token in `localStorage`, which lets a tablet
  reconnect to its seat. It is not a security boundary and is not treated as
  one; the worst a forged one does is answer for a team at the same table.

There is no HTTPS, because there is no certificate authority on an offline LAN
and self-signed certificates would mean teaching ninety people to click through
a browser warning. Everything on the wire is trivia questions.

## Testing

- `src/server/engine.test.ts` plays real games against the real bank: full
  games, the question window running its full length, wagers, tiebreaks,
  mixed rounds, the deck's no-repeat guarantee across restarts, the break
  clocks, the night ending itself, the answer-key boundary, mid-question
  restart, and a night written by a build that still said Block.
- `src/server/integration.test.ts` spawns the built server and drives it over
  websockets: the password gate, role gating, identity handoff, reconnection,
  and a player and partner seeing each other's answer.
- `src/server/auth.test.ts` covers the control password on its own: where it is
  read from, that a generated one is reused rather than rotated, that a login
  survives a restart, and that a prefix of the password is rejected.

`npm test` runs content validation and both suites.

## Playing a whole night with nobody in the room

`npm run flow` is the third kind of test, and it is the one that catches the
failure the other two are structurally blind to: the night running out of
road.

The unit tests drive the engine a call at a time. The screenshot pass drives
the UI a click at a time. Both of them supply the thumb. `npm run flow` sets
up a two-game night with short breaks, taps the big button once, and then
watches: it answers on the handsets while a question is up, photographs each
phase the first time it appears, and fails if the night has not reached
`night_over`.

It earned its keep on the first run. The reveal of the last question in a
round queued nothing — correct when every round boundary waited for the MC,
and fatal once breaks were meant to end themselves. Every unit test passed and
every screenshot rendered; the night simply stopped on an answer and sat
there.

## Clocks that do not move

`npm run jitter` is the third audit, and it exists because of a bug neither
of the others can see.

The falling score and the countdown are the only things on these screens that
change every second, so they are the only things whose SIZE must not. They
were one interpolated string in a flexible pill: as the numbers lost a digit
the pill narrowed, fitted beside the category, and snapped back to one line —
then the next tick pushed it to two again. Once a second, for twenty seconds,
on every question, four inches from a player's face.

A unit test asserts about a value, and a screenshot is one instant. This is
about the same element at two instants being the same shape, so it is
measured: sample the bounding box of every clock on every tick of a real
question, on the handset, the big screen and the MC's phone, and fail if any
width or height takes more than one value.

The fix is in `.qhead-live`: the pill never wraps and never shrinks, and each
number reserves the width of the largest value it can reach, in tabular
figures, taken from the config rather than hardcoded — `questionPoints` and
`secondsPerQuestion` are both settings. Verified against the widest an MC can
set: `SECS=120 PTS=5000 npm run jitter`.

## Screenshots as a smoke test

`npm run screenshots` spawns a throwaway server on a random port, drives four
browser contexts through a real game — three teams joining, the MC unlocking
with the host password, a question, answers, a reveal, a scoreboard — and
captures each screen.

It is kept because it earns its place twice. It produces the README images,
and it fails loudly on UI regressions the unit tests are blind to. Both of the
bugs it has caught so far were invisible to the test suite:

- The name-entry screen branched on whether the typed name was empty, so it
  vanished after the first keystroke and threw the player into team selection
  mid-word.
- Opening `/control` without a password connected, was rejected with close
  code 4001, and called `location.reload()` — an infinite reload loop.

Neither is expressible as an assertion about engine state, which is exactly
why driving the real thing matters.

## Scaling to a full room

One device is one entry. There is no joining an existing team, no member list,
and no team-size cap — a table that wants to play together shares a tablet.
Besides being simpler for a hundred people arriving at once, it removes a
lobby-wide list that every device would otherwise have to receive and render.

`npm run loadtest` opens N real websocket clients against a throwaway server,
has them all join and all answer one question, and reports the bytes. The first
run at 100 devices reported **26.5 MB to players for a single question**, which
is what prompted three changes:

**Coalescing.** A hundred answers arrive as a hundred separate socket messages,
each previously triggering its own full push to every device. Broadcasts are
now batched over a 60 ms window.

**Deduplication.** A player's screen does not change when somebody else
answers. Each client's serialised projection is compared against what it last
received, and identical payloads are skipped. This turns the answer flood from
"every device hears about every answer" into "every device hears about its own".

**Per-role payloads.** The host and MC render every entry, so they get the full
table. A player renders the top of the board plus their own row, so that is all
they are sent — and `reveal.outcomes`, which carries a row per entry, is cut to
the player's own. That last one was the largest single payload in the game and
it grew with the square of the room.

Measured on 100 entries answering one question:

| | before | after |
|---|---|---|
| to all players | 26,520 KB | 1,394 KB |
| messages | 10,500 | 600 |
| per device | 265 KB | 13.9 KB |
| to host | 2,540 KB | 153 KB |

The MC's roster also switches to a search box past ten entries, and the host
screen swaps its per-entry answered dots for a progress bar past twenty-four —
a dot per team is a nice touch at eight and unreadable confetti at a hundred.
