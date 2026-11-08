import { render, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { EntryKind, PlayerState } from '../../shared/protocol';
import './shared/styles.css';
import { nextUpWindowMs, useCountdown, useGame, useNow, useWakeLock } from './shared/useGame';
import { inRunUpToQuestion, pointsAt } from '../../shared/protocol';
import { AutoAdvance, Badge, Board, BreakClock, ConnBanner, Keypad, NextUp, Toast } from './shared/ui';

/**
 * The player view. One screen at a time, one decision at a time.
 *
 * The guiding rule: a player should never have to ask "what am I supposed to
 * be doing right now". Whatever the phase, the top of the screen says where we
 * are and the middle holds the only control that matters.
 */

function Lobby({ state, send }: { state: PlayerState; send: ReturnType<typeof useGame>['send'] }) {
  const [kind, setKind] = useState<EntryKind | null>(null);
  const [handle, setHandle] = useState(() => localStorage.getItem('primetime.handle') ?? '');
  // Kept on the device once it has been accepted. "Change my name" drops the
  // seat and comes back through the gate, and making someone re-read a code
  // they have already proved they can see is friction for nothing.
  const [code, setCode] = useState(() => localStorage.getItem('primetime.roomCode') ?? '');

  // Already in — show who they are and let them wait.
  if (state.me.teamId) {
    return (
      <>
        <div class="card stack center">
          <div class="eyebrow">You're in</div>
          <h1 style={{ fontSize: '2rem' }}>{state.me.teamName}</h1>
          <p class="muted">
            {state.me.kind === 'team' ? 'Playing as a team' : 'Playing solo'} · waiting for the host to start
          </p>
          <span class="pill">{state.entryCount} {state.entryCount === 1 ? 'player' : 'players'} so far</span>
        </div>
        <button class="btn btn-ghost btn-block" onClick={() => { setKind(null); send({ t: 'leave' }); }}>
          Change my name
        </button>
      </>
    );
  }

  // Step 1 — solo or team. Asked first because it changes what the handle means.
  if (!kind) {
    return (
      <div class="card stack">
        <div class="eyebrow">{state.venueName}</div>
        <h1>Welcome</h1>
        <p class="muted">
          One device per entry. Play on your own, or share this device with the people at your table.
        </p>
        <button class="btn btn-primary btn-lg btn-block" onClick={() => setKind('solo')}>
          Just me
        </button>
        <button class="btn btn-lg btn-block" onClick={() => setKind('team')}>
          A team on this device
        </button>
      </div>
    );
  }

  // Step 2 — the handle. No real names required; anonymity is the default.
  const submit = () => {
    const clean = handle.trim();
    const room = code.trim();
    if (!clean || !room) return;
    localStorage.setItem('primetime.handle', clean);
    localStorage.setItem('primetime.roomCode', room);
    send({ t: 'join', roomCode: room, name: clean, kind });
  };

  return (
    <div class="card stack">
      <div class="eyebrow">{kind === 'team' ? 'Team' : 'Playing solo'}</div>
      <h1>{kind === 'team' ? 'Name your team' : 'Pick a name'}</h1>
      <p class="muted">
        This is what shows on the big screen. Use whatever you like — it does not have to be your real name.
      </p>
      <input
        value={handle}
        onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder={kind === 'team' ? 'The Snowbirds' : 'Ace'}
        enterkeyhint="go"
        maxLength={28}
      />
      {/* Short on purpose: the eyebrow is uppercase and letterspaced, and
          anything longer wraps to two lines on a phone. The big screen's own
          step 3 says where the code comes from. */}
      <div class="eyebrow">Room code</div>
      <input
        value={code}
        onInput={(e) => setCode((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder="falcon-7"
        autocapitalize="none"
        autocomplete="off"
        spellcheck={false}
        enterkeyhint="go"
        maxLength={24}
      />
      <button
        class="btn btn-primary btn-lg btn-block"
        disabled={!handle.trim() || !code.trim()}
        onClick={submit}
      >
        Join
      </button>
      <button class="btn btn-ghost btn-block" onClick={() => setKind(null)}>Back</button>
    </div>
  );
}

function Question({ state, send }: { state: PlayerState; send: ReturnType<typeof useGame>['send'] }) {
  const q = state.question;
  const { secondsLeft, now } = useCountdown(state.deadline, state.config.secondsPerQuestion);
  if (!q) return null;

  const locked = state.phase === 'locked' || state.phase === 'reveal' || !state.deadline;
  const reveal = state.reveal;
  const chosen = state.me.choiceIndex;

  // What the question is worth right now. This is the whole clock as far as a
  // player is concerned: the number falling is what makes a room answer, and
  // it replaced a progress bar that moved constantly and said less. Priced off
  // the real window so time the MC grants stretches the slide rather than
  // skipping it. Once locked, the reveal card reports what was actually won.
  const windowMs = state.deadline && state.startedAt ? state.deadline - state.startedAt : 0;
  const onOffer = locked ? q.points : pointsAt(now - (state.startedAt ?? now), windowMs, state.config);

  // Their own answer's price, from the server, which is the only place that
  // knows when the tap landed. It is quoted in words under the choices rather
  // than in the pill, which keeps falling: the two numbers have two jobs. The
  // pill is what a tap is worth NOW, so once a team is in it is the price of
  // changing their mind; the line below is what they already hold. Tapping a
  // different letter re-times the answer, so the line drops to meet the pill
  // when they genuinely switch, and holds when they tap the same letter twice.
  const mine = state.me.pointsIfRight;

  // Widths reserved from the largest value each number can take, so the pill
  // is the same size at 1000 as at 200 and at 19s as at 9s. Read off the
  // config rather than hardcoded, because both are settings the MC can change.
  const pointsWidth = `${String(state.config.questionPoints).length}ch`;
  const secondsWidth = `${String(state.config.secondsPerQuestion).length}ch`;

  return (
    <>
      <div class="row-between qhead">
        <span class="pill qhead-cat">
          {/* The question's own category, not the round's: in a mixed round
              the round has no subject and this is the only place a player is
              told what they are being asked about. The name gives way to an
              ellipsis before the position does — "Classic Film & Television"
              is 25 characters and the 7 that say where you are in the round
              matter more than the last word of the subject. */}
          <span class="ellipsis">{q.categoryName}</span>
          <span class="nowrap">· {q.position}/{q.ofTotal}</span>
        </span>
        {/*
          The falling score and the clock.

          Every part of this is pinned. The pill never wraps, never shrinks,
          and reserves the width of the widest value each number can reach, so
          a tick from 1000 to 990 or 10s to 9s changes the digits and nothing
          else. It used to be one interpolated string in a flexible pill: as
          the numbers lost a digit the pill got narrower, fitted beside the
          category, and snapped back to one line — then the next tick pushed
          it to two again. It did that every second, for twenty seconds, on
          every question.
        */}
        <span class="pill pill-brass pill-live qhead-live">
          {state.held ? (
            'Paused'
          ) : (
            <>
              {/* Number and unit inside one flex child, so the gap between
                  the metrics does not also open up between "19" and "s". */}
              <span>
                <span class="tabular" style={{ minWidth: pointsWidth }}>{onOffer}</span> pts
              </span>
              {!locked && state.deadline && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    <span class="tabular" style={{ minWidth: secondsWidth }}>{secondsLeft}</span>s
                  </span>
                </>
              )}
            </>
          )}
        </span>
      </div>

      <div class="card stack">
        <p class="prompt">{q.prompt}</p>
        {q.image && <img src={`/media/${q.image}`} alt="" style={{ width: '100%', borderRadius: '12px' }} />}
      </div>

      <div class="answers" role="group" aria-label="Answer choices">
        {(q.choices ?? []).map((choice, i) => {
          const isCorrect = reveal && reveal.answerIndex === i;
          const isMineWrong = reveal && chosen === i && !isCorrect;
          return (
            <button
              key={i}
              class={`answer${isCorrect ? ' is-correct' : ''}${isMineWrong ? ' is-wrong' : ''}${reveal && !isCorrect && chosen !== i ? ' is-muted' : ''}`}
              data-slot={i}
              aria-pressed={chosen === i}
              disabled={locked}
              onClick={() => send({ t: 'answer', choiceIndex: i })}
            >
              <Badge slot={i} />
              <span class="label">{choice}</span>
              {isCorrect && <span class="pill pill-ok">Correct</span>}
            </button>
          );
        })}
      </div>

      {/* Name the slot in both states. The chosen row is marked with a tint and
          a border in the slot's own hue, which is colour alone, and this room
          is 55 to 75 by design — the letter is the non-colour channel, so it
          has to survive the lock, not just the open window. The seconds are
          deliberately not repeated here: the timer above already counts, and a
          number inside centred prose reflows the line on every tick. */}
      {chosen !== undefined && !locked && (
        <p class="center muted">
          {['A', 'B', 'C', 'D'][chosen]} is in{mine !== undefined ? `, worth ${mine} if you're right` : ''}. Tap
          another to change your mind.
        </p>
      )}
      {state.held && <p class="center muted">The MC paused the round.</p>}
      {chosen === undefined && !locked && !state.held && <p class="center muted">Tap your answer.</p>}
      {locked && !reveal && (
        <p class="center muted">
          {chosen === undefined
            ? 'No answer from your team.'
            : `${['A', 'B', 'C', 'D'][chosen]} is locked in${
                mine !== undefined ? `, worth ${mine} if you're right` : ''
              }.`}
        </p>
      )}
    </>
  );
}

function Reveal({ state }: { state: PlayerState }) {
  const reveal = state.reveal;
  if (!reveal) return null;
  const mine = reveal.outcomes.find((o) => o.teamId === state.me.teamId);

  return (
    <>
      {mine ? (
        <div class={`card center stack ${mine.correct ? '' : ''}`}>
          <div class="eyebrow">{mine.correct ? 'Correct' : 'Not this time'}</div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: '3rem', lineHeight: 1 }}>
            {mine.awarded > 0 ? `+${mine.awarded}` : mine.awarded}
          </div>
          {mine.correct && (
            <span class="pill pill-brass">
              {mine.full ? 'Full value — inside the reading time' : `of ${mine.max}`}
            </span>
          )}
        </div>
      ) : (
        <div class="card center">
          <div class="eyebrow">No answer</div>
        </div>
      )}
      <p class="faint center">{reveal.correctPct}% of teams got this one.</p>
      <AutoAdvance
        at={state.autoAdvanceAt}
        label={state.moreInRound ? 'Next question in' : 'Round ends in'}
        held={state.held}
      />
    </>
  );
}

function Wager({ state, send }: { state: PlayerState; send: ReturnType<typeof useGame>['send'] }) {
  const [value, setValue] = useState('');
  const max = state.me.maxWager;
  const placed = state.me.wager;
  // The betting window closes on a clock now, so a table deciding whether to
  // go all in needs to know how long it has to decide. Without it the screen
  // simply changes underneath them.
  const closing = state.wagerEndsAt;

  if (placed !== undefined) {
    return (
      <div class="card center stack">
        <div class="eyebrow">Wager placed</div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: '3.4rem', lineHeight: 1 }}>{placed}</div>
        <p class="muted">Get it right and you gain {placed}. Get it wrong and you lose {placed}.</p>
        {closing && <WagerClock at={closing} held={state.held} placed />}
        <button class="btn btn-ghost" onClick={() => { setValue(''); send({ t: 'set_wager', amount: -1 }); }}>
          Change it
        </button>
      </div>
    );
  }

  return (
    <div class="card stack">
      <div class="eyebrow">Final question</div>
      <h1>Place your wager</h1>
      {closing && <WagerClock at={closing} held={state.held} />}
      <p class="muted">
        Up to {max} points. Right answer wins it, wrong answer loses it. No bet, nothing either way.
      </p>
      <div class="grid3">
        {[0.25, 0.5, 1].map((frac) => (
          <button key={frac} class="btn" onClick={() => send({ t: 'set_wager', amount: Math.round(max * frac) })}>
            {frac === 1 ? 'All in' : `${frac * 100}%`}
          </button>
        ))}
      </div>
      <Keypad
        value={value}
        onChange={setValue}
        max={max}
        submitLabel="Wager"
        onSubmit={() => send({ t: 'set_wager', amount: Number(value) })}
      />
    </div>
  );
}

/**
 * How long is left to bet.
 *
 * Deliberately blunt about the consequence of running out, because it is the
 * one place in the game where doing nothing is a decision: no bet means no
 * points won and none lost, and a table that did not realise the clock was
 * running would rightly be annoyed.
 */
function WagerClock({ at, held, placed }: { at: number; held?: boolean; placed?: boolean }) {
  const now = useNow(!held);
  if (held) return <p class="center muted">The MC paused the betting.</p>;
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return (
    <div class="center stack" style={{ gap: '2px' }}>
      <div class="clock" style={{ fontSize: '2.6rem' }}>{seconds}</div>
      <p class="faint" style={{ margin: 0 }}>{seconds > 0 ? 'seconds left to bet' : 'betting closed'}</p>
    </div>
  );
}

function Tiebreak({ state, send }: { state: PlayerState; send: ReturnType<typeof useGame>['send'] }) {
  const [value, setValue] = useState('');
  const q = state.question;
  const involved = state.scoreboard.some((r) => r.teamId === state.me.teamId && r.rank === 1);

  if (!involved) {
    return (
      <div class="card center stack">
        <div class="eyebrow">Tiebreaker</div>
        <p class="muted">The leaders are settling it. Watch the big screen.</p>
      </div>
    );
  }
  return (
    <div class="card stack">
      <div class="eyebrow">Tiebreaker — closest wins</div>
      <p class="prompt">{q?.prompt}</p>
      {state.me.numberAnswer !== undefined ? (
        <div class="center stack">
          <div class="keypad-display">{state.me.numberAnswer}</div>
          <p class="muted">Locked in.</p>
        </div>
      ) : (
        <Keypad value={value} onChange={setValue} submitLabel="Lock in" onSubmit={() => send({ t: 'answer_number', value: Number(value) })} />
      )}
    </div>
  );
}

function Standings({
  state,
  title,
  sub,
  clock,
}: {
  state: PlayerState;
  title: string;
  sub?: string;
  /** The break clock, when this scoreboard is a break rather than a beat. */
  clock?: ComponentChildren;
}) {
  const mine = state.scoreboard.find((r) => r.teamId === state.me.teamId);
  const top = state.scoreboard.filter((r) => r.teamId !== state.me.teamId).slice(0, 8);
  return (
    <>
      {sub && <p class="center" style={{ fontSize: '1.2rem', margin: 0 }}>{sub}</p>}
      {clock}
      <div class="card center stack">
        <div class="eyebrow">{title}</div>
        {mine && (
          <>
            <div style={{ fontFamily: 'var(--serif)', fontSize: '3rem', lineHeight: 1 }}>{mine.score}</div>
            <p class="muted">
              {mine.rank === 1 ? 'Leading the room' : `${ordinal(mine.rank)} of ${state.entryCount}`}
              {mine.delta > 0 ? ` · +${mine.delta} that round` : ''}
            </p>
          </>
        )}
      </div>
      <div class="stack">
        <div class="eyebrow">Top of the table</div>
        <Board rows={[...(mine ? [mine] : []), ...top].sort((a, b) => a.rank - b.rank)} limit={9} />
      </div>
    </>
  );
}

function ordinal(n: number) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function Waiting({ state, title, sub }: { state: PlayerState; title: string; sub?: string }) {
  const mine = state.teams.find((t) => t.id === state.me.teamId);
  return (
    <div class="card center stack">
      <div class="eyebrow">{mine?.name ?? state.venueName}</div>
      <h1>{title}</h1>
      {sub && <p class="muted">{sub}</p>}
    </div>
  );
}

function App() {
  const { state, status, send, toast, dismissToast } = useGame<PlayerState>('player');

  // The screen must not sleep mid-round on a shared tablet.
  useWakeLock();

  // The clock may run while the screen still shows the answer, so `counting`
  // is the wider condition and the run-up is the narrower one inside it.
  const counting = !!state?.autoAdvanceAt && !state?.held && state?.phase === 'reveal';
  const gapNow = useNow(counting);
  const nextUp =
    inRunUpToQuestion(state) &&
    state!.autoAdvanceAt! - gapNow <= nextUpWindowMs(state!.config.nextQuestionDelaySeconds);

  if (!state) {
    return (
      <div class="shell">
        <ConnBanner status={status} />
        <div class="card center"><p class="muted">Connecting to tonight's game…</p></div>
      </div>
    );
  }

  const noTeam = !state.me.teamId && state.phase !== 'lobby';

  return (
    <div class="shell">
      <ConnBanner status={status} />
      {state.message && <div class="warn">{state.message}</div>}

      {state.phase === 'lobby' && <Lobby state={state} send={send} />}

      {noTeam && (
        <>
          <div class="warn center">The night is already underway — you'll start from zero.</div>
          <Lobby state={state} send={send} />
        </>
      )}

      {!noTeam && (
        <>
          {state.phase === 'game_intro' && (
            <Waiting
              state={state}
              title={`Game ${state.game.index} of ${state.game.ofTotal ?? 1}`}
              sub={`${state.config.roundsPerGame} rounds of ${state.config.questionsPerRound}`}
            />
          )}
          {state.phase === 'round_intro' && (
            <Waiting
              state={state}
              title={`Round ${state.round?.index} of ${state.round?.ofTotal}`}
              sub={
                state.round?.mixed
                  ? `${state.config.questionsPerRound} questions, a different category every time.`
                  : `${state.round?.categoryName ?? ''} · ${state.round?.blurb ?? ''}`
              }
            />
          )}
          {(state.phase === 'question' || state.phase === 'locked' || state.phase === 'wager_question') && (
            <Question state={state} send={send} />
          )}
          {(state.phase === 'reveal' || state.phase === 'wager_reveal') &&
            (nextUp ? (
              // The last seconds of the gap belong to the run-up, not to a
              // number ticking under an answer nobody is reading any more.
              // Switches at the same instant as the big screen, because both
              // measure it from the same autoAdvanceAt.
              <NextUp at={state.autoAdvanceAt} held={state.held} big full />
            ) : (
              <>
                <Question state={state} send={send} />
                <Reveal state={state} />
              </>
            ))}
          {state.phase === 'round_scores' && (
            // The same facts the big screen is showing, so a player looking
            // down at their phone gets the break and its clock too.
            <Standings
              state={state}
              title={`End of Round ${state.round?.index ?? 1}`}
              clock={
                state.breakEndsAt ? (
                  <BreakClock
                    at={state.breakEndsAt}
                    held={state.held}
                  />
                ) : undefined
              }
            />
          )}
          {state.phase === 'wager_bet' && <Wager state={state} send={send} />}
          {state.phase === 'tiebreak' && <Tiebreak state={state} send={send} />}
          {state.phase === 'tiebreak_reveal' && <Standings state={state} title="Tiebreaker settled" />}
          {state.phase === 'game_results' && (
            <Standings
              state={state}
              title={`Game ${state.game.index} of ${state.game.ofTotal ?? 1} final`}
              clock={
                state.game.index < (state.game.ofTotal ?? 1) ? (
                  <BreakClock
                    at={state.breakEndsAt}
                    held={state.held}
                  />
                ) : undefined
              }
            />
          )}
          {state.phase === 'night_over' && <Standings state={state} title="Final standings" />}
        </>
      )}

      {/* The run-up already claims the height; a second flexible gap under it
          would split the screen and leave the clock stranded above centre. */}
      {!nextUp && <div class="spacer" />}
      {/* Empty for a player with no seat: the server withholds it, because it
          is the thing that buys the seat. */}
      {(state.phase === 'lobby' || noTeam) && state.roomCode && (
        <p class="faint center">Room {state.roomCode}</p>
      )}
      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
