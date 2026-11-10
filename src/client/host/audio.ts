/**
 * The big screen's sound, synthesized rather than streamed.
 *
 * Nothing here loads a file. Everything is oscillators and envelopes through
 * the Web Audio graph, for three reasons that all matter on this box:
 *
 *  - No megabytes in git and nothing to pull over clubhouse wifi.
 *  - A loop built from a clock has no seam.
 *  - It can follow the game. The question bed tightens as the value falls,
 *    which a recording cannot do.
 *
 * There is one bed, and it plays only under a live question. The pad that used
 * to run through the lobby and the breaks is gone: it was the only bed that
 * ever played under a speaking voice, and the room could not follow the MC
 * over it. Sound during a break is now the absence of sound.
 *
 * Host only, always. Twenty handsets playing the same loop over wifi would be
 * hundreds of milliseconds apart, which is not music. The same call was already
 * made for read-aloud in useGame.ts.
 *
 * The question bed has four variants and rotates through them, one per
 * question. Their grooves live as data in beds.ts; the scheduling, and every
 * formula that ties the crescendo to the clock, lives here and is the same for
 * all four.
 */

import { bedVariantByKey, DEFAULT_BED_VARIANT, type BedVariant } from './beds';
// One beat of a question bed. Shared with scripts/render-beds.mjs, which
// renders the beds to mp3 — the recordings are this code, not a copy of it.
import { bpmAt as bedBpmAt, hit, scheduleBeat } from './bedengine';

export type Bed = 'question' | null;

export interface HostAudio {
  /** Must be called from a real click: browsers refuse audio before one. */
  resume(): Promise<void>;
  /**
   * `variantKey` names the question groove (see beds.ts). It is adopted on the
   * next bar line, so switching beds never clips a bar in half.
   */
  setBed(bed: Bed, variantKey?: string): void;
  /** 0..1 intensity for the question bed, driven by the falling value. */
  setIntensity(v: number): void;
  setVolume(v: number): void;
  /**
   * Three rising ticks and a chord, placed so the chord lands exactly as the
   * question appears. `msUntilQuestion` is how long is left, not a duration.
   */
  countIn(msUntilQuestion: number): void;
  /** Current output level, 0..1. For checking the thing is actually audible. */
  meter(): number;
  /** Which question bed is playing. For checking the rotation from the console. */
  variant(): string;
  running(): boolean;
  dispose(): void;
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
      variant: () => DEFAULT_BED_VARIANT.key,
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

  // The bed and the cues keep separate gains: a cue has to be audible over a
  // bed that is fading, and the count-in fires while the bed is still going.
  const questionGain = ctx.createGain();
  questionGain.gain.value = 0;
  questionGain.connect(master);
  const cueGain = ctx.createGain();
  cueGain.gain.value = 1;
  cueGain.connect(master);

  let bed: Bed = null;
  let variant: BedVariant = DEFAULT_BED_VARIANT;
  let pendingVariant: BedVariant | null = null;
  let intensity = 0;
  let timer: number | undefined;
  let nextBeat = 0;
  let beat = 0;
  let disposed = false;

  const bpmAt = (i: number) => bedBpmAt(variant, i);

  /**
   * Schedules a little ahead of the clock so timing does not depend on the
   * tab. What one beat sounds like is bedengine.ts; this is only when.
   */
  function pump() {
    if (disposed) return;
    const ahead = ctx.currentTime + 0.25;
    while (nextBeat < ahead) {
      const at = Math.max(nextBeat, ctx.currentTime + 0.01);
      const beatDur = 60 / bpmAt(bed === 'question' ? intensity : 0);
      if (bed === 'question') {
        // A pending bed is adopted on the bar line, never mid-bar: a groove
        // that changes on beat three sounds like a mistake rather than a
        // change. beat is reset to 0 by setBed, so the first bar is already a
        // bar line and a new question starts on its own bed immediately.
        if (pendingVariant && beat % 4 === 0) {
          variant = pendingVariant;
          pendingVariant = null;
        }
        scheduleBeat(ctx, questionGain, { variant, beat, at, beatDur, intensity });
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
      if (timer === undefined) {
        nextBeat = ctx.currentTime + 0.1;
        pump();
      }
      // One chord, right here, because this click used to answer itself. The
      // lobby pad started the instant the MC armed the sound, so a working
      // setup was obvious and a dead soundbar was obvious. With no lobby bed
      // the next sound is the first question's count-in, which is a bad place
      // to discover the TV is muted. This proves the whole path: the browser
      // let the audio through AND the room can hear it.
      const at = ctx.currentTime + 0.05;
      for (const f of [523.25, 659.25, 783.99]) hit(ctx, cueGain, at, 'tick', 0.18, f);
    },
    setBed(next, variantKey) {
      // The bed a question asks for can change while the bed itself does not:
      // the question phase is re-entered for every question, but a reconnect
      // can also re-assert the same phase. Both end up here, so the groove is
      // recorded either way and the early return only skips the cross-fade.
      if (variantKey !== undefined) {
        const want = bedVariantByKey(variantKey);
        pendingVariant = want === variant && next === bed ? null : want;
      }
      if (next === bed) return;
      bed = next;
      // Long fades: a bed appearing or vanishing abruptly is more noticeable
      // than the bed itself. In quicker on a question than out of one, so the
      // groove is under the room by the time the prompt is readable.
      fade(questionGain, next === 'question' ? 1 : 0, next === 'question' ? 0.4 : 1.0);
      if (next === 'question') beat = 0;
    },
    setIntensity(v) {
      intensity = Math.max(0, Math.min(1, v));
    },
    setVolume(v) {
      fade(master, Math.max(0, Math.min(1, v)), 0.2);
    },
    countIn(msUntilQuestion: number) {
      // Anchored to the end, not the start. Three ticks a second apart and the
      // chord on the question itself, so the room counts down to the thing
      // rather than finishing early and waiting.
      const target = ctx.currentTime + Math.max(0.05, msUntilQuestion / 1000);
      const gap = Math.min(1, Math.max(0.35, (target - ctx.currentTime) / 3.2));
      const at = (before: number) => Math.max(ctx.currentTime + 0.01, target - before);
      hit(ctx, cueGain, at(gap * 3), 'tick', 0.22, 523.25);
      hit(ctx, cueGain, at(gap * 2), 'tick', 0.22, 659.25);
      hit(ctx, cueGain, at(gap), 'tick', 0.22, 783.99);
      for (const f of [1046.5, 1318.5, 1568]) {
        hit(ctx, cueGain, at(0.03), 'tick', 0.16, f);
      }
    },
    variant() {
      // The bed that is sounding, not the one queued for the next question.
      // The queued one is set the moment a reveal starts fading the current
      // bed out, and reporting that during the fade sends you looking for a
      // rotation bug in a bed you are still hearing.
      return variant.key;
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
      // Nothing to stop by hand any more: every voice a question bed makes is
      // scheduled with its own stop time, so closing the context is the whole
      // teardown. The pad was the only thing here that ran forever.
      void ctx.close();
    },
  };
}
