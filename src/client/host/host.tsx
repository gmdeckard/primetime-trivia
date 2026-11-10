import { render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { HostState, WatchState } from '../../../shared/protocol';
import '../shared/styles.css';
import { Login } from '../shared/login';
import { nextUpWindowMs, useCountdown, useGame, useNow, useSpeech, useWakeLock } from '../shared/useGame';
import { createHostAudio, type Bed, type HostAudio } from './audio';
import { pickBedVariant } from './beds';
import { inRunUpToQuestion, pointsAt } from '../../../shared/protocol';
import { AutoAdvance, Badge, Board, BreakClock, NextUp, Toast } from '../shared/ui';

/**
 * The big screen. Read-only, and sized for a projector at the far end of a
 * clubhouse room.
 *
 * It deliberately never shows the answer key before the reveal — not because
 * players would read it off the screen, but because the MC's own laptop is
 * usually mirroring this, and a reflection in a window has ruined more than
 * one quiz night.
 *
 * This file also serves `/watch`, which is this screen on the phone of someone
 * who is not playing: a first-timer who does not want to commit to a team, or
 * a teammate who would rather read the question than lean across the table.
 * Only three things differ, and all three are things that belong to the one
 * screen at the front of the room — it makes no sound, it does not explain how
 * to join, and it is laid out for a phone. Everything the watcher is allowed to
 * see is whatever the big screen is showing, which is why it is the same code.
 */

/** The big screen's state, wherever it is being rendered. */
type ScreenState = HostState | WatchState;

/**
 * True when this page is the watch screen rather than the big screen.
 *
 * Read off the path once, at module load, because it cannot change without a
 * navigation. `/watch/` with the trailing slash is the same page: the server
 * serves both and a phone keyboard will produce either.
 */
const WATCHING =
  typeof location !== 'undefined' && location.pathname.replace(/\/+$/, '') === '/watch';

/**
 * The team this screen is following, scanned off that team's own device.
 *
 * `/watch?team=<code>` is what the QR on a seated player's screen encodes. It
 * is the whole credential, so this screen never asks for the room code: the
 * errand the QR removes is walking to the big screen to read one.
 */
const WATCH_TEAM =
  typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('team') ?? ''
    : '';

/**
 * The room code this device last used to take a seat, if it has one.
 *
 * A teammate who played last week, or who is watching after joining on the
 * same phone, should not have to walk to the back of the room and read the
 * screen again. It is only ever a prefill: the server still checks it, and
 * useGame.ts drops it the moment the night is reset, so a stale one cannot
 * sit in the box looking correct.
 */
function savedRoomCode(): string {
  try {
    return localStorage.getItem('primetime.roomCode') ?? '';
  } catch {
    // Private mode, or storage switched off. Not worth a broken page.
    return '';
  }
}

/**
 * The room code, asked once, before anything is shown.
 *
 * A watcher gives no name and takes no seat, so this is the whole of getting
 * in, and it is the same question the join form asks — the gate is "can you
 * read the big screen", and the answer has to be the same at both doors.
 */
function WatchGate({ initial, onWatch }: { initial: string; onWatch: (code: string) => void }) {
  const [code, setCode] = useState(initial);
  const submit = () => {
    const clean = code.trim();
    if (clean) onWatch(clean);
  };
  return (
    <div class="host is-watch center">
      <div class="stack watch-gate">
        <div class="center stack">
          <div class="eyebrow">Just watching</div>
          <h1 class="serif watch-gate-title">Follow along</h1>
          <p class="muted">
            The question, the clock and the scoreboard, on your own screen. You will not be
            playing and nothing you do here is scored.
          </p>
        </div>
        <div class="eyebrow">Room code</div>
        <input
          value={code}
          onInput={(e) => setCode((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          autocapitalize="none"
          autocomplete="off"
          spellcheck={false}
          enterkeyhint="go"
          maxLength={28}
        />
        <button class="btn btn-primary btn-lg btn-block" disabled={!code.trim()} onClick={submit}>
          Watch
        </button>
        <p class="muted center">
          Changed your mind? <a href="/">Take a seat and play</a>.
        </p>
      </div>
    </div>
  );
}

/**
 * Which break the room is on.
 *
 * A round with another round after it gets the short break. The last round of
 * a game runs into the wager and then the long break, so its scoreboard is a
 * beat and not a break — the engine agrees, and only sets a break clock on the
 * ones that are one.
 */
function breakMinutes(state: ScreenState): number {
  return state.phase === 'game_results' ? state.config.gameBreakMinutes : state.config.roundBreakMinutes;
}

/**
 * The two things a player has to do, in the order they have to do them.
 *
 * The wifi step leads and is set in the largest type on the panel: a phone that
 * is still on the pub's own network cannot load the join page at all, and a room
 * reading the QR code first just gets a browser error and asks the MC about it.
 * The steps are numbered by a CSS counter, so dropping the wifi step on a
 * network that needs no instructions renumbers the QR step to 1 on its own.
 */
function JoinPanel({ state }: { state: HostState }) {
  return (
    <ol class="join-steps">
      {state.join.ssid && (
        <li class="join-step">
          <div class="join-step-body">
            <div class="eyebrow">Join this wifi network</div>
            <div class="join-wifi">
              <strong>{state.join.ssid}</strong>
              {state.join.ssidAlt && (
                <>
                  {' or '}
                  <strong>{state.join.ssidAlt}</strong>
                </>
              )}
            </div>
            {state.join.wifiPassword && (
              <div class="join-wifi-pass">
                password <strong>{state.join.wifiPassword}</strong>
              </div>
            )}
          </div>
        </li>
      )}
      <li class="join-step">
        <div class="join-step-body">
          <div class="eyebrow">Scan, or type this in any browser</div>
          <div class="join">
            <div class="join-qr" dangerouslySetInnerHTML={{ __html: state.join.qrSvg }} />
            <div class="stack">
              <div class="join-url">{state.join.url.replace('http://', '')}</div>
              <p class="muted" style={{ fontSize: '1.2rem' }}>
                Play solo or share a device
              </p>
            </div>
          </div>
        </div>
      </li>
      <li class="join-step">
        <div class="join-step-body">
          <div class="eyebrow">Type this room code</div>
          {/* Big because it is now typed, not just read. The join is gated on
              it, so a code nobody can make out from the back of the room is a
              room nobody can get into. */}
          <div class="join-code">{state.roomCode}</div>
        </div>
      </li>
    </ol>
  );
}

function AnswerGrid({ state }: { state: ScreenState }) {
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

function AnsweredStrip({ state }: { state: ScreenState }) {
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
function StandingsRail({ state }: { state: ScreenState }) {
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

/** The betting clock, at the size the back of the hall can read. */
function WagerCountdown({ at, held }: { at: number; held?: boolean }) {
  const now = useNow(!held);
  if (held) return <div class="center"><span class="pill">Betting paused</span></div>;
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return (
    <div class="center stack" style={{ gap: '4px' }}>
      <div class="clock clock-big">{seconds}</div>
      <p class="muted" style={{ fontSize: '1.4rem', margin: 0 }}>
        {seconds > 0 ? 'seconds left to bet' : 'betting closed'}
      </p>
    </div>
  );
}

function Podium({ state, title, children }: { state: ScreenState; title: string; children?: ComponentChildren }) {
  const rows = state.scoreboard;
  const winner = rows[0];
  return (
    <div class="host-body host-scores">
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
      {children}
      <div class="board-fit">
        <Board rows={rows} limit={10} split fit />
      </div>
    </div>
  );
}

function App() {
  // The big screen sits untouched through a ten-minute break, and so does the
  // phone of somebody watching a question they are not answering.
  useWakeLock();
  // Held here rather than inside the gate so retyping a refused code opens a
  // new socket: the server pins a watcher's admission to the one it arrived on.
  const [watchCode, setWatchCode] = useState('');
  // The big screen's own credential. Not a watcher's: the two doors on this
  // file are different on purpose — the password says "I am running tonight",
  // the room code says "I am in the room".
  const [token, setToken] = useState(() => {
    try {
      return WATCHING ? null : localStorage.getItem('primetime.controlToken');
    } catch {
      return null;
    }
  });
  const { state, send: _send, toast, dismissToast, unauthorized } = useGame<ScreenState>(
    WATCHING ? 'watch' : 'host',
    {
      enabled: WATCHING ? !!watchCode || !!WATCH_TEAM : !!token,
      roomCode: watchCode,
      teamCode: WATCH_TEAM,
    },
  );
  // A rejected token — the password changed, or this one was revoked — drops
  // the big screen back to the login rather than retrying forever.
  useEffect(() => {
    if (unauthorized) setToken(null);
  }, [unauthorized]);
  // Never on a watch screen. Twenty phones counting the room in half a second
  // apart is the same mistake as twenty phones playing the bed, and the room
  // already has a voice doing it.
  const speak = useSpeech(!WATCHING && !!state?.config.musicSpeakCountIn);

  // Built once and kept for the night. A browser refuses to make a sound until
  // someone has clicked the page, so `armed` stays false until the MC does —
  // otherwise the screen is silently doing nothing and looks broken.
  //
  // A watch screen never builds it at all. Every bed and cue in this game is
  // synthesized on the device playing it, so a room of watchers would each
  // start their own copy a few hundred milliseconds out from the next — see
  // audio.ts, which has said "host only, always" since the first bed.
  const audioRef = useRef<HostAudio | null>(null);
  const [armed, setArmed] = useState(false);
  if (audioRef.current === null && typeof window !== 'undefined' && !WATCHING) {
    audioRef.current = createHostAudio();
  }
  useEffect(() => () => audioRef.current?.dispose(), []);
  // Exposed for diagnosis from the browser console on the laptop driving the
  // TV: primetimeAudio.meter() says whether anything is actually coming out.
  if (typeof window !== 'undefined') {
    (window as unknown as { primetimeAudio?: HostAudio | null }).primetimeAudio = audioRef.current;
  }

  const music = !!state?.config.music;
  const phase = state?.phase;
  // A paused round is silent. The pause exists because something interrupted
  // the night, and a bed carrying on underneath that is the opposite of what
  // the MC just asked for.
  // One bed, one place: under a live question. Everything else in the night is
  // silent, including the lobby, both breaks, the intros and the results, which
  // used to carry a pad. Those are the windows where the MC is talking, and the
  // first real night said the pad made the MC hard to follow for players with
  // hearing aids. The question window is the opposite case: the room is reading
  // and nobody is speaking over it.
  const wantBed: Bed =
    !armed || !music || state?.held ? null
      : phase === 'question' || phase === 'wager_question' ? 'question'
        : null;

  // Which of the four question grooves this question gets. Derived from the
  // state rather than counted locally, so the bed survives a reload of the big
  // screen mid-question: a counter would restart and a random pick would
  // change the music under a room that is already answering.
  const bedVariantKey = pickBedVariant({
    game: state?.game.index ?? 1,
    round: state?.round?.index ?? 1,
    position: state?.question?.position ?? 0,
    roundsPerGame: state?.config.roundsPerGame ?? 2,
    questionsPerRound: state?.config.questionsPerRound ?? 10,
    wager: phase === 'wager_question',
  }).key;

  useEffect(() => { audioRef.current?.setBed(wantBed, bedVariantKey); }, [wantBed, bedVariantKey]);
  useEffect(() => { audioRef.current?.setVolume(state?.config.musicVolume ?? 0.35); }, [state?.config.musicVolume]);

  // The run-up fires once as the next question approaches, and only once: the
  // effect keys on the autoAdvanceAt it belongs to.
  useEffect(() => {
    if (!armed || !music || !state) return;
    // Counting the room in is only honest when a question is actually coming.
    // The last reveal of a round carries an autoAdvanceAt like every other
    // one, and it advances into the scoreboard and the break, or into the end
    // of the night; the clock beside it already reads "Round ends in".
    if (!inRunUpToQuestion(state)) return;
    // Non-null because inRunUpToQuestion only returns true with a timer set.
    const target = state.autoAdvanceAt!;
    const lead = nextUpWindowMs(state.config.nextQuestionDelaySeconds);
    const ids: number[] = [];
    const after = (ms: number, fn: () => void) => {
      ids.push(setTimeout(fn, Math.max(0, ms)) as unknown as number);
    };

    after(target - lead - Date.now(), () => audioRef.current?.countIn(target - Date.now()));

    // Said as three cues rather than one sentence. Spoken in one go the engine
    // takes two to three seconds to get through it, so "Go" landed while the
    // clock still read 2 or 3 — the room was told to go and then waited. Each
    // word is now placed against the moment the question actually appears,
    // with "Go" a beat before it so it finishes on the question.
    if (state.config.musicSpeakCountIn) {
      after(target - 3000 - Date.now(), () => speak('Get ready', true));
      after(target - 1900 - Date.now(), () => speak('Set', true));
      after(target - 700 - Date.now(), () => speak('Go!', true));
    }
    return () => ids.forEach(clearTimeout);
  }, [armed, music, state?.autoAdvanceAt, state?.held, state?.phase, state?.moreInRound]);

  // Hooks run before any early return, so the countdown can't be conditional.
  const { secondsLeft, now } = useCountdown(state?.deadline, state?.config.secondsPerQuestion ?? 1);
  // Matches the player's handset exactly: both price off the same window and
  // the same shared curve, so the two screens cannot disagree.
  const hostWindowMs = state?.deadline && state?.startedAt ? state.deadline - state.startedAt : 0;
  const onOffer =
    state?.question && state.deadline && state.startedAt && state.phase === 'question'
      ? pointsAt(now - state.startedAt, hostWindowMs, state.config)
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

  // A watch screen shows the gate until the server has accepted the code and
  // sent a snapshot. That covers both halves of the same moment: nothing typed
  // yet, and something typed that was wrong — in which case the refusal is
  // already on screen as a toast and the box is still there to correct.
  if (WATCHING && !state) {
    // A scanned code that the server has not refused yet is still connecting,
    // and the gate would flash the room-code box at somebody who never needed
    // it. Once it IS refused - last night's QR, most often - the box is the
    // way back in, so the toast and the gate arrive together.
    if (WATCH_TEAM && !toast) {
      return <div class="host is-watch center"><p class="muted">Finding your table…</p></div>;
    }
    return (
      <>
        <WatchGate initial={watchCode || savedRoomCode()} onWatch={setWatchCode} />
        <Toast message={toast} onDismiss={dismissToast} />
      </>
    );
  }

  if (!WATCHING && !token) {
    return <Login eyebrow="Big screen" onToken={setToken} />;
  }

  if (!state) {
    return <div class="host center"><p class="muted">Starting up…</p></div>;
  }

  const q = state.question;
  // The table this screen follows, if it follows one. Narrowed off `role`
  // rather than tested field by field: the big screen has no such thing.
  const followed = state.role === 'watch' ? state.team : undefined;

  // The answer and its fact get the first part of the gap; the scoreboard takes
  // the last few seconds, so each question ends on where everyone now stands.
  const standingsWindowMs = nextUpWindowMs(state.config.nextQuestionDelaySeconds);
  // Not gated on how many teams are playing. It used to require more than one,
  // which meant that on a single-entry night — and on every solo test — the big
  // screen never left the question and the run-up clock never appeared at all.
  const showStandings =
    inRunUpToQuestion(state) &&
    state.autoAdvanceAt! - tick <= standingsWindowMs;

  // No point showing the rail next to a full scoreboard.
  const showRail =
    !showStandings &&
    state.scoreboard.length > 1 &&
    (state.phase === 'question' || state.phase === 'locked' || state.phase === 'reveal');

  // The bed follows the money: full value is calm, the floor is urgent.
  const span = state.config.questionPoints - state.config.minQuestionPoints;
  audioRef.current?.setIntensity(
    span > 0 ? 1 - (onOffer - state.config.minQuestionPoints) / span : 0,
  );

  return (
    <div class={`host${WATCHING ? ' is-watch' : ''}`}>
      {!WATCHING && state.config.music && !armed && (
        // A browser will not make a sound until the page has been clicked, so
        // this is the click. It is on the big screen rather than the MC's phone
        // because the gesture has to happen on the page that plays the audio.
        <button
          class="btn btn-primary host-sound-on"
          onClick={() => { void audioRef.current?.resume().then(() => setArmed(true)); }}
        >
          Turn sound on
        </button>
      )}
      <div class="host-bar">
        <div>
          <div class="eyebrow">{state.venueName}</div>
          {/* The standings screens say where the night is in their own
              headline, so the corner repeating "Mixed bag · round 2 of 2"
              over the champions is noise at the one moment nobody is
              thinking about which round it was. */}
          {state.round && state.phase !== 'night_over' && state.phase !== 'game_results' && (
            <div class="serif" style={{ fontSize: '1.5rem' }}>
              {/* While a question is up, the category is named in the middle
                  of the screen where the room is already looking, so the
                  header carries the position alone. Printing it in both
                  places just made the corner compete with the centre. */}
              {q ? (
                <span class="muted" style={{ fontSize: '1.1rem' }}>
                  Round {state.round.index} of {state.round.ofTotal} · question {q.position} of {q.ofTotal}
                </span>
              ) : (
                <>
                  {state.round.categoryName}
                  <span class="muted" style={{ fontSize: '1rem' }}>
                    {' '}· round {state.round.index} of {state.round.ofTotal}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        <div class="row" style={{ gap: '14px' }}>
          {state.game.index > 0 && (
            <span class="pill">Game {state.game.index} of {state.game.ofTotal ?? 1}</span>
          )}
          <span class="pill">{state.entryCount} playing</span>
          <span class="pill pill-brass">{state.roomCode}</span>
          {/* The way back, for somebody watching the room and deciding they
              want in: they should not have to be told a second address.
              Never for a follower. They are already on a team, and taking a
              seat here would enter a SECOND one — splitting their table's
              points between two rows, which is the mistake the MC script
              spends a whole section warning about. */}
          {WATCHING && !followed && <a class="pill watch-join" href="/">Join in</a>}
        </div>
      </div>

      {/* What this table has in. The whole reason the QR exists: a plain
          watcher sees the room, and this is the one thing they cannot see,
          because the server does not know where they are sitting. The wording
          matches the team's own handset exactly — same letter, same price off
          the same stamped arrival — so two screens at one table cannot
          disagree about what is in and what it is worth. */}
      {followed && (
        <div class="watch-team">
          <span class="eyebrow">{followed.name}</span>
          {followed.rank !== undefined && (
            <span class="pill">
              {followed.rank === 1 ? 'Leading' : `${followed.rank}th`} · {followed.score ?? 0}
            </span>
          )}
          {followed.choiceIndex !== undefined ? (
            <span class="pill pill-brass">
              {['A', 'B', 'C', 'D'][followed.choiceIndex]} is in
              {followed.pointsIfRight !== undefined
                ? `, worth ${followed.pointsIfRight} if you're right`
                : ''}
            </span>
          ) : followed.numberAnswer !== undefined ? (
            <span class="pill pill-brass">{followed.numberAnswer} is in</span>
          ) : followed.wager !== undefined ? (
            <span class="pill pill-brass">{followed.wager} on the line</span>
          ) : state.phase === 'question' || state.phase === 'wager_question' ? (
            <span class="pill">Nothing in yet</span>
          ) : null}
        </div>
      )}

      {state.message && <div class="warn center" style={{ fontSize: '1.2rem' }}>{state.message}</div>}

      {state.phase === 'lobby' && (
        <div class="host-body">
          <div class="center stack">
            <h1 class="host-display">{state.venueName}</h1>
            {/* The big screen's invitation to the room. Telling a watcher to
                play on their own or share a device, directly above a line
                saying they are not playing, is the screen arguing with
                itself. */}
            {!WATCHING && (
              <p class="muted" style={{ fontSize: '1.5rem' }}>Play on your own or share a device.</p>
            )}
          </div>
          {/* Instructions for getting in, which is not what this screen is
              for — and `join` is not in a watch snapshot to render anyway. */}
          {'join' in state ? (
            <JoinPanel state={state} />
          ) : (
            <p class="muted center">
              {followed
                ? `Waiting for the first question. You are following ${followed.name} — they answer on their own device, not this one.`
                : 'Waiting for the first question. You are watching, not playing.'}
              {!followed && (
                <>
                  {' '}Tap <a href="/">Join in</a> to take a seat.
                </>
              )}
            </p>
          )}
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

      {state.phase === 'game_intro' && (
        <div class="host-body center stack">
          <div class="eyebrow">Here we go</div>
          <h1 class="host-display">Game {state.game.index} of {state.game.ofTotal ?? 1}</h1>
          <p class="muted" style={{ fontSize: '1.5rem' }}>
            {state.config.roundsPerGame} rounds · {state.config.questionsPerRound} questions each
            {state.config.finalWager ? ' · final wager to close' : ''}
          </p>
          <AutoAdvance at={state.autoAdvanceAt} label="Starting in" held={state.held} />
        </div>
      )}

      {state.phase === 'round_intro' && state.round && (
        <div class="host-body center stack">
          <div class="eyebrow">Game {state.game.index} of {state.game.ofTotal ?? 1}</div>
          <h1 class="host-display">Round {state.round.index} of {state.round.ofTotal}</h1>
          <p class="muted" style={{ fontSize: '1.6rem', maxWidth: '26ch', margin: '0 auto' }}>
            {state.round.mixed
              ? `${state.config.questionsPerRound} questions, a different category every time`
              : `${state.round.categoryName} — ${state.round.blurb}`}
          </p>
          <AutoAdvance at={state.autoAdvanceAt} label="First question in" held={state.held} />
        </div>
      )}

      {(state.phase === 'question' || state.phase === 'locked' || state.phase === 'reveal' ||
        state.phase === 'wager_question' || state.phase === 'wager_reveal') && q && (
        <div class={`host-stage${showRail ? ' has-rail' : ''}`}>
        {showStandings ? (
          <div class="host-body">
            <NextUp at={state.autoAdvanceAt} held={state.held} big />
            <div class="board-fit">
              <Board rows={state.scoreboard} limit={10} split fit />
            </div>
          </div>
        ) : (
        <div class="host-body">
          {/* The room watches this screen, not their phones. A progress bar
              moving constantly at the top of it was the most distracting thing
              in the hall, and said less than the falling number does. */}
          {state.deadline && (
            <div class="center">
              {/* Same pinning as the handsets. Alone on its line this cannot
                  wrap, but it re-centred itself every time a digit dropped,
                  which on a projector is a word visibly jumping sideways. */}
              <span class="pill pill-brass pill-live qhead-live" style={{ fontSize: '1.6rem' }}>
                <span>
                  <span class="tabular" style={{ minWidth: `${String(state.config.questionPoints).length}ch` }}>
                    {onOffer}
                  </span> pts
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  <span class="tabular" style={{ minWidth: `${String(state.config.secondsPerQuestion).length}ch` }}>
                    {secondsLeft}
                  </span>s
                </span>
              </span>
            </div>
          )}
          {/* Named before the prompt, every question. The room is used to a
              round announcing its subject once; a mixed round has to announce
              it ten times, and this is where the eye already is. */}
          <div class="center">
            <span class="pill" style={{ fontSize: '1.3rem' }}>{q.categoryName}</span>
          </div>
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
              {/* "Answers in" is the state — everyone has locked. "Answer in
                  4" underneath it was the countdown to the reveal, and the
                  two together read as an instruction to answer within four
                  seconds, which is the opposite of what just happened. */}
              <div class="center"><span class="pill pill-brass" style={{ fontSize: '1.3rem' }}>Answers in</span></div>
              <AutoAdvance
                at={state.autoAdvanceAt}
                label="Revealing in"
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
                label={state.moreInRound ? 'Next question in' : 'Round ends in'}
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
        <div class="host-body host-scores">
          {/* The room needs two things at a break: that the round is over, and
              how long they have. Both go above the board, in the size the back
              of the hall can read - but not at the size they would take on a
              screen with nothing else on it, because twelve rows of standings
              underneath have to be readable too. */}
          <div class="center stack">
            <h1 class="host-display">End of Round {state.round?.index ?? 1}</h1>
            {state.breakEndsAt ? (
              <BreakClock
                at={state.breakEndsAt}
                held={state.held}
                big
              />
            ) : (
              <>
                <p style={{ fontSize: '1.8rem', margin: 0 }}>
                  {state.config.finalWager ? 'Final question next' : 'Game closing'}
                </p>
                <AutoAdvance at={state.autoAdvanceAt} label="Next in" held={state.held} />
              </>
            )}
            <div class="eyebrow">
              Round {state.round?.index} of {state.round?.ofTotal} · Game {state.game.index} of{' '}
              {state.game.ofTotal ?? 1}
            </div>
          </div>
          <div class="board-fit">
            <Board rows={state.scoreboard} limit={12} split fit />
          </div>
        </div>
      )}

      {state.phase === 'wager_bet' && (
        <div class="host-body center stack">
          <div class="eyebrow">Final question of the game</div>
          <h1 class="host-display">Place your wagers</h1>
          <p class="muted" style={{ fontSize: '1.5rem' }}>
            Bet any part of your score. Right answer wins it, wrong answer loses it.
          </p>
          {/* The clock that closes the betting. The room is looking at this
              screen while it decides, so this is where the number belongs. */}
          {state.wagerEndsAt && <WagerCountdown at={state.wagerEndsAt} held={state.held} />}
          <div class="teamgrid" style={{ maxWidth: '1000px', margin: '0 auto' }}>
            {state.scoreboard.map((row) => (
              <div
                key={row.teamId}
                class={`teamchip${state.answeredTeamIds.includes(row.teamId) ? ' is-in' : ''}`}
              >
                <strong>{row.name}</strong>
                <span class="faint">
                  {state.answeredTeamIds.includes(row.teamId) ? 'bet placed' : `${row.score} on the board`}
                </span>
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
            <div class="center">
              <span class="pill pill-brass pill-live" style={{ fontSize: '1.6rem' }}>{secondsLeft}s</span>
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

      {state.phase === 'game_results' && (
        <Podium state={state} title={`Game ${state.game.index} of ${state.game.ofTotal ?? 1} — final standings`}>
          {/* The long break, with the clock on it. The room's question at the
              end of a game is how long they have, and this is the screen
              they are all looking at while they ask it. */}
          {state.game.index < (state.game.ofTotal ?? 1) && (
            <BreakClock
              at={state.breakEndsAt}
              held={state.held}
              big
            />
          )}
        </Podium>
      )}
      {state.phase === 'night_over' && <Podium state={state} title="Tonight's champions" />}

      {state.phase !== 'lobby' && (
        <div class="host-bar">
          {/* The footer that lets a latecomer in mid-round. A watcher is
              already in, and is holding the address they would be told. */}
          <p class="faint">
            {'join' in state
              ? `Join at ${state.join.url.replace('http://', '')} · room ${state.roomCode}`
              : 'Watching'}
          </p>
          <p class="faint">{state.entryCount} playing</p>
        </div>
      )}

      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
