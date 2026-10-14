import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import type { ClientMessage, PlayerState, ServerMessage } from '../../shared/protocol.js';

/**
 * Boots the real server as a child process and drives it over websockets.
 *
 * The engine tests cover the rules; this covers the wiring — role gating, the
 * PIN, identity handoff and whether a state snapshot actually reaches a tablet.
 */

const PORT = 8411;
const PIN = '424242';
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dataDir: string;

/** A websocket wrapper that lets a test await the next state matching a predicate. */
class Client {
  private socket: WebSocket;
  private states: unknown[] = [];
  private waiters: Array<{ match: (s: never) => boolean; resolve: (s: never) => void }> = [];
  closed: Promise<number>;
  identity?: { playerId: string; token: string };

  constructor() {
    this.socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.closed = new Promise((resolve) => this.socket.on('close', (code) => resolve(code)));
    this.socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      if (msg.t === 'identity') this.identity = { playerId: msg.playerId, token: msg.token };
      if (msg.t !== 'state') return;
      this.states.push(msg.state);
      for (const waiter of this.waiters.slice()) {
        if (waiter.match(msg.state as never)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(msg.state as never);
        }
      }
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(msg: ClientMessage) {
    this.socket.send(JSON.stringify(msg));
  }

  /** Resolve on the first state — past or future — that matches. */
  next<S>(match: (state: S) => boolean, label = 'state'): Promise<S> {
    const existing = this.states.find((s) => match(s as S));
    if (existing) return Promise.resolve(existing as S);
    return new Promise<S>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 4000);
      this.waiters.push({
        match: match as never,
        resolve: ((s: S) => {
          clearTimeout(timer);
          resolve(s);
        }) as never,
      });
    });
  }

  close() {
    this.socket.close();
  }
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'primetime-integration-'));
  server = spawn(process.execPath, ['dist/src/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PRIMETIME_PIN: PIN,
      PRIMETIME_DATA: dataDir,
      // Pinned off so the no-credentials path is exercised deterministically,
      // whatever the developer has in their shell.
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
    },
    stdio: 'ignore',
  });
  // Poll until it answers rather than guessing at a sleep duration.
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/info`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up');
});

after(() => {
  server?.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
});

test('the join endpoint advertises a reachable URL and a QR code', async () => {
  const info = (await (await fetch(`${BASE}/api/info`)).json()) as { url: string; qrSvg: string; roomCode: string };
  assert.match(info.url, /^http:\/\/[\d.]+:\d+$/);
  assert.match(info.qrSvg, /^<svg/);
  assert.match(info.roomCode, /^[A-Z]+-\d$/);
});

test('a wrong control PIN is rejected', async () => {
  const res = await fetch(`${BASE}/api/control/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '000000' }),
  });
  assert.equal(res.status, 401);
});

test('the control socket is closed without a valid token', async () => {
  const client = new Client();
  await client.open();
  client.send({ t: 'hello', role: 'control', token: 'not-a-real-token' });
  const code = await client.closed;
  assert.equal(code, 4001, 'an unauthorised control client should be disconnected');
});

test('players join, answer, and the MC drives the night', async () => {
  const token = ((await (
    await fetch(`${BASE}/api/control/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: PIN }),
    })
  ).json()) as { token: string }).token;

  const mc = new Client();
  await mc.open();
  mc.send({ t: 'hello', role: 'control', token });
  await mc.next<{ role: string }>((s) => s.role === 'control', 'control state');

  const ann = new Client();
  const bob = new Client();
  await ann.open();
  await bob.open();
  ann.send({ t: 'hello', role: 'player' });
  bob.send({ t: 'hello', role: 'player' });
  await ann.next<PlayerState>((s) => !!s.me?.playerId, 'ann identity');
  await bob.next<PlayerState>((s) => !!s.me?.playerId, 'bob identity');
  assert.ok(ann.identity?.token, 'a player should be handed a reconnect token');

  ann.send({ t: 'join', name: 'The Snowbirds', kind: 'team' });
  const seated = await ann.next<PlayerState>((s) => !!s.me.teamId, 'ann seated');
  bob.send({ t: 'join', name: 'Bob', kind: 'solo' });
  const bobSeated = await bob.next<PlayerState>((s) => !!s.me.teamId, 'bob seated');
  assert.notEqual(bobSeated.me.teamId, seated.me.teamId, 'each device is its own entry');

  // A player must not be able to drive the game, however they ask.
  bob.send({ t: 'advance' });
  await new Promise((r) => setTimeout(r, 200));
  const stillLobby = await ann.next<PlayerState>((s) => s.phase === 'lobby', 'still in the lobby');
  assert.equal(stillLobby.phase, 'lobby', 'a player should not be able to start the game');

  mc.send({ t: 'set_config', patch: { roundsPerBlock: 1, questionsPerRound: 2, finalWager: false } });
  mc.send({ t: 'advance' }); // lobby -> block_intro
  mc.send({ t: 'advance' }); // -> round_intro
  mc.send({ t: 'advance' }); // -> question

  const question = await ann.next<PlayerState>((s) => s.phase === 'question', 'first question');
  assert.ok(question.question?.prompt, 'the player should receive the prompt');
  assert.equal(question.question?.choices?.length, 4);
  assert.equal(question.reveal, undefined, 'and must not receive the answer yet');
  assert.equal(question.teams.length, 0, 'players must not be sent the whole entry list');

  ann.send({ t: 'answer', choiceIndex: 1 });
  await ann.next<PlayerState>((s) => s.me.choiceIndex === 1, 'answer registered');

  // One device answering must not answer for anybody else.
  const bobView = await bob.next<PlayerState>((s) => s.phase === 'question', 'bob still on the question');
  assert.equal(bobView.me.choiceIndex, undefined, "another entry's answer leaked across devices");

  mc.send({ t: 'lock_now' });
  mc.send({ t: 'advance' }); // -> reveal
  const reveal = await ann.next<PlayerState>((s) => s.phase === 'reveal', 'reveal');
  assert.ok(reveal.reveal?.answerText, 'the reveal should name the answer');
  assert.ok(reveal.reveal?.funFact, 'and carry the fact that starts the conversation');

  for (const client of [mc, ann, bob]) client.close();
});

test('the question bank editor is closed without the host PIN', async () => {
  const res = await fetch(`${BASE}/api/author/context`);
  assert.equal(res.status, 401, 'an unauthenticated request must not see the editor');

  const bogus = await fetch(`${BASE}/api/author/context`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(bogus.status, 401, 'a made-up bearer token must not work either');

  // Generation is the expensive one; make sure it is behind the same gate.
  const generate = await fetch(`${BASE}/api/author/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audience: '55-75', category: 'geography', count: 5, difficulties: [2] }),
  });
  assert.equal(generate.status, 401, 'generation must not be callable without the PIN');
});

test('the editor reports honestly when there are no API credentials', async () => {
  const token = ((await (
    await fetch(`${BASE}/api/control/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: PIN }),
    })
  ).json()) as { token: string }).token;

  const context = (await (
    await fetch(`${BASE}/api/author/context`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as {
    credentials: boolean;
    categories: Array<{ id: string; count: number }>;
    models: Array<{ id: string }>;
    packs: unknown[];
  };

  // The test server runs without ANTHROPIC_API_KEY, so this must be false
  // rather than the screen pretending it can generate.
  assert.equal(context.credentials, false);
  assert.ok(context.categories.length > 10, 'the editor should offer every category');
  assert.ok(context.models.some((m) => m.id === 'claude-opus-5-5'));
  assert.ok(Array.isArray(context.packs));
});

test('a player reconnecting with their token keeps their seat', async () => {
  const first = new Client();
  await first.open();
  first.send({ t: 'hello', role: 'player' });
  await first.next<PlayerState>((s) => !!s.me?.playerId, 'identity');
  const identity = first.identity!;
  first.close();

  const again = new Client();
  await again.open();
  again.send({ t: 'hello', role: 'player', playerId: identity.playerId, token: identity.token });
  const state = await again.next<PlayerState>((s) => !!s.me?.playerId, 'resumed identity');
  assert.equal(state.me.playerId, identity.playerId, 'the same player id should come back');
  again.close();
});
