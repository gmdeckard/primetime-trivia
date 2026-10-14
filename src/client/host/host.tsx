import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { HostState } from '../../../shared/protocol';
import '../shared/styles.css';
import { useCountdown, useGame, useSpeech, useWakeLock } from '../shared/useGame';
import { pointsAvailable } from '../../../shared/protocol';
import { AutoAdvance, Badge, Board, Timer, Toast } from '../shared/ui';

/**
 * The big screen. Read-only, and sized for a projector at the far end of a
 * clubhouse room.
 *
 * It deliberately never shows the answer key before the reveal — not because
 * players would read it off the screen, but because the MC's own laptop is
 * usually mirroring this, and a reflection in a window has ruined more than
 * one quiz night.
 */

function JoinPanel({ state }: { state: HostState }) {
  return (
    <div class="join">
      <div class="join-qr" dangerouslySetInnerHTML={{ __html: state.join.qrSvg }} />
      <div class="stack">
        <div class="eyebrow">Scan, or type this in any browser</div>
        <div class="join-url">{state.join.url.replace('http://', '')}</div>
        {state.join.ssid && (
          <p class="muted" style={{ fontSize: '1.3rem' }}>
            First join the wifi network <strong>{state.join.ssid}</strong>
          </p>
        )}
        <p class="muted" style={{ fontSize: '1.2rem' }}>
          Room <strong>{state.roomCode}</strong> · play solo or share a device
        </p>
      </div>
    </div>
  );
}

function AnswerGrid({ state }: { state: HostState }) {
  const q = state.question;
  const reveal = state.reveal;
  if (!q?.choices) return null;
  return (
    <div class="answers">
      {q.choices.map((choice, i) => {
        const correct = reveal?.answerIndex === i;
        return (
          <div
            key={i}
            class={`answer${correct ? ' is-correct' : ''}${reveal && !correct ? ' is-muted' : ''}`}
            data-slot={i}
          >
            <Badge slot={i} />
            <span class="label">{choice}</span>
          </div>
        );
      })}
    </div>
  );
}

function AnsweredStrip({ state }: { state: HostState }) {
  const total = state.entryCount;
  const answered = state.answeredCount;
  // A dot per entry is a nice touch at eight and unreadable confetti at a
  // hundred, so past a couple of dozen it becomes a bar.
  const asBar = total > 24;
  return (
    <div class="row" style={{ justifyContent: 'center', gap: '18px' }}>
      <span class="pill pill-brass" style={{ fontSize: '1.1rem' }}>
        {answered} of {total} in
      </span>
      {asBar ? (
        <span class="answerbar">
          <i style={{ width: `${total ? (answered / total) * 100 : 0}%` }} />
        </span>
      ) : (
        <div class="dots">
          {state.teams.map((t) => (
            <span key={t.id} class={`dot${state.answeredTeamIds.includes(t.id) ? ' is-on' : ''}`} title={t.name} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Live standings beside the question.
 *
 * Shows a filled dot for a team that has locked an answer, so the MC can see
 * who is still thinking without looking at their phone, and the room can see
 * the race without waiting for the end of the round.
 */
function StandingsRail({ state }: { state: HostState }) {
  const rows = state.scoreboard;
  if (rows.length < 2) return null;
  // Past about ten the rows get too small to read across a room; the full
  // scoreboard between questions covers everyone.
  const shown = rows.slice(0, 10);
  const live = state.phase === 'question';

  return (
    <div class="rail">
      <div class="rail-head">Standings</div>
      {shown.map((row) => (
        <div key={row.teamId} class={`rail-row${row.rank === 1 && row.score > 0 ? ' is-lead' : ''}`}>
          <span class="rail-rank">{row.rank}</span>
          <span class="rail-name">{row.name}</span>
          <span class="rail-score">{row.score}</span>
          <span class={`rail-dot${state.answeredTeamIds.includes(row.teamId) ? ' is-in' : ''}`} />
        </div>
      ))}
      {rows.length > shown.length && (
        <div class="rail-foot">+{rows.length - shown.length} more</div>
      )}
      {live && <div class="rail-foot">● answered</div>}
    </div>
  );
}

function Podium({ state, title }: { state: HostState; title: string }) {
  const rows = state.scoreboard;
  const winner = rows[0];
  return (
    <div class="host-body">
      <div class="center stack">
        <div class="eyebrow">{title}</div>
        {winner && (
          <>
            <div class="host-display" style={{ color: 'var(--brass)' }}>{winner.name}</div>
            <p class="muted" style={{ fontSize: '1.6rem' }}>
              {winner.score} points
              {rows[1] ? ` · ${winner.score - rows[1].score} clear of ${rows[1].name}` : ''}
            </p>
          </>
        )}
      </div>
      <div style={{ maxWidth: '900px', margin: '0 auto', width: '100%' }}>
        <Board rows={rows} limit={10} />
      </div>
    </div>
  );
}

function App() {
  // The big screen sits untouched through a ten-minute break.
  useWakeLock();
  const { state, send: _send, toast, dismissToast } = useGame<HostState>('host');
  const speak = useSpeech(!!state?.config.readAloud);

  useEffect(() => {
    if (!state) return;
    if (state.phase !== 'question' && state.phase !== 'wager_question') return;
    const q = state.question;
    if (!q) return;
    const letters = ['A', 'B', 'C', 'D'];
    const spoken = [q.prompt, ...(q.choices ?? []).map((c, i) => `${letters[i]}. ${c}`)].join('. ');
    speak(spoken);
  }, [state?.phase, state?.question?.prompt, speak]);

  // Hooks run before any early return, so the countdown can't be conditional.
  const { secondsLeft, fraction } = useCountdown(state?.deadline, state?.config.secondsPerQuestion ?? 1);
  // Matches the player's handset exactly: both derive from the same deadline
  // and the same shared bands, so the two screens cannot disagree.
  const onOffer =
    state?.question && state.deadline && state.phase === 'question'
      ? pointsAvailable(state.question.points, state.config, 1 - fraction)
      : state?.question?.points ?? 0;

  // Drives the switch from the answer to the scoreboard during the gap between
  // questions. Purely a presentation decision — the engine still owns when the
  // game actually moves, and both are derived from the same deadline, so they
  // never disagree.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!state?.autoAdvanceAt || state.held) return;
    const id = setInterval(() => setTick(Date.now()), 200);
    return () => clearInterval(id);
  }, [state?.autoAdvanceAt, state?.held]);

  if (!state) {
    return <div class="host center"><p class="muted">Starting up…</p></div>;
  }

  const q = state.question;

  // The answer and its fact get the first part of the gap; the scoreboard takes
  // the last few seconds, so each question ends on where everyone now stands.
  const gapMs = state.config.nextQuestionDelaySeconds * 1000;
  const standingsWindowMs = Math.min(5000, gapMs * 0.45);
  const showStandings =
    state.phase === 'reveal' &&
    !!state.autoAdvanceAt &&
    !state.held &&
    state.scoreboard.length > 1 &&
    state.autoAdvanceAt - tick <= standingsWindowMs;

  // No point showing the rail next to a full scoreboard.
  const showRail =
    !showStandings &&
    state.scoreboard.length > 1 &&
    (state.phase === 'question' || state.phase === 'locked' || state.phase === 'reveal');

  return (
    <div class="host">
      <div class="host-bar">
        <div>
          <div class="eyebrow">{state.venueName}</div>
          {state.round && (
            <div class="serif" style={{ fontSize: '1.5rem' }}>
              {state.round.categoryName}
              <span class="muted" style={{ fontSize: '1rem' }}>
                {' '}· round {state.round.index} of {state.round.ofTotal}
                {q ? ` · question ${q.position} of ${q.ofTotal}` : ''}
              </span>
            </div>
          )}
        </div>
        <div class="row" style={{ gap: '14px' }}>
          {state.block.index > 0 && <span class="pill">Block {state.block.index}</span>}
          <span class="pill">{state.entryCount} playing</span>
          <span class="pill pill-brass">{state.roomCode}</span>
        </div>
      </div>

      {state.message && <div class="warn center" style={{ fontSize: '1.2rem' }}>{state.message}</div>}

      {state.phase === 'lobby' && (
        <div class="host-body">
          <div class="center stack">
            <h1 class="host-display">{state.venueName}</h1>
            <p class="muted" style={{ fontSize: '1.5rem' }}>Play on your own or share a device.</p>
          </div>
          <JoinPanel state={state} />
          {state.teams.length > 0 && (
            <>
              <div class="center">
                <span class="pill pill-brass" style={{ fontSize: '1.2rem' }}>
                  {state.entryCount} in
                </span>
              </div>
              <div class={`namewall${state.teams.length > 24 ? ' is-dense' : ''}`}>
                {state.teams.map((t) => (
                  <span key={t.id} class="namechip">{t.name}</span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {state.phase === 'block_intro' && (
        <div class="host-body center stack">
          <div class="eyebrow">Here we go</div>
          <h1 class="host-display">Block {state.block.index}</h1>
          <p class="muted" style={{ fontSize: '1.5rem' }}>
            {state.config.roundsPerBlock} rounds · {state.config.questionsPerRound} questions each
            {state.config.finalWager ? ' · final wager to close' : ''}
          </p>
        </div>
      )}

      {state.phase === 'round_intro' && state.round && (
        <div class="host-body center stack">
          <div class="eyebrow">Round {state.round.index} of {state.round.ofTotal}</div>
          <h1 class="host-display">{state.round.categoryName}</h1>
          <p class="muted" style={{ fontSize: '1.6rem', maxWidth: '26ch', margin: '0 auto' }}>{state.round.blurb}</p>
        </div>
      )}

      {(state.phase === 'question' || state.phase === 'locked' || state.phase === 'reveal' ||
        state.phase === 'wager_question' || state.phase === 'wager_reveal') && q && (
        <div class={`host-stage${showRail ? ' has-rail' : ''}`}>
        {showStandings ? (
          <div class="host-body">
            <div class="center">
              <div class="eyebrow">Standings</div>
            </div>
            <div style={{ maxWidth: '1000px', margin: '0 auto', width: '100%' }}>
              <Board rows={state.scoreboard} limit={10} />
            </div>
            <AutoAdvance
              at={state.autoAdvanceAt}
              total={state.config.nextQuestionDelaySeconds}
              label="Next question in"
              held={state.held}
            />
          </div>
        ) : (
        <div class="host-body">
          {state.deadline && (
            <div style={{ maxWidth: '1100px', margin: '0 auto', width: '100%' }}>
              <Timer fraction={fraction} seconds={secondsLeft} />
              {/* The room is watching this screen, not their phones, so the
                  falling value belongs here as much as on the handset. */}
              <div class="center" style={{ marginTop: '8px' }}>
                <span
                  class={`pill pill-brass${onOffer > q.points ? ' pill-live' : ''}`}
                  style={{ fontSize: '1.3rem' }}
                >
                  {onOffer} pts
                </span>
              </div>
            </div>
          )}
          <h1 class="prompt center">{q.prompt}</h1>
          {q.image && (
            <img
              src={`/media/${q.image}`}
              alt=""
              style={{ maxHeight: '38vh', maxWidth: '90%', margin: '0 auto', borderRadius: '16px', display: 'block' }}
            />
          )}
          <AnswerGrid state={state} />
          {state.phase === 'question' && <AnsweredStrip state={state} />}
          {state.phase === 'locked' && (
            <div class="stack" style={{ gap: '14px' }}>
              <div class="center"><span class="pill pill-brass" style={{ fontSize: '1.3rem' }}>Answers in</span></div>
              <AutoAdvance
                at={state.autoAdvanceAt}
                total={state.config.revealDelaySeconds}
                label="Answer in"
                held={state.held}
              />
            </div>
          )}
          {state.reveal && (
            <>
              <p class="fact">{state.reveal.funFact}</p>
              <div class="center">
                <span class="pill" style={{ fontSize: '1.1rem' }}>
                  {state.reveal.correctPct}% of teams got it
                </span>
              </div>
              <AutoAdvance
                at={state.autoAdvanceAt}
                total={state.config.nextQuestionDelaySeconds}
                label="Next question in"
                held={state.held}
              />
            </>
          )}
        </div>
        )}
        {showRail && <StandingsRail state={state} />}
        </div>
      )}

      {state.phase === 'round_scores' && (
        <div class="host-body">
          <div class="center">
            <div class="eyebrow">After {state.round?.categoryName}</div>
          </div>
          <div style={{ maxWidth: '900px', margin: '0 auto', width: '100%' }}>
            <Board rows={state.scoreboard} limit={12} />
          </div>
        </div>
      )}

      {state.phase === 'wager_bet' && (
        <div class="host-body center stack">
          <div class="eyebrow">Final question of the block</div>
          <h1 class="host-display">Place your wagers</h1>
          <p class="muted" style={{ fontSize: '1.5rem' }}>
            Bet any part of your score. Right answer wins it, wrong answer loses it.
          </p>
          <div class="teamgrid" style={{ maxWidth: '1000px', margin: '0 auto' }}>
            {state.scoreboard.map((row) => (
              <div key={row.teamId} class="teamchip">
                <strong>{row.name}</strong>
                <span class="faint">{row.score} on the board</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {state.phase === 'tiebreak' && q && (
        <div class="host-body center stack">
          <div class="eyebrow">Tiebreaker — closest answer wins</div>
          <h1 class="prompt">{q.prompt}</h1>
          {state.deadline && (
            <div style={{ maxWidth: '900px', margin: '0 auto', width: '100%' }}>
              <Timer fraction={fraction} seconds={secondsLeft} />
            </div>
          )}
        </div>
      )}

      {state.phase === 'tiebreak_reveal' && state.reveal && (
        <div class="host-body center stack">
          <div class="eyebrow">The answer was</div>
          <h1 class="host-display">{state.reveal.answerText}</h1>
          <div class="teamgrid" style={{ maxWidth: '1000px', margin: '0 auto' }}>
            {state.reveal.outcomes.map((o) => (
              <div key={o.teamId} class="teamchip">
                <strong>{o.name}</strong>
                <span class="faint">guessed {o.numberAnswer ?? '—'}{o.correct ? ' · wins it' : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {state.phase === 'block_results' && <Podium state={state} title={`Block ${state.block.index} — final standings`} />}
      {state.phase === 'night_over' && <Podium state={state} title="Tonight's champions" />}

      {state.phase !== 'lobby' && (
        <div class="host-bar">
          <p class="faint">Join at {state.join.url.replace('http://', '')} · room {state.roomCode}</p>
          <p class="faint">{state.entryCount} playing</p>
        </div>
      )}

      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
