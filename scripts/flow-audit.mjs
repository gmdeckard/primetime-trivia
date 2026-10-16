#!/usr/bin/env node
/**
 * Plays a whole night, start to finish, with nobody touching it.
 *
 * The unit tests drive the engine a call at a time, and the screenshot pass
 * drives the UI a click at a time. Neither of them can see the failure this
 * script exists for: the night running out of road. A reveal that queues
 * nothing, a break whose clock never fires, a game that offers a fourth game
 * when three were scheduled — every one of those looks like a passing test and
 * a working screenshot, and like a dead screen in front of ninety people.
 *
 * So: one tap to start, then it watches. It photographs each phase the first
 * time it appears, answers on the handsets while a question is up, and fails
 * if the night has not reached `night_over` by the time it gives up.
 *
 *   npm run flow
 *   npm run flow -- docs/flow
 *
 * Needs playwright-core and a Chromium binary, same as `npm run screenshots`.
 * Point CHROME_PATH at one if the default Playwright location is not yours.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';

const out = process.argv[2] ?? join(tmpdir(), `primetime-flow-${Date.now()}`);
mkdirSync(out, { recursive: true });

const PORT = 8400 + Math.floor(Math.random() * 400);
const DATA = join(tmpdir(), `primetime-flow-data-${Date.now()}`);
const PASSWORD = `flow-${randomBytes(6).toString('hex')}`;
const server = spawn(process.execPath, ['dist/src/server/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    PRIMETIME_PASSWORD: PASSWORD,
    PRIMETIME_DATA: DATA,
    PRIMETIME_VENUE: 'Thursday Trivia',
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

/** Every phase a complete night must pass through, in order. */
const REQUIRED = ['Game intro', 'Round intro', 'Live', 'Locked', 'Answer up', 'Round over', 'Game over', 'Night over'];

let browser;
let failure;
try {
  const errors = [];
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    chromiumSandbox: false,
  });
  const watch = (page, label) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${label}: uncaught ${e.message}`));
    return page;
  };

  const host = watch(await browser.newPage({ viewport: { width: 1920, height: 1080 } }), 'host');
  await host.goto(`${BASE}/host`);

  const players = [];
  for (const name of ['The Snowbirds', 'Ace', 'Desert Rats']) {
    const p = watch(await browser.newPage({ viewport: { width: 375, height: 667 } }), name);
    await p.goto(BASE);
    await p.getByRole('button', { name: 'Just me' }).click();
    await p.locator('input').first().pressSequentially(name);
    await p.getByRole('button', { name: 'Join' }).click();
    players.push(p);
  }

  const mc = watch(await browser.newPage({ viewport: { width: 420, height: 900 } }), 'mc');
  await mc.goto(`${BASE}/control`);
  await mc.locator('input').first().pressSequentially(PASSWORD);
  await mc.getByRole('button', { name: 'Unlock' }).click();
  await mc.locator('.control-primary').waitFor();

  // A night small enough to play out in a couple of minutes, with every beat
  // still a real beat: two games, two rounds each, breaks short enough to
  // watch expire. The wager is off because betting is the one phase that is
  // meant to wait for the MC, and this script is testing what does not.
  await mc.evaluate(() => {
    const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'control', token: localStorage.getItem('primetime.controlToken') }));
      setTimeout(() => ws.send(JSON.stringify({ t: 'set_config', patch: {
        gamesPerNight: 2, roundsPerGame: 2, questionsPerRound: 2,
        roundBreakMinutes: 0.15, gameBreakMinutes: 0.25, introSeconds: 2,
        secondsPerQuestion: 4, revealDelaySeconds: 1, nextQuestionDelaySeconds: 2,
        finalWager: false, autoStartAfterBreak: true,
      } })), 150);
    };
  });
  await mc.waitForTimeout(700);

  const seen = new Set();
  // The one and only tap.
  await mc.locator('.control-primary').click();

  for (let i = 0; i < 400; i++) {
    const phase = await mc.evaluate(() => document.querySelector('.pill-brass')?.textContent ?? '');
    if (phase && !seen.has(phase)) {
      seen.add(phase);
      await host.waitForTimeout(350);
      const slug = phase.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await host.screenshot({ path: `${out}/${slug}-host.png`, animations: 'disabled' });
      await players[0].screenshot({ path: `${out}/${slug}-player.png`, animations: 'disabled' });
      console.log(`  ${phase}`);
    }
    if (phase === 'Live') {
      for (const [n, p] of players.entries()) await p.locator('.answer').nth(n % 4).click().catch(() => {});
    }
    if (phase === 'Night over') break;
    await mc.waitForTimeout(400);
  }

  const missed = REQUIRED.filter((p) => !seen.has(p));
  if (missed.length) {
    failure = `the night never reached: ${missed.join(', ')} — it stalled somewhere it queues nothing`;
  } else if (errors.length) {
    failure = `console errors: ${errors.join(' | ')}`;
  }
  console.log(`\n  ${seen.size} phases, screenshots in ${out}`);
  console.log(failure ? `  FAILED: ${failure}` : '  A whole night ran itself, from one tap.');
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGKILL');
  rmSync(DATA, { recursive: true, force: true });
}
if (failure) process.exit(1);
