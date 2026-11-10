import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import type { ClientMessage, PlayerState, ServerMessage, WatchState } from '../../shared/protocol.js';

/**
 * Boots the real server as a child process and drives it over websockets.
 *
 * The engine tests cover the rules; this covers the wiring — role gating, the
 * password, identity handoff and whether a state snapshot actually reaches a tablet.
 */

const PORT = 8411;
const PASSWORD = 'clubhouse-thursday-7';
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
  /** Server-side refusals. A gate that is never seen to refuse is not a gate. */
  errors: string[] = [];

  constructor() {
    this.socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.closed = new Promise((resolve) => this.socket.on('close', (code) => resolve(code)));
    this.socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      if (msg.t === 'identity') this.identity = { playerId: msg.playerId, token: msg.token };
      if (msg.t === 'error') this.errors.push(msg.message);
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

  /** Resolve on the first error message containing `needle`, past or future. */
  async nextError(needle: string, timeoutMs = 4000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.errors.find((m) => m.toLowerCase().includes(needle.toLowerCase()));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for error matching ${needle}`);
      await new Promise((r) => setTimeout(r, 25));
    }
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

  /**
   * How many snapshots this client has been sent.
   *
   * For the assertions that are about silence. A gate that refuses in words
   * and then pushes the game anyway has not refused anything, and the only way
   * to see that is to count what arrived.
   */
  get stateCount(): number {
    return this.states.length;
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
      PRIMETIME_PASSWORD: PASSWORD,
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

test('a wrong control password is rejected', async () => {
  const res = await fetch(`${BASE}/api/control/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'not-the-password' }),
  });
  assert.equal(res.status, 401);
});

test('a prefix of the password is rejected', async () => {
  // The old comparison padded both sides to 16 bytes and sliced, so anything
  // sharing the first 16 characters was accepted. This password is longer.
  const res = await fetch(`${BASE}/api/control/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD.slice(0, 16) }),
  });
  assert.equal(res.status, 401, 'matching the first 16 characters must not be enough');
});

test('a malformed login body is a refusal, not a crash', async () => {
  // The JSON parse in the login route is wrapped in a catch that is new in this
  // change. A tablet that posts junk, or an empty body from a flaky connection,
  // has to come back as a plain 401 rather than a 500 the MC cannot read.
  for (const body of ['', 'not json at all', '{"password":', '[]', 'null']) {
    const res = await fetch(`${BASE}/api/control/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(res.status, 401, `a body of ${JSON.stringify(body)} should be refused, not crash the server`);
  }
});

test('a control page cached before the rename still logs in', async () => {
  const res = await fetch(`${BASE}/api/control/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: PASSWORD }),
  });
  assert.equal(res.status, 200, 'the old `pin` field must still be accepted');
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
      body: JSON.stringify({ password: PASSWORD }),
    })
  ).json()) as { token: string }).token;

  const mc = new Client();
  await mc.open();
  mc.send({ t: 'hello', role: 'control', token });
  const mcState = await mc.next<{ role: string; roomCode: string }>(
    (s) => s.role === 'control',
    'control state',
  );
  const room = mcState.roomCode;
  assert.ok(room, 'the MC must be told the room code — it is what they read out');

  const ann = new Client();
  const bob = new Client();
  await ann.open();
  await bob.open();
  ann.send({ t: 'hello', role: 'player' });
  bob.send({ t: 'hello', role: 'player' });
  await ann.next<PlayerState>((s) => !!s.me?.playerId, 'ann identity');
  await bob.next<PlayerState>((s) => !!s.me?.playerId, 'bob identity');
  assert.ok(ann.identity?.token, 'a player should be handed a reconnect token');

  // The gate, end to end. A device that has not been seated is not told the
  // code, and guessing it does not work: this is the only thing standing
  // between a public hostname and a stranger on the scoreboard.
  const annLobby = await ann.next<PlayerState>((s) => s.phase === 'lobby', 'ann in the lobby');
  assert.equal(annLobby.roomCode, '', 'a seatless player must not be handed the room code');

  ann.send({ t: 'join', roomCode: 'not-the-code', name: 'Gatecrasher', kind: 'solo' });
  const refused = await ann.nextError('room code');
  assert.match(refused, /not right/i, 'the refusal should point at the big screen');
  const stillOut = await ann.next<PlayerState>((s) => s.phase === 'lobby', 'ann still seatless');
  assert.equal(stillOut.me.teamId, undefined, 'a wrong code must not seat anyone');

  ann.send({ t: 'join', roomCode: room, name: 'The Snowbirds', kind: 'team' });
  const seated = await ann.next<PlayerState>((s) => !!s.me.teamId, 'ann seated');
  assert.equal(seated.roomCode, room, 'once seated, a player can read the code to the next table');
  bob.send({ t: 'join', roomCode: room, name: 'Bob', kind: 'solo' });
  const bobSeated = await bob.next<PlayerState>((s) => !!s.me.teamId, 'bob seated');
  assert.notEqual(bobSeated.me.teamId, seated.me.teamId, 'each device is its own entry');

  // A player must not be able to drive the game, however they ask.
  bob.send({ t: 'advance' });
  await new Promise((r) => setTimeout(r, 200));
  const stillLobby = await ann.next<PlayerState>((s) => s.phase === 'lobby', 'still in the lobby');
  assert.equal(stillLobby.phase, 'lobby', 'a player should not be able to start the game');

  mc.send({ t: 'set_config', patch: { roundsPerGame: 1, questionsPerRound: 2, finalWager: false } });
  mc.send({ t: 'advance' }); // lobby -> game_intro
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

test('the question bank editor is closed without the host password', async () => {
  const res = await fetch(`${BASE}/api/author/context`);
  assert.equal(res.status, 401, 'an unauthenticated request must not see the editor');

  const bogus = await fetch(`${BASE}/api/author/context`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(bogus.status, 401, 'a made-up bearer token must not work either');

  // Generation is the expensive one; make sure it is behind the same gate.
  const generate = await fetch(`${BASE}/api/author/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audience: '35-75', category: 'geography', count: 5, difficulties: [2] }),
  });
  assert.equal(generate.status, 401, 'generation must not be callable without the password');
});

test('the editor reports honestly when there are no API credentials', async () => {
  const token = ((await (
    await fetch(`${BASE}/api/control/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
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

/*
 * Value: protects=the re-identify in index.ts flush(), which hands a new player
 *   record to any device still connected when the MC resets the night;
 *   fails_when=that block is removed — the phone is shown the join form (phase
 *   is lobby and it holds no team), types the new room code, and engine.join
 *   throws "unknown player", so the only way back in is reloading the page.
 *   That is the bug the first real night hit: every player in the room had to
 *   be told to refresh before game two;
 *   why_new=no test resets a night with a socket still open. The engine tests
 *   call resetNight() on an engine nobody is connected to, which is exactly the
 *   case that works; seam=none, this drives the built server over a real
 *   websocket;
 *   no_claim=says nothing about the host or control views across a reset, and
 *   nothing about what the browser does with the stale saved room code, which
 *   is client-side in useGame.ts.
 */
test('a player still connected through a night reset can rejoin without reloading', async () => {
  const token = ((await (
    await fetch(`${BASE}/api/control/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
  ).json()) as { token: string }).token;

  const mc = new Client();
  await mc.open();
  mc.send({ t: 'hello', role: 'control', token });
  const before = await mc.next<{ role: string; roomCode: string }>((s) => s.role === 'control', 'control state');

  const phone = new Client();
  await phone.open();
  phone.send({ t: 'hello', role: 'player' });
  await phone.next<PlayerState>((s) => !!s.me?.playerId, 'phone identity');
  const firstIdentity = phone.identity!;

  // Unique across the whole file: these tests share one server, so a name an
  // earlier test seated is still taken and join() would refuse this one.
  phone.send({ t: 'join', roomCode: before.roomCode, name: 'Reset Night Crew', kind: 'team' });
  await phone.next<PlayerState>((s) => !!s.me.teamId, 'seated on the first night');

  // The MC ends the night and starts a fresh one. The phone is in somebody's
  // pocket: it never reloads, and nobody touches it.
  mc.send({ t: 'reset_night' });
  const after = await mc.next<{ role: string; roomCode: string }>(
    (s) => s.role === 'control' && !!s.roomCode && s.roomCode !== before.roomCode,
    'a new room code',
  );

  // The server should have noticed the phone was orphaned and re-issued it.
  const reseated = await phone.next<PlayerState>((s) => s.phase === 'lobby' && !s.me.teamId, 'back at the join form');
  assert.equal(reseated.me.teamId, undefined, 'the old seat should not survive the reset');
  assert.notEqual(
    phone.identity!.playerId,
    firstIdentity.playerId,
    'an orphaned device must be handed a new identity, not left holding a dead one',
  );

  // Now the thing the room actually did: type the new code and tap Join.
  phone.send({ t: 'join', roomCode: after.roomCode, name: 'Reset Night Crew', kind: 'team' });
  const seatedAgain = await phone.next<PlayerState>((s) => !!s.me.teamId, 'seated on the second night');
  assert.equal(seatedAgain.me.teamName, 'Reset Night Crew', 'and they keep the name they typed');
  assert.deepEqual(phone.errors, [], 'no refusal should have been sent to a device that did nothing wrong');

  phone.close();
  mc.close();
});

/*
 * Value: protects=the watch door in index.ts — the room-code check on a `watch`
 *   hello, the `admitted` flag, and the `flush` guard that holds a snapshot
 *   back until it is set;
 *   fails_when=either half is dropped. Without the check, anyone who can reach
 *   the server watches the night; without the flush guard the refusal is words
 *   only, because the next flush pushes the whole game to a socket that was
 *   just told no — and a flush happens on every answer, so that window is
 *   every few seconds all night;
 *   why_new=no test opens a `watch` socket at all. The engine knows nothing
 *   about roles, and the existing gate test covers `join`, which is a
 *   different door with a different refusal path (`join` throws, this one
 *   answers and stays open on purpose);
 *   seam=none, this drives the built server over a real websocket;
 *   no_claim=says nothing about what the watch page renders, which is
 *   client-side in host.tsx and has no DOM test in this suite, and nothing
 *   about /api/info, which hands the room code to anyone who asks for it.
 */
test('watching costs the room code, and a wrong one is told nothing', async () => {
  const token = ((await (
    await fetch(`${BASE}/api/control/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
  ).json()) as { token: string }).token;

  const mc = new Client();
  await mc.open();
  mc.send({ t: 'hello', role: 'control', token });
  const room = (await mc.next<{ role: string; roomCode: string }>((s) => s.role === 'control', 'control state')).roomCode;

  // A stranger on the public hostname, guessing.
  const guesser = new Client();
  await guesser.open();
  guesser.send({ t: 'hello', role: 'watch', roomCode: 'not-the-code' });
  const refused = await guesser.nextError('room code');
  assert.match(refused, /not right/i, 'the refusal should point at the big screen');

  // And one that gives no code at all, which must not read as "no check".
  const silent = new Client();
  await silent.open();
  silent.send({ t: 'hello', role: 'watch' });
  await silent.nextError('room code');

  // Make the server flush to everyone it believes is watching. Without the
  // guard in flush() this is the moment both of the above receive the night.
  mc.send({ t: 'say', message: 'Testing the watch door' });
  await mc.next<{ role: string; message?: string }>((s) => s.message === 'Testing the watch door', 'the MC message');
  assert.equal(guesser.stateCount, 0, 'a refused watcher must never be sent a snapshot');
  assert.equal(silent.stateCount, 0, 'nor one that asked without a code');

  // The code off the big screen, typed the way a phone actually produces it.
  const watcher = new Client();
  await watcher.open();
  watcher.send({ t: 'hello', role: 'watch', roomCode: ` ${room.toLowerCase().replace('-', ' ')} ` });
  const seen = await watcher.next<WatchState>((s) => s.role === 'watch', 'the watch view');
  assert.equal(seen.roomCode, room, 'a watcher is in the room and can see its code');
  assert.equal(
    (seen as WatchState & { join?: unknown }).join,
    undefined,
    'the join panel is the big screen\'s job, not a watcher\'s',
  );
  assert.ok(Array.isArray(seen.teams), 'a watcher sees the room the way the big screen does');
  assert.deepEqual(watcher.errors, [], 'the right code, however typed, is not a refusal');

  // A watcher is not a player, and asking nicely does not change that.
  const before = seen.entryCount;
  watcher.send({ t: 'join', roomCode: room, name: 'Watching Not Playing', kind: 'team' });
  watcher.send({ t: 'answer', choiceIndex: 0 });
  watcher.send({ t: 'set_wager', amount: 1000 });
  await new Promise((r) => setTimeout(r, 250));
  mc.send({ t: 'say', message: 'Still nobody new' });
  const after = await watcher.next<WatchState>((s) => s.message === 'Still nobody new', 'a later snapshot');
  assert.equal(after.entryCount, before, 'a watch socket must not be able to take a seat');

  watcher.close();
  guesser.close();
  silent.close();
  mc.close();
});

/*
 * Value: protects=the wiring in index.ts that gives ControlAuth the data dir,
 *   which is what makes the password stable and the MC's session survive a
 *   restart;
 *   fails_when=`dir: DATA_DIR` is dropped from the ControlAuth construction in
 *   index.ts — every auth.test.ts case still passes, because they pass `dir`
 *   themselves, while the real server silently goes back to a new password and
 *   an empty token set on every boot, which is the exact thing this change
 *   exists to stop;
 *   why_new=no test starts the built server without PRIMETIME_PASSWORD, and
 *   none starts it twice against one data directory; seam=none;
 *   no_claim=says nothing about file permissions or about what happens when
 *   two servers share a data directory at the same time.
 */
test('the real server keeps its password and its sessions across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-restart-'));
  const port = 8413;
  const base = `http://127.0.0.1:${port}`;

  const boot = async () => {
    const child = spawn(process.execPath, ['dist/src/server/index.js'], {
      env: { ...process.env, PORT: String(port), PRIMETIME_DATA: dir, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/api/info`)).ok) return child;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    child.kill('SIGKILL');
    throw new Error('the server never came up');
  };
  const stop = async (child: ChildProcess) => {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  };

  try {
    // Nothing configured: the server has to make a password and write it down.
    let child = await boot();
    const file = join(dir, 'control-password');
    assert.ok(existsSync(file), 'an unconfigured box must save the password it generated');
    const password = readFileSync(file, 'utf8').trim();

    const first = await fetch(`${base}/api/control/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    assert.equal(first.status, 200, 'the password it wrote down has to be the one it accepts');
    const token = ((await first.json()) as { token: string }).token;
    await stop(child);

    // Same box, next night.
    child = await boot();
    assert.equal(readFileSync(file, 'utf8').trim(), password, 'the password must not change on a restart');
    const after = await fetch(`${base}/api/author/context`, { headers: { authorization: `Bearer ${token}` } });
    assert.notEqual(after.status, 401, 'and a restart must not send the MC back to the login screen');
    await stop(child);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
