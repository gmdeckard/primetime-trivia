import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { EntryKind, PlayerState } from '../../shared/protocol';
import './shared/styles.css';
import { useCountdown, useGame, useWakeLock } from './shared/useGame';
import { pointsAt } from '../../shared/protocol';
import { AutoAdvance, Badge, Board, ConnBanner, Keypad, Toast } from './shared/ui';

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
    if (!clean) return;
    localStorage.setItem('primetime.handle', clean);
    send({ t: 'join', name: clean, kind });
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
      <button class="btn btn-primary btn-lg btn-block" disabled={!handle.trim()} onClick={submit}>
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

  return (
    <>
      <div class="row-between">
        <span class="pill">
          {state.round?.categoryName} · {q.position}/{q.ofTotal}
        </span>
        <span class="pill pill-brass pill-live">
          {onOffer} pts{!locked && state.deadline ? ` · ${secondsLeft}s` : ''}
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
        <p class="center muted">{['A', 'B', 'C', 'D'][chosen]} is in. Tap another to change your mind.</p>
      )}
      {chosen === undefined && !locked && <p class="center muted">Tap your answer.</p>}
      {locked && !reveal && (
        <p class="center muted">
          {chosen === undefined ? 'No answer from your team.' : `${['A', 'B', 'C', 'D'][chosen]} is locked in.`}
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
        total={state.config.nextQuestionDelaySeconds}
        label="Next question in"
        held={state.held}
      />
    </>
  );
}

function Wager({ state, send }: { state: PlayerState; send: ReturnType<typeof useGame>['send'] }) {
  const [value, setValue] = useState('');
  const max = state.me.maxWager;
  const placed = state.me.wager;

  if (placed !== undefined) {
    return (
      <div class="card center stack">
        <div class="eyebrow">Wager placed</div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: '3.4rem', lineHeight: 1 }}>{placed}</div>
        <p class="muted">Get it right and you gain {placed}. Get it wrong and you lose {placed}.</p>
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
      <p class="muted">Up to {max} points. Right answer wins it, wrong answer loses it.</p>
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

function Standings({ state, title, sub }: { state: PlayerState; title: string; sub?: string }) {
  const mine = state.scoreboard.find((r) => r.teamId === state.me.teamId);
  const top = state.scoreboard.filter((r) => r.teamId !== state.me.teamId).slice(0, 8);
  return (
    <>
      {sub && <p class="center" style={{ fontSize: '1.2rem', margin: 0 }}>{sub}</p>}
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
          {state.phase === 'block_intro' && <Waiting state={state} title={`Block ${state.block.index}`} sub="Starting now." />}
          {state.phase === 'round_intro' && (
            <Waiting
              state={state}
              title={state.round?.categoryName ?? 'Next round'}
              sub={`Round ${state.round?.index} of ${state.round?.ofTotal} · ${state.round?.blurb ?? ''}`}
            />
          )}
          {(state.phase === 'question' || state.phase === 'locked' || state.phase === 'wager_question') && (
            <Question state={state} send={send} />
          )}
          {(state.phase === 'reveal' || state.phase === 'wager_reveal') && (
            <>
              <Question state={state} send={send} />
              <Reveal state={state} />
            </>
          )}
          {state.phase === 'round_scores' && (
            // The same two facts the big screen is showing, so a player who is
            // looking down at their phone gets the break length too.
            <Standings
              state={state}
              title={`End of Round ${state.round?.index ?? 1}`}
              sub={`${
                !state.round || state.round.index >= state.round.ofTotal
                  ? state.config.blockBreakMinutes
                  : state.config.roundBreakMinutes
              } minute break`}
            />
          )}
          {state.phase === 'wager_bet' && <Wager state={state} send={send} />}
          {state.phase === 'tiebreak' && <Tiebreak state={state} send={send} />}
          {state.phase === 'tiebreak_reveal' && <Standings state={state} title="Tiebreaker settled" />}
          {state.phase === 'block_results' && <Standings state={state} title={`Block ${state.block.index} final`} />}
          {state.phase === 'night_over' && <Standings state={state} title="Final standings" />}
        </>
      )}

      <div class="spacer" />
      {(state.phase === 'lobby' || noTeam) && <p class="faint center">Room {state.roomCode}</p>}
      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
