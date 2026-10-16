# Running a trivia night

Written for whoever actually runs the evening. No technical knowledge assumed
past opening a terminal once.

## What you need

- A laptop, connected to the TV or projector by HDMI
- Wifi that the laptop and everyone's tablets are all on. **Internet is not
  required.**
- Your own phone, for the controls
- Players' own phones or tablets, or a stack of venue tablets

### Strongly recommended: your own travel router

A $30 travel router (GL.iNet and similar) solves three problems at once:

1. The wifi name and password are the same every week, so you can print them
   on the table cards.
2. You can reserve a fixed address for the laptop, so the join address never
   changes and the printed QR code keeps working forever.
3. **It avoids client isolation.** Many guest networks block devices from
   talking to each other. When that is on, players can join the wifi, the
   laptop is running fine, and nothing works — with no error message that
   explains why. This is the single most likely thing to ruin a first attempt.

Plug it into the clubhouse ethernet, or run it with no internet at all. The
game does not care.

## First time setup

Once, on the laptop:

```bash
npm install
npm run build
```

## Every night

```bash
npm start
```

The terminal prints a block of addresses. Leave this window open — it is the
game. Closing it ends the night.

```
  Thursday Trivia
  ────────────────────────────────────────────────────
  Players join at   http://192.168.1.42:8080
  Big screen        http://192.168.1.42:8080/host
  MC controls       http://192.168.1.42:8080/control
  Host password     brass-lantern-42
  Room code         CORAL-9
  ────────────────────────────────────────────────────
```

Then:

1. Open the **Big screen** address in a browser on the laptop, and press F11
   for full screen. Drag it to the TV.
2. Open the **MC controls** address on your phone and type the **Host
   password**. Your phone remembers it after that, and the password itself does
   not change between games, so this is a once-per-phone step rather than a
   once-per-night one.
3. Tell the room the join address. The big screen is showing it in large type
   with a QR code — point at it rather than reading the numbers out.

To put the event name on the screen:

```bash
PRIMETIME_VENUE="Thursday Trivia" PRIMETIME_SSID="Clubhouse-Guest" npm start
```

## How people join

**One device, one entry.** When someone opens the join address they pick
whether they're playing on their own or as a table sharing that device, then
type a handle. It does not have to be their real name — people who would rather
stay anonymous can.

There's no joining someone else's team and no list of teams to scroll. At a
hundred people, finding your partner in a list is slower and goes wrong more
often than just typing a name.

A table of four who want to play together simply share one tablet. A couple who
want to compete against each other use two.

## What the words mean

Three layers, and the screens use the same three words you will:

- a **round** is ten questions
- a **game** is a few rounds, closed by the final wager
- a **night** is a few games

Ten questions, five minute break, ten more, the wager, ten minute break, next
game. Set all of it under **Setup** on your phone.

## Setting up the game

Setup is five groups, each of which says what it is set to without being
opened.

**Shape of the night.** Questions per round, rounds per game, games tonight.
Type the number or use the steppers; the panel works out how long the night
runs and tells you. The night ends itself after the last game, so you do not
have to remember to stop.

Also here: **Categories in a round**. *Mixed* is the default and means one
question from each of ten shuffled categories — nobody sits out a round
because they know nothing about opera. *One per round* puts the whole round on
one subject, which is what you want for a themed round.

**Timing.** Every number is a field, not a choice of three. The answer window,
the pause before the answer, how long the answer stays up, how long an intro
card holds, and the two breaks: between rounds and between games. Defaults are
20 seconds a question, 5 minutes between rounds, 10 between games.

Two switches here matter most:

- **Breaks end themselves** — on by default. The break counts down on every
  screen and the next round starts at zero. Turn it off and the clock still
  counts down and still says five minutes, but the game waits for your button.
  Turn it off when you have an announcement to make.
- **Run the round automatically** — on by default. The lock, the reveal and
  the next question all run on the clock, so you do not touch anything for a
  whole round.

With both on, the night runs itself from the first question to the last.

**Scoring.** A question is worth 1000 points, holds full value for the first 5
seconds while the room reads, then slides to 200 at the buzzer. All three
numbers are yours to change. The floor sits well above zero on purpose: a
correct answer arrived at slowly is still a correct answer.

**Sound and speech.** Big-screen sound, volume, music under the question, the
spoken run-up, and reading questions aloud. All off by default. Sound only ever
comes out of the big screen, and that screen needs one click on **Turn sound
on** before a browser will play anything.

**Questions.** The age group, and any extra packs.

Each age group is a folder of questions — `content/questions/8-12/` is the
kids' night — and picking one swaps the night's material wholesale rather than
mixing it. The list shows what each group actually has behind it, so a group
with eight categories written for it says so, and the warning at the top of
the screen tells you a round of ten will ask two of them twice.

Only `shared/` crosses over, and today that is just the numeric tiebreakers,
so a tie at the top is breakable whoever is playing.

## During the night

**The round runs itself.** Once a question is up, the game locks the answers
when the timer runs out, pauses a beat, reveals the answer, leaves it up long
enough for you to read the fact aloud, and moves to the next question. You do
not need to touch anything for a whole round.

Every screen shows the same countdown — "Next question in 7" — so the room
knows it is still moving and you know exactly how long you have to talk.

The big screen keeps **live standings** beside the question, with a dot that
fills in as each team locks an answer. You can see who is still thinking
without looking at your phone. Then for the last few seconds before the next
question, the screen gives the whole wall to the scoreboard, so every question
ends on where everyone stands.

**Hold** pauses it whenever you want to tell a story, settle an argument, or
wait for someone to come back from the bar. Press it again to carry on from
where you were. The big button also still works: tapping it skips the rest of
the countdown and moves on immediately.

**Breaks are on a clock.** At the end of a round every screen shows the
standings and a countdown — 4:58, then 4:57 — so nobody has to ask how long
they have, including you. With **Breaks end themselves** on, the next round
starts at zero; with it off, the clock still runs and the game waits for your
button. The big button always skips the rest of it.

The one beat that never runs on a clock is **the final wager**. A team that
has not bet loses its whole stake, so you decide when betting closes.

If you would rather drive every step yourself, turn off **Run the round
automatically** and **Breaks end themselves**, and the game waits for you at
every stage.

One large button sits at the bottom of your phone and always does the right
next thing. The label tells you what it will do and the line underneath gives
you something to say. Space bar does the same, so a presentation clicker works.

While a question is live you also get:

- **+15s** — more time, as often as you like
- **Lock now** — everyone has clearly finished
- **Skip** — this question is a dud, bin it with no score
- **Swap this question** — they have seen it before; replaces it with another
  from the same category, or from anywhere in the selection if the round is
  mixed

Tap any team to adjust their score, rename them, or remove them.

### Things that will happen

**Somebody joins late.** They join like anyone else and start from zero. No
restart needed.

**A tablet goes to sleep.** They tap to wake and the page reconnects on its
own, landing on whatever is happening now. Nobody needs to reload anything.

**The laptop sleeps, or you close the lid.** Start it again with `npm start`.
The night comes back — teams, scores, which questions have been used. The
question that was live gets parked rather than scored, and the screen tells you
so. Reveal it and carry on.

**Two teams tie at the top.** The controls offer a tiebreaker: a numeric
question where the closest guess wins. It is sudden death and only the tied
teams play.

**A game ends and nobody wants to stop.** Raise **Games tonight** in Setup —
it is the one shape setting you can change mid-night — and the button offers
another game with the same teams and carried-over scores.

**No question comes back until the bank has been used up.** Each age group has
its own deck per category: deal off the top, reshuffle only when that group's
cards run out. A kids night never spends the adults' questions and the other
way round, so the two can run in the same room on the same week. It holds
across restarts, across nights and across **Reset everything**, because the
people it protects are the regulars who come every week.

It lives in `data/rotation.json`, one line per group and category, in plain
text you can open and read. Delete the file if you ever want to start the
whole bank over.

## Afterwards

Nothing to do. The final standings stay on the screen until you stop the
server.

If you want a completely fresh night — new teams, zero scores — use **Reset
everything** in the controls, or just restart with an empty `data/` folder.
Reset everything deliberately leaves the question rotation alone, so a fresh
night does not start re-asking questions the room has already had.

By default the game avoids any question used in the previous eight nights, so
a weekly game will not recycle material for about two months.

## If something goes wrong

**Players get "can't reach this page".** They are on a different wifi network,
or the network has client isolation on. Check the first; if the laptop is fine
and several devices all fail, assume the second and use your own router.

**The address in the terminal looks wrong** (starts with `172.` or `169.`).
The laptop picked a virtual adapter. The terminal lists every address it found
— try the one starting `192.168.`.

**The big screen is tiny or cut off.** F11 for full screen. The layout scales
to whatever it is given.

**A question is wrong.** Press **Skip**, say so out loud, and move on — then
open an issue on GitHub so it gets fixed for everyone.
