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
| `src/server/http.ts` | Static serving, `/api`, control PIN. |
| `src/server/lan.ts` | Work out the address players should type. |
| `src/server/index.ts` | Boot, websocket wiring, role gating. |
| `src/client/shared/` | Styles, socket hook, countdown, shared components. |
| `src/client/{player,host,control}` | The three screens. |

## Phases

```
lobby ─▶ block_intro ─▶ round_intro ─▶ question ─▶ locked ─▶ reveal ─┐
                            ▲                                       │
                            └───────── more questions ◀─────────────┘
                                              │ round over
                                              ▼
                            round_scores ─▶ more rounds? ─▶ round_intro
                                              │ last round
                                              ▼
                       wager_bet ─▶ wager_question ─▶ wager_reveal
                                              │
                                              ▼
                       block_results ─▶ another block? ─▶ block_intro
                                              │              (scores carry)
                                              ▼
                                          night_over

    tiebreak ─▶ tiebreak_reveal   (entered from block_results on a tie)
```

`engine.advance()` is the MC's single button: every phase knows what comes
next. `primaryAction()` in the control view maps each phase to the label and
hint shown on that button.

## Security model

The threat is not an attacker, it is a curious guest. The host screen displays
an address; somebody will try `/control` on their phone.

- The control view requires a six-digit PIN, printed in the terminal, exchanged
  for a bearer token. Comparison is constant-time.
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
  blocks, auto-lock, wagers, tiebreaks, no-repeat guarantees, the answer-key
  boundary, mid-question restart.
- `src/server/integration.test.ts` spawns the built server and drives it over
  websockets: the PIN gate, role gating, identity handoff, reconnection, and a
  player and partner seeing each other's answer.

`npm test` runs content validation and both suites.

## Screenshots as a smoke test

`npm run screenshots` spawns a throwaway server on a random port, drives four
browser contexts through a real game — three teams joining, the MC unlocking
with a PIN, a question, answers, a reveal, a scoreboard — and captures each
screen.

It is kept because it earns its place twice. It produces the README images,
and it fails loudly on UI regressions the unit tests are blind to. Both of the
bugs it has caught so far were invisible to the test suite:

- The name-entry screen branched on whether the typed name was empty, so it
  vanished after the first keystroke and threw the player into team selection
  mid-word.
- Opening `/control` without a PIN connected, was rejected with close code
  4001, and called `location.reload()` — an infinite reload loop.

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
