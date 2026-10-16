import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { MIN_PASSWORD, type ControlState, type GameConfig } from '../../../shared/protocol';
import '../shared/styles.css';
import { useCountdown, useGame, useWakeLock } from '../shared/useGame';
import {
  AutoAdvance,
  Board,
  BreakClock,
  Choice,
  ConnBanner,
  NumberField,
  RadioList,
  Section,
  Slider,
  Toast,
  Toggle,
} from '../shared/ui';

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

/**
 * Typed once per device, not once per game.
 *
 * The password is set on the server and does not rotate, and the server keeps
 * issued tokens across a restart, so in practice the MC sees this screen when
 * they pick up a new phone and never again.
 */
function Login({ onToken }: { onToken: (token: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/control/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError('That password is not right.');
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
        <h1>Host password</h1>
        <p class="muted">
          The one set on the server. It is printed in the start-up banner and is the same every night.
        </p>
        <input
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if ((e as KeyboardEvent).key === 'Enter' && password.length >= MIN_PASSWORD) submit();
          }}
          type="password"
          autocomplete="current-password"
          placeholder="Host password"
          style={{ fontSize: '1.5rem', textAlign: 'center' }}
        />
        {error && <p class="pill pill-bad">{error}</p>}
        <button class="btn btn-primary btn-lg btn-block" onClick={submit} disabled={busy || password.length < MIN_PASSWORD}>
          Unlock
        </button>
      </div>
    </div>
  );
}

/**
 * The phase, in the room's words.
 *
 * `state.phase.replace(/_/g, ' ')` printed "round scores" and "game results",
 * which are state machine names. The MC reads this pill mid-sentence.
 */
const PHASE_LABELS: Record<string, string> = {
  lobby: 'Joining',
  game_intro: 'Game intro',
  round_intro: 'Round intro',
  question: 'Live',
  locked: 'Locked',
  reveal: 'Answer up',
  round_scores: 'Round over',
  wager_bet: 'Wagers',
  wager_question: 'Final',
  wager_reveal: 'Final answer',
  tiebreak: 'Tiebreak',
  tiebreak_reveal: 'Tiebreak answer',
  game_results: 'Game over',
  night_over: 'Night over',
};

/** What the big button does, in words the MC can glance at. */
function primaryAction(state: ControlState): { label: string; hint: string } {
  const games = state.game.ofTotal ?? 1;
  switch (state.phase) {
    case 'lobby':
      return { label: 'Start game 1', hint: `${state.entryCount} ready · ${games} ${games === 1 ? 'game' : 'games'} tonight` };
    case 'game_intro':
      return { label: 'First round', hint: `Game ${state.game.index} of ${games}` };
    case 'round_intro':
      return {
        label: 'First question',
        hint: state.round?.mixed ? 'Mixed categories' : state.round?.categoryName ?? '',
      };
    case 'question': return { label: 'Answers in', hint: `${state.answeredCount} of ${state.entryCount} answered` };
    case 'locked':
      return state.autoAdvanceAt
        ? { label: 'Reveal now', hint: `${state.answeredCount} of ${state.entryCount} answered` }
        : { label: 'Reveal the answer', hint: `${state.answeredCount} of ${state.entryCount} answered` };
    case 'reveal':
      return state.autoAdvanceAt
        ? { label: 'Next now', hint: state.upNext ?? '' }
        : { label: 'Next question', hint: state.upNext ?? '' };
    case 'round_scores': {
      const round = state.round;
      const last = !round || round.index >= round.ofTotal;
      // The last round of a game runs into the wager, so there is no break to
      // announce there — the long one comes after the game closes.
      if (last) {
        return state.config.finalWager
          ? { label: 'Start the final question', hint: `Round ${round?.index ?? 1} ended · wagers next` }
          : { label: `Close game ${state.game.index}`, hint: `Round ${round?.index ?? 1} ended` };
      }
      return {
        label: `Start round ${(round?.index ?? 1) + 1}`,
        hint: `${state.config.roundBreakMinutes} min break · ${
          state.config.autoStartAfterBreak ? 'starts itself' : 'waiting on you'
        }`,
      };
    }
    case 'wager_bet':
      return {
        label: 'Show the final question',
        hint: `${state.answeredCount} of ${state.entryCount} have bet${
          state.wagerEndsAt ? '' : ' · waiting on you'
        }`,
      };
    case 'wager_question':
      return { label: 'Answers in', hint: `${state.answeredCount} of ${state.entryCount} answered` };
    case 'wager_reveal': return { label: `Game ${state.game.index} standings`, hint: '' };
    case 'tiebreak': return { label: 'Answers in', hint: 'Closest wins' };
    case 'tiebreak_reveal': return { label: 'Back to standings', hint: '' };
    case 'game_results': {
      const last = state.game.index >= games;
      return last
        ? { label: 'Finish the night', hint: `Game ${state.game.index} of ${games} — that was the last one` }
        : {
            label: `Start game ${state.game.index + 1}`,
            hint: `${state.config.gameBreakMinutes} min break · ${
              state.config.autoStartAfterBreak ? 'starts itself' : 'waiting on you'
            }`,
          };
    }
    case 'night_over': return { label: '—', hint: 'Night finished' };
  }
}

/**
 * The MC's settings page.
 *
 * Rebuilt from a column of lit-up buttons. The old version offered three
 * seconds-per-question values and the one you wanted was always a fourth; it
 * said "Volume 45%" on a button you pressed to cycle; and everything was open
 * at once, so finding one setting meant scrolling past twenty. Now: real
 * number fields with steppers, sliders where the feel matters more than the
 * number, switches that show their state without being pressed, and sections
 * that summarise themselves closed.
 *
 * Grouped the way an MC thinks about a night — the shape of it, how fast it
 * moves, what it pays, what it sounds like, where the questions come from —
 * rather than by which part of the config object the setting lives in.
 */
function Setup({ state, send }: { state: ControlState; send: ReturnType<typeof useGame>['send'] }) {
  const c = state.config;
  const set = (patch: Partial<GameConfig>) => send({ t: 'set_config', patch });
  const [venue, setVenue] = useState(state.venueName);
  const [open, setOpen] = useState<string | null>('shape');
  const only = (id: string) => setOpen(open === id ? null : id);

  // A pack only reaches a night whose age group matches it, so these are the
  // sets the selected group can actually draw from. `any` means a pack that
  // declared no group and suits whichever one is picked, and an empty age
  // group means no filter at all, so every pack is live and every pack shows.
  const packsFor = c.audience
    ? state.packs.filter((p) => p.audience === c.audience || p.audience === 'any')
    : state.packs;
  const packsOn = packsFor.some((p) => c.packs.includes(p.id));

  // Structural settings are refused once a game is running, because a round
  // half-built one shape and half another is worse than a shape you cannot
  // change until the break. The panel says so rather than silently ignoring
  // the tap, which is what it used to do.
  const inLobby = state.phase === 'lobby';

  const perNight = Math.max(1, c.gamesPerNight * c.roundsPerGame * c.questionsPerRound);
  /**
   * How long a group's questions last before the deck has to be reshuffled
   * and the room starts seeing repeats.
   *
   * The thing an MC running a weekly night actually wants to know, and it is
   * not the raw count: eighty questions reads as plenty and is one and a bit
   * nights at this shape. Below two nights it is said in nights, because that
   * is the number that should stop you.
   */
  const nightsOf = (available: number) => {
    const nights = available / perNight;
    if (nights < 1) return 'not even one full night';
    if (nights < 2) return `${nights.toFixed(1)} nights before repeats`;
    const weeks = Math.floor(nights);
    return `about ${weeks} ${weeks === 1 ? 'night' : 'nights'} before repeats`;
  };

  const questionBeat = c.secondsPerQuestion + c.revealDelaySeconds + c.nextQuestionDelaySeconds;
  const roundMinutes = (c.questionsPerRound * questionBeat + c.introSeconds) / 60;
  const gameMinutes =
    c.roundsPerGame * roundMinutes +
    (c.roundsPerGame - 1) * c.roundBreakMinutes +
    (c.finalWager ? 2.5 : 0);
  const nightMinutes = c.gamesPerNight * gameMinutes + (c.gamesPerNight - 1) * c.gameBreakMinutes;
  const clock = (mins: number) => {
    const total = Math.round(mins);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <div class="card stack setup">
      <label class="field">
        <span class="field-label">
          <span>Event name</span>
          <span class="field-hint">shown on the big screen</span>
        </span>
        <input
          value={venue}
          onInput={(e) => setVenue((e.target as HTMLInputElement).value)}
          onBlur={() => set({ venueName: venue })}
          maxLength={40}
        />
      </label>

      <Section
        title="Shape of the night"
        summary={`${c.gamesPerNight} games × ${c.roundsPerGame} rounds × ${c.questionsPerRound} questions · ${clock(nightMinutes)}`}
        open={open === 'shape'}
        onToggle={() => only('shape')}
      >
        {!inLobby && (
          <p class="faint">
            A game is running, so the shape is locked until the night is reset. Everything else below is live.
          </p>
        )}
        <div class="fieldgrid">
          <NumberField
            label="Questions per round"
            value={c.questionsPerRound}
            min={1}
            max={25}
            disabled={!inLobby}
            onChange={(questionsPerRound) => set({ questionsPerRound })}
          />
          <NumberField
            label="Rounds per game"
            value={c.roundsPerGame}
            min={1}
            max={10}
            disabled={!inLobby}
            onChange={(roundsPerGame) => set({ roundsPerGame })}
          />
          <NumberField
            label="Games tonight"
            hint="the night ends after the last one"
            value={c.gamesPerNight}
            min={1}
            max={8}
            onChange={(gamesPerNight) => set({ gamesPerNight })}
          />
        </div>
        <p class="faint">
          A round runs about {clock(roundMinutes)}, a game about {clock(gameMinutes)} with its breaks.
        </p>
        <Choice
          label="Categories in a round"
          hint={
            c.roundCategoryMode === 'mixed'
              ? 'one question each from ten shuffled categories'
              : 'the whole round on one subject'
          }
          value={c.roundCategoryMode}
          disabled={!inLobby}
          options={[
            { value: 'mixed', label: 'Mixed' },
            { value: 'single', label: 'One per round' },
          ]}
          onChange={(roundCategoryMode) => set({ roundCategoryMode })}
        />
        <Toggle
          label="Final wager"
          hint={
            c.finalWager
              ? c.wagerSeconds
                ? `a Jeopardy-style bet closes each game · ${c.wagerSeconds}s to bet`
                : 'a Jeopardy-style bet closes each game · you close the betting'
              : 'no bet; the last round ends the game'
          }
          on={c.finalWager}
          onChange={(finalWager) => set({ finalWager })}
        />
      </Section>

      <Section
        title="Timing"
        summary={`${c.secondsPerQuestion}s a question · ${c.roundBreakMinutes}/${c.gameBreakMinutes} min breaks · ${
          c.autoStartAfterBreak && (!c.finalWager || c.wagerSeconds) ? 'runs itself' : 'waits for you'
        }`}
        open={open === 'timing'}
        onToggle={() => only('timing')}
      >
        <div class="fieldgrid">
          <NumberField
            label="Answer window"
            unit="s"
            value={c.secondsPerQuestion}
            min={5}
            max={120}
            onChange={(secondsPerQuestion) => set({ secondsPerQuestion })}
          />
          <NumberField
            label="Pause before the answer"
            unit="s"
            value={c.revealDelaySeconds}
            min={0}
            max={30}
            onChange={(revealDelaySeconds) => set({ revealDelaySeconds })}
          />
          <NumberField
            label="Time on the answer"
            hint="long enough to read the fact aloud"
            unit="s"
            value={c.nextQuestionDelaySeconds}
            min={2}
            max={60}
            onChange={(nextQuestionDelaySeconds) => set({ nextQuestionDelaySeconds })}
          />
          <NumberField
            label="Intro cards"
            hint="how long a round or game title holds"
            unit="s"
            value={c.introSeconds}
            min={0}
            max={60}
            onChange={(introSeconds) => set({ introSeconds })}
          />
          <NumberField
            label="Betting window"
            hint={c.wagerSeconds ? 'closes by itself' : '0 means you close it'}
            unit="s"
            value={c.wagerSeconds}
            min={0}
            max={300}
            step={5}
            disabled={!c.finalWager}
            onChange={(wagerSeconds) => set({ wagerSeconds })}
          />
          <NumberField
            label="Break between rounds"
            unit="min"
            value={c.roundBreakMinutes}
            min={0}
            max={60}
            onChange={(roundBreakMinutes) => set({ roundBreakMinutes })}
          />
          <NumberField
            label="Break between games"
            unit="min"
            value={c.gameBreakMinutes}
            min={0}
            max={90}
            onChange={(gameBreakMinutes) => set({ gameBreakMinutes })}
          />
        </div>
        <Toggle
          label="Breaks end themselves"
          hint={
            c.autoStartAfterBreak
              ? 'the clock runs out and the next round starts'
              : 'the clock still counts down, but you start the next round'
          }
          on={c.autoStartAfterBreak}
          onChange={(autoStartAfterBreak) => set({ autoStartAfterBreak })}
        />
        <Toggle
          label="Run the round automatically"
          hint={
            c.autoAdvance
              ? 'lock, reveal and next question all on the clock'
              : 'you tap through every step'
          }
          on={c.autoAdvance}
          onChange={(autoAdvance) => set({ autoAdvance })}
        />
      </Section>

      <Section
        title="Scoring"
        summary={`${c.questionPoints} points, falling to ${c.minQuestionPoints} after ${c.readSeconds}s`}
        open={open === 'scoring'}
        onToggle={() => only('scoring')}
      >
        <div class="fieldgrid">
          <NumberField
            label="Question value"
            unit="pts"
            value={c.questionPoints}
            min={100}
            max={5000}
            step={100}
            onChange={(questionPoints) => set({ questionPoints })}
          />
          <NumberField
            label="Worth at the buzzer"
            hint="never nothing for a slow correct answer"
            unit="pts"
            value={c.minQuestionPoints}
            min={0}
            max={c.questionPoints}
            step={50}
            onChange={(minQuestionPoints) => set({ minQuestionPoints })}
          />
        </div>
        <Slider
          label="Full value for"
          value={c.readSeconds}
          min={0}
          max={Math.max(1, c.secondsPerQuestion)}
          format={(v) => `${v}s of ${c.secondsPerQuestion}s`}
          onChange={(readSeconds) => set({ readSeconds })}
        />
        <p class="faint">
          Answer inside {c.readSeconds}s and it pays {c.questionPoints}. After that it slides to{' '}
          {c.minQuestionPoints} at the buzzer, so two teams who both knew it are split by how fast they were sure.
        </p>
      </Section>

      <Section
        title="Sound and speech"
        summary={
          c.music
            ? `on at ${Math.round(c.musicVolume * 100)}%${c.musicUnderQuestion ? ' · under questions' : ''}`
            : c.readAloud ? 'music off · questions read aloud' : 'off'
        }
        open={open === 'sound'}
        onToggle={() => only('sound')}
      >
        {/* Sound only ever comes out of the big screen. The first time it is
            switched on, that screen needs one click before a browser will play
            anything — there is a button on it saying so. */}
        <Toggle
          label="Big-screen sound"
          hint="synthesized on the big screen, nothing over the wifi"
          on={c.music}
          onChange={(music) => set({ music })}
        />
        <Slider
          label="Volume"
          value={Math.round(c.musicVolume * 100)}
          min={0}
          max={100}
          step={5}
          format={(v) => `${v}%`}
          disabled={!c.music}
          onChange={(v) => set({ musicVolume: Math.round(v) / 100 })}
        />
        <Toggle
          label="Music under the question"
          hint="competes with the microphone in a room with hearing aids"
          on={c.musicUnderQuestion}
          disabled={!c.music}
          onChange={(musicUnderQuestion) => set({ musicUnderQuestion })}
        />
        <Toggle
          label="Spoken run-up"
          hint="get ready, set, go before each question"
          on={c.musicSpeakCountIn}
          disabled={!c.music}
          onChange={(musicSpeakCountIn) => set({ musicSpeakCountIn })}
        />
        <Toggle
          label="Read questions aloud"
          hint="the big screen's own voice reads the prompt and options"
          on={c.readAloud}
          onChange={(readAloud) => set({ readAloud })}
        />
      </Section>

      <Section
        title="Questions"
        summary={`${state.audiences.find((g) => g.id === c.audience)?.name ?? 'No filter'} · ${state.bank.availableInSelection} in play`}
        open={open === 'content'}
        onToggle={() => only('content')}
      >
        {/*
          Age group. Each one is a folder under content/questions, and picking
          one swaps the night's material wholesale rather than mixing it: the
          questions in content/questions/8-12 are the kids' night. Only the
          shared folder crosses over, which is where the numeric tiebreakers
          live so a tie is breakable whoever is playing.

          The list and the counts come from the server, so a group nobody has
          written for is not offered and a folder added this afternoon is.
        */}
        <div class="field">
          <span class="field-label">
            <span>Age group</span>
            <span class="field-hint">one folder each</span>
          </span>
          <RadioList
            value={c.audience}
            options={state.audiences.map((group) => ({
              value: group.id,
              label: group.name,
              // Nights, not just a count. "80 questions" sounds like plenty
              // and is one and a bit nights at this shape, which is the
              // difference between the no-repeat promise holding for a
              // season and breaking next week.
              hint: group.available
                ? `${group.available} questions in ${group.categories} ${
                    group.categories === 1 ? 'category' : 'categories'
                  } · ${nightsOf(group.available)}`
                : 'no question set switched on',
            }))}
            onChange={(audience) => {
              // Switching group can land on one whose sets are all off — pick
              // Kids after a night of running adult1 alone and there is
              // nothing to ask. Switch that group's sets on when none of them
              // are, which repairs the dead selection without overriding a
              // deliberate one: if the MC has already chosen among a group's
              // sets, that choice is left exactly as it is.
              const mine = state.packs.filter((p) => p.audience === audience || p.audience === 'any');
              const anyOn = mine.some((p) => c.packs.includes(p.id));
              set({
                audience,
                ...(anyOn || !mine.length
                  ? {}
                  : { packs: [...c.packs, ...mine.map((p) => p.id)] }),
              });
            }}
          />
        </div>

        {/*
          The packs for the chosen age group, and only those.

          This used to list every pack on disk under the heading "Extra packs"
          and the hint "the core bank is always in play". Both were wrong. The
          adult room has no core bank — all 1824 of its questions are in
          adult1 and adult2 — so switching the packs off leaves the fifteen
          shared tiebreakers and a night that cannot fill a round. And the one
          set that really was always in play, because it was the only material
          carrying no pack at all, was the kids' bank: the MC could see no
          switch for it and the screen implied there was nothing to switch.
          Every question now belongs to a pack, so the switches below are the
          whole of what is in play.

          Packs for other age groups are not shown because they can do nothing
          — a question is excluded unless its group is the one selected — and a
          switch that cannot change anything is worse than no switch.
        */}
        {packsFor.length > 0 && (
          <div class="field">
            <span class="field-label">
              <span>Question sets</span>
              <span class="field-hint">one switch each</span>
            </span>
            {packsFor.map((pack) => (
              <Toggle
                key={pack.id}
                label={pack.name}
                hint={`${pack.questionCount} questions`}
                on={c.packs.includes(pack.id)}
                onChange={(on) =>
                  set({ packs: on ? [...c.packs, pack.id] : c.packs.filter((p) => p !== pack.id) })
                }
              />
            ))}
            {!packsOn && (
              <p class="warn" style={{ marginTop: '8px' }}>
                Nothing is switched on for{' '}
                {state.audiences.find((g) => g.id === c.audience)?.name ?? 'this group'}. A night
                needs at least one set.
              </p>
            )}
          </div>
        )}

        <p class="faint">
          {state.bank.total} questions loaded · {state.bank.availableInSelection} unused for{' '}
          {state.audiences.find((g) => g.id === c.audience)?.name ?? 'this group'}. The numeric
          tiebreakers sit outside the sets and play on every night. No question comes back until
          this group has been through that category's whole set, and each group keeps its own place
          in the deck.
        </p>
      </Section>
    </div>
  );
}

function Teams({ state, send }: { state: ControlState; send: ReturnType<typeof useGame>['send'] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const full = state.config.questionPoints;

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
                {/* Scaled off the question value, not fixed. These were
                    -10/+5/+10 from the old scoring, and against a board where
                    one question is worth a thousand they adjusted nothing at
                    all: the MC awarding a disputed answer needs the value of
                    the answer. */}
                <div class="grid3">
                  {[-full, Math.round(full / 2), full].map((delta) => (
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
  // The MC is holding a microphone, not tapping this.
  useWakeLock();
  const [token, setToken] = useState(() => localStorage.getItem('primetime.controlToken'));
  // No token means no socket. Connecting anyway gets us closed with 4001 on
  // every attempt, which is a reconnect loop with nothing to show for it.
  const { state, status, send, toast, unauthorized, dismissToast } = useGame<ControlState>('control', { enabled: !!token });
  const { secondsLeft } = useCountdown(state?.deadline, state?.config.secondsPerQuestion ?? 1);
  const [showSetup, setShowSetup] = useState(false);
  // Mid-question the MC needs the answer, the clock and the big button. The
  // roster, the announce buttons and the end-of-night controls were adding
  // ~600px below all that on a 667px phone, so the one screen that has to be
  // glanceable was the one that scrolled. They live behind this instead.
  const [showMore, setShowMore] = useState(false);

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

  // A rejected token (the password changed, or it was revoked) drops us back to the login.
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
  const onBreak = state.phase === 'round_scores' || state.phase === 'game_results';
  const live = state.phase === 'question' || state.phase === 'wager_question' || state.phase === 'tiebreak';
  const pausable = state.phase !== 'lobby' && state.phase !== 'night_over';

  return (
    <div class="control">
      <ConnBanner status={status} />

      <div class="row-between">
        <div>
          <div class="eyebrow">MC controls</div>
          <strong>{state.venueName}</strong>
        </div>
        <div class="row" style={{ gap: '8px' }}>
          <button class={`btn btn-sm${showSetup ? ' btn-primary' : ''}`} onClick={() => setShowSetup(!showSetup)}>
            {showSetup ? 'Hide setup' : 'Setup'}
          </button>
          <button class={`btn btn-sm${showMore ? ' btn-primary' : ''}`} onClick={() => setShowMore(!showMore)}>
            {showMore ? 'Less' : 'More'}
          </button>
        </div>
      </div>

      {state.warnings.map((w) => (
        <div key={w} class="warn">{w}</div>
      ))}

      {/* The banner is on the big screen and in every player's hand, so the way
          to take it down belongs here, not behind the More toggle with the
          things you touch twice a night. */}
      {state.message && (
        <div class="warn row-between">
          <span>{state.message}</span>
          <button class="btn btn-sm" onClick={() => send({ t: 'say', message: '' })}>Clear</button>
        </div>
      )}

      {state.phase === 'lobby' && (
        <div class="card stack">
          <div class="row-between">
            <div class="eyebrow">Joining</div>
            <span class="pill pill-brass">{state.entryCount} in</span>
          </div>
          {state.entryCount === 0 ? (
            <p class="muted">
              Nobody yet. Players join at <strong>{state.venueName}</strong>'s address on the big screen.
            </p>
          ) : (
            <div class="chips">
              {state.teams.slice(-18).map((t) => (
                <span key={t.id} class="chip">{t.name}</span>
              ))}
              {state.teams.length > 18 && <span class="chip">+{state.teams.length - 18} more</span>}
            </div>
          )}
        </div>
      )}

      {(showSetup || (state.phase === 'lobby' && showSetup)) && <Setup state={state} send={send} />}

      {/* Phase, answer key and lookahead: everything the MC speaks from. */}
      <div class="card stack">
        <div class="row-between">
          <span class="pill pill-brass">{PHASE_LABELS[state.phase] ?? state.phase.replace(/_/g, ' ')}</span>
          {live && (
            <span class="pill qhead-live">
              {/* The deadline is withheld while paused, so secondsLeft reads 0.
                  Saying "0s" on a stopped clock is worse than saying nothing.
                  Digits reserve their width here too: this row carries the
                  phase and the position beside it, and a pill that changes
                  size every second shoves both of them about. */}
              {state.held ? (
                'Paused'
              ) : (
                <span>
                  <span class="tabular" style={{ minWidth: `${String(state.config.secondsPerQuestion).length}ch` }}>
                    {secondsLeft}
                  </span>s
                </span>
              )}
              <span aria-hidden="true">·</span>
              <span>
                <span class="tabular">{state.answeredCount}/{state.entryCount}</span> in
              </span>
            </span>
          )}
          {/* G1/3 R2/2 rather than the words. This row carries the phase and
              the clock as well, and on a 375px phone the spelled-out version
              wrapped to a second line and pushed the answer key off screen. */}
          <span class="faint nowrap">
            G{state.game.index || 1}/{state.game.ofTotal ?? 1}
            {state.round ? ` R${state.round.index}/${state.round.ofTotal}` : ''}
          </span>
        </div>

        {state.question && (
          <>
            {/* The category, because in a mixed round it changes every
                question and it is the thing the MC says before reading it. */}
            <div class="eyebrow">
              {state.question.categoryName} · Q{state.question.position}/{state.question.ofTotal}
            </div>
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

      {state.phase === 'question' && showMore && (
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

      {(state.phase === 'game_results' || state.phase === 'round_scores' || state.phase === 'night_over') && (
        <>
          <Board rows={state.scoreboard} />
          {state.scoreboard.filter((r) => r.rank === 1).length > 1 && (
            <button class="btn btn-block" onClick={() => send({ t: 'start_tiebreak' })}>
              Break the tie at the top
            </button>
          )}
        </>
      )}

      {(showMore ||
        state.phase === 'lobby' ||
        state.phase === 'round_scores' ||
        state.phase === 'game_results' ||
        state.phase === 'night_over') &&
        (state.phase !== 'lobby' || state.entryCount > 0) && <Teams state={state} send={send} />}

      {showMore && (
      <div class="card stack">
        <div class="eyebrow">Announce on the big screen</div>
        <div class="grid2">
          <button
            class="btn btn-sm"
            onClick={() =>
              send({ t: 'say', message: `Short break — back in ${state.config.roundBreakMinutes} minutes.` })
            }
          >
            Break
          </button>
          <button class="btn btn-sm" onClick={() => send({ t: 'say', message: '' })}>Clear</button>
        </div>
      </div>
      )}

      {showMore && (
      <div class="card stack">
        <div class="eyebrow">End of night</div>
        <button class="btn btn-sm btn-block" onClick={() => { if (confirm('End the night and show final standings?')) send({ t: 'end_night' }); }}>
          End the night
        </button>
        <button
          class="btn btn-sm btn-danger btn-block"
          onClick={() => { if (confirm('Clear all teams and scores, and restore the current default settings? This cannot be undone.')) send({ t: 'reset_night' }); }}
        >
          Reset everything
        </button>
        <p class="faint">
          {state.bank.usedTonight} questions asked tonight · {state.bank.availableInSelection} unused remaining
        </p>
      </div>
      )}

      <div class="control-sticky">
        {onBreak && (
          <div style={{ marginBottom: '10px' }}>
            <BreakClock
              at={state.breakEndsAt}
              held={state.held}
            />
          </div>
        )}
        {/* The break clock above already counts this down, in minutes, which
            is the unit the room is thinking in. A second countdown saying
            "Next in 298" underneath it is the same fact told worse. */}
        {state.autoAdvanceAt && !state.held && !onBreak && (
          <div class="row" style={{ gap: '10px', marginBottom: '10px' }}>
            <div class="grow">
              <AutoAdvance
                at={state.autoAdvanceAt}
                label={
                  state.phase === 'locked'
                    ? 'Revealing in'
                    : state.phase === 'game_intro' || state.phase === 'round_intro'
                      ? 'Starting in'
                      : 'Next in'
                }
                held={state.held}
              />
            </div>
          </div>
        )}
        {/* Pause sits beside the big button rather than above it: both have to
            be under a thumb, and a row of its own was 48px of a 667px phone.
            Reachable at any point in a game, not only in the gap between
            questions — the whole reason to want it is something interrupting a
            live question, which is exactly when it used to be missing. */}
        <div class={pausable ? 'control-actions' : ''}>
          {pausable && (
            <button
              class={`btn btn-lg${state.held ? ' btn-primary' : ''}`}
              onClick={() => send({ t: 'hold', held: !state.held })}
            >
              {state.held ? 'Resume' : 'Pause'}
            </button>
          )}
          <button
            class="btn btn-primary btn-lg btn-block control-primary"
            onClick={() => send({ t: 'advance' })}
            disabled={state.phase === 'night_over' || state.held}
          >
            {state.held ? 'Round paused' : action.label}
          </button>
        </div>
        {action.hint && <p class="faint center" style={{ margin: '8px 0 0' }}>{action.hint}</p>}
      </div>

      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
