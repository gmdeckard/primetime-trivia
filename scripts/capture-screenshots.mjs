#!/usr/bin/env node
/**
 * Plays a short game against a throwaway server and screenshots every screen.
 *
 * This is how the README images are produced, and it doubles as a smoke test
 * of the real UI: it fails loudly if a button moves or a phase stops
 * rendering, which unit tests cannot see.
 *
 *   npm run screenshots
 *
 * Needs playwright-core and a Chromium binary. Point CHROME_PATH at one if the
 * default Playwright location is not where yours lives.
 */
import { chromium } from 'playwright-core';
import { seedHostToken } from './host-auth.mjs';
import { mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'docs/screenshots';
mkdirSync(out, { recursive: true });

// The capture owns its own server on a private port and data directory, so a
// rerun always starts from an empty lobby.
const PORT = 8200 + Math.floor(Math.random() * 600);
const DATA = join(tmpdir(), `primetime-shots-${Date.now()}`);
// Made up per run rather than written here, so the repository never carries a
// string that reads like a host password.
const PASSWORD = `shots-${randomBytes(6).toString('hex')}`;
const server = spawn(process.execPath, ['dist/src/server/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    PRIMETIME_PASSWORD: PASSWORD,
    PRIMETIME_VENUE: 'Thursday Trivia',
    PRIMETIME_SSID: 'Clubhouse-Guest',
    PRIMETIME_DATA: DATA,
  },
  stdio: 'ignore',
});
const BASE = `http://localhost:${PORT}`;
let up = false;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${BASE}/api/info`)).ok) { up = true; break; } } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
if (!up) { server.kill('SIGKILL'); throw new Error(`server never came up on ${PORT}`); }
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });

let browser;
try {
  const errors = [];
  // One login shared by every host window this script opens.
  let hostAuth;
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    // Many Linux distros now block unprivileged user namespaces, which breaks
    // Chromium's sandbox. This only ever renders our own localhost pages.
    chromiumSandbox: false,
  });

  async function open(label, path, w, h, scale = 2) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${label}: uncaught ${e.message}`));
    // The big screen asks for the host password now. Seeded only for /host:
    // /control's own login is one of the screenshots this script takes.
    if (path.startsWith('/host')) hostAuth = await seedHostToken(page, BASE, PASSWORD, hostAuth);
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !/Connecting to tonight|Starting up/.test(document.body.innerText), { timeout: 15000 });
    return page;
  }

  /**
   * The width a watch screen is actually read at.
   *
   * The big screen's layout is written against 1920x1080 and `/watch` serves
   * the same bundle to a phone, so this is the one screen in the game whose
   * layout nothing else checks. A capture at 390px is what catches it going
   * back to a TV scale: everything here fit one screenful when it was written,
   * and a shot that needs scrolling to reach the answers is the regression.
   */
  const PHONE = { width: 390, height: 844 };

  const pause = (p, ms = 600) => p.waitForTimeout(ms);
  const press = async (p, text) => {
    await p.locator('input').first().waitFor({ state: 'visible', timeout: 10000 });
    await p.locator('input').first().pressSequentially(text, { delay: 15 });
  };
  /** Type into the nth input. The join form is a handle plus the room code. */
  const pressNth = async (p, i, text) => {
    const input = p.locator('input').nth(i);
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.pressSequentially(text, { delay: 15 });
  };
  const tap = async (p, name) => {
    const b = p.getByRole('button', { name });
    try {
      await b.waitFor({ state: 'visible', timeout: 10000 });
    } catch (err) {
      console.log('TAP FAILED for', String(name));
      console.log('  body:', (await p.innerText('body')).replace(/\n+/g, ' | ').slice(0, 400));
      console.log('  buttons:', JSON.stringify(await p.locator('button').allInnerTexts()));
      throw err;
    }
    await b.click();
  };
  async function shoot(page, name) {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null)).catch(() => {});
    await page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled', caret: 'hide', timeout: 20000 });
    console.log(`  ${name}`);
  }

  /** One device, one entry: pick solo or team, then type a handle. */
  async function seat(label, handle, kind = 'solo') {
    const page = await open(label, '/', 420, 900);
    await tap(page, kind === 'team' ? 'A team on this device' : 'Just me');
    await pause(page, 400);
    await press(page, handle);
    await pressNth(page, 1, roomCode);
    await tap(page, 'Join');
    await pause(page, 700);
    return page;
  }

  const host = await open('host', '/host', 1920, 1080, 1);
  await shoot(host, '01-host-lobby');

  // Read the gate off the big screen, exactly as a player in the room does.
  // Each page gets its own context, so every device types it for itself.
  const roomCode = (await host.locator('.join-code').innerText()).trim();
  if (!roomCode) throw new Error('no room code on the host screen — the join gate cannot be driven');

  // --- players arrive
  const ann = await open('ann', '/', 420, 900);
  await shoot(ann, '02-player-solo-or-team');
  await tap(ann, 'A team on this device');
  await pause(ann, 400);
  await press(ann, 'The Snowbirds');
  await pressNth(ann, 1, roomCode);
  await tap(ann, 'Join');
  await pause(ann, 700);
  await shoot(ann, '03-player-seated');

  const bob = await seat('bob', 'Ace', 'solo');
  const carol = await seat('carol', 'Desert Rats', 'team');
  const dave = await seat('dave', 'Roadrunner', 'solo');
  await pause(host, 900);
  await shoot(host, '04-host-lobby-filling');

  // --- the MC takes over
  const mc = await open('control', '/control', 420, 900);
  await shoot(mc, '05-control-login');
  await press(mc, PASSWORD);
  await tap(mc, 'Unlock');
  await mc.locator('.control-primary').waitFor({ state: 'visible', timeout: 10000 });
  await pause(mc, 900);
  await shoot(mc, '06-control-setup');

  for (let i = 0; i < 3; i++) {
    await mc.locator('.control-primary').click();
    await pause(mc, 700);
  }
  await pause(host, 900);
  await shoot(host, '07-host-question');
  await shoot(ann, '08-player-question');
  await shoot(mc, '09-control-question');

  // The same question as somebody who is not playing sees it. Opened now
  // rather than in the lobby because an empty watch screen proves nothing
  // about the layout — a question with four answers on it is the hard case.
  const watcher = await open('watch', '/watch', PHONE.width, PHONE.height);
  await press(watcher, roomCode);
  await tap(watcher, 'Watch');
  await pause(watcher, 900);
  await shoot(watcher, '07b-watch-question');

  // --- answers come in
  await ann.locator('.answer').nth(1).click();
  await pause(ann, 600);
  await shoot(ann, '10-player-answered');
  await shoot(bob, '11-partner-sees-the-answer');
  await carol.locator('.answer').nth(0).click();
  await pause(host, 700);
  await shoot(host, '12-host-answers-arriving');

  // --- reveal
  await mc.locator('.control-primary').click();
  await pause(mc, 700);
  await mc.locator('.control-primary').click();
  await pause(host, 1100);
  await shoot(host, '13-host-reveal');
  await shoot(ann, '14-player-reveal');

  // The big screen hands the last seconds of the gap over to the scoreboard,
  // with the run-up to the next question above it; the handset switches to the
  // same run-up at the same moment.
  await pause(host, 6500);
  await shoot(host, '15-host-standings-gap');
  await shoot(ann, '15b-player-next-up');

  // --- run the round out to a scoreboard
  for (let i = 0; i < 40; i++) {
    const phase = await mc.evaluate(() => document.querySelector('.pill-brass')?.textContent ?? '');
    if (phase.includes('Round over')) break;
    if (phase.includes('Question live')) {
      await ann.locator('.answer').nth(0).click().catch(() => {});
      await carol.locator('.answer').nth(1).click().catch(() => {});
      await dave.locator('.answer').nth(2).click().catch(() => {});
      await pause(mc, 250);
    }
    await mc.locator('.control-primary').click();
    await pause(mc, 420);
  }
  await pause(host, 900);
  await shoot(host, '16-host-scoreboard');
  await shoot(ann, '17-player-standings');
  await shoot(mc, '18-control-break');

  // The settings page, which is where the MC sets the shape of the night. Each
  // section opened in turn, because a closed accordion in a screenshot tells
  // you nothing about what is in it.
  await tap(mc, 'Setup');
  await pause(mc, 400);
  for (const [name, shot] of [
    ['Shape of the night', '19-control-setup-shape'],
    ['Timing', '20-control-setup-timing'],
    ['Scoring', '21-control-setup-scoring'],
    ['Sound and speech', '22-control-setup-sound'],
    ['Questions', '23-control-setup-questions'],
  ]) {
    // Match the title, not the head: the head carries a summary too, and
    // "Shape of the night · 3 games x 2 rounds x 10 questions" answers to
    // hasText 'Questions', so every later section screenshotted the shape.
    const head = mc
      .locator('.section-head')
      .filter({ has: mc.locator('.section-title', { hasText: new RegExp(`^${name}$`) }) })
      .first();
    await head.click();
    await pause(mc, 350);
    // Without this the shot is the top of the page every time, and the
    // section the file is named after is somewhere below the fold.
    await head.scrollIntoViewIfNeeded();
    await pause(mc, 250);
    await shoot(mc, shot);
  }

  // The question sets sit below the age groups and are the part of that
  // section an MC actually has to decide about, so they get their own shot.
  const sets = mc.locator('.field-label', { hasText: 'Question sets' }).first();
  if (await sets.count()) {
    await sets.scrollIntoViewIfNeeded();
    await pause(mc, 250);
    await shoot(mc, '24-control-setup-sets');
  }

  console.log('CONSOLE_ERRORS=' + JSON.stringify(errors, null, 1));

} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGKILL');
  rmSync(DATA, { recursive: true, force: true });
}
