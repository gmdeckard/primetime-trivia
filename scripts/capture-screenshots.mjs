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
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !/Connecting to tonight|Starting up/.test(document.body.innerText), { timeout: 15000 });
    return page;
  }

  const pause = (p, ms = 600) => p.waitForTimeout(ms);
  const press = async (p, text) => {
    await p.locator('input').first().waitFor({ state: 'visible', timeout: 10000 });
    await p.locator('input').first().pressSequentially(text, { delay: 15 });
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
    await tap(page, 'Join');
    await pause(page, 700);
    return page;
  }

  const host = await open('host', '/host', 1920, 1080, 1);
  await shoot(host, '01-host-lobby');

  // --- players arrive
  const ann = await open('ann', '/', 420, 900);
  await shoot(ann, '02-player-solo-or-team');
  await tap(ann, 'A team on this device');
  await pause(ann, 400);
  await press(ann, 'The Snowbirds');
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
  await mc.locator('.control-sticky > button').waitFor({ state: 'visible', timeout: 10000 });
  await pause(mc, 900);
  await shoot(mc, '06-control-setup');

  for (let i = 0; i < 3; i++) {
    await mc.locator('.control-sticky > button').click();
    await pause(mc, 700);
  }
  await pause(host, 900);
  await shoot(host, '07-host-question');
  await shoot(ann, '08-player-question');
  await shoot(mc, '09-control-question');

  // --- answers come in
  await ann.locator('.answer').nth(1).click();
  await pause(ann, 600);
  await shoot(ann, '10-player-answered');
  await shoot(bob, '11-partner-sees-the-answer');
  await carol.locator('.answer').nth(0).click();
  await pause(host, 700);
  await shoot(host, '12-host-answers-arriving');

  // --- reveal
  await mc.locator('.control-sticky > button').click();
  await pause(mc, 700);
  await mc.locator('.control-sticky > button').click();
  await pause(host, 1100);
  await shoot(host, '13-host-reveal');
  await shoot(ann, '14-player-reveal');

  // The big screen hands the last seconds of the gap over to the scoreboard.
  await pause(host, 6500);
  await shoot(host, '15-host-standings-gap');

  // --- run the round out to a scoreboard
  for (let i = 0; i < 40; i++) {
    const phase = await mc.evaluate(() => document.querySelector('.pill-brass')?.textContent ?? '');
    if (phase.includes('round scores')) break;
    if (phase.includes('question')) {
      await ann.locator('.answer').nth(0).click().catch(() => {});
      await carol.locator('.answer').nth(1).click().catch(() => {});
      await dave.locator('.answer').nth(2).click().catch(() => {});
      await pause(mc, 250);
    }
    await mc.locator('.control-sticky > button').click();
    await pause(mc, 420);
  }
  await pause(host, 900);
  await shoot(host, '16-host-scoreboard');
  await shoot(ann, '17-player-standings');

  console.log('CONSOLE_ERRORS=' + JSON.stringify(errors, null, 1));

} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGKILL');
  rmSync(DATA, { recursive: true, force: true });
}
