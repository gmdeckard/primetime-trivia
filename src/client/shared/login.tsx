import { useState } from 'preact/hooks';
import { MIN_PASSWORD } from '../../../shared/protocol';

/**
 * The host password, typed once per device.
 *
 * Shared by the MC's phone and the big screen, because they are the same
 * credential and always were: both are operator equipment, and the server
 * keeps issued tokens across a restart, so in practice this screen appears
 * when somebody picks up a new device and never again.
 *
 * The big screen only started asking when the game moved to a public
 * hostname. On the room's own wifi, reaching the server meant standing in the
 * room; on a domain it means nothing at all, and an ungated /host was the live
 * questions, the team names, the room code and the wifi password served to
 * anybody who knew the address.
 */
export function Login({ eyebrow, onToken }: { eyebrow: string; onToken: (token: string) => void }) {
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
      // One key for one credential. The big screen reads the same one, so an
      // MC who set this laptop up through /control is already past this.
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
        <div class="eyebrow">{eyebrow}</div>
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
