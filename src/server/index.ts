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
import { controlState, hostState, playerState, watchState } from './views.js';

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

type Role = 'player' | 'host' | 'control' | 'watch';

interface Client {
  socket: WebSocket;
  role: Role;
  playerId?: string;
  /**
   * Set once a watcher has given tonight's room code.
   *
   * A watch socket exists before it is allowed anything — the page connects
   * and introduces itself in the same breath — so this is what `flush` checks
   * before pushing a snapshot, the way it checks `playerId` for a player. A
   * watcher who typed the wrong code is connected and gets nothing.
   */
  admitted?: boolean;
  /**
   * The team a watch socket is following, when it arrived with a team's code.
   *
   * Undefined on a watch socket that gave only the room code: that one is
   * attached to the room, and the server has no idea which table it is at.
   */
  watchTeamId?: string;
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
  if (client.role === 'watch') return watchState(engine, client.watchTeamId);
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
    // A watcher who has not given the room code is connected and nothing more.
    if (client.role === 'watch' && !client.admitted) continue;
    // The same thing that happens to a seated phone when the night is reset,
    // happening to a teammate's: the team this screen follows no longer
    // exists. It is dropped back to the door rather than left showing a table
    // that is not playing — the lesson the orphaned-player fix above paid for,
    // which is that a dead reference is worse than an empty screen.
    if (client.role === 'watch' && client.watchTeamId && !engine.hasTeam(client.watchTeamId)) {
      client.admitted = false;
      client.watchTeamId = undefined;
      client.lastSent = undefined;
      send(client.socket, {
        t: 'error',
        message: 'That game has finished. Scan the code on your table again, or watch the room from the big screen.',
      });
      continue;
    }
    if (client.socket.readyState !== client.socket.OPEN) continue;
    // The night may have been reset out from under this socket, which throws
    // away every player record while the phones stay connected. Such a device
    // is handed a new identity here rather than being left holding a dead id:
    // without this it is shown the join form, types the new room code, and is
    // told "unknown player" by engine.join — and the only cure a player can
    // find on their own is reloading the page, which is what they should never
    // have to be told to do. Re-identifying is also what makes `answer` and
    // `set_wager` work again, which would otherwise no-op in silence.
    if (client.role === 'player' && !engine.hasPlayer(client.playerId)) {
      const player = engine.identify();
      client.playerId = player.id;
      client.lastSent = undefined;
      send(client.socket, { t: 'identity', playerId: player.id, token: player.token });
    }
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
  // Wall-clock is enough here and survives better than a monotonic reading in
  // a log line a person reads: the number wanted is "how long was this phone
  // on", not a precise interval.
  const openedAt = Date.now();

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
        // The big screen is operator equipment, and on a public hostname it
        // has to prove it. Ungated, this role was the live question, the team
        // names, the room code and the wifi password handed to anyone who
        // guessed the address — and the room code is the whole join gate, so
        // reading one screen remotely was also a seat on the scoreboard.
        // Same password as the MC's phone: one credential, typed once per
        // device, and a laptop already set up through /control is past it.
        if (msg.role === 'host' && !auth.valid(msg.token)) {
          send(socket, { t: 'error', message: 'The big screen needs the host password.' });
          socket.close(4001, 'unauthorized');
          return;
        }
        // Watching costs the room code and nothing else: no seat, no name.
        // The socket is left open rather than closed on a wrong code, because
        // the page's own reconnect would then race the person retyping it —
        // staying open and unadmitted lets them simply try again, and `ready`
        // below is what keeps the first snapshot from going out meanwhile.
        if (msg.role === 'watch') {
          // Two doors into the same role. A team's code is scanned off that
          // team's own device, so it stands on its own: asking for the room
          // code as well would mean walking to the big screen, which is the
          // errand the QR exists to remove.
          const team = engine.teamByWatchCode(msg.teamCode);
          if (msg.teamCode && !team) {
            // Almost always last night's QR, still in somebody's camera roll
            // or on a printed table card: resetNight() built new teams with
            // new codes, which is what makes the old ones mean nothing.
            send(socket, { t: 'error', message: 'That code is from a game that has finished. Scan the one on your table now, or join from the big screen.' });
            return;
          }
          client.watchTeamId = team?.id;
          client.admitted = !!team || engine.roomCodeMatches(msg.roomCode);
          if (!client.admitted) {
            send(socket, { t: 'error', message: 'That room code is not right — it is on the big screen.' });
            return;
          }
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

      // The other half of the same rule, and the reason a watch screen cannot
      // play: these five all act on a seat, and only a player holds one. They
      // used to be reachable by any ready socket and were saved from doing
      // damage by `engine` refusing an unknown player id, which is a guard in
      // the wrong place — it made "cannot answer" a property of the engine's
      // bookkeeping rather than something the door says.
      const playerOnly = new Set<ClientMessage['t']>([
        'join', 'leave', 'answer', 'answer_number', 'set_wager',
      ]);
      if (playerOnly.has(msg.t) && client.role !== 'player') return;

      // Asked for by a seated device, answered once. Deliberately not part of
      // the state snapshot: the SVG is about a kilobyte and a half, and a
      // hundred phones re-receiving their own unchanged QR on every flush of
      // every question is megabytes spent saying nothing new.
      if (msg.t === 'team_qr') {
        if (client.role !== 'player') return;
        const code = engine.watchCodeFor(client.playerId);
        if (!code) {
          send(socket, { t: 'error', message: 'Take a seat first — the code follows your team.' });
          return;
        }
        const url = `${joinInfo().url}/watch?team=${code}`;
        void QRCode.toString(url, { type: 'svg', margin: 4, errorCorrectionLevel: 'Q' }).then((qrSvg) => {
          send(socket, { t: 'team_qr', url, qrSvg });
        });
        return;
      }

      switch (msg.t) {
        case 'join': engine.join(client.playerId!, msg.roomCode, msg.name, msg.kind, msg.tableNo); break;
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

  socket.on('close', (code: number, reason: Buffer) => {
    clients.delete(client);
    if (client.playerId) engine.setConnected(client.playerId, false);
    // One line per close, because the alternative is guessing. A phone that
    // drops mid-round, a big screen that was never authorized (4001), a tablet
    // carried out of the building — they all look identical from the room, and
    // after the night there is nothing to read. Role and duration are what
    // distinguish "wifi blinked" from "someone closed the tab", and the code
    // is what distinguishes either from the server shutting down (1001).
    const seconds = Math.round((Date.now() - openedAt) / 1000);
    const why = reason.length > 0 ? ` ${reason.toString('utf8')}` : '';
    console.log(`  socket close ${code}${why} role=${client.role} open=${seconds}s`);
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
    console.log('  server on a Linux or macOS machine on the same wifi instead.');
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
