/**
 * The question beds: four grooves the big screen rotates through.
 *
 * Bass and drums, no chords. The chord layers were removed on 2026-11-03:
 * even with a progression that moved every bar and a voicing that rotated,
 * four chords under a twenty second question read as one tone going round and
 * round. What a bed owes the room is pressure, and pressure is tempo, a bass
 * figure and a drum pattern.
 *
 * One bed under every question is the thing a room stops hearing by question
 * six, and then it is just noise under the prompt. These four are different
 * enough to notice the change and close enough that none of them is a surprise
 * in the middle of a night.
 *
 * Everything here is data. `audio.ts` reads these numbers and schedules them;
 * no variant can schedule anything of its own, which is what keeps the
 * crescendo honest: intensity still drives tempo, brightness, busyness and
 * loudness in exactly one place for all four.
 *
 * Notes are MIDI numbers, not Hz. Four variants is sixty-four bass steps, and
 * a typo in a Hz table reads as a plausible number right up until the room
 * hears it.
 */

/** MIDI note to Hz. 69 is A4, 440Hz. */
export const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export interface BedVariant {
  key: string;
  /** Shown by primetimeAudio.variant() when diagnosing from the console. */
  name: string;
  /** Beats per minute at intensity 0, and what full intensity adds. */
  bpm: number;
  bpmClimb: number;
  /** Sixteen steps, one per beat: four bars, so the figure answers itself. */
  bass: number[];
  bassWave: OscillatorType;
  /** Lowpass cutoff at intensity 0, and what full intensity adds. */
  bassFilterHz: number;
  bassSweepHz: number;
  bassQ: number;
  /**
   * Kick and clap positions in beats within a four-beat bar, so 2.5 is the
   * "and" of three and the pattern reads the way it sounds.
   */
  kick: number[];
  kickGain: number;
  clap: number[];
  /** An offbeat hat on every beat. Off for the beds that tick instead. */
  hatEighths: boolean;
  /** Intensity above which sixteenth hats fill in. Over 1 means never. */
  hatSixteenthsFrom: number;
  /** Which bar position gets the open hat that turns the bar over, or null. */
  openHatBar: number | null;
  /** A dry high tick on every beat: a clock, not a drum. */
  tickEveryBeat: boolean;
  /** Fraction of a beat that pushes offbeats late. 0 is straight. */
  swing: number;
}

export const BED_VARIANTS: BedVariant[] = [
  {
    // The original bed, kept to the number so the rotation adds beds rather
    // than replacing the one that was already tuned in the room.
    key: 'think',
    name: 'Think',
    bpm: 116,
    bpmClimb: 20,
    bass: [33, 33, 40, 33, 36, 33, 40, 43, 33, 33, 40, 45, 36, 43, 40, 38],
    bassWave: 'sawtooth',
    bassFilterHz: 260,
    bassSweepHz: 2600,
    bassQ: 7,
    kick: [0, 1, 2, 3],
    kickGain: 0.42,
    clap: [1, 3],
    hatEighths: true,
    hatSixteenthsFrom: 0.4,
    openHatBar: 3,
    tickEveryBeat: false,
    swing: 0,
  },
  {
    // Half-time and a pedal tone, with a tick on every beat doing the work the
    // kick does elsewhere. The bass holds D for three bars and then climbs
    // chromatically into the A7, so the tension has somewhere to go.
    key: 'clock',
    name: 'Clock',
    bpm: 100,
    bpmClimb: 24,
    bass: [38, 38, 38, 38, 38, 38, 38, 38, 38, 38, 38, 38, 34, 35, 36, 37],
    bassWave: 'square',
    bassFilterHz: 220,
    bassSweepHz: 2200,
    bassQ: 9,
    kick: [0, 2],
    kickGain: 0.46,
    clap: [2],
    hatEighths: false,
    hatSixteenthsFrom: 0.5,
    openHatBar: null,
    tickEveryBeat: true,
    swing: 0,
  },
  {
    // The fast one. Hats from the first beat, a kick that pushes the "and" of
    // two, octave-jumping bass, and stabs early enough that the last ten
    // seconds are genuinely loud.
    key: 'chase',
    name: 'Chase',
    bpm: 128,
    bpmClimb: 22,
    bass: [36, 48, 36, 48, 34, 46, 34, 46, 36, 48, 39, 51, 38, 50, 36, 48],
    bassWave: 'sawtooth',
    bassFilterHz: 300,
    bassSweepHz: 3000,
    bassQ: 6,
    kick: [0, 1.5, 2, 3],
    kickGain: 0.44,
    clap: [1, 3],
    hatEighths: true,
    hatSixteenthsFrom: 0.2,
    openHatBar: 3,
    tickEveryBeat: false,
    swing: 0,
  },
  {
    // The light one, and the reason the rotation is worth having: an easy
    // question at the top of a round does not need a chase. Major, swung, a
    // walking bass in quarters, and stabs that only show up at the very end.
    key: 'parlor',
    name: 'Parlor',
    bpm: 108,
    bpmClimb: 18,
    bass: [36, 40, 43, 45, 36, 40, 43, 47, 38, 41, 45, 48, 43, 40, 38, 36],
    bassWave: 'triangle',
    bassFilterHz: 340,
    bassSweepHz: 1800,
    bassQ: 4,
    kick: [0, 2],
    kickGain: 0.34,
    clap: [1, 3],
    hatEighths: true,
    hatSixteenthsFrom: 2,
    openHatBar: null,
    tickEveryBeat: false,
    swing: 0.17,
  },
];

export const DEFAULT_BED_VARIANT = BED_VARIANTS[0]!;

export function bedVariantByKey(key: string | undefined): BedVariant {
  return BED_VARIANTS.find((v) => v.key === key) ?? DEFAULT_BED_VARIANT;
}

/** The wager is the one question the whole block has been walking towards. */
export const WAGER_BED_KEY = 'clock';

/**
 * How many questions into the night this one is, 1-based.
 *
 * Counting the night rather than the round is what makes the rotation hold at
 * a boundary. Mixing a round multiplier with a position used to land round two
 * on the bed round one had just finished on, which is the one place the repeat
 * is most audible: the room comes back from a break expecting something new.
 */
export function nightQuestionNumber(at: {
  game: number;
  round: number;
  position: number;
  roundsPerGame: number;
  questionsPerRound: number;
}): number {
  const game = Math.max(1, at.game);
  const round = Math.max(1, at.round);
  const rounds = Math.max(1, at.roundsPerGame);
  const perRound = Math.max(1, at.questionsPerRound);
  return ((game - 1) * rounds + (round - 1)) * perRound + Math.max(0, at.position);
}

/**
 * Which bed this question gets.
 *
 * Deterministic, and that is the whole point: the host page re-renders on
 * every tick and remounts on a reconnect, so a random pick would change the
 * music underneath a question the room is already answering. Every number it
 * reads is in the state both sides of a reconnect agree on.
 *
 * The counter steps by one per question for the whole night, so no two
 * questions in a row run the same bed — across a round break or a game break
 * included.
 */
export function pickBedVariant(at: {
  game: number;
  round: number;
  position: number;
  roundsPerGame: number;
  questionsPerRound: number;
  wager?: boolean;
}): BedVariant {
  if (at.wager) return bedVariantByKey(WAGER_BED_KEY);
  const n = BED_VARIANTS.length;
  // The night's first question gets the first bed in the table, which is the
  // one that was already tuned in the room. Opening a night on Clock, the
  // tense half-time one, is a strange first impression; it earns its place
  // later, and on the wager.
  const i = nightQuestionNumber(at) - 1;
  return BED_VARIANTS[((i % n) + n) % n]!;
}
