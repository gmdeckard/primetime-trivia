# Running a trivia night

Written for whoever actually runs the evening. The way it runs now needs no
terminal at all — the game is already on the internet and the night is three
steps in a browser. The local-laptop setup is still here as a fallback, and
assumes no technical knowledge past opening a terminal once.

## What you need

- Your own phone, for the controls
- A TV or projector in the room, and a laptop to drive it by HDMI
- Players' own phones or tablets, or a stack of venue tablets

Nothing gets installed on anybody's phone. The game is a web page.

## Two ways to run it

Read this part once and then forget it — it decides where the game lives, not
what you do on the night.

### The way it runs now: the server is on the internet

A small cloud box runs the game at `trivia.cableplantiq.com` all week. The
laptop in the room is only a browser pointed at it, and the phones reach it over
the clubhouse wifi. **This needs working internet in the room**, and nothing
else: no router to carry in, no address to read out, nothing to start.

The reason it moved there is worth knowing, because it is the thing that breaks
a local setup. The rec center's wifi has **client isolation** on, which
silently blocks devices from reaching each other — a server in that room is
unreachable from the phones no matter how well it is configured, with no error
message that explains why. A server on the internet is not affected: the phones
go out to it and come back in, which isolation does not stop. It has a second
effect worth having, which is that phones stay on the wifi instead of being
pulled onto mobile data by a network that appears not to work.

Setting that box up is [DEPLOYMENT.md](DEPLOYMENT.md). This file is about the
night.

### The fallback: a laptop on a local network

Still supported and still fine, and the right answer in a venue with no usable
internet. It needs a network you control, for the reason above.

#### For the local path: bring your own router

A $30 travel router (GL.iNet and similar) solves three problems at once:

1. The wifi name and password are the same every week, so you can print them
   on the table cards.
2. You can reserve a fixed address for the laptop, so the join address never
   changes and the printed QR code keeps working forever.
3. **It avoids client isolation**, which is the single most likely thing to
   ruin a first attempt.

Plug it into the clubhouse ethernet, or run it with no internet at all. The
game does not care.

## Every night

### On the hosted box

Nothing to start. The server is already running and has been all week, so the
night begins at step 1 below with `https://trivia.cableplantiq.com`.

Worth a glance an hour before, not at seven o'clock: open the big screen
address and check it loads and shows a room code.

### On a laptop

Once, the first time:

```bash
npm install
npm run build
```

Then every night:

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

The password is spelled out in that block only when the server generated one
for you. One you set yourself reads `(as configured)`, because it is already
written down wherever you set it.

## Starting the night

Three steps, the same on either setup. The addresses are the ones in the banner
above, or `https://trivia.cableplantiq.com` on the hosted box.

1. Open the **Big screen** address in a browser on the laptop, and press F11
   for full screen. Drag it to the TV. **It asks for the host password the
   first time on that device** — the same password as the controls, because the
   big screen carries the room code and the join code and is operator
   equipment. The laptop you always use is already past it; a borrowed one is
   not, so do not leave this until the room is filling up.
2. Open the **MC controls** address on your phone and type the **Host
   password**. Your phone remembers it after that, and the password itself does
   not change between games, so this is a once-per-phone step rather than a
   once-per-night one.
3. Tell the room the join address. The big screen is showing it in large type
   with a QR code — point at it rather than reading the address out. Then read
   the **room code** out, twice, because that is the part people get wrong.

To put the event name on the screen, type it in **Setup** on your phone — it
is the first field, and it takes effect on the big screen as you leave the box.
On a laptop you can also set it at start-up:

```bash
PRIMETIME_VENUE="Thursday Trivia" npm start
```

The two settings below are start-up ones, so on the hosted box they go in
`/etc/default/primetime-trivia` and need a restart; see
[DEPLOYMENT.md](DEPLOYMENT.md).

### Naming the wifi on the big screen

By default the big screen says nothing about wifi, and numbers its steps
accordingly. That is right for the hosted box, where the room is on the venue's
own network and a screen naming some other one sends people hunting through
their phone settings for a network that is not being broadcast.

On the local path, name the network you carried in and the screen adds a step
telling people to join it first:

```bash
PRIMETIME_SSID="Thursday-Trivia" PRIMETIME_WIFI_PASSWORD="snowbird2026" npm start
```

`PRIMETIME_SSID_ALT` names a second network, for a router broadcasting a 5 GHz
band under its own name.

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

**Somebody can watch instead of playing.** Under the two choices is a third
button, **I just want to watch**. It asks for the room code and nothing else:
no name, and they never appear on the scoreboard. They get the question, the
clock, the standings and the answer on their own phone — the big screen, in
their hand. A "Join in" link sits on that screen all night, so somebody who
warms up in round two can take a seat for the next game.

Offer it rather than waiting to be asked. It is for the person who came with
somebody else and the first-timer who does not want to commit to a team yet.

A watcher who came in that way is in the room rather than at a table: they see
what the big screen shows, and not what any particular team answered.

**The rest of a table gets a better version.** Each seated team's own screen
carries a QR code for its table to scan, and that one opens a watch screen
following **that team**: the question, the clock, and what their device has
locked in with what it is currently worth. So three people at a table of four
can read the question off their own phones while one device answers for all of
them, and nobody has to lean across the table to see what was tapped. Those
codes are minted per team and stop working the moment the night is reset, so
last week's QR in somebody's camera roll is harmless — the screen says so and
tells them to scan the one on the table now.

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

**Sound and speech.** Three controls: big-screen sound, its volume, and the
spoken count-in. **All on by default** — a trivia night with no sound reads as
broken equipment, which is what a night in the room taught. Sound only ever
comes out of the big screen, and that screen needs one click on **Turn sound
on** before a browser will play anything. That click is also your sound check:
it plays a three-note chord, so no chord means no sound all night.

There is one piece of music and it plays **under the live question only** —
never under the lobby, the breaks, the intros or the reveal. It used to play
under those too, and that came out after the first real night: players with
hearing aids could not follow the MC over it. Under a question nobody is
talking, and the room liked it there.

**Questions.** The age group, and the question sets switched on for it.

Each age group is a folder of questions — `content/questions/8-12/` is the
kids' night — and picking one swaps the night's material wholesale rather than
mixing it. The list shows what each group actually has behind it, so a group
with eight categories written for it says so, and the warning at the top of
the screen tells you a round of ten will ask two of them twice.

Under it are that group's question sets, one switch each: **Adult set 1** and
**Adult set 2** for the main room, **Kids set 1** for the children's night.
Every multiple-choice question belongs to one of them, so at least one has to
be on — switch them all off and the night has nothing to ask, and the screen
says so. Sets for the other age groups are not listed, because a question is
excluded unless its group is the one selected and the switch could do nothing.

Only `shared/` crosses over, and today that is just the numeric tiebreakers,
so a tie at the top is breakable whoever is playing and whichever sets are on.

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

**The final wager runs on a clock too.** The room gets 40 seconds to bet,
counted down on every screen, and then the final question appears. **The
subject is named before anyone bets** — on the big screen, on every handset and
on your own controls — because a bet placed with no idea what is coming is a
coin toss rather than a decision. The question itself is chosen when the
betting opens, so the subject on the screen is the subject they get. A table
that has not bet when it closes has bet nothing, so they win nothing and lose
nothing — which is the fair outcome for not deciding. Set **Betting window**
to 0 in Timing if you would rather close it yourself.

If you would rather drive every step yourself, turn off **Run the round
automatically** and **Breaks end themselves** and set the betting window to 0,
and the game waits for you at every stage.

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

**The laptop sleeps, or you close the lid.** On the hosted box this costs you
the big screen and nothing else: the game is somewhere else and never stopped,
so wake the laptop, reload `/host`, and the night is where you left it. Every
phone in the room carried on without you.

Running locally, the laptop *is* the game. Start it again with `npm start`. The
night comes back — teams, scores, which questions have been used. The question
that was live gets parked rather than scored, and the screen tells you so.
Reveal it and carry on.

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

Nothing to do. The final standings stay on the screen — on the hosted box until
somebody resets the night, and locally until you stop the server.

If you want a completely fresh night — new teams, zero scores — use **Reset
everything** in the controls, or just restart with an empty `data/` folder.
Reset everything deliberately leaves the question rotation alone, so a fresh
night does not start re-asking questions the room has already had.

By default the game avoids any question used in the previous eight nights, so
a weekly game will not recycle material for about two months.

## If something goes wrong

**Players get "can't reach this page", on the hosted box.** Their phone has no
working internet, or the box is down. Check your own phone on the same wifi
first: if that loads the join page, it is their device, and the fix is usually
to turn wifi off and on. If no phone can load it, the game is not reachable and
the standings are not coming back by themselves — see
[DEPLOYMENT.md](DEPLOYMENT.md).

**Players get "can't reach this page", on a laptop.** They are on a different
wifi network, or the network has client isolation on. Check the first; if the
laptop is fine and several devices all fail, assume the second and use your own
router.

**The address in the terminal looks wrong** (starts with `172.` or `169.`).
The laptop picked a virtual adapter. The terminal lists every address it found
— try the one starting `192.168.`. This cannot happen on the hosted box, which
prints the domain and does not guess.

**The big screen asks for a password you do not have.** It is the same one as
the controls, so a phone already running `/control` is past it and can keep
running the night on its own. Without it there is no big screen, which is why
step 1 is worth doing early rather than at seven o'clock.

**The big screen is tiny or cut off.** F11 for full screen. The layout scales
to whatever it is given.

**A question is wrong.** Press **Skip**, say so out loud, and move on — then
open an issue on GitHub so it gets fixed for everyone.
