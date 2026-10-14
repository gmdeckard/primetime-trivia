#!/usr/bin/env node
/**
 * Open N devices against a throwaway server, have them all join and all answer,
 * and report what it costs on the wire.
 *
 *   npm run loadtest          # 100 devices
 *   npm run loadtest -- 250
 *
 * Exists because "how many people can this take" is a question about bandwidth
 * on a clubhouse access point, not about CPU, and the only honest way to answer
 * it is to measure. It is also how the per-role payload trimming was found: the
 * first run showed 26 MB going to players for a single question.
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = Number(process.argv[2] ?? 100);
const PORT = 8500 + Math.floor(Math.random() * 300);
const DATA = join(tmpdir(), `pt-load-${Date.now()}`);
const PIN = '424242';

const server = spawn(process.execPath, ['dist/src/server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), PRIMETIME_PIN: PIN, PRIMETIME_DATA: DATA },
  stdio: 'ignore',
});
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/api/info`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const BASE = `ws://localhost:${PORT}/ws`;
const stats = { playerBytes: 0, playerMsgs: 0, hostBytes: 0, hostMsgs: 0 };

function open(role, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BASE);
    ws.on('open', () => {
      ws.send(JSON.stringify(role === 'control' ? { t: 'hello', role, token } : { t: 'hello', role }));
      resolve(ws);
    });
    ws.on('message', (raw) => {
      const size = raw.length ?? String(raw).length;
      if (role === 'player') { stats.playerBytes += size; stats.playerMsgs += 1; }
      if (role === 'host') { stats.hostBytes += size; stats.hostMsgs += 1; }
    });
  });
}

console.log(`Opening ${N} player devices...`);
const t0 = Date.now();
const players = [];
for (let i = 0; i < N; i++) players.push(await open('player'));
const host = await open('host');

const token = (await (await fetch(`http://localhost:${PORT}/api/control/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }),
})).json()).token;
const mc = await open('control', token);
await new Promise((r) => setTimeout(r, 500));
console.log(`  connected in ${Date.now() - t0}ms`);

console.log(`Joining ${N} entries...`);
const tJoin = Date.now();
players.forEach((ws, i) => ws.send(JSON.stringify({ t: 'join', name: `Player ${i + 1}`, kind: i % 3 === 0 ? 'team' : 'solo' })));
await new Promise((r) => setTimeout(r, 3000));
console.log(`  joined in ~${Date.now() - tJoin}ms`);

// reset counters so we measure one question cleanly
stats.playerBytes = 0; stats.playerMsgs = 0; stats.hostBytes = 0; stats.hostMsgs = 0;

console.log('Running one question with everyone answering...');
mc.send(JSON.stringify({ t: 'set_config', patch: { autoAdvance: false } }));
await new Promise((r) => setTimeout(r, 300));
for (let i = 0; i < 3; i++) { mc.send(JSON.stringify({ t: 'advance' })); await new Promise((r) => setTimeout(r, 400)); }

const tAns = Date.now();
players.forEach((ws, i) => ws.send(JSON.stringify({ t: 'answer', choiceIndex: i % 4 })));
await new Promise((r) => setTimeout(r, 4000));
const answerMs = Date.now() - tAns;

mc.send(JSON.stringify({ t: 'advance' }));
await new Promise((r) => setTimeout(r, 1500));

const info = await (await fetch(`http://localhost:${PORT}/api/info`)).json();
console.log('');
console.log('──────────────────────────────────────────────');
console.log(`  entries              ${N}`);
console.log(`  all answered in      ${answerMs}ms (includes a 4s settle)`);
console.log(`  bytes to ALL players ${(stats.playerBytes / 1024).toFixed(0)} KB over ${stats.playerMsgs} messages`);
console.log(`  per player           ${(stats.playerBytes / N / 1024).toFixed(1)} KB`);
console.log(`  avg player message   ${(stats.playerBytes / Math.max(1, stats.playerMsgs)).toFixed(0)} bytes`);
console.log(`  bytes to host        ${(stats.hostBytes / 1024).toFixed(0)} KB over ${stats.hostMsgs} messages`);
console.log(`  avg host message     ${(stats.hostBytes / Math.max(1, stats.hostMsgs)).toFixed(0)} bytes`);
console.log('──────────────────────────────────────────────');

for (const ws of players) ws.close();
host.close(); mc.close();
server.kill('SIGKILL');
rmSync(DATA, { recursive: true, force: true });
