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

## Setting up the game

On your phone, before you start:


- **Block shape** — 3 × 8 is about thirty minutes; 4 × 6 and 2 × 10 are also
  offered, and the screen tells you the estimated running time
- **Seconds per question** — 35 is the default; 25 for a sharp crowd, 50 if
  there is a lot of discussion at the tables
- **Run the round automatically** — on by default. Reveals the answer a few
  seconds after the timer, then moves on. Tune the two pauses underneath: the
  beat before the answer, and how long the answer stays up. Lengthen the second
  one if you like to talk around the fun fact.
- **Speed bonus** — 5 points for the fastest correct team. Turn it off if the
  room is mixed and you want knowledge alone to decide.
- **Final wager** — a Jeopardy-style bet to close the block. Leave it on; it
  keeps the last-place table interested right to the end.
- **Read questions aloud** — the big screen speaks each question using the
  laptop's own voice. Useful for low-vision players and needs no internet.

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

Auto-advance deliberately **stops at the end of every round**. Scoreboards,
the move to the next category, the final wager and tiebreakers all wait for
you, because those are the moments you want to talk over.

If you would rather drive every step yourself, turn off **Run the round
automatically** in Setup and the game waits for you at each stage.

One large button sits at the bottom of your phone and always does the right
next thing. The label tells you what it will do and the line underneath gives
you something to say. Space bar does the same, so a presentation clicker works.

While a question is live you also get:

- **+15s** — more time, as often as you like
- **Lock now** — everyone has clearly finished
- **Skip** — this question is a dud, bin it with no score
- **Swap this question** — they have seen it before; replaces it with another
  from the same category

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

**The thirty minutes are up and nobody wants to stop.** Press the button again
and it starts another block with the same teams and carried-over scores. No
question repeats, so you can run three blocks back to back.

## Afterwards

Nothing to do. The final standings stay on the screen until you stop the
server.

If you want a completely fresh night — new teams, zero scores — use **Reset
everything** in the controls, or just restart with an empty `data/` folder.

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
