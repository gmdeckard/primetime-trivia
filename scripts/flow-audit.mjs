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
import { seedHostToken } from './host-auth.mjs';
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
const REQUIRED = [
  'Game intro', 'Round intro', 'Live', 'Locked', 'Answer up', 'Round over',
  // The wager, unattended: the betting window has to open, close itself, and
  // hand on to the final question without the MC.
  'Wagers', 'Final', 'Final answer',
  'Game over', 'Night over',
];

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
  // The big screen carries the host password now, like the MC's phone.
  await seedHostToken(host, BASE, PASSWORD);
  await host.goto(`${BASE}/host`);

  // A seat costs the room code, and the only place to read it is the big
  // screen - exactly as in the room. Without this the Join button stays
  // disabled and every player here times out on it, which is how this script
  // had been failing since the gate landed.
  const roomCode = (await host.locator('.join-code').innerText()).trim();
  if (!roomCode) throw new Error('no room code on the host screen - the join gate cannot be driven');

  const players = [];
  for (const name of ['The Snowbirds', 'Ace', 'Desert Rats']) {
    const p = watch(await browser.newPage({ viewport: { width: 375, height: 667 } }), name);
    await p.goto(BASE);
    await p.getByRole('button', { name: 'Just me' }).click();
    // Two boxes on this form: the handle, then the code off the screen.
    await p.locator('input').nth(0).pressSequentially(name);
    await p.locator('input').nth(1).pressSequentially(roomCode);
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
  // watch expire, and the final wager ON with a short betting window. The
  // wager used to be excluded here because it was the one phase that waited
  // for a thumb; it is now the phase most worth covering, because a night
  // that runs itself has to get through it unattended.
  await mc.evaluate(() => {
    const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'control', token: localStorage.getItem('primetime.controlToken') }));
      setTimeout(() => ws.send(JSON.stringify({ t: 'set_config', patch: {
        gamesPerNight: 2, roundsPerGame: 2, questionsPerRound: 2,
        roundBreakMinutes: 0.15, gameBreakMinutes: 0.25, introSeconds: 2,
        secondsPerQuestion: 4, revealDelaySeconds: 1, nextQuestionDelaySeconds: 2,
        finalWager: true, wagerSeconds: 6, autoStartAfterBreak: true,
      } })), 150);
    };
  });
  await mc.waitForTimeout(700);

  const seen = new Set();
  const wording = [];

  /**
   * An opportunistic tap: click if it is there, carry on if it is not.
   *
   * The timeout is the whole point. Playwright waits 30 SECONDS by default
   * for an element to become clickable, and `.catch(() => {})` swallows the
   * eventual error without shortening the wait — so a tap aimed at a button
   * that has already gone, like "All in" after the betting window closes,
   * parks this loop for half a minute. Three phases went by inside one of
   * those, and the run reported them as a stall in the game. They were a
   * stall in the harness.
   */
  const tap = (locator) => locator.click({ timeout: 1000 }).catch(() => {});
  // The one and only tap.
  await mc.locator('.control-primary').click();

  // A wall-clock deadline, not an iteration count. Each new phase costs two
  // screenshots and two page reads, so "400 polls" was a budget that shrank
  // every time the night gained a beat — and when the final wager went in,
  // a run quietly ran out of polls before the end and reported it as a stall.
  const deadline = Date.now() + 8 * 60_000;
  // A blank reading means the MC page is not rendering — it crashed, or its
  // assets went out from under it because somebody rebuilt mid-run. Either
  // way the sampler is now blind, and a blind sampler reports "the night
  // never reached X" as though the game had stalled, which sends you looking
  // in the engine for a bug that is in the harness.
  let blind = 0;
  while (Date.now() < deadline) {
    const phase = await mc.evaluate(() => document.querySelector('.pill-brass')?.textContent ?? '');
    blind = phase ? 0 : blind + 1;
    if (blind === 12) {
      errors.push('the MC page stopped rendering — sampling is blind from here, so any missing phase below is unproven');
    }
    if (phase && !seen.has(phase)) {
      seen.add(phase);
      await host.waitForTimeout(350);
      const slug = phase.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await host.screenshot({ path: `${out}/${slug}-host.png`, animations: 'disabled' });
      await players[0].screenshot({ path: `${out}/${slug}-player.png`, animations: 'disabled' });

      // The hierarchy is Night > Game > Round > Question, and "block" is what
      // the middle layer used to be called. A bulk rename caught every
      // identifier and missed a line of prose on the wager screen, which then
      // sat on the big screen saying FINAL QUESTION OF THE BLOCK until a
      // screenshot was looked at. Since this script already visits every
      // phase on both screens, it may as well read them.
      for (const [who, page] of [['big screen', host], ['handset', players[0]]]) {
        const text = await page.evaluate(() => document.body.innerText);
        const stale = text.match(/\bblocks?\b/i);
        if (stale) wording.push(`${phase} / ${who}: "${stale[0]}"`);
      }
      console.log(`  ${phase}`);
    }
    if (phase === 'Live' || phase === 'Final') {
      for (const [n, p] of players.entries()) await tap(p.locator('.answer').nth(n % 4));
    }
    // One table bets, the others deliberately do not — a night has to survive
    // a table that simply never taps.
    if (phase === 'Wagers') {
      await tap(players[0].getByRole('button', { name: 'All in' }));
    }
    if (phase === 'Night over') break;
    await mc.waitForTimeout(400);
  }

  if (wording.length) {
    failure = `screens still say "block", which is not a word this game uses: ${wording.join(' · ')}`;
  }
  // Errors are reported whatever else went wrong. They used to be an `else`
  // branch after the missing-phases check, which is backwards: a page that
  // throws stops updating, so the sampling stalls and the run reports missing
  // phases — hiding the exception that actually caused it.
  if (errors.length) console.log(`\n  page errors:\n    ${errors.join('\n    ')}`);

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
