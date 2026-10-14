import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { PlayerState } from '../../shared/protocol';
import './shared/styles.css';
import { useCountdown, useGame } from './shared/useGame';
import { AutoAdvance, Badge, Board, ConnBanner, Keypad, Timer, Toast } from './shared/ui';

/**
 * The player view. One screen at a time, one decision at a time.
 *
 * The guiding rule: a player should never have to ask "what am I supposed to
 * be doing right now". Whatever the phase, the top of the screen says where we
 * are and the middle holds the only control that matters.
 */

function Lobby({ state, send }: { state: PlayerState; send: ReturnType<typeof useGame>['send'] }) {
  const [name, setName] = useState(() => localStorage.getItem('primetime.name') ?? '');
  // Whether the name has been committed, tracked separately from whether it is
  // non-empty. Branching on the text itself made the name screen disappear on
  // the first keystroke and dump the player into team selection mid-word.
  const [named, setNamed] = useState(() => !!localStorage.getItem('primetime.name'));
  const [teamName, setTeamName] = useState('');
  const [mode, setMode] = useState<'pick' | 'create'>('pick');

  const confirmName = () => {
    const clean = name.trim();
    if (!clean) return;
    localStorage.setItem('primetime.name', clean);
    setName(clean);
    setNamed(true);
  };

  if (state.me.teamId) {
    const mine = state.teams.find((t) => t.id === state.me.teamId);
    return (
      <>
        <div class="card stack center">
          <div class="eyebrow">You're in</div>
          <h1 style={{ fontSize: '2rem' }}>{mine?.name}</h1>
          <p class="muted">
            {mine?.members.length === 1
              ? 'Waiting for your teammate, and for the host to start.'
              : `With ${mine?.members.filter((m) => m !== state.me.name).join(', ')}`}
          </p>
          <div class="dots center" style={{ justifyContent: 'center' }}>
            {Array.from({ length: state.config.teamSize }).map((_, i) => (
              <span key={i} class={`dot${i < (mine?.members.length ?? 0) ? ' is-on' : ''}`} />
            ))}
          </div>
        </div>
        <div class="card stack">
          <div class="eyebrow">{state.teams.length} teams so far</div>
          <div class="stack" style={{ gap: '8px' }}>
            {state.teams.map((t) => (
              <div key={t.id} class="row-between">
                <strong>{t.name}</strong>
                <span class="faint">{t.members.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>
        <button class="btn btn-ghost btn-block" onClick={() => send({ t: 'leave_team' })}>
          Leave this team
        </button>
      </>
    );
  }

  if (!named) {
    return (
      <div class="card stack">
        <div class="eyebrow">{state.venueName}</div>
        <h1>Welcome</h1>
        <p class="muted">What should we call you?</p>
        <input
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirmName(); }}
          placeholder="Your first name"
          autocomplete="given-name"
          enterkeyhint="done"
          maxLength={24}
        />
        <button class="btn btn-primary btn-lg btn-block" disabled={!name.trim()} onClick={confirmName}>
          Continue
        </button>
      </div>
    );
  }

  if (mode === 'create') {
    return (
      <div class="card stack">
        <div class="eyebrow">New team</div>
        <h1>Name your team</h1>
        <input
          value={teamName}
          onInput={(e) => setTeamName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && teamName.trim()) {
              send({ t: 'create_team', name: teamName.trim(), playerName: name.trim() });
            }
          }}
          placeholder="The Snowbirds"
          enterkeyhint="done"
          maxLength={28}
        />
        <button
          class="btn btn-primary btn-lg btn-block"
          disabled={!teamName.trim()}
          onClick={() => send({ t: 'create_team', name: teamName.trim(), playerName: name.trim() })}
        >
          Create team
        </button>
        <button class="btn btn-ghost btn-block" onClick={() => setMode('pick')}>Back</button>
      </div>
    );
  }

  const open = state.openTeams.filter((t) => !t.full);
  return (
    <>
      <div class="card stack">
        <div class="eyebrow">
          Hello {name} · <button class="btn-ghost" style={{ textDecoration: 'underline' }} onClick={() => setNamed(false)}>not you?</button>
        </div>
        <h1>Join a team</h1>
        <p class="muted">
          Teams of {state.config.teamSize}. Sit with your partner and share one device, or use your own — either works.
        </p>
      </div>

      {open.length > 0 && (
        <div class="stack">
          {open.map((t) => (
            <button
              key={t.id}
              class="btn btn-lg btn-block"
              style={{ justifyContent: 'space-between' }}
              onClick={() => send({ t: 'join_team', teamId: t.id, name: name.trim() })}
            >
              <span>{t.name}</span>
              <span class="faint">{t.members.length ? t.members.join(', ') : 'empty'}</span>
            </button>
          ))}
        </div>
      )}

      <button class="btn btn-primary btn-lg btn-block" onClick={() => setMode('create')}>
        Start a new team
      </button>
      {state.openTeams.some((t) => t.full) && (
        <p class="faint center">Full: {state.openTeams.filter((t) => t.full).map((t) => t.name).join(', ')}</p>
      )}
    </>
  );
}

function Question({ state, send }: { state: PlayerState; send: ReturnType<typeof useGame>['send'] }) {
  const q = state.question;
  const { secondsLeft, fraction } = useCountdown(state.deadline, state.config.secondsPerQuestion);
  if (!q) return null;

  const locked = state.phase === 'locked' || state.phase === 'reveal' || !state.deadline;
  const reveal = state.reveal;
  const chosen = state.me.choiceIndex;

  return (
    <>
      <div class="row-between">
        <span class="pill">{state.round?.categoryName}</span>
        <span class="pill pill-brass">{q.points} pts</span>
      </div>

      {state.deadline && <Timer fraction={fraction} seconds={secondsLeft} />}

      <div class="card stack">
        <div class="faint">Question {q.position} of {q.ofTotal}</div>
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

      {/* Naming who tapped it stops the "did you lock it in?" confusion at a shared tablet. */}
      {chosen !== undefined && !reveal && (
        <p class="center muted">
          {state.me.chosenBy && state.me.chosenBy !== state.me.name
            ? `${state.me.chosenBy} locked in ${['A', 'B', 'C', 'D'][chosen]}. Tap another to change it.`
            : `Locked in ${['A', 'B', 'C', 'D'][chosen]}. Tap another to change your mind.`}
        </p>
      )}
      {chosen === undefined && !locked && <p class="center muted">Tap your answer.</p>}
      {locked && chosen === undefined && !reveal && <p class="center muted">No answer from your team.</p>}
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
          {mine.speedBonus && <span class="pill pill-brass">First in — speed bonus</span>}
        </div>
      ) : (
        <div class="card center">
          <div class="eyebrow">No answer</div>
        </div>
      )}
      <div class="card stack">
        <div class="eyebrow">The answer</div>
        <p class="prompt">{reveal.answerText}</p>
        <p class="muted" style={{ fontFamily: 'var(--serif)' }}>{reveal.funFact}</p>
        <p class="faint">{reveal.correctPct}% of teams got this one.</p>
      </div>
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

function Standings({ state, title }: { state: PlayerState; title: string }) {
  const mine = state.scoreboard.find((r) => r.teamId === state.me.teamId);
  return (
    <>
      <div class="card center stack">
        <div class="eyebrow">{title}</div>
        {mine && (
          <>
            <div style={{ fontFamily: 'var(--serif)', fontSize: '3rem', lineHeight: 1 }}>{mine.score}</div>
            <p class="muted">
              {mine.rank === 1 ? 'Leading the room' : `${ordinal(mine.rank)} place`}
              {mine.delta > 0 ? ` · +${mine.delta} that round` : ''}
            </p>
          </>
        )}
      </div>
      <Board rows={state.scoreboard} limit={8} />
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
  useEffect(() => {
    let lock: { release: () => Promise<void> } | undefined;
    const request = async () => {
      try {
        const wakeLock = (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock;
        if (wakeLock) lock = await wakeLock.request('screen');
      } catch {
        /* Unsupported on older iPads; the host reminds people to tap to wake. */
      }
    };
    void request();
    const onVisible = () => { if (document.visibilityState === 'visible') void request(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, []);

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
        <div class="card stack center">
          <div class="eyebrow">Already underway</div>
          <h1>Join a team</h1>
          <p class="muted">Pick a team with a free seat — you'll come in with their score.</p>
          {state.openTeams.filter((t) => !t.full).map((t) => (
            <button
              key={t.id}
              class="btn btn-lg btn-block"
              onClick={() => send({ t: 'join_team', teamId: t.id, name: localStorage.getItem('primetime.name') || 'Guest' })}
            >
              {t.name}
            </button>
          ))}
        </div>
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
          {state.phase === 'round_scores' && <Standings state={state} title={`After ${state.round?.categoryName}`} />}
          {state.phase === 'wager_bet' && <Wager state={state} send={send} />}
          {state.phase === 'tiebreak' && <Tiebreak state={state} send={send} />}
          {state.phase === 'tiebreak_reveal' && <Standings state={state} title="Tiebreaker settled" />}
          {state.phase === 'block_results' && <Standings state={state} title={`Block ${state.block.index} final`} />}
          {state.phase === 'night_over' && <Standings state={state} title="Final standings" />}
        </>
      )}

      <div class="spacer" />
      <p class="faint center">Room {state.roomCode}</p>
      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
