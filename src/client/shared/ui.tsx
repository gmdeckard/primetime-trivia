import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ConnStatus } from './useGame';

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

export function Timer({ fraction, seconds }: { fraction: number; seconds: number }) {
  const low = seconds <= 10;
  return (
    <div class="timer-row">
      <div class={`timer grow${low ? ' is-low' : ''}`} role="presentation">
        <i style={{ width: `${fraction * 100}%` }} />
      </div>
      <div class="timer-count" aria-live="off">{seconds}</div>
      <span class="sr-only" role="timer">{seconds} seconds remaining</span>
    </div>
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
  total,
  label,
  held,
}: {
  at?: number;
  total: number;
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
  const fraction = Math.max(0, Math.min(1, msLeft / (total * 1000)));

  return (
    <div class="autonext">
      <span class="autonext-label">{label}</span>
      <span class="autonext-bar"><i style={{ width: `${fraction * 100}%` }} /></span>
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
