/**
 * The browser half of `npm run beds`.
 *
 * Bundled by scripts/render-beds.mjs and run in headless Chromium, because
 * Web Audio is the only synthesizer this project has and Node does not have
 * one. It renders through `scheduleBeat`, the same function the big screen
 * calls, so an mp3 is evidence about the bed the room hears rather than about
 * a second implementation of it.
 */
import { DEFAULT_CONFIG, pointsAt } from '../shared/protocol';
import { BED_VARIANTS, bedVariantByKey, DEFAULT_BED_VARIANT } from '../src/client/host/beds';
import { bpmAt, hit, scheduleBeat, SYNTH_KIT, type VoiceKit } from '../src/client/host/bedengine';
import { CANDIDATE_KITS } from './bed-kits';

/** Matches createHostAudio's master gain, so the mp3 is at playing level. */
const MASTER = 0.35;
const SAMPLE_RATE = 44100;

/**
 * How urgent the bed is at this point in a question.
 *
 * Copied from nothing: it is the host's own line, `1 - (onOffer - min) / span`,
 * reading the same pointsAt the handsets price answers with. That is what
 * makes the recording's crescendo arrive where the real one does — full value
 * through the reading seconds, then climbing to the buzzer.
 */
function intensityAt(elapsedMs: number, windowMs: number) {
  const span = DEFAULT_CONFIG.questionPoints - DEFAULT_CONFIG.minQuestionPoints;
  if (span <= 0) return 0;
  const onOffer = pointsAt(elapsedMs, windowMs, DEFAULT_CONFIG);
  return 1 - (onOffer - DEFAULT_CONFIG.minQuestionPoints) / span;
}

/** One question of one bed, scheduled onto `out` starting at `startAt`. */
function scheduleQuestion(
  ctx: BaseAudioContext,
  out: AudioNode,
  key: string,
  startAt: number,
  seconds: number,
  kit: VoiceKit = SYNTH_KIT,
): number {
  const variant = bedVariantByKey(key);
  const windowMs = seconds * 1000;
  let t = 0;
  let beat = 0;
  while (t < seconds) {
    const intensity = intensityAt(t * 1000, windowMs);
    const beatDur = 60 / bpmAt(variant, intensity);
    scheduleBeat(ctx, out, { variant, beat, at: startAt + t, beatDur, intensity, kit });
    t += beatDur;
    beat++;
  }
  return startAt + seconds;
}

export interface Rendered {
  sampleRate: number;
  /** Little-endian Float32 mono samples, base64 for the trip out of the page. */
  pcm: string;
}

/**
 * A plain reverb: noise that decays, used as an impulse response. Not a model
 * of any room, but a dry note sounds cheap however good its harmonics are,
 * and this is the cheapest honest way to put one somewhere.
 */
function room(ctx: BaseAudioContext, out: AudioNode, amount: number, seconds = 1.5): GainNode {
  const len = Math.floor(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      // Exponential decay, and a touch of early silence so the tail reads as
      // a room rather than as the note being smeared.
      const t = i / len;
      const early = i < ctx.sampleRate * 0.01 ? 0 : 1;
      data[i] = (Math.random() * 2 - 1) * (1 - t) ** 2.6 * early;
    }
  }
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse;
  const send = ctx.createGain();
  send.gain.value = amount;
  const wet = ctx.createGain();
  // Keeps total level roughly constant as the send goes up, so a reverby kit
  // is not also a louder kit in the comparison.
  wet.gain.value = 0.9;
  send.connect(convolver).connect(wet).connect(out);
  return send;
}

async function render(seconds: number, fill: (ctx: OfflineAudioContext, out: AudioNode) => void): Promise<Rendered> {
  const ctx = new OfflineAudioContext(1, Math.ceil(SAMPLE_RATE * seconds), SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = MASTER;
  master.connect(ctx.destination);
  fill(ctx, master);
  const buf = await ctx.startRendering();
  const samples = buf.getChannelData(0);
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return { sampleRate: ctx.sampleRate, pcm: btoa(binary) };
}

/** One bed, one question long, with the real falling-value crescendo. */
export function renderBed(key: string, seconds: number) {
  return render(seconds + 1, (ctx, out) => {
    scheduleQuestion(ctx, out, key, 0.2, seconds);
  });
}

/**
 * The rotation: four questions in the order a night plays them, with a gap
 * between where the reveal and the scoreboard go. The point of this file is
 * hearing whether the change registers at all.
 *
 * Each question is announced by its number in short ticks — one tick, then
 * two, then three, then four — because listening to eighty-seven seconds of
 * this and then arguing about which bed was third is how the first version of
 * these previews got read as "the rotation sounds different from the files".
 * It did not; the numbering did.
 */
export function renderRotation(seconds: number, gap: number) {
  const keys = BED_VARIANTS.map((v) => v.key);
  const total = keys.length * (seconds + gap) + 1;
  return render(total, (ctx, out) => {
    let at = 0.6;
    keys.forEach((key, index) => {
      // The marker sits in the gap, finishing before the bed starts.
      for (let n = 0; n <= index; n++) hit(ctx, out, at - 0.5 - (index - n) * 0.16, 'tick', 0.3, 1568);
      at = scheduleQuestion(ctx, out, key, at, seconds) + gap;
    });
  });
}

/** The order the medley plays, for the console table. */
export const rotationOrder = () =>
  BED_VARIANTS.map((v, i) => `${i + 1} tick${i ? 's' : ''} ${v.name}`).join(', ');

export const bedKeys = () => BED_VARIANTS.map((v) => ({ key: v.key, name: v.name }));

/** Every kit worth hearing: today's, then the candidates. */
const ALL_KITS: VoiceKit[] = [SYNTH_KIT, ...CANDIDATE_KITS];

export const paletteKeys = () =>
  ALL_KITS.map((k) => ({ key: k.key, name: k.name, reverb: k.reverb }));

/**
 * A laptop or phone speaker, roughly: nothing below about 300Hz survives, and
 * what is just above it is quiet. Two cascaded highpasses give the ~12dB per
 * octave slope a small driver has.
 *
 * Rendering through this is how to tell a mix problem from a playback
 * problem. If today's bed through here sounds like today's bed does on your
 * desk, the music is in a band your speaker cannot play and no instrument
 * choice will fix it.
 */
function smallSpeaker(ctx: BaseAudioContext, out: AudioNode): GainNode {
  const a = ctx.createBiquadFilter();
  a.type = 'highpass';
  a.frequency.value = 300;
  a.Q.value = 0.7;
  const b = ctx.createBiquadFilter();
  b.type = 'highpass';
  b.frequency.value = 300;
  b.Q.value = 0.7;
  // A little presence lift, which is also what a small driver does.
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = 2500;
  peak.Q.value = 1;
  peak.gain.value = 4;
  const input = ctx.createGain();
  input.connect(a).connect(b).connect(peak).connect(out);
  return input;
}

/**
 * One palette, playing the bed the room was already tuned on, so the only
 * thing that differs between these files is what the notes are made of.
 *
 * `speaker` renders it through the small-speaker model above.
 */
export function renderPalette(kitKey: string, seconds: number, speaker = false) {
  const kit = ALL_KITS.find((k) => k.key === kitKey) ?? SYNTH_KIT;
  return render(seconds + 2, (ctx, out) => {
    const tail = speaker ? smallSpeaker(ctx, out) : out;
    // The bed plays into `bus`, which goes to the output and, if the kit asks
    // for a room, also into the reverb send. Scheduling onto `out` instead
    // would have left the send silent and every palette dry.
    const bus = ctx.createGain();
    let head: AudioNode = bus;
    if (kit.highpassHz) {
      // Energy under a speaker's floor is not quiet, it is wasted: it eats
      // the headroom that holds everything audible down.
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = kit.highpassHz;
      bus.connect(hp);
      head = hp;
    }
    head.connect(tail);
    if (kit.reverb > 0) head.connect(room(ctx, tail, kit.reverb));
    scheduleQuestion(ctx, bus, DEFAULT_BED_VARIANT.key, 0.2, seconds, kit);
  });
}
