import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useNow, type ConnStatus } from './useGame';

export const LETTERS = ['A', 'B', 'C', 'D'] as const;
export const SHAPES = ['circle', 'square', 'diamond', 'shield'] as const;

export function Badge({ slot, small }: { slot: number; small?: boolean }) {
  return (
    <span
      class={`badge${small ? ' badge-sm' : ''}`}
      data-shape={SHAPES[slot] ?? 'circle'}
      style={{ background: `var(--${(['a', 'b', 'c', 'd'] as const)[slot] ?? 'a'})` }}
      aria-hidden="true"
    >
      <span>{LETTERS[slot]}</span>
    </span>
  );
}

/**
 * The "moving on in N" strip shown while auto-advance is counting down.
 *
 * Deliberately calm: a shrinking bar and a number, no flashing. It exists so
 * the room knows the game is still running and the MC knows exactly how long
 * they have to say something before it moves.
 */
export function AutoAdvance({
  at,
  label,
  held,
}: {
  at?: number;
  label: string;
  held?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at || held) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [at, held]);

  if (held) {
    return (
      <div class="row" style={{ justifyContent: 'center' }}>
        <span class="pill">Paused</span>
      </div>
    );
  }
  if (!at) return null;

  const msLeft = Math.max(0, at - now);
  const seconds = Math.ceil(msLeft / 1000);

  return (
    <div class="autonext">
      <span class="autonext-label">{label}</span>
      <span class="autonext-count tabular">{seconds}</span>
    </div>
  );
}

export function Board({
  rows,
  showDelta = true,
  limit,
}: {
  rows: Array<{ teamId: string; name: string; score: number; delta: number; rank: number }>;
  showDelta?: boolean;
  limit?: number;
}) {
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <div class="board">
      {shown.map((row) => (
        <div key={row.teamId} class={`board-row${row.rank === 1 && row.score > 0 ? ' is-lead' : ''}`}>
          <div class="board-rank">{row.rank}</div>
          <div class="board-name">{row.name}</div>
          <div class="board-score tabular">{row.score}</div>
          {showDelta ? (
            <div class={`board-delta ${row.delta > 0 ? 'up' : 'flat'}`}>
              {row.delta > 0 ? `+${row.delta}` : row.delta < 0 ? row.delta : '—'}
            </div>
          ) : (
            <div />
          )}
        </div>
      ))}
      {!shown.length && <p class="muted center">No teams yet.</p>}
    </div>
  );
}

export function ConnBanner({ status }: { status: ConnStatus }) {
  if (status === 'open') return null;
  return (
    <div class="status" role="status">
      {status === 'connecting' ? 'Connecting…' : 'Reconnecting — stay on this page'}
    </div>
  );
}

export function Toast({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div class="toast" role="alert" onClick={onDismiss}>
      {message}
    </div>
  );
}

export function Card({ children, class: cls }: { children: ComponentChildren; class?: string }) {
  return <div class={`card ${cls ?? ''}`}>{children}</div>;
}

/** Numeric entry without summoning the OS keyboard, which covers half an iPad. */
export function Keypad({
  value,
  onChange,
  onSubmit,
  submitLabel,
  max,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  max?: number;
}) {
  const press = (digit: string) => {
    const next = `${value}${digit}`.replace(/^0+(?=\d)/, '').slice(0, 9);
    if (max !== undefined && Number(next) > max) {
      onChange(String(max));
      return;
    }
    onChange(next);
  };
  return (
    <div class="stack">
      <div class="keypad-display">{value || '0'}</div>
      <div class="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} class="btn" onClick={() => press(d)}>{d}</button>
        ))}
        <button class="btn" onClick={() => onChange(value.slice(0, -1))} aria-label="Delete last digit">←</button>
        <button class="btn" onClick={() => press('0')}>0</button>
        <button class="btn btn-primary" onClick={onSubmit} disabled={!value}>{submitLabel}</button>
      </div>
    </div>
  );
}

/**
 * The run-up to the next question.
 *
 * Replaced a countdown sitting on top of live content. On the handsets it is
 * the whole screen, so nobody is reading an answer while a number moves under
 * it; on the big screen it sits above the standings, which the room is looking
 * at anyway during the gap.
 */
export function NextUp({ at, held, big, full }: { at?: number; held?: boolean; big?: boolean; full?: boolean }) {
  const now = useNow(!!at && !held);
  if (held) return <div class="center"><span class="pill">Paused</span></div>;
  if (!at) return null;
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return (
    <div class={`center stack nextup${full ? ' nextup-full' : ''}`}>
      <div class="eyebrow">Next question</div>
      <div class={`clock${big ? ' clock-big' : ''}`}>{seconds}</div>
    </div>
  );
}

/**
 * A break, counting down.
 *
 * The minutes were on the screens before this; what they were not doing was
 * passing. A room told "five minute break" with no clock has no way to tell
 * four minutes in from fifteen, and neither does the MC, which is how a night
 * quietly loses half an hour between rounds.
 *
 * It renders mm:ss rather than a bare number of seconds because this is the
 * one clock in the game that runs for minutes, and "247" is not a length of
 * time anybody reads at a glance.
 */
export function BreakClock({
  at,
  held,
  minutes,
  auto,
  big,
}: {
  at?: number;
  held?: boolean;
  minutes: number;
  /** Whether reaching zero starts the next round by itself. */
  auto?: boolean;
  big?: boolean;
}) {
  const now = useNow(!!at && !held);
  // A whole number of minutes is a length the room understands. Anything else
  // is just "break" — "0.15 minute break" is not a sentence, and the clock
  // underneath is already telling them the real answer.
  const length = Number.isInteger(minutes) && minutes >= 1 ? `${minutes} minute break` : 'Break';
  if (!at) {
    return <p class={big ? 'breakclock-note' : 'faint'}>{length} · waiting for the MC</p>;
  }
  if (held) {
    return <div class="center"><span class="pill">Paused</span></div>;
  }
  const msLeft = Math.max(0, at - now);
  const totalSeconds = Math.ceil(msLeft / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = String(totalSeconds % 60).padStart(2, '0');
  const over = msLeft <= 0;

  return (
    <div class={`breakclock${big ? ' breakclock-big' : ''}`}>
      <div class="breakclock-time tabular">{over ? '0:00' : `${mm}:${ss}`}</div>
      <div class="breakclock-note">
        {over
          ? auto ? 'Starting now' : 'Break over — the MC starts the next round'
          : auto ? `${length} · starts by itself` : `${length} · the MC starts it`}
      </div>
    </div>
  );
}

/**
 * An on/off switch.
 *
 * The control panel used to say this with a button that lit up when it was on,
 * which reads as "press me to do the thing" rather than "this is how the thing
 * is set". A switch says which state it is in without being pressed, which is
 * what an MC glancing at a settings page needs.
 */
export function Toggle({
  label,
  hint,
  on,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      class={`toggle${on ? ' is-on' : ''}`}
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span class="toggle-text">
        <span class="toggle-label">{label}</span>
        {hint && <span class="toggle-hint">{hint}</span>}
      </span>
      <span class="toggle-track" aria-hidden="true"><i /></span>
    </button>
  );
}

/**
 * A number with a unit, typed or stepped.
 *
 * Three buttons offering 25, 35 and 50 seconds is not a setting, it is three
 * settings — and the number the MC wants is always the fourth one. This takes
 * any value in range, and keeps the steppers for the common case of nudging it
 * by one while holding a microphone.
 *
 * Commits on blur and on Enter rather than on every keystroke: typing "15"
 * into a field that applies each character would set the clock to 1 second on
 * the way, and that reaches the room.
 */
export function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  unit,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // Follow the server when it is not being edited, so another device's change
  // shows up here instead of being overwritten by a stale draft.
  useEffect(() => { setDraft(String(value)); }, [value]);

  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const commit = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const next = clamp(Math.round(n / step) * step);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  const nudge = (by: number) => {
    const next = clamp(value + by);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div class={`field${disabled ? ' is-disabled' : ''}`}>
      <label class="field-label">
        <span>{label}</span>
        {hint && <span class="field-hint">{hint}</span>}
      </label>
      <div class="field-row">
        <button class="step" disabled={disabled || value <= min} onClick={() => nudge(-step)} aria-label={`${label} down`}>
          −
        </button>
        <input
          class="field-input tabular"
          type="number"
          inputMode="numeric"
          value={draft}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={(e) => commit((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if ((e as KeyboardEvent).key === 'Enter') commit((e.target as HTMLInputElement).value);
          }}
        />
        {unit && <span class="field-unit">{unit}</span>}
        <button class="step" disabled={disabled || value >= max} onClick={() => nudge(step)} aria-label={`${label} up`}>
          +
        </button>
      </div>
    </div>
  );
}

/** A slider, for the settings where the exact number matters less than the feel. */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div class={`field${disabled ? ' is-disabled' : ''}`}>
      <label class="field-label">
        <span>{label}</span>
        <span class="field-hint tabular">{format ? format(value) : value}</span>
      </label>
      <input
        class="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

/**
 * A collapsible group of settings.
 *
 * The whole panel open at once was a page of buttons the MC scrolled past
 * looking for the one they wanted. Each section says what it is set to on its
 * own header, so the common case is reading the summary and not opening it.
 */
export function Section({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class={`section${open ? ' is-open' : ''}`}>
      <button class="section-head" aria-expanded={open} onClick={onToggle}>
        <span class="section-title">{title}</span>
        <span class="section-summary">{summary}</span>
        <span class="section-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div class="section-body">{children}</div>}
    </div>
  );
}

/** Two or three mutually exclusive choices, where a switch would not name both. */
export function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
  onChange: (next: T) => void;
}) {
  return (
    <div class={`field${disabled ? ' is-disabled' : ''}`}>
      <label class="field-label">
        <span>{label}</span>
        {hint && <span class="field-hint">{hint}</span>}
      </label>
      <div class="segmented" role="group" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            class={`segment${opt.value === value ? ' is-on' : ''}`}
            aria-pressed={opt.value === value}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
