/**
 * The big screen's sound, synthesized rather than streamed.
 *
 * Nothing here loads a file. Everything is oscillators and envelopes through
 * the Web Audio graph, for three reasons that all matter on this box:
 *
 *  - No megabytes in git and nothing to pull over clubhouse wifi.
 *  - A loop built from a clock has no seam, so a bed can run for a ten minute
 *    break without the join becoming the thing everyone hears.
 *  - It can follow the game. The question bed tightens as the value falls,
 *    which a recording cannot do.
 *
 * Host only, always. Twenty handsets playing the same loop over wifi would be
 * hundreds of milliseconds apart, which is not music. The same call was already
 * made for read-aloud in useGame.ts.
 */

export type Bed = 'lobby' | 'question' | null;

export interface HostAudio {
  /** Must be called from a real click: browsers refuse audio before one. */
  resume(): Promise<void>;
  setBed(bed: Bed): void;
  /** 0..1 intensity for the question bed, driven by the falling value. */
  setIntensity(v: number): void;
  setVolume(v: number): void;
  /** Three rising ticks and a chord, for the run-up to the next question. */
  countIn(): void;
  running(): boolean;
  dispose(): void;
}

type Ctx = AudioContext;

const A_MINOR = [220, 261.63, 329.63, 392]; // A3 C4 E4 G4 — warm, unresolved
const BASS_STEPS = [55, 55, 82.41, 55, 65.41, 55, 82.41, 98]; // A1 walking figure

/** One short percussive hit. Used for the kick, the hats and the ticks. */
function hit(
  ctx: Ctx,
  out: GainNode,
  at: number,
  kind: 'kick' | 'hat' | 'tick',
  gain: number,
  freq = 880,
) {
  if (kind === 'hat') {
    // Filtered noise. A sine would read as a beep, not a hat.
    const len = Math.floor(ctx.sampleRate * 0.04);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(hp).connect(g).connect(out);
    src.start(at);
    src.stop(at + 0.05);
    return;
  }

  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = kind === 'kick' ? 'sine' : 'triangle';
  const start = kind === 'kick' ? 120 : freq;
  const end = kind === 'kick' ? 45 : freq;
  const dur = kind === 'kick' ? 0.22 : 0.12;
  osc.frequency.setValueAtTime(start, at);
  if (kind === 'kick') osc.frequency.exponentialRampToValueAtTime(end, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(out);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

export function createHostAudio(): HostAudio {
  const Ctor: typeof AudioContext | undefined =
    typeof window !== 'undefined'
      ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!Ctor) {
    // No Web Audio (very old browser). Everything becomes a no-op rather than
    // throwing on a screen the room is looking at.
    return {
      resume: async () => {},
      setBed: () => {},
      setIntensity: () => {},
      setVolume: () => {},
      countIn: () => {},
      running: () => false,
      dispose: () => {},
    };
  }

  const ctx = new Ctor();
  const master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);

  // Each bed has its own gain so beds can cross-fade instead of cutting.
  const lobbyGain = ctx.createGain();
  lobbyGain.gain.value = 0;
  lobbyGain.connect(master);
  const questionGain = ctx.createGain();
  questionGain.gain.value = 0;
  questionGain.connect(master);
  const cueGain = ctx.createGain();
  cueGain.gain.value = 1;
  cueGain.connect(master);

  let bed: Bed = null;
  let intensity = 0;
  let timer: number | undefined;
  let nextBeat = 0;
  let beat = 0;
  let disposed = false;

  // Pads for the lobby and the breaks: four detuned sines per chord tone,
  // drifting slowly. Deliberately shapeless — it is there so a silent hall
  // does not feel like the game has crashed, not to be listened to.
  const pads: OscillatorNode[] = [];
  function startPads() {
    if (pads.length) return;
    for (const f of A_MINOR) {
      for (const detune of [-4, 4]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        osc.detune.value = detune;
        g.gain.value = 0.06;
        // Slow, prime-ish rates so the voices never pulse together.
        lfo.frequency.value = 0.03 + Math.random() * 0.05;
        lfoGain.gain.value = 0.035;
        lfo.connect(lfoGain).connect(g.gain);
        osc.connect(g).connect(lobbyGain);
        osc.start();
        lfo.start();
        pads.push(osc, lfo);
      }
    }
  }

  const BPM = 124;
  const beatDur = 60 / BPM;

  /** Schedules a little ahead of the clock so timing does not depend on the tab. */
  function pump() {
    if (disposed) return;
    const ahead = ctx.currentTime + 0.25;
    while (nextBeat < ahead) {
      const at = Math.max(nextBeat, ctx.currentTime + 0.01);
      if (bed === 'question') {
        const step = beat % 8;
        hit(ctx, questionGain, at, 'kick', 0.5);
        hit(ctx, questionGain, at + beatDur / 2, 'hat', 0.12 + intensity * 0.12);
        if (intensity > 0.45) hit(ctx, questionGain, at + beatDur / 4, 'hat', 0.05);

        const bass = ctx.createOscillator();
        const bg = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        bass.type = 'sawtooth';
        bass.frequency.value = BASS_STEPS[step] ?? 55;
        filter.type = 'lowpass';
        // Opens up as the clock runs down: the room hears the pressure.
        filter.frequency.value = 220 + intensity * 900;
        filter.Q.value = 6;
        bg.gain.setValueAtTime(0.0001, at);
        bg.gain.exponentialRampToValueAtTime(0.16, at + 0.01);
        bg.gain.exponentialRampToValueAtTime(0.0001, at + beatDur * 0.7);
        bass.connect(filter).connect(bg).connect(questionGain);
        bass.start(at);
        bass.stop(at + beatDur);
      }
      nextBeat += beatDur;
      beat++;
    }
    timer = setTimeout(pump, 60) as unknown as number;
  }

  function fade(node: GainNode, to: number, seconds: number) {
    const now = ctx.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(node.gain.value, now);
    node.gain.linearRampToValueAtTime(to, now + seconds);
  }

  return {
    async resume() {
      if (ctx.state === 'suspended') await ctx.resume();
      startPads();
      if (timer === undefined) {
        nextBeat = ctx.currentTime + 0.1;
        pump();
      }
    },
    setBed(next) {
      if (next === bed) return;
      bed = next;
      // Long fades: a bed appearing or vanishing abruptly is more noticeable
      // than the bed itself.
      fade(lobbyGain, next === 'lobby' ? 1 : 0, 1.6);
      fade(questionGain, next === 'question' ? 1 : 0, next === 'question' ? 0.4 : 1.0);
      if (next === 'question') beat = 0;
    },
    setIntensity(v) {
      intensity = Math.max(0, Math.min(1, v));
    },
    setVolume(v) {
      fade(master, Math.max(0, Math.min(1, v)), 0.2);
    },
    countIn() {
      // Three rising ticks and a chord on the fourth: get ready, set, go.
      const t = ctx.currentTime + 0.02;
      hit(ctx, cueGain, t, 'tick', 0.22, 523.25);
      hit(ctx, cueGain, t + 0.6, 'tick', 0.22, 659.25);
      hit(ctx, cueGain, t + 1.2, 'tick', 0.22, 783.99);
      for (const f of [1046.5, 1318.5, 1568]) {
        hit(ctx, cueGain, t + 1.8, 'tick', 0.16, f);
      }
    },
    running() {
      return ctx.state === 'running';
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const n of pads) {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
      }
      pads.length = 0;
      void ctx.close();
    },
  };
}
