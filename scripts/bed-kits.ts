/**
 * Candidate voice kits, for listening to before any of them ships.
 *
 * The question "what instrument is this imitating?" had no answer: the beds
 * were raw oscillators, and a naked sawtooth in the 300Hz-3kHz band is the
 * definition of tinny. These four are real answers to that question, built
 * the only way this project allows — oscillators and envelopes, nothing
 * loaded — and rendered to mp3 by `npm run beds`.
 *
 * A kit is now a bass and a drum voice only. The chord layers are gone: a
 * four chord progression under a twenty second question was heard as one
 * repeating tone, whatever instrument played it, so what is left to design is
 * the plucked note and the kit around it.
 *
 * They live in scripts/ on purpose. Nothing here is on the big screen; the
 * one that wins moves into bedengine.ts beside SYNTH_KIT and becomes the
 * default. SYNTH_KIT is rendered alongside them so the comparison includes
 * what the room hears today.
 *
 * What makes an oscillator sound like an instrument, in the three parts these
 * kits actually use:
 *
 *  - Overtones. A struck metal bar rings at its fundamental and again near
 *    four and nine times that, which is why a vibraphone reads as metal and a
 *    sine reads as a test tone. Added as quiet extra sines, not as a brighter
 *    waveform, because a brighter waveform adds every harmonic at once and
 *    that is the fizz.
 *  - The attack. A plucked string, a hammered tine and a blown horn differ
 *    more in their first thirty milliseconds than anywhere else.
 *  - The room. A completely dry note sounds cheap however good its harmonics
 *    are, so every kit declares how much reverb it wants.
 */
import type { Ctx, VoiceKit } from '../src/client/host/bedengine';

/** A decaying burst of noise. The raw material for every brush and click. */
function noise(ctx: Ctx, out: AudioNode, at: number, dur: number, gain: number, hpHz: number, lpHz?: number) {
  const len = Math.max(32, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = hpHz;
  const g = ctx.createGain();
  g.gain.value = gain;
  let chain: AudioNode = src.connect(hp);
  if (lpHz !== undefined) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lpHz;
    chain = chain.connect(lp);
  }
  chain.connect(g).connect(out);
  src.start(at);
  src.stop(at + dur + 0.02);
}

/**
 * A note built from its overtones: `[ratio, level]` pairs over one envelope.
 * Used by the ticks and the rim clicks; the chord voices it was written for
 * are gone.
 */
function partials(
  ctx: Ctx,
  out: AudioNode,
  freq: number,
  at: number,
  gain: number,
  attack: number,
  decay: number,
  spectrum: Array<[number, number]>,
  tremoloHz = 0,
  type: OscillatorType = 'sine',
) {
  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0.0001, at);
  bus.gain.exponentialRampToValueAtTime(gain, at + attack);
  bus.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  bus.connect(out);
  if (tremoloHz > 0) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = tremoloHz;
    depth.gain.value = gain * 0.3;
    lfo.connect(depth).connect(bus.gain);
    lfo.start(at);
    lfo.stop(at + attack + decay + 0.05);
  }
  for (const [ratio, level] of spectrum) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq * ratio;
    // The overtones of a struck bar die away faster than its fundamental.
    g.gain.setValueAtTime(level, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, level * 0.2), at + attack + decay * 0.5);
    osc.connect(g).connect(bus);
    osc.start(at);
    osc.stop(at + attack + decay + 0.05);
  }
}

/**
 * A filtered oscillator pair with a pluck envelope. Every kit's bass.
 *
 * It plays in the octave the tables are written in, and nothing below 35Hz is
 * cut. An earlier pass moved it up an octave and cut at 80Hz, which was tuned
 * against a model of a laptop speaker; on headphones that removed the low end
 * the listener could actually hear. The bed has to work on both, so the fix
 * for the soundbar is the sustained midrange layer, not throwing the bass
 * away. The small trim stays because the comp now carries the body the bass
 * was being asked to carry on its own.
 */
function pluckedBass(
  ctx: Ctx,
  out: AudioNode,
  freq: number,
  at: number,
  dur: number,
  gain: number,
  cutoff: number,
  q: number,
  waves: Array<[OscillatorType, number]>,
  attack: number,
  tail: number,
) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  filter.Q.value = q;
  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0.0001, at);
  bus.gain.exponentialRampToValueAtTime(gain, at + attack);
  bus.gain.exponentialRampToValueAtTime(0.0001, at + dur * tail);
  filter.connect(bus).connect(out);
  for (const [type, level] of waves) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = level;
    osc.connect(g).connect(filter);
    osc.start(at);
    osc.stop(at + dur);
  }
}



/**
 * Vibraphone, upright bass, brushes. The think-music family: metal bars
 * struck softly, a plucked string with the finger noise left in, and a kit
 * played with wire brushes instead of sticks.
 */
export const VIBES_KIT: VoiceKit = {
  key: 'vibes',
  name: 'Vibraphone trio',
  reverb: 0.38,
  highpassHz: 35,
  bass(ctx, out, freq, at, dur, gain, cutoff, _q, _wave) {
    // An upright is dark: the string's harmonics above about 700Hz are the
    // bow or the fingerboard, not the note. Capped rather than swept wide.
    // Capped relative to the note now that the note is an octave higher: a
    // fixed 700Hz ceiling on a 110Hz string removed the harmonics that make
    // an upright audible at all on a small speaker.
    pluckedBass(ctx, out, freq, at, dur, gain * 1.0, Math.min(cutoff + 240, Math.max(900, freq * 7)), 1, [['triangle', 0.9], ['sine', 0.6]], 0.014, 0.85);
    noise(ctx, out, at, 0.02, gain * 0.14, 400, 1800);
  },
  drum(ctx, out, at, kind, gain, freq = 880) {
    if (kind === 'hat') {
      // A brush sweep, not a stick. Longer, softer, narrower band.
      noise(ctx, out, at, 0.1, gain * 0.7, 4500, 11000);
      return;
    }
    if (kind === 'tick') {
      partials(ctx, out, freq * 0.75, at, gain * 0.5, 0.002, 0.07, [[1, 1], [3, 0.1]]);
      return;
    }
    // A soft kick with a felt beater: low thump, a little body, no click.
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(130, at);
    osc.frequency.exponentialRampToValueAtTime(48, at + 0.26);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + 0.3);
    noise(ctx, out, at, 0.03, gain * 0.18, 200, 1200);
  },
};

/**
 * Electric piano. Two sines where one shakes the other, which is how a Rhodes
 * tine gets its bell attack and its warm sustain out of almost no harmonics.
 */
export const RHODES_KIT: VoiceKit = {
  key: 'rhodes',
  name: 'Electric piano',
  reverb: 0.3,
  highpassHz: 35,
  bass(ctx, out, freq, at, dur, gain, cutoff, _q, _wave) {
    pluckedBass(ctx, out, freq, at, dur, gain * 0.95, Math.min(cutoff + 240, Math.max(800, freq * 6)), 0.8, [['sine', 1], ['triangle', 0.35]], 0.018, 0.8);
  },
  drum(ctx, out, at, kind, gain, freq = 880) {
    if (kind === 'hat') {
      noise(ctx, out, at, 0.07, gain * 0.75, 5500, 12000);
      return;
    }
    if (kind === 'tick') {
      partials(ctx, out, freq * 0.6, at, gain * 0.45, 0.002, 0.06, [[1, 1]]);
      return;
    }
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, at);
    osc.frequency.exponentialRampToValueAtTime(45, at + 0.24);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain * 0.95, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + 0.28);
  },
};

/**
 * The same synth bed, given a body: the stabs filtered instead of naked, two
 * detuned voices instead of one, a sine under the bass, and a room. Still no
 * instrument — this is the option that only removes the harshness.
 */
export const WARM_KIT: VoiceKit = {
  key: 'warm',
  name: 'Warm synth',
  reverb: 0.24,
  highpassHz: 35,
  bass(ctx, out, freq, at, dur, gain, cutoff, q, wave) {
    pluckedBass(ctx, out, freq, at, dur, gain * 0.85, Math.min(cutoff + 400, 2200), q * 0.6, [[wave, 0.8], ['sine', 0.7]], 0.01, 0.7);
  },
  drum(ctx, out, at, kind, gain, freq = 880) {
    if (kind === 'hat') {
      noise(ctx, out, at, 0.05, gain * 0.85, 6000);
      return;
    }
    if (kind === 'tick') {
      // A sine, not a triangle. The triangle is what reads as a beep.
      partials(ctx, out, freq * 0.8, at, gain * 0.7, 0.002, 0.08, [[1, 1], [2, 0.12]]);
      return;
    }
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, at);
    osc.frequency.exponentialRampToValueAtTime(52, at + 0.22);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + 0.26);
    noise(ctx, out, at, 0.02, gain * 0.2, 900, 3500);
  },
};

/**
 * The game show sting: a stack of detuned sawtooths swelling through a
 * resonant filter. The loudest and the brightest, and the one most likely to
 * be the thing that sounded tinny in the first place.
 */
export const BRASS_KIT: VoiceKit = {
  key: 'brass',
  name: 'Brass section',
  reverb: 0.2,
  highpassHz: 35,
  bass(ctx, out, freq, at, dur, gain, cutoff, q, _wave) {
    pluckedBass(ctx, out, freq, at, dur, gain * 0.9, cutoff, q, [['sawtooth', 0.7], ['square', 0.4]], 0.008, 0.72);
  },
  drum(ctx, out, at, kind, gain, freq = 880) {
    if (kind === 'hat') {
      noise(ctx, out, at, 0.04, gain, 7500);
      return;
    }
    if (kind === 'tick') {
      partials(ctx, out, freq, at, gain, 0.002, 0.09, [[1, 1], [2, 0.2], [3, 0.08]]);
      return;
    }
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(170, at);
    osc.frequency.exponentialRampToValueAtTime(55, at + 0.2);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain * 1.15, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + 0.24);
    noise(ctx, out, at, 0.02, gain * 0.35, 1200);
  },
};

export const CANDIDATE_KITS = [VIBES_KIT, RHODES_KIT, WARM_KIT, BRASS_KIT];
