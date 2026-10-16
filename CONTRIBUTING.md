# Contributing

The most useful contribution is almost always **more questions**. The code
works; the bank is what determines whether a venue can run this weekly for a
season without repeats.

## Adding questions

1. Read [docs/QUESTION-STYLE.md](docs/QUESTION-STYLE.md). The rules about
   plausible distractors and the required `fact` field are what keep the game
   worth playing for this audience — they are not formalities.
2. Find the age group your questions are for — `content/questions/35-75/` is
   the adult room and most of the bank — then the pack inside it, and add to
   the file for your category, or create one named after the category.
   **The outer folder sets the age group**, so the file does not need to say
   so; the `pack:` header at the top of the file sets the pack. Anything that genuinely
   suits every age equally goes in `content/questions/shared/`, which is a
   short list: today it is the numeric tiebreakers.
3. Run the checks:

   ```bash
   npm run fix:content   # repairs YAML quoting
   npm run validate      # must report 0 errors
   ```

4. Open a pull request. Say roughly where the questions came from.

Question ids must be unique across the whole bank — prefix them with your
category (`geo-031`, `mil-031`) and the validator will catch collisions.

A pull request of twenty good questions in one category is more useful than two
hundred scraped from somewhere, and much more likely to be merged. Please don't
paste from commercial quiz books or trivia apps.

## Adding a category

Add it to `content/categories.yaml`:

```yaml
- id: trains-railways
  name: Trains & Railways
  blurb: Lines, locomotives and the men who laid the track.
  sample: Gauges, routes, record runs
```

The `blurb` appears on the round intro card on the big screen, so write it as
something an MC would say out loud. A category needs at least `questionsPerRound`
questions (8 by default) before the engine will draw a round from it.

## Code changes

```bash
npm install
npm run dev     # server on 8080, client with hot reload on 5173
npm test
```

Before opening a pull request, `npm test` should pass. It runs content
validation, the engine tests, the control-password tests and the websocket
integration tests.

Questions are not fact-checked by `npm test`. Validation checks that the YAML
parses, that categories exist and that nothing is a duplicate — it says nothing
about whether an answer is true. `npm run fact-check` is the audit: free and
offline by default, and `--verify` adds a model pass over the whole bank that
costs money. Neither is proof. Both produce a list for a person to work through,
and neither ever edits a question.

There are no client-side tests. `src/client/**` is exercised by
`npm run screenshots`, which plays a real game in a headless browser and fails
loudly when a screen stops rendering. That is why the lane map in
`.gstack/pregate.json` maps the client to no tests: a statement of what exists,
not a gate anyone turned off.

A few things to know:

- **All mutation goes through `engine.ts`.** If a change needs new state, add a
  method there rather than reaching into the snapshot from elsewhere.
- **The answer key must not reach the player or host projection before the
  reveal.** `views.ts` enforces this and there is a test for it. If you add a
  field, check which projections it belongs in.
- **Keep the player bundle small.** It loads over clubhouse wifi onto old
  iPads. No framework additions without a good reason; there are currently no
  runtime dependencies in the client beyond Preact.
- **Accessibility is not optional here.** Minimum 19px body text, 60px tap
  targets, and any new answer affordance needs a non-colour channel too. The
  audience is over 55 by definition.

## Testing on real devices

The thing worth testing by hand is an actual tablet on actual wifi, because
that is where the problems are — a sleeping screen, a slow reconnect, a tap
target that is fine with a mouse and awkward with a thumb. Run `npm run dev`,
find your laptop's LAN address, and open it on a phone.

## Reporting problems

Useful bug reports say what device and browser, what phase the game was in, and
what the terminal printed. `data/events.jsonl` holds a line per transition and
is often the fastest way to see what happened.
