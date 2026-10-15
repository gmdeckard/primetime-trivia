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
  /** Current output level, 0..1. For checking the thing is actually audible. */
  meter(): number;
  running(): boolean;
  dispose(): void;
}

type Ctx = AudioContext;

// An octave up from where this started. A TV soundbar and a laptop speaker
// both roll off hard below about 200Hz, so a pad voiced at A3 measured fine and
// was inaudible in the room. This sits where small speakers actually work.
// Four chords rather than one. A single sustained chord is a drone, and a
// drone is what "boring" means: nothing ever arrives. These move slowly enough
// to sit under conversation and often enough that the room notices change.
const PROGRESSION = [
  [440, 523.25, 659.25, 783.99], // Am7
  [349.23, 440, 523.25, 698.46], // F
  [392, 493.88, 587.33, 783.99], // G
  [329.63, 440, 523.25, 659.25], // Am/C
];
/** Two bars of bass, so the figure answers itself instead of repeating. */
const BASS_STEPS = [
  55, 55, 82.41, 55, 65.41, 55, 82.41, 98,
  55, 55, 82.41, 110, 65.41, 98, 82.41, 73.42,
];

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
  const start = kind === 'kick' ? 160 : freq;
  const end = kind === 'kick' ? 55 : freq;
  const dur = kind === 'kick' ? 0.22 : 0.12;
  osc.frequency.setValueAtTime(start, at);
  if (kind === 'kick') {
    osc.frequency.exponentialRampToValueAtTime(end, at + dur);
    // A click on top of the thump. The body of a kick lives below what these
    // speakers can produce; the click is what makes it register as a beat.
    hit(ctx, out, at, 'tick', gain * 0.5, 1800);
  }
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
      meter: () => 0,
      running: () => false,
      dispose: () => {},
    };
  }

  const ctx = new Ctor();
  const master = ctx.createGain();
  master.gain.value = 0.35;
  // Tapped so the level can be read back. A bed that is playing but inaudible
  // and a bed that is not playing at all look identical from the outside.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  master.connect(analyser);
  master.connect(ctx.destination);
  const meterBuf = new Float32Array(analyser.fftSize);

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

  // Pads for the lobby and the breaks. Two detuned voices per chord tone, and
  // the chord changes every few seconds — slow enough to talk over, often
  // enough that it is music rather than a held note.
  const padVoices: Array<{ osc: OscillatorNode; degree: number }> = [];
  const padAux: OscillatorNode[] = [];
  let chord = 0;
  let chordTimer: number | undefined;

  function moveChord() {
    chord = (chord + 1) % PROGRESSION.length;
    const notes = PROGRESSION[chord]!;
    for (const v of padVoices) {
      // Glide rather than jump: a pad that steps between chords clicks.
      v.osc.frequency.setTargetAtTime(notes[v.degree] ?? 440, ctx.currentTime, 0.9);
    }
    chordTimer = setTimeout(moveChord, 7000) as unknown as number;
  }

  function startPads() {
    if (padVoices.length) return;
    PROGRESSION[0]!.forEach((f, degree) => {
      for (const detune of [-5, 5]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        // Triangle rather than sine: a few harmonics is the difference between
        // a pad you can hear across a room and one that only shows on a meter.
        osc.type = 'triangle';
        osc.frequency.value = f;
        osc.detune.value = detune;
        g.gain.value = 0.05;
        // Slow, prime-ish rates so the voices never pulse together.
        lfo.frequency.value = 0.03 + Math.random() * 0.05;
        lfoGain.gain.value = 0.035;
        lfo.connect(lfoGain).connect(g.gain);
        osc.connect(g).connect(lobbyGain);
        osc.start();
        lfo.start();
        padVoices.push({ osc, degree });
        padAux.push(lfo);
      }
    });
    chordTimer = setTimeout(moveChord, 7000) as unknown as number;
  }

  // Tempo is not fixed. It climbs with the clock, which is most of why the
  // last five seconds of a question feel different from the first five.
  const bpmAt = (i: number) => 116 + i * 20;

  /** A short chord stab. Arrives late in a question and is most of the lift. */
  function stab(at: number, gain: number) {
    const notes = PROGRESSION[(beat >> 4) % PROGRESSION.length]!;
    for (const f of notes.slice(0, 3)) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(g).connect(questionGain);
      osc.start(at);
      osc.stop(at + 0.2);
    }
  }

  /**
   * Schedules a little ahead of the clock so timing does not depend on the tab.
   *
   * The pattern is sixteen beats, not eight, and almost everything in it is a
   * function of `intensity`, which the host drives from the falling value. At
   * the start of a question this is a kick, an offbeat hat and a bass figure;
   * by the end it is faster, busier, brighter and louder, with claps and chord
   * stabs that were not there before. That climb is the crescendo — it is tied
   * to the clock rather than to a loop, so it lands with the buzzer.
   */
  function pump() {
    if (disposed) return;
    const ahead = ctx.currentTime + 0.25;
    while (nextBeat < ahead) {
      const at = Math.max(nextBeat, ctx.currentTime + 0.01);
      const beatDur = 60 / bpmAt(bed === 'question' ? intensity : 0);
      if (bed === 'question') {
        const step = beat % BASS_STEPS.length;
        const inBar = beat % 4;

        hit(ctx, questionGain, at, 'kick', 0.42 + intensity * 0.16);
        // Backbeat clap: the first thing that makes it a groove rather than a
        // pulse. Present from the start, louder as it goes.
        if (inBar === 1 || inBar === 3) {
          hit(ctx, questionGain, at, 'hat', 0.1 + intensity * 0.1);
          hit(ctx, questionGain, at + 0.012, 'hat', 0.08 + intensity * 0.08);
        }
        hit(ctx, questionGain, at + beatDur / 2, 'hat', 0.1 + intensity * 0.14);
        if (intensity > 0.4) hit(ctx, questionGain, at + beatDur / 4, 'hat', 0.04 + intensity * 0.05);
        if (intensity > 0.7) hit(ctx, questionGain, at + (beatDur * 3) / 4, 'hat', 0.04 + intensity * 0.05);
        // An open hat on the last eighth of each bar, to turn it over.
        if (intensity > 0.25 && inBar === 3) hit(ctx, questionGain, at + beatDur / 2, 'hat', 0.16);
        if (intensity > 0.55 && inBar === 2) stab(at + beatDur / 2, 0.07 + intensity * 0.06);

        const bass = ctx.createOscillator();
        const bg = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        bass.type = 'sawtooth';
        bass.frequency.value = BASS_STEPS[step] ?? 55;
        filter.type = 'lowpass';
        // Opens up as the clock runs down: the room hears the pressure.
        filter.frequency.value = 260 + intensity * 2600;
        filter.Q.value = 7;
        bg.gain.setValueAtTime(0.0001, at);
        bg.gain.exponentialRampToValueAtTime(0.15 + intensity * 0.07, at + 0.01);
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
    meter() {
      analyser.getFloatTimeDomainData(meterBuf);
      let sum = 0;
      for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i]! * meterBuf[i]!;
      return Math.sqrt(sum / meterBuf.length);
    },
    running() {
      return ctx.state === 'running';
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (chordTimer !== undefined) clearTimeout(chordTimer);
      for (const n of [...padVoices.map((v) => v.osc), ...padAux]) {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
      }
      padVoices.length = 0;
      padAux.length = 0;
      void ctx.close();
    },
  };
}
