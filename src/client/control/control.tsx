import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ControlState, GameConfig } from '../../../shared/protocol';
import '../shared/styles.css';
import { useCountdown, useGame } from '../shared/useGame';
import { AutoAdvance, Board, ConnBanner, Toast } from '../shared/ui';

/**
 * The MC's phone.
 *
 * Two rules shaped this screen. First, there is always exactly one obvious
 * primary button, pinned to the bottom of the screen where a thumb already is
 * — an MC is standing up, holding a microphone, looking at the room, not at
 * this. Second, it shows the answer and the next question, because the whole
 * reason this is a separate view is so the host can run the room while facing
 * it instead of hunching over the laptop.
 */

function Login({ onToken }: { onToken: (token: string) => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/control/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) {
        setError('That PIN is not right.');
        return;
      }
      const { token } = (await res.json()) as { token: string };
      localStorage.setItem('primetime.controlToken', token);
      onToken(token);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="shell">
      <div class="card stack">
        <div class="eyebrow">MC controls</div>
        <h1>Host PIN</h1>
        <p class="muted">Printed in the terminal window where you started the game.</p>
        <input
          value={pin}
          onInput={(e) => setPin((e.target as HTMLInputElement).value)}
          inputMode="numeric"
          autocomplete="off"
          placeholder="000000"
          style={{ fontSize: '2rem', textAlign: 'center', fontFamily: 'var(--mono)' }}
        />
        {error && <p class="pill pill-bad">{error}</p>}
        <button class="btn btn-primary btn-lg btn-block" onClick={submit} disabled={busy || pin.length < 4}>
          Unlock
        </button>
      </div>
    </div>
  );
}

/** What the big button does, in words the MC can glance at. */
function primaryAction(state: ControlState): { label: string; hint: string } {
  switch (state.phase) {
    case 'lobby': return { label: 'Start the block', hint: `${state.entryCount} ready` };
    case 'block_intro': return { label: 'First round', hint: 'Introduce the category' };
    case 'round_intro': return { label: 'First question', hint: state.round?.categoryName ?? '' };
    case 'question': return { label: 'Answers in', hint: `${state.answeredCount} of ${state.entryCount} answered` };
    case 'locked':
      return state.autoAdvanceAt
        ? { label: 'Reveal now', hint: 'Revealing by itself shortly' }
        : { label: 'Reveal the answer', hint: 'Build it up a moment' };
    case 'reveal':
      return state.autoAdvanceAt
        ? { label: 'Next now', hint: state.upNext ?? '' }
        : { label: 'Next question', hint: state.upNext ?? '' };
    case 'round_scores': return { label: 'Continue', hint: 'Read out the top three' };
    case 'wager_bet': return { label: 'Show the final question', hint: 'Once every team has bet' };
    case 'wager_question': return { label: 'Answers in', hint: 'Lock the final question' };
    case 'wager_reveal': return { label: 'Final standings', hint: '' };
    case 'tiebreak': return { label: 'Answers in', hint: 'Closest wins' };
    case 'tiebreak_reveal': return { label: 'Back to standings', hint: '' };
    case 'block_results': return { label: 'Start another block', hint: 'Same teams, scores carry over' };
    case 'night_over': return { label: '—', hint: 'Night finished' };
  }
}

function Setup({ state, send }: { state: ControlState; send: ReturnType<typeof useGame>['send'] }) {
  const set = (patch: Partial<GameConfig>) => send({ t: 'set_config', patch });
  const [venue, setVenue] = useState(state.venueName);

  return (
    <div class="card stack">
      <div class="eyebrow">Before you start</div>

      <label class="stack" style={{ gap: '6px' }}>
        <span class="faint">Event name (shown on the big screen)</span>
        <input
          value={venue}
          onInput={(e) => setVenue((e.target as HTMLInputElement).value)}
          onBlur={() => set({ venueName: venue })}
          maxLength={40}
        />
      </label>

      <div class="stack" style={{ gap: '6px' }}>
        <span class="faint">
          Shape of a block — {state.config.roundsPerBlock} × {state.config.questionsPerRound} questions ≈{' '}
          {Math.round(
            (state.config.roundsPerBlock * state.config.questionsPerRound * (state.config.secondsPerQuestion + 22) +
              (state.config.finalWager ? 150 : 0)) / 60,
          )}{' '}
          min
        </span>
        <div class="grid3">
          {[
            { label: '3 × 8', rounds: 3, questions: 8 },
            { label: '4 × 6', rounds: 4, questions: 6 },
            { label: '2 × 10', rounds: 2, questions: 10 },
          ].map((opt) => (
            <button
              key={opt.label}
              class={`btn${state.config.roundsPerBlock === opt.rounds && state.config.questionsPerRound === opt.questions ? ' btn-primary' : ''}`}
              onClick={() => set({ roundsPerBlock: opt.rounds, questionsPerRound: opt.questions })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div class="stack" style={{ gap: '6px' }}>
        <span class="faint">Seconds per question — {state.config.secondsPerQuestion}</span>
        <div class="grid3">
          {[25, 35, 50].map((n) => (
            <button
              key={n}
              class={`btn${state.config.secondsPerQuestion === n ? ' btn-primary' : ''}`}
              onClick={() => set({ secondsPerQuestion: n })}
            >
              {n}s
            </button>
          ))}
        </div>
      </div>

      <div class="stack" style={{ gap: '6px' }}>
        <span class="faint">
          Pacing — {state.config.autoAdvance
            ? `reveals after ${state.config.revealDelaySeconds}s, moves on after ${state.config.nextQuestionDelaySeconds}s`
            : 'you tap through every step'}
        </span>
        <button
          class={`btn${state.config.autoAdvance ? ' btn-primary' : ''}`}
          onClick={() => set({ autoAdvance: !state.config.autoAdvance })}
        >
          Run the round automatically {state.config.autoAdvance ? 'on' : 'off'}
        </button>
        {state.config.autoAdvance && (
          <>
            <span class="faint">Pause before the answer</span>
            <div class="grid3">
              {[2, 4, 6].map((n) => (
                <button
                  key={n}
                  class={`btn btn-sm${state.config.revealDelaySeconds === n ? ' btn-primary' : ''}`}
                  onClick={() => set({ revealDelaySeconds: n })}
                >
                  {n}s
                </button>
              ))}
            </div>
            <span class="faint">Time on the answer — long enough to read the fact aloud</span>
            <div class="grid3">
              {[7, 10, 15].map((n) => (
                <button
                  key={n}
                  class={`btn btn-sm${state.config.nextQuestionDelaySeconds === n ? ' btn-primary' : ''}`}
                  onClick={() => set({ nextQuestionDelaySeconds: n })}
                >
                  {n}s
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div class="grid2">
        <button
          class={`btn${state.config.speedBonus ? ' btn-primary' : ''}`}
          onClick={() => set({ speedBonus: !state.config.speedBonus })}
        >
          Speed bonus {state.config.speedBonus ? 'on' : 'off'}
        </button>
        <button
          class={`btn${state.config.finalWager ? ' btn-primary' : ''}`}
          onClick={() => set({ finalWager: !state.config.finalWager })}
        >
          Final wager {state.config.finalWager ? 'on' : 'off'}
        </button>
      </div>

      <button
        class={`btn${state.config.readAloud ? ' btn-primary' : ''}`}
        onClick={() => set({ readAloud: !state.config.readAloud })}
      >
        Read questions aloud {state.config.readAloud ? 'on' : 'off'}
      </button>

      {state.packs.length > 0 && (
        <div class="stack" style={{ gap: '6px' }}>
          <span class="faint">Extra packs — the core bank is always in play</span>
          {state.packs.map((pack) => {
            const on = state.config.packs.includes(pack.id);
            return (
              <button
                key={pack.id}
                class={`btn btn-sm${on ? ' btn-primary' : ''}`}
                style={{ justifyContent: 'space-between' }}
                onClick={() =>
                  set({
                    packs: on
                      ? state.config.packs.filter((p) => p !== pack.id)
                      : [...state.config.packs, pack.id],
                  })
                }
              >
                <span>{pack.name}</span>
                <span class="faint">{pack.questionCount} · {pack.audience}</span>
              </button>
            );
          })}
        </div>
      )}

      <p class="faint">
        {state.bank.total} questions loaded · {state.bank.availableInSelection} unused in the current selection
      </p>
    </div>
  );
}

function Teams({ state, send }: { state: ControlState; send: ReturnType<typeof useGame>['send'] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // At a hundred entries, scrolling to find one is hopeless. Filter by name,
  // and otherwise show the table in score order so the ones the MC is most
  // likely to be asked about are at the top.
  const needle = filter.trim().toLowerCase();
  const rows = state.scoreboard.filter((r) => !needle || r.name.toLowerCase().includes(needle));
  const shown = needle ? rows : rows.slice(0, 25);

  return (
    <div class="card stack">
      <div class="row-between">
        <div class="eyebrow">Players ({state.entryCount})</div>
        <span class="faint">tap to adjust</span>
      </div>

      {state.entryCount > 10 && (
        <input
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          placeholder="Find a player or team"
          maxLength={28}
        />
      )}

      {shown.map((row) => {
        const entry = state.teams.find((t) => t.id === row.teamId);
        const answered = state.answeredTeamIds.includes(row.teamId);
        return (
          <div key={row.teamId} class="stack" style={{ gap: '8px' }}>
            <button class="row-between" style={{ width: '100%', textAlign: 'left' }} onClick={() => setOpen(open === row.teamId ? null : row.teamId)}>
              <span class="grow">
                <strong>{row.name}</strong>
                <br />
                <span class="faint">
                  {row.rank === 1 && row.score > 0 ? 'leading' : `${row.rank} of ${state.entryCount}`}
                  {entry?.kind === 'team' ? ' · team' : ''}
                  {entry && !entry.connected ? ' · offline' : ''}
                </span>
              </span>
              <span class="row" style={{ gap: '8px' }}>
                {answered && <span class="pill pill-ok">in</span>}
                <span class="board-score tabular">{row.score}</span>
              </span>
            </button>
            {open === row.teamId && (
              <div class="stack" style={{ gap: '8px', paddingLeft: '8px' }}>
                <div class="grid3">
                  {[-10, 5, 10].map((delta) => (
                    <button key={delta} class="btn btn-sm" onClick={() => send({ t: 'adjust_score', teamId: row.teamId, delta })}>
                      {delta > 0 ? `+${delta}` : delta}
                    </button>
                  ))}
                </div>
                <div class="grid2">
                  <button
                    class="btn btn-sm"
                    onClick={() => {
                      const name = prompt('New name', row.name);
                      if (name) send({ t: 'rename_team', teamId: row.teamId, name });
                    }}
                  >
                    Rename
                  </button>
                  <button
                    class="btn btn-sm btn-danger"
                    onClick={() => {
                      if (confirm(`Remove ${row.name}? Their score goes with them.`)) send({ t: 'remove_team', teamId: row.teamId });
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {!needle && rows.length > shown.length && (
        <p class="faint">Showing the top {shown.length}. Use the search to reach the rest.</p>
      )}
      {!state.entryCount && <p class="muted">Nobody has joined yet.</p>}
    </div>
  );
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('primetime.controlToken'));
  // No token means no socket. Connecting anyway gets us closed with 4001 on
  // every attempt, which is a reconnect loop with nothing to show for it.
  const { state, status, send, toast, unauthorized, dismissToast } = useGame<ControlState>('control', { enabled: !!token });
  const { secondsLeft } = useCountdown(state?.deadline, state?.config.secondsPerQuestion ?? 1);
  const [showSetup, setShowSetup] = useState(false);

  // Space bar advances, so an MC with a bluetooth clicker or a laptop can run
  // the whole night without looking down.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return;
      if (e.code === 'Space' || e.code === 'ArrowRight' || e.code === 'PageDown') {
        e.preventDefault();
        send({ t: 'advance' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [send]);

  // A rejected token (server restarted, PIN changed) drops us back to the PIN screen.
  useEffect(() => {
    if (unauthorized) setToken(null);
  }, [unauthorized]);

  if (!token) return <Login onToken={setToken} />;

  if (!state) {
    return (
      <div class="shell">
        <ConnBanner status={status} />
        <div class="card center"><p class="muted">Connecting…</p></div>
      </div>
    );
  }

  const action = primaryAction(state);
  const live = state.phase === 'question' || state.phase === 'wager_question' || state.phase === 'tiebreak';

  return (
    <div class="control">
      <ConnBanner status={status} />

      <div class="row-between">
        <div>
          <div class="eyebrow">MC controls</div>
          <strong>{state.venueName}</strong>
        </div>
        <button class="btn btn-sm" onClick={() => setShowSetup(!showSetup)}>
          {showSetup ? 'Hide setup' : 'Setup'}
        </button>
      </div>

      {state.warnings.map((w) => (
        <div key={w} class="warn">{w}</div>
      ))}

      {(showSetup || state.phase === 'lobby') && <Setup state={state} send={send} />}

      {/* Phase, answer key and lookahead: everything the MC speaks from. */}
      <div class="card stack">
        <div class="row-between">
          <span class="pill pill-brass">{state.phase.replace(/_/g, ' ')}</span>
          {live && <span class="pill">{secondsLeft}s · {state.answeredCount}/{state.entryCount} in</span>}
          {state.round && <span class="faint">R{state.round.index}/{state.round.ofTotal}</span>}
        </div>

        {state.question && (
          <>
            <p style={{ fontFamily: 'var(--serif)', fontSize: '1.15rem', margin: 0 }}>{state.question.prompt}</p>
            {state.answerKey && (
              <div class="answerkey">
                <div class="eyebrow" style={{ color: '#8fd79f' }}>Answer</div>
                <strong>
                  {state.answerKey.index !== undefined ? `${['A', 'B', 'C', 'D'][state.answerKey.index]} — ` : ''}
                  {state.answerKey.text}
                </strong>
                <p class="faint" style={{ marginBottom: 0 }}>{state.answerKey.funFact}</p>
              </div>
            )}
          </>
        )}

        {state.phase === 'reveal' && state.upNext && (
          <p class="faint">Up next: {state.upNext}</p>
        )}
      </div>

      {live && (
        <div class="grid3">
          <button class="btn" onClick={() => send({ t: 'extend_timer', seconds: 15 })}>+15s</button>
          <button class="btn" onClick={() => send({ t: 'lock_now' })}>Lock now</button>
          <button class="btn" onClick={() => send({ t: 'skip_question' })}>Skip</button>
        </div>
      )}

      {state.phase === 'question' && (
        <button class="btn btn-block btn-sm" onClick={() => send({ t: 'replace_question' })}>
          Swap this question — they've seen it before
        </button>
      )}

      {state.phase === 'wager_bet' && (
        <div class="card stack">
          <div class="eyebrow">Wagers</div>
          {state.scoreboard.map((row) => (
            <div key={row.teamId} class="row-between">
              <span>{row.name}</span>
              <span class="faint">{row.score} available</span>
            </div>
          ))}
        </div>
      )}

      {(state.phase === 'block_results' || state.phase === 'round_scores' || state.phase === 'night_over') && (
        <>
          <Board rows={state.scoreboard} />
          {state.scoreboard.filter((r) => r.rank === 1).length > 1 && (
            <button class="btn btn-block" onClick={() => send({ t: 'start_tiebreak' })}>
              Break the tie at the top
            </button>
          )}
        </>
      )}

      <Teams state={state} send={send} />

      <div class="card stack">
        <div class="eyebrow">Announce on the big screen</div>
        <div class="grid2">
          <button class="btn btn-sm" onClick={() => send({ t: 'say', message: 'Short break — back in 10 minutes.' })}>
            Break
          </button>
          <button class="btn btn-sm" onClick={() => send({ t: 'say', message: '' })}>Clear</button>
        </div>
      </div>

      <div class="card stack">
        <div class="eyebrow">End of night</div>
        <button class="btn btn-sm btn-block" onClick={() => { if (confirm('End the night and show final standings?')) send({ t: 'end_night' }); }}>
          End the night
        </button>
        <button
          class="btn btn-sm btn-danger btn-block"
          onClick={() => { if (confirm('Clear all teams and scores and start fresh? This cannot be undone.')) send({ t: 'reset_night' }); }}
        >
          Reset everything
        </button>
        <p class="faint">
          {state.bank.usedTonight} questions asked tonight · {state.bank.availableInSelection} unused remaining
        </p>
      </div>

      <div class="control-sticky">
        {(state.autoAdvanceAt || state.held) && (
          <div class="row" style={{ gap: '10px', marginBottom: '10px' }}>
            <div class="grow">
              <AutoAdvance
                at={state.autoAdvanceAt}
                total={state.phase === 'locked' ? state.config.revealDelaySeconds : state.config.nextQuestionDelaySeconds}
                label={state.phase === 'locked' ? 'Revealing in' : 'Next in'}
                held={state.held}
              />
            </div>
            <button
              class={`btn btn-sm${state.held ? ' btn-primary' : ''}`}
              onClick={() => send({ t: 'hold', held: !state.held })}
            >
              {state.held ? 'Resume' : 'Hold'}
            </button>
          </div>
        )}
        <button class="btn btn-primary btn-lg btn-block" onClick={() => send({ t: 'advance' })} disabled={state.phase === 'night_over'}>
          {action.label}
        </button>
        {action.hint && <p class="faint center" style={{ margin: '8px 0 0' }}>{action.hint}</p>}
      </div>

      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
