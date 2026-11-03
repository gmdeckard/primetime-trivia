/**
 * One beat of a question bed, scheduled onto a Web Audio graph.
 *
 * This lives apart from audio.ts for one reason: `scripts/render-beds.mjs`
 * renders the beds to mp3 so they can be listened to away from a trivia
 * night, and a renderer that reimplemented the groove would be reviewing its
 * own copy. Both the big screen and the renderer call `scheduleBeat`, so a
 * recording is evidence about the thing the room actually hears.
 *
 * audio.ts owns the clock, the beds' cross-fades and the count-in. This file
 * owns what a single beat sounds like and nothing else: no timers, no state
 * between calls, no AudioContext of its own.
 */

import { hz, type BedVariant } from './beds';

/** Anything that can build nodes: a live AudioContext or an offline render. */
export type Ctx = BaseAudioContext;

/**
 * What a bed's notes and drums are made of.
 *
 * Split out from the groove because the two are different questions. The
 * groove is which beats and which notes; a kit is what a note sounds like.
 * Four beds all playing raw oscillators sound like four arrangements of one
 * cheap keyboard, which is the complaint these exist to answer.
 *
 * A kit is a bass voice and a drum voice. There is no chord voice: the chord
 * layers are gone, because four chords under a twenty second question read as
 * one repeating tone however the harmony moved underneath them.
 *
 * `SYNTH_KIT` below is what the big screen has always played. Candidate kits
 * live in scripts/bed-kits.ts and are rendered to mp3 by `npm run beds`;
 * whichever one wins moves in here and becomes the default.
 */
export interface VoiceKit {
  key: string;
  name: string;
  /** One bass note. `cutoff` carries the variant's filter sweep. */
  bass(
    ctx: Ctx,
    out: AudioNode,
    freq: number,
    at: number,
    dur: number,
    gain: number,
    cutoff: number,
    q: number,
    wave: OscillatorType,
  ): void;
  /** One drum or click. */
  drum(ctx: Ctx, out: AudioNode, at: number, kind: 'kick' | 'hat' | 'tick', gain: number, freq?: number): void;
  /**
   * How much room to put around the kit, 0..1. A dry oscillator reads as
   * cheap however good its harmonics are.
   */
  reverb: number;
  /**
   * Semitones to move the bass figure by. The tables are written around A1
   * at 55Hz, which measures as half the mix and is inaudible on the speakers
   * this actually plays through; +12 puts the same figure where a soundbar
   * can reproduce it.
   */
  bassSemitones?: number;
  /**
   * Cut everything below this, in Hz. Energy under a speaker's floor is not
   * quiet, it is wasted: it eats headroom and the master gain holds the rest
   * down to make room for it.
   */
  highpassHz?: number;
}

/** One short percussive hit. Used for the kick, the hats and the ticks. */
export function hit(
  ctx: Ctx,
  out: AudioNode,
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

/**
 * Tempo is not fixed. It climbs with the clock, which is most of why the last
 * five seconds of a question feel different from the first five. Both ends of
 * the climb are the variant's; the shape of it is not.
 */
export const bpmAt = (variant: BedVariant, intensity: number) =>
  variant.bpm + intensity * variant.bpmClimb;

/**
 * The kit the big screen plays today: one oscillator per voice, no overtones
 * and no room. It is the baseline the candidates are judged against, and it
 * stays here unchanged so a palette experiment can never alter what ships.
 */
export const SYNTH_KIT: VoiceKit = {
  key: 'synth',
  name: 'Synth (today)',
  reverb: 0,
  drum: hit,
  bass(ctx, out, freq, at, dur, gain, cutoff, q, wave) {
    const bass = ctx.createOscillator();
    const bg = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    bass.type = wave;
    bass.frequency.value = freq;
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = q;
    bg.gain.setValueAtTime(0.0001, at);
    bg.gain.exponentialRampToValueAtTime(gain, at + 0.01);
    bg.gain.exponentialRampToValueAtTime(0.0001, at + dur * 0.7);
    bass.connect(filter).connect(bg).connect(out);
    bass.start(at);
    bass.stop(at + dur);
  },
};

export interface BeatAt {
  variant: BedVariant;
  /** Defaults to SYNTH_KIT: what the big screen plays today. */
  kit?: VoiceKit;
  /** Beats since the question started. Bars are four, bass figures sixteen. */
  beat: number;
  /** Context time this beat lands on. */
  at: number;
  /** Seconds per beat at the current tempo. */
  beatDur: number;
  /** 0..1, driven by the falling point value. */
  intensity: number;
}

/**
 * Schedules everything that happens on one beat of a question bed.
 *
 * Bass and drums. The pattern is sixteen beats, not eight, and almost
 * everything in it is a function of `intensity`, which the host drives from
 * the falling value. At the start of a question this is a kick, an offbeat hat
 * and a bass figure; by the end it is faster, busier, brighter and louder.
 * That climb is the crescendo — it is tied to the clock rather than to a loop,
 * so it lands with the buzzer.
 *
 * With the chord stabs gone the lift at the end has to come from four things
 * at once: the tempo climbing, the bass filter opening, sixteenth hats filling
 * in, and every voice getting louder. No layer arrives that was not already
 * playing, which is a quieter ending than a stab and the price of not having
 * a repeating tone.
 *
 * What the variant supplies is which notes, which drum positions and where
 * each layer comes in. Every `intensity` term below is shared, so a bed cannot
 * opt out of the crescendo or run away with it.
 */
export function scheduleBeat(ctx: Ctx, out: AudioNode, { variant: v, beat, at, beatDur, intensity, kit = SYNTH_KIT }: BeatAt) {
  const step = beat % v.bass.length;
  const inBar = beat % 4;
  // Offbeats land late on a swung bed and exactly on the beat otherwise.
  const off = (fraction: number) => at + beatDur * (fraction + (fraction > 0 ? v.swing : 0));

  for (const pos of v.kick) {
    if (Math.floor(pos) === inBar) kit.drum(ctx, out, off(pos - inBar), 'kick', v.kickGain + intensity * 0.16);
  }
  // Backbeat clap: the first thing that makes it a groove rather than a pulse.
  // Present from the start, louder as it goes.
  if (v.clap.includes(inBar)) {
    kit.drum(ctx, out, at, 'hat', 0.1 + intensity * 0.1);
    kit.drum(ctx, out, at + 0.012, 'hat', 0.08 + intensity * 0.08);
  }
  // The clock bed has no offbeat hat at all; a dry tick on every beat is the
  // whole point of it, and a hat on top only muddies that.
  if (v.tickEveryBeat) kit.drum(ctx, out, at, 'tick', 0.05 + intensity * 0.05, 2200);
  if (v.hatEighths) kit.drum(ctx, out, off(0.5), 'hat', 0.1 + intensity * 0.14);
  if (intensity > v.hatSixteenthsFrom) {
    kit.drum(ctx, out, off(0.25), 'hat', 0.04 + intensity * 0.05);
    if (intensity > v.hatSixteenthsFrom + 0.3) kit.drum(ctx, out, off(0.75), 'hat', 0.04 + intensity * 0.05);
  }
  // An open hat on the last eighth of a bar, to turn it over.
  if (v.openHatBar !== null && intensity > 0.25 && inBar === v.openHatBar) {
    kit.drum(ctx, out, off(0.5), 'hat', 0.16);
  }
  kit.bass(
    ctx,
    out,
    hz((v.bass[step] ?? 33) + (kit.bassSemitones ?? 0)),
    at,
    beatDur,
    0.15 + intensity * 0.07,
    // Opens up as the clock runs down: the room hears the pressure.
    v.bassFilterHz + intensity * v.bassSweepHz,
    v.bassQ,
    v.bassWave,
  );
}
