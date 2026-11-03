#!/usr/bin/env node
/**
 * Renders the question beds to mp3 so they can be judged on real speakers.
 *
 * A bed cannot be reviewed from the source and it cannot be reviewed on a
 * trivia night either: by then ninety people are in the room. So this writes
 * one file per bed plus a rotation medley, and you listen to them on the way
 * to work.
 *
 *   npm run beds              # docs/beds
 *   npm run beds -- /tmp/out  # anywhere else
 *
 * Nothing is streamed or downloaded. Every sample comes out of the project's
 * own synthesis, through `scheduleBeat` — the function the big screen calls on
 * every beat — rendered by Chromium's OfflineAudioContext because Web Audio is
 * the only synthesizer here and Node has none. The mp3s are therefore the beds
 * themselves, not a second implementation that might drift.
 *
 * Needs playwright-core, a Chromium binary (CHROME_PATH if it is not in the
 * Playwright cache) and lamejs, all devDependencies. The output is ignored by
 * git: it is regenerable, and binaries in history are what made .git 64MB.
 */
import { chromium } from 'playwright-core';
import { build } from 'vite';
import { createContext, runInContext } from 'node:vm';
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * lamejs, the long way round.
 *
 * Its npm entry point (`src/js/index.js`) throws `MPEGMode is not defined` on
 * Node 20: the sources are a Java port that was only ever loaded as a set of
 * browser scripts sharing one global. The package also ships the concatenated
 * bundle those scripts were meant to become, which works fine — it just wants
 * a `window` to hang itself off. So it gets one.
 */
function loadLamejs() {
  const require = createRequire(import.meta.url);
  const bundle = join(dirname(require.resolve('lamejs/package.json')), 'lame.min.js');
  const sandbox = {
    console, Math, Date, JSON, Error, isNaN, parseInt, parseFloat,
    Array, Object, String, Number, Boolean,
    Int16Array, Int32Array, Float32Array, Float64Array, Uint8Array, ArrayBuffer,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(bundle, 'utf8'), sandbox);
  if (typeof sandbox.lamejs?.Mp3Encoder !== 'function') {
    throw new Error(`lamejs did not load from ${bundle}`);
  }
  return sandbox.lamejs;
}

const lamejs = loadLamejs();

/** One question at the shipped clock, which is what the room will hear. */
const QUESTION_SECONDS = Number(process.env.BED_SECONDS ?? 20);
/** The gap in the medley, standing in for the reveal and the scoreboard. */
const MEDLEY_GAP = 1.5;
const KBPS = 160;

const out = resolve(process.argv[2] ?? 'docs/beds');
mkdirSync(out, { recursive: true });
const work = join(tmpdir(), `bed-render-${Date.now()}`);

/** Float32 mono to a 16-bit mp3. Peak-normalized headroom, no dynamics. */
function toMp3(samples, sampleRate) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const encoder = new lamejs.Mp3Encoder(1, sampleRate, KBPS);
  const chunks = [];
  const block = 1152;
  for (let i = 0; i < pcm.length; i += block) {
    const buf = encoder.encodeBuffer(pcm.subarray(i, i + block));
    if (buf.length) chunks.push(Buffer.from(buf));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}

function peak(samples) {
  let p = 0;
  for (const s of samples) p = Math.max(p, Math.abs(s));
  return p;
}

let browser;
try {
  // Bundled to one IIFE because a page cannot import TypeScript, and bundling
  // is also what proves the renderer and the big screen share the module.
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      outDir: work,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: resolve('scripts/bed-render-entry.ts'),
        formats: ['iife'],
        name: 'BedPreview',
        fileName: () => 'bed-preview.js',
      },
    },
  });

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    chromiumSandbox: false,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // about:blank refuses a script tag on some builds; a data document does not.
  await page.setContent('<!doctype html><title>bed render</title>');
  await page.addScriptTag({ path: join(work, 'bed-preview.js') });

  const beds = await page.evaluate(() => window.BedPreview.bedKeys());
  const jobs = [
    ...beds.map((b, i) => ({
      file: `${String(i + 1).padStart(2, '0')}-${b.key}.mp3`,
      label: `${b.name} — question ${i + 1} of the rotation, one ${QUESTION_SECONDS}s question`,
      call: `renderBed(${JSON.stringify(b.key)}, ${QUESTION_SECONDS})`,
    })),
    {
      file: '00-rotation.mp3',
      label: await page.evaluate(() => window.BedPreview.rotationOrder()),
      call: `renderRotation(${QUESTION_SECONDS}, ${MEDLEY_GAP})`,
    },
  ];

  // The palettes: the same bed, four candidate instrument kits plus today's,
  // in their own folder so they are not confused with the shipped beds.
  const palettes = await page.evaluate(() => window.BedPreview.paletteKeys());
  const paletteDir = join(out, 'palettes');
  mkdirSync(paletteDir, { recursive: true });
  palettes.forEach((p, i) => {
    jobs.push({
      file: join('palettes', `${String(i + 1).padStart(2, '0')}-${p.key}.mp3`),
      label: `${p.name}${p.reverb ? `, reverb ${p.reverb}` : ', dry'} — Think's groove`,
      call: `renderPalette(${JSON.stringify(p.key)}, ${QUESTION_SECONDS})`,
    });
  });
  // The diagnosis, as audio: the same bed before and after, both played
  // through a model of the speaker that cannot reproduce its bass.
  for (const [key, file, what] of [
    ['synth', '00-today-through-a-small-speaker.mp3', "today's bed"],
    ['vibes', '06-vibes-through-a-small-speaker.mp3', 'the vibraphone kit'],
  ]) {
    jobs.push({
      file: join('palettes', file),
      label: `${what}, heard through a laptop or phone speaker (nothing below 300Hz)`,
      call: `renderPalette(${JSON.stringify(key)}, ${QUESTION_SECONDS}, true)`,
    });
  }

  const rows = []; 
  for (const job of jobs) {
    const r = await page.evaluate(`window.BedPreview.${job.call}`);
    const samples = new Float32Array(Buffer.from(r.pcm, 'base64').buffer.slice(0));
    const p = peak(samples);
    // A render that came back silent is the failure this script is most
    // likely to hit, and an mp3 of silence looks like a success on disk.
    if (!(p > 0.005)) throw new Error(`${job.file} rendered silent (peak ${p.toFixed(5)})`);
    const mp3 = toMp3(samples, r.sampleRate);
    writeFileSync(join(out, job.file), mp3);
    rows.push({
      file: job.file,
      seconds: samples.length / r.sampleRate,
      peak: p,
      kb: statSync(join(out, job.file)).size / 1024,
      label: job.label,
    });
  }

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);

  console.log(`\n  ${out}\n`);
  for (const r of rows.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(
      `  ${r.file.padEnd(16)} ${r.seconds.toFixed(1).padStart(5)}s  ${r.kb.toFixed(0).padStart(4)}KB  peak ${r.peak.toFixed(3)}  ${r.label}`,
    );
  }
  console.log('');
} finally {
  await browser?.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
