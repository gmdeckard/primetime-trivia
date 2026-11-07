#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import QRCode from 'qrcode';
import { MIN_PASSWORD, type ClientMessage, type GameConfig, type ServerMessage } from '../../shared/protocol.js';
import { handleAuthorRoute } from './author-routes.js';
import { loadBank } from './content.js';
import { DraftStore } from './drafts.js';
import { Engine, type NightState } from './engine.js';
import { ControlAuth, createRequestHandler } from './http.js';
import { lanAddresses, isWsl, hasNoReachableAddress, hasOnlyUnusableAddresses } from './lan.js';
import { joinTargets, normalizePublicUrl, wifiInfo } from './join.js';
import { Store } from './store.js';
import { controlState, hostState, playerState } from './views.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Find the project root by walking up to the nearest package.json.
 *
 * The compiled layout (dist/src/server) and the tsx layout (src/server) sit at
 * different depths, and hard-coding either one breaks the other. Walking up is
 * dull and correct.
 */
function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from, '../..');
}
const root = findRoot(here);

const PORT = Number(process.env.PORT ?? 8080);
// Unset means every interface, which is what a laptop on the venue LAN needs.
// Behind a TLS proxy set this to 127.0.0.1, or the plain-HTTP port stays
// reachable from outside alongside the HTTPS one and the control password
// crosses the internet in the clear on that path.
const BIND = process.env.PRIMETIME_BIND?.trim() || undefined;
const PUBLIC_URL = normalizePublicUrl(process.env.PRIMETIME_PUBLIC_URL);
const CONTENT_DIR = process.env.PRIMETIME_CONTENT ?? join(root, 'content');
const DATA_DIR = process.env.PRIMETIME_DATA ?? join(root, 'data');
const CLIENT_DIR = join(root, 'dist', 'client');

let bank = loadBank(CONTENT_DIR);
const store = new Store(DATA_DIR);
const drafts = new DraftStore(DATA_DIR);
const auth = new ControlAuth({
  password: process.env.PRIMETIME_PASSWORD,
  legacyPin: process.env.PRIMETIME_PIN,
  dir: DATA_DIR,
});

const errors = bank.issues.filter((i) => i.severity === 'error');
const warnings = bank.issues.filter((i) => i.severity === 'warning');
if (errors.length) {
  console.error(`\n  ${errors.length} content error(s):`);
  for (const issue of errors.slice(0, 20)) {
    console.error(`    ${issue.file}${issue.id ? ` [${issue.id}]` : ''}: ${issue.message}`);
  }
  if (errors.length > 20) console.error(`    ... and ${errors.length - 20} more`);
  if (!bank.questions.length) {
    // Repeat the first error at the bottom. The MC is looking at a tail of a
    // log twenty minutes before a night starts, and the line that explains
    // the failure is the one furthest from where their eye is.
    const first = errors[0];
    console.error('\n  No questions loaded, so there is no game to run.');
    if (first) {
      console.error(`  The first error, which is usually the only one that matters:`);
      console.error(`    ${first.file}${first.id ? ` [${first.id}]` : ''}: ${first.message}`);
    }
    console.error(`  Content was read from ${CONTENT_DIR}`);
    console.error('  Fix that, then start again.\n');
    process.exit(1);
  }
}

const config: Partial<GameConfig> = {};
if (process.env.PRIMETIME_VENUE) config.venueName = process.env.PRIMETIME_VENUE;

const resumed = store.loadNight<NightState>();
const engine = new Engine(bank, store, config, resumed);
if (resumed) console.log(`  Resumed the night already in progress (room ${engine.snapshot().roomCode}).`);

// ------------------------------------------------------------------ sockets

type Role = 'player' | 'host' | 'control';

interface Client {
  socket: WebSocket;
  role: Role;
  playerId?: string;
  /** Last payload this client received, so we can skip sending it again. */
  lastSent?: string;
}

const clients = new Set<Client>();

function joinInfo() {
  const targets = joinTargets({ publicUrl: PUBLIC_URL.url, lan: lanAddresses(), port: PORT });
  return {
    url: targets.url,
    urls: targets.urls,
    isPublic: targets.isPublic,
    ...wifiInfo(),
    roomCode: engine.snapshot().roomCode,
    venueName: engine.snapshot().config.venueName,
  };
}

let cachedQr = { url: '', svg: '' };
async function qrForJoinUrl(url: string): Promise<string> {
  if (cachedQr.url === url) return cachedQr.svg;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 4, errorCorrectionLevel: 'Q' });
  cachedQr = { url, svg };
  return svg;
}

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

async function stateFor(client: Client) {
  if (client.role === 'host') {
    const info = joinInfo();
    return hostState(engine, {
      url: info.url,
      ssid: info.ssid,
      ssidAlt: info.ssidAlt,
      wifiPassword: info.wifiPassword,
      qrSvg: await qrForJoinUrl(info.url),
    });
  }
  if (client.role === 'control') return controlState(engine);
  return playerState(engine, client.playerId!);
}

/**
 * Push state to everyone who needs it.
 *
 * Two things keep this affordable at a hundred devices.
 *
 * Coalescing: a burst of answers arrives as a burst of separate socket
 * messages, each of which would otherwise trigger its own full push to every
 * device. A short window collapses them into one.
 *
 * Deduplication: a player's own screen does not change when somebody else
 * answers, so there is nothing to send them. Comparing against what they last
 * received turns the answer flood from "every device hears about every answer"
 * into "every device hears about its own". Measured on 100 entries answering
 * one question, that is the difference between 26 MB and a few hundred KB.
 */
const COALESCE_MS = 60;
let pending: NodeJS.Timeout | undefined;

async function flush() {
  pending = undefined;
  for (const client of clients) {
    if (client.role === 'player' && !client.playerId) continue;
    if (client.socket.readyState !== client.socket.OPEN) continue;
    const payload = JSON.stringify({ t: 'state', state: await stateFor(client) });
    if (payload === client.lastSent) continue;
    client.lastSent = payload;
    client.socket.send(payload);
  }
}

function broadcast() {
  if (pending) return;
  pending = setTimeout(() => void flush(), COALESCE_MS);
}

engine.onChange(broadcast);

/** Re-read content from disk, e.g. after a pack is published from /author. */
function reloadBank() {
  const fresh = loadBank(CONTENT_DIR);
  const errors = fresh.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    return { ok: false, message: `Not reloaded — ${errors.length} content error(s). Run \`npm run validate\`.` };
  }
  const result = engine.replaceBank(fresh);
  if (result.ok) bank = fresh;
  return result;
}

const server = createServer(createRequestHandler({
  clientDir: CLIENT_DIR,
  imagesDir: join(CONTENT_DIR, 'images'),
  auth,
  joinInfo,
  handleAuthor: (req, res, path) =>
    handleAuthorRoute(req, res, path, {
      contentDir: CONTENT_DIR,
      drafts,
      bank: () => bank,
      reloadBank,
      authorised: (request) => auth.validRequest(request as unknown as { headers: Record<string, unknown> }),
    }),
}));

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  const client: Client = { socket, role: 'player' };
  clients.add(client);
  let ready = false;

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }

    try {
      if (msg.t === 'hello') {
        client.role = msg.role;
        if (msg.role === 'control' && !auth.valid(msg.token)) {
          send(socket, { t: 'error', message: 'Control view needs the host password.' });
          socket.close(4001, 'unauthorized');
          return;
        }
        if (msg.role === 'player') {
          const player = engine.identify(msg.playerId, msg.token);
          client.playerId = player.id;
          send(socket, { t: 'identity', playerId: player.id, token: player.token });
        }
        ready = true;
        void stateFor(client).then((state) => {
          const payload = JSON.stringify({ t: 'state', state });
          client.lastSent = payload;
          if (socket.readyState === socket.OPEN) socket.send(payload);
        });
        return;
      }

      if (!ready) return;

      // Everything below mutates the game; control messages need the gate.
      const controlOnly = new Set<ClientMessage['t']>([
        'set_config', 'start_game', 'advance', 'reveal', 'lock_now', 'extend_timer',
        'skip_question', 'replace_question', 'adjust_score', 'rename_team', 'remove_team',
        'set_round_category', 'start_tiebreak', 'end_night', 'reset_night', 'say', 'hold',
      ]);
      if (controlOnly.has(msg.t) && client.role !== 'control') return;

      switch (msg.t) {
        case 'join': engine.join(client.playerId!, msg.name, msg.kind, msg.tableNo); break;
        case 'leave': engine.leave(client.playerId!); break;
        case 'answer': engine.answer(client.playerId!, msg.choiceIndex); break;
        case 'answer_number': engine.answerNumber(client.playerId!, msg.value); break;
        case 'set_wager': engine.setWager(client.playerId!, msg.amount); break;

        case 'set_config': engine.setConfig(msg.patch); break;
        case 'start_game': engine.startGame(); break;
        case 'advance': engine.advance(); break;
        case 'reveal': engine.reveal(); break;
        case 'lock_now': engine.lockNow('host'); break;
        case 'extend_timer': engine.extendTimer(msg.seconds); break;
        case 'skip_question': engine.skipQuestion(); break;
        case 'replace_question': engine.replaceQuestion(); break;
        case 'adjust_score': engine.adjustScore(msg.teamId, msg.delta, msg.note); break;
        case 'rename_team': engine.renameTeam(msg.teamId, msg.name); break;
        case 'remove_team': engine.removeTeam(msg.teamId); break;
        case 'set_round_category': engine.setRoundCategory(msg.roundIndex, msg.categoryId); break;
        case 'hold': engine.setHeld(msg.held); break;
        case 'start_tiebreak': engine.startTiebreak(); break;
        case 'end_night': engine.endNight(); break;
        case 'reset_night': engine.resetNight(); break;
        case 'say': engine.say(msg.message); break;
      }
    } catch (err) {
      send(socket, { t: 'error', message: (err as Error).message });
    }
  });

  socket.on('close', () => {
    clients.delete(client);
    if (client.playerId) engine.setConnected(client.playerId, false);
  });

  socket.on('error', () => clients.delete(client));
});

// Keep the connection warm through a long gap. This pings; it deliberately
// does NOT reap. A ten-minute break is an idle big screen and an idle MC
// phone, and a screen that gets closed for being quiet looks to the room like
// the app crashed. The cost is that a tablet carried out of the building
// stays on the roster until its socket actually drops.
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (client.socket.readyState === client.socket.OPEN) client.socket.ping();
  }
}, 20_000);

/** The bare hosts out of the join URLs, for the reachability checks below. */
function hostsFromUrls(urls: string[]): string[] {
  return urls.map((u) => u.replace(/^https?:\/\//, '').split(':')[0] ?? '');
}

server.listen(PORT, BIND, () => {
  const info = joinInfo();
  const line = '─'.repeat(52);
  console.log(`\n  ${engine.snapshot().config.venueName}`);
  console.log(`  ${line}`);
  console.log(`  Players join at   ${info.url}`);
  for (const alt of info.urls.filter((u) => u !== info.url)) console.log(`                    ${alt}`);
  // Inside the `Players join at` ... `Question editor` range on purpose: that
  // is the slice start-server.sh lifts out of the log for its own banner.
  if (info.ssid) {
    const alt = info.ssidAlt ? ` or ${info.ssidAlt}` : '';
    const pw = info.wifiPassword ? ` · password ${info.wifiPassword}` : '';
    console.log(`  Wifi              ${info.ssid}${alt}${pw}`);
  }
  console.log(`  Big screen        ${info.url}/host`);
  console.log(`  MC controls       ${info.url}/control`);
  console.log(`  Question editor   ${info.url}/author`);
  // Printed only when the server made it up, because that is the one case
  // where nobody can look it up anywhere else. stdout lands in server.log and
  // in the journal, and this credential no longer expires at the next boot the
  // way the old per-boot PIN did, so echoing a password the operator already
  // chose just copies it somewhere easier to read.
  if (auth.generated) {
    console.log(`  Host password     ${auth.password}`);
  } else if (auth.fromLegacyPin) {
    console.log(`  Host password     (from PRIMETIME_PIN)`);
  } else {
    console.log(`  Host password     (as configured)`);
  }
  console.log(`  Room code         ${engine.snapshot().roomCode}`);
  console.log(`  ${line}`);
  if (auth.warning) {
    console.log(`  ! ${auth.warning}`);
  }
  if (auth.generated && auth.persisted) {
    console.log(`  No password was set, so one was generated and saved to`);
    console.log(`  ${join(DATA_DIR, 'control-password')} — edit that file to change it.`);
    console.log(`  It is the same every night until you do.`);
  } else if (auth.generated) {
    // The warning above already says why it was not written down.
    console.log(`  This password is for this run only. Set PRIMETIME_PASSWORD, or put`);
    console.log(`  one of at least ${MIN_PASSWORD} characters in ${join(DATA_DIR, 'control-password')}.`);
  }
  if (auth.fromLegacyPin) {
    console.log(`  Using PRIMETIME_PIN, which is deprecated. Rename it to`);
    console.log(`  PRIMETIME_PASSWORD, or put the password in`);
    console.log(`  ${join(DATA_DIR, 'control-password')} instead.`);
  }
  console.log(`  ${bank.questions.length} questions in ${bank.categories.length} categories` +
    (warnings.length ? `, ${warnings.length} content warning(s)` : ''));
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('  (set ANTHROPIC_API_KEY to generate new questions from /author)');
  }
  if (PUBLIC_URL.error) {
    // Said loudly, because the fallback is the LAN address and on a public box
    // that is an address nobody in the room can reach.
    console.log(`\n  ! ${PUBLIC_URL.error}`);
    console.log('  Falling back to the detected local address, which is almost');
    console.log('  certainly not what players should type.');
  }
  // Every warning below is about LAN detection. With a public URL configured
  // the detected addresses are not what anyone is being told to type, so a
  // warning about them is noise at best and sends the operator chasing a
  // problem that is not there.
  if (PUBLIC_URL.url) {
    console.log(`\n  Serving behind ${PUBLIC_URL.url}. Local detection is not in use.`);
    if (!BIND) {
      console.log(`  Port ${PORT} is open on every interface. Behind a TLS proxy set`);
      console.log('  PRIMETIME_BIND=127.0.0.1 so the plain-HTTP port is not reachable.');
    }
  } else if (!info.urls.length) {
    console.log('\n  No local network address found. Connect the laptop to the venue wifi');
    console.log('  (or your own travel router) before players try to join.');
  } else if (hasOnlyUnusableAddresses(hostsFromUrls(info.urls)) && !(isWsl() && hasNoReachableAddress(hostsFromUrls(info.urls)))) {
    // Everything looks healthy here and no phone can join: the adapter never
    // got a DHCP lease, so the OS invented a 169.254 address that routes
    // nowhere. Said now, in the room, rather than discovered by twenty people
    // scanning a QR code that times out.
    console.log('\n  The only address this machine has is a 169.254 one, which means');
    console.log('  the network never gave it a lease. Nothing can reach the server');
    console.log('  at that address, including the phones.');
    console.log('');
    console.log('  Check the laptop is on the right wifi and the router is up, then');
    console.log('  start again. If the address is right and the detection is wrong,');
    console.log('  pin it:  PRIMETIME_HOST_IP=192.168.1.40 ./start-server.sh');
  } else if (isWsl() && hasNoReachableAddress(hostsFromUrls(info.urls))) {
    // The worst kind of failure: everything looks fine here and no phone can
    // join. Say so now rather than letting the room discover it.
    console.log('\n  WSL networking is NAT, so the address above exists only inside WSL.');
    console.log('  Nothing on the venue wifi can reach this server as it stands.');
    console.log('');
    console.log('  Fix it in Windows, in %USERPROFILE%\\.wslconfig:');
    console.log('      [wsl2]');
    console.log('      networkingMode=mirrored');
    console.log('  then `wsl --shutdown` and start again. WSL will then share the');
    console.log('  laptop\'s real address and players can join.');
    console.log('');
    console.log('  If your Windows build does not support mirrored mode, run the');
    console.log('  server on Windows itself with .\\start-server.ps1 instead.');
  }
  console.log('');
});

function shutdown() {
  clearInterval(heartbeat);
  if (pending) clearTimeout(pending);
  engine.dispose();
  for (const client of clients) client.socket.close(1001, 'server stopping');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
