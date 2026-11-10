#!/usr/bin/env node
/**
 * Watch every live clock for a whole question and fail if any of them moves.
 *
 * The falling score and the countdown are the only things on these screens
 * that change every second, so they are the only things whose SIZE must not.
 * They used to be one interpolated string in a flexible pill: as the numbers
 * lost a digit the pill narrowed, fitted beside the category, and snapped
 * back to one line — then the next tick pushed it to two again. Once a
 * second, for twenty seconds, on every question, four inches from a player's
 * face.
 *
 * Nothing in the unit tests or the screenshot pass can see this. A test
 * asserts about a value, and a screenshot is one instant; this is about the
 * same element at two instants being the same shape. So it is measured:
 * sample the bounding box of each clock on every tick of a real question on
 * all three screens, and fail if any width or height takes more than one
 * value.
 *
 *   npm run jitter
 *   SECS=120 PTS=5000 npm run jitter     the widest values an MC can set
 *
 * Needs playwright-core and a Chromium binary, same as `npm run screenshots`.
 */
import { chromium } from 'playwright-core';
import { seedHostToken } from './host-auth.mjs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';

const out = process.argv[2] ?? join(tmpdir(), `primetime-jitter-${Date.now()}`);
mkdirSync(out, { recursive: true });
const PORT = 8900 + Math.floor(Math.random() * 90);
const DATA = join(tmpdir(), `pt-jit-${Date.now()}`);
const PASSWORD = `j-${randomBytes(5).toString('hex')}`;
const server = spawn(process.execPath, ['dist/src/server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), PRIMETIME_PASSWORD: PASSWORD, PRIMETIME_DATA: DATA, PRIMETIME_VENUE: 'Thursday Trivia' },
  stdio: 'ignore',
});
const BASE = `http://localhost:${PORT}`;
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/info`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

let browser, bad = 0;
let hostAuth;
try {
  const errors = [];
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, chromiumSandbox: false });
  // The narrowest phone we support, where any wrap will show first.
  // The big screen comes up first, because a seat costs the room code and the
  // only place to read it is the host page — exactly as in the room.
  const big = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // The big screen carries the host password now, like the MC's phone.
  hostAuth = await seedHostToken(big, BASE, PASSWORD, hostAuth);
  await big.goto(`${BASE}/host`);
  const roomCode = (await big.locator('.join-code').innerText()).trim();
  if (!roomCode) throw new Error('no room code on the host screen — the join gate cannot be driven');

  const player = await browser.newPage({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });
  player.on('pageerror', e => errors.push(String(e.message)));
  await player.goto(BASE);
  await player.getByRole('button', { name: 'Just me' }).click();
  await player.locator('input').first().pressSequentially('Sam');
  await player.locator('input').nth(1).pressSequentially(roomCode);
  await player.getByRole('button', { name: 'Join' }).click();

  const mc = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await mc.goto(`${BASE}/control`);
  await mc.locator('input').first().pressSequentially(PASSWORD);
  await mc.getByRole('button', { name: 'Unlock' }).click();
  await mc.locator('.control-primary').waitFor();
  // A long answer window so the countdown runs through plenty of digit drops,
  // and the single longest category so the header is at its most cramped.
  // Config values must be passed IN: page.evaluate runs in the browser, where
  // process.env does not exist, and referencing it throws inside the page and
  // silently sends nothing.
  await mc.evaluate((patch) => {
    const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'control', token: localStorage.getItem('primetime.controlToken') }));
      setTimeout(() => ws.send(JSON.stringify({ t: 'set_config', patch })), 150);
    };
  }, {
    secondsPerQuestion: Number(process.env.SECS ?? 22),
    questionPoints: Number(process.env.PTS ?? 1000),
    minQuestionPoints: 200,
    roundCategoryMode: 'single',
    categories: ['film-tv'],
    questionsPerRound: 3,
    roundsPerGame: 1,
    finalWager: false,
    introSeconds: 0,
  });
  await mc.waitForTimeout(700);
  for (let i = 0; i < 3; i++) { await mc.locator('.control-primary').click(); await mc.waitForTimeout(400); }
  await player.locator('.answers').waitFor({ timeout: 10000 });

  const box = () => player.evaluate(() => {
    const head = document.querySelector('.qhead');
    const live = document.querySelector('.qhead-live');
    const cat = document.querySelector('.qhead-cat');
    if (!head || !live || !cat) return null;
    const r = live.getBoundingClientRect(), h = head.getBoundingClientRect(), c = cat.getBoundingClientRect();
    return { liveW: Math.round(r.width), liveH: Math.round(r.height), headH: Math.round(h.height),
             catH: Math.round(c.height), text: live.innerText.replace(/\s+/g, ' ').trim() };
  });

  const host = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  host.on('pageerror', e => errors.push('host: ' + String(e.message)));
  hostAuth = await seedHostToken(host, BASE, PASSWORD, hostAuth);
  await host.goto(`${BASE}/host`);
  await host.waitForTimeout(600);

  const otherBox = (page) => page.evaluate(() => {
    const el = document.querySelector('.qhead-live');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), text: el.innerText.replace(/\s+/g, ' ').trim() };
  });

  const hostSeen = [];
  const mcSeen = [];
  const seen = [];
  for (let i = 0; i < Number(process.env.SAMPLES ?? 46); i++) {
    const b = await box();
    if (b) seen.push(b);
    if (seen.length === 5) {
      await player.screenshot({ path: `${out}/mid-countdown.png` });
      const m = await player.evaluate(() => ({
        doc: document.documentElement.scrollHeight,
        vp: window.innerHeight,
        shell: Math.round(document.querySelector('.shell').getBoundingClientRect().width),
        cat: Math.round(document.querySelector('.qhead-cat').getBoundingClientRect().width),
        live: Math.round(document.querySelector('.qhead-live').getBoundingClientRect().width),
        catText: document.querySelector('.qhead-cat').innerText.replace(/\s+/g, ' '),
      }));
      console.log(`  page ${m.doc}px content / ${m.vp}px screen ${m.doc > m.vp ? `(scrolls ${m.doc - m.vp})` : '(fits)'}`);
      console.log(`  shell ${m.shell}px = category ${m.cat}px + clock ${m.live}px + gap`);
      console.log(`  category reads: "${m.catText}"`);
    }
    const hb = await otherBox(host); if (hb) hostSeen.push(hb);
    const mb = await otherBox(mc); if (mb) mcSeen.push(mb);
    await player.waitForTimeout(500);
    const phase = await mc.evaluate(() => document.querySelector('.pill-brass')?.textContent ?? '');
    if (phase !== 'Live') break;
  }

  const widths = [...new Set(seen.map(s => s.liveW))];
  const heights = [...new Set(seen.map(s => s.liveH))];
  const headHeights = [...new Set(seen.map(s => s.headH))];
  console.log(`  samples taken: ${seen.length}`);
  console.log(`  values shown:  ${seen[0]?.text}  ->  ${seen[seen.length - 1]?.text}`);
  console.log(`  clock pill width(s):   ${widths.join(', ')}  ${widths.length === 1 ? 'STABLE' : 'JITTERS'}`);
  console.log(`  clock pill height(s):  ${heights.join(', ')}  ${heights.length === 1 ? 'STABLE' : 'JITTERS'}`);
  console.log(`  whole header height(s):${headHeights.join(', ')}  ${headHeights.length === 1 ? 'STABLE' : 'JITTERS'}`);
  for (const [name, list] of [['big screen', hostSeen], ['MC phone', mcSeen]]) {
    const w = [...new Set(list.map(x => x.w))];
    const h = [...new Set(list.map(x => x.h))];
    console.log(`  ${name}: ${list[0]?.text} -> ${list[list.length - 1]?.text}`);
    console.log(`    width(s) ${w.join(', ')}  ${w.length === 1 ? 'STABLE' : 'JITTERS'} · height(s) ${h.join(', ')}  ${h.length === 1 ? 'STABLE' : 'JITTERS'}`);
    if (w.length > 1 || h.length > 1) bad++;
  }
  await host.screenshot({ path: `${out}/host-question.png` });
  await mc.screenshot({ path: `${out}/mc-question.png` });
  bad += (widths.length > 1 ? 1 : 0) + (heights.length > 1 ? 1 : 0) + (headHeights.length > 1 ? 1 : 0);
  await player.screenshot({ path: `${out}/header.png` });
  if (errors.length) { console.log('  page errors: ' + JSON.stringify(errors)); bad++; }
  console.log(bad ? `\n  FAILED: ${bad} clock(s) change size as they count.` : '\n  Every clock held its size for the whole question.');
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGKILL');
  rmSync(DATA, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
