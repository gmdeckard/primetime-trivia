import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ClientMessage, GameState, ServerMessage } from '../../../shared/protocol';

export type ConnStatus = 'connecting' | 'open' | 'retrying';

/**
 * The single websocket connection, with the reconnection behaviour this
 * environment actually needs: tablets sleep, people wander out of range of
 * the clubhouse access point, and nobody is going to tell a 68-year-old to
 * reload the page. So we reconnect forever with a short backoff, re-announce
 * our identity, and let the server's next snapshot repair our state.
 */
export function useGame<S extends GameState>(
  role: S['role'],
  options: { enabled?: boolean; roomCode?: string } = {},
) {
  const enabled = options.enabled ?? true;
  const roomCode = options.roomCode;
  const [state, setState] = useState<S | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [toast, setToast] = useState<string | null>(null);
  /** Set when the server rejects our credentials; the caller decides what to do. */
  const [unauthorized, setUnauthorized] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const closedRef = useRef(false);

  const send = useCallback((msg: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    closedRef.current = false;
    const connect = () => {
      if (closedRef.current) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => {
        retryRef.current = 0;
        setStatus('open');
        const hello: ClientMessage =
          role === 'player'
            ? {
                t: 'hello',
                role: 'player',
                playerId: localStorage.getItem('primetime.playerId') ?? undefined,
                token: localStorage.getItem('primetime.token') ?? undefined,
              }
            : role === 'control'
              ? { t: 'hello', role: 'control', token: localStorage.getItem('primetime.controlToken') ?? undefined }
              : role === 'watch'
                // Re-sent on every reconnect, because the server holds the
                // admission on the socket and a reconnect is a new socket.
                ? { t: 'hello', role: 'watch', roomCode }
                // The same token as the MC's phone. The big screen is the
                // other half of the operator's equipment, not a seat.
                : { t: 'hello', role: 'host', token: localStorage.getItem('primetime.controlToken') ?? undefined };
        socket.send(JSON.stringify(hello));
      };

      socket.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as ServerMessage;
        if (msg.t === 'state') {
          setState(msg.state as S);
        } else if (msg.t === 'identity') {
          // A different id than the one we introduced ourselves with means the
          // server could not place us: the night was reset and this is a new
          // one. The room code we saved belongs to the night that just ended,
          // and leaving it in the box is worse than leaving the box empty —
          // it looks filled in and correct, so the player taps Join without
          // reading it and is told their code is wrong. The handle stays:
          // their name is still their name.
          const had = localStorage.getItem('primetime.playerId');
          if (had && had !== msg.playerId) localStorage.removeItem('primetime.roomCode');
          // Survives a reload and a tablet restart, so a team keeps its seat.
          localStorage.setItem('primetime.playerId', msg.playerId);
          localStorage.setItem('primetime.token', msg.token);
        } else if (msg.t === 'error' || msg.t === 'toast') {
          setToast(msg.message);
        }
      };

      socket.onclose = (event) => {
        socketRef.current = null;
        if (closedRef.current) return;
        if (event.code === 4001) {
          // Credentials rejected. Drop the stale token and tell the caller, which
          // shows the login again. Reloading here instead would spin: the
          // fresh page reconnects, gets rejected, and reloads again forever.
          // Only the roles that carry that token: the MC's phone and the big
          // screen. These screens share an origin, so throwing it away for
          // every role would log the MC out because somebody typed a wrong
          // room code at the watch door on the same device.
          if (role === 'control' || role === 'host') {
            localStorage.removeItem('primetime.controlToken');
          }
          closedRef.current = true;
          setUnauthorized(true);
          return;
        }
        setStatus('retrying');
        retryRef.current = Math.min(retryRef.current + 1, 6);
        setTimeout(connect, 400 * retryRef.current);
      };
    };

    connect();
    return () => {
      closedRef.current = true;
      socketRef.current?.close();
    };
    // A changed room code reconnects: the admission lives on the socket, so a
    // watcher who retypes it needs a new one.
  }, [role, enabled, roomCode]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(id);
  }, [toast]);

  return { state, status, send, toast, unauthorized, dismissToast: () => setToast(null) };
}

/**
 * Hold the screen awake for as long as this component is mounted.
 *
 * Every screen in this game is a screen somebody is looking at and nobody is
 * touching. The big screen sits untouched through a ten-minute break and then
 * through a twenty-second question; the MC's phone sits in a hand that is
 * holding a microphone. A device that sleeps there looks exactly like the app
 * crashing, and the room blames the app.
 *
 * The lock is dropped by the browser whenever the page is hidden, so it has to
 * be taken again on every return to visibility rather than only once on mount.
 *
 * Measured caveat: the API is secure-context only. Served from a LAN IP over
 * plain http, which is how every device in the room connects,
 * navigator.wakeLock is undefined and this is a no-op. It works when the page
 * is opened on the machine serving it, via localhost, which is the practical
 * way to keep the big screen awake. Everything else is a device setting.
 */
export function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | undefined;
    const request = async () => {
      try {
        const wakeLock = (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock;
        if (wakeLock) lock = await wakeLock.request('screen');
      } catch {
        /* Denied or unsupported. Nothing to do but let the device sleep. */
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
}

/**
 * Seconds remaining against an absolute server deadline.
 *
 * Counting locally rather than streaming ticks keeps the bar smooth on a
 * saturated clubhouse access point, and means twenty tablets cost nothing.
 * Clock skew is irrelevant because the server also enforces the lock.
 */
export function useCountdown(deadline?: number, totalSeconds = 1) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!deadline) return;
    let frame = 0;
    const tick = () => {
      const now = Date.now();
      setNow(now);
      // Stop at the deadline instead of spinning until the server's lock
      // broadcast clears `deadline`. That gap is a timer fire plus a coalesce
      // window plus a LAN hop, and these are old iPads.
      if (now < deadline) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [deadline]);

  if (!deadline) return { secondsLeft: 0, fraction: 0, running: false, now };
  const msLeft = Math.max(0, deadline - now);
  return {
    secondsLeft: Math.ceil(msLeft / 1000),
    fraction: Math.max(0, Math.min(1, msLeft / (totalSeconds * 1000))),
    running: msLeft > 0,
    now,
  };
}

/**
 * Read the question aloud on the host screen using whatever voices the OS has
 * installed. Deliberately host-only: twenty tablets all speaking would be
 * chaos, and the big screen is where the room's attention already is.
 */
/**
 * The least robotic voice the machine has.
 *
 * Left to itself a browser picks the first installed voice, which on Windows
 * is usually one of the old "Desktop" engines — the ones that sound like a
 * 1990s answering machine. Modern Windows and Edge ship far better neural
 * voices under names containing "Natural" or "Online", so prefer those, then
 * anything that is not a Desktop engine, and only then give up and take the
 * default. Nothing is installed by this; it only picks from what is there.
 */
function bestVoice(): SpeechSynthesisVoice | null {
  const all = window.speechSynthesis.getVoices?.() ?? [];
  const english = all.filter((v) => /^en(-|$)/i.test(v.lang));
  const pool = english.length ? english : all;
  if (!pool.length) return null;
  const score = (v: SpeechSynthesisVoice) => {
    const n = v.name.toLowerCase();
    if (n.includes('natural')) return 4;
    if (n.includes('online')) return 3;
    if (!n.includes('desktop')) return 2;
    return 1;
  };
  return pool.slice().sort((a, b) => score(b) - score(a))[0] ?? null;
}

export function useSpeech(enabled: boolean) {
  const lastRef = useRef('');
  // getVoices() is empty until the engine has loaded them, so nudge a re-read.
  useEffect(() => {
    if (!enabled || !('speechSynthesis' in window)) return;
    const warm = () => bestVoice();
    warm();
    window.speechSynthesis.addEventListener?.('voiceschanged', warm);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', warm);
  }, [enabled]);

  return useCallback(
    (text: string, repeat = false) => {
      if (!enabled || !('speechSynthesis' in window)) return;
      // The repeat guard exists so a re-render does not read the same question
      // twice. A cue said before every question is the same words every time
      // and must say them again, so it opts out.
      if (!repeat && lastRef.current === text) return;
      lastRef.current = repeat ? '' : text;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = bestVoice();
      if (voice) utterance.voice = voice;
      // A cue is short and wants a bit of lift; a question wants to be clear.
      utterance.rate = repeat ? 1.05 : 0.95;
      utterance.pitch = repeat ? 1.15 : 1;
      window.speechSynthesis.speak(utterance);
    },
    [enabled],
  );
}

/**
 * A clock that ticks only while something is counting down.
 *
 * Used for the beat between questions: the big screen and every handset switch
 * to the "next question" screen at the same instant because they both compute
 * it from the same `autoAdvanceAt` the server broadcast.
 */
export function useNow(active: boolean, everyMs = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs]);
  return now;
}

/**
 * How long the run-up to the next question lasts, at the end of the gap the
 * reveal gets. Shared so the screens cannot disagree about when to switch.
 */
export function nextUpWindowMs(gapSeconds: number): number {
  return Math.min(5000, gapSeconds * 1000 * 0.45);
}
