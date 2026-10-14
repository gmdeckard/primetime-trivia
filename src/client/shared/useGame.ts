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
export function useGame<S extends GameState>(role: S['role'], options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
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
              : { t: 'hello', role: 'host' };
        socket.send(JSON.stringify(hello));
      };

      socket.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as ServerMessage;
        if (msg.t === 'state') {
          setState(msg.state as S);
        } else if (msg.t === 'identity') {
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
          // shows the PIN screen again. Reloading here instead would spin: the
          // fresh page reconnects, gets rejected, and reloads again forever.
          localStorage.removeItem('primetime.controlToken');
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
  }, [role, enabled]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(id);
  }, [toast]);

  return { state, status, send, toast, unauthorized, dismissToast: () => setToast(null) };
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
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [deadline]);

  if (!deadline) return { secondsLeft: 0, fraction: 0, running: false };
  const msLeft = Math.max(0, deadline - now);
  return {
    secondsLeft: Math.ceil(msLeft / 1000),
    fraction: Math.max(0, Math.min(1, msLeft / (totalSeconds * 1000))),
    running: msLeft > 0,
  };
}

/**
 * Read the question aloud on the host screen using whatever voices the OS has
 * installed. Deliberately host-only: twenty tablets all speaking would be
 * chaos, and the big screen is where the room's attention already is.
 */
export function useSpeech(enabled: boolean) {
  const lastRef = useRef('');
  return useCallback(
    (text: string) => {
      if (!enabled || !('speechSynthesis' in window)) return;
      if (lastRef.current === text) return;
      lastRef.current = text;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    },
    [enabled],
  );
}
