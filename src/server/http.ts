import { chmodSync, createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import QRCode from 'qrcode';
import { MIN_PASSWORD } from '../../shared/protocol.js';

/** A login body is `{"password":"..."}`; 4 KB is already absurdly generous. */
const MAX_LOGIN_BODY = 4096;

/**
 * Static file serving and the handful of REST endpoints. Everything else runs
 * over the websocket.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
};

/** Readable words for a generated password: no lookalikes, nothing to misread aloud. */
const WORDS = [
  'amber', 'anchor', 'badge', 'brass', 'cedar', 'copper', 'cobalt', 'domino',
  'ember', 'falcon', 'granite', 'harbor', 'indigo', 'juniper', 'kettle', 'lantern',
  'marble', 'nutmeg', 'onyx', 'pepper', 'quarry', 'ribbon', 'saddle', 'timber',
  'umber', 'velvet', 'walnut', 'yarrow',
];

export interface ControlAuthOptions {
  /** Explicit password, normally from PRIMETIME_PASSWORD. Wins over everything. */
  password?: string;
  /** Where to keep the password and the issued tokens. Normally the data dir. */
  dir?: string;
  /** Deprecated PRIMETIME_PIN, honoured so an existing box keeps working. */
  legacyPin?: string;
}

/**
 * The control view can rename teams, change scores and see every answer, so it
 * needs a gate. On a shared clubhouse network the threat isn't a hacker, it's
 * a curious guest who opens /control on their phone because the host screen
 * told them the address.
 *
 * The password is set once on the server and does not change between games.
 * A per-boot random PIN meant the MC had to go and read it off a terminal
 * before every night, which is friction paid by the one person who is already
 * busiest. Resolution order:
 *
 *   1. `PRIMETIME_PASSWORD`
 *   2. `control-password` in the data dir
 *   3. `PRIMETIME_PIN`, the old env var, still honoured
 *   4. a generated passphrase, written to (2) so it is the same next time
 *
 * Step 4 is why there is no "no password configured" failure: a box that will
 * not start an hour before trivia is worse than one with a password nobody
 * chose, and because it is written down it is still stable and still editable.
 */
export class ControlAuth {
  /** The live password. Printed in the start-up banner. */
  readonly password: string;
  /** True when nobody chose this password and the server made one up. */
  readonly generated: boolean;
  /** True when the password came from the deprecated PRIMETIME_PIN. */
  readonly fromLegacyPin: boolean;
  /** True when a generated password was written down, so the next boot reuses it. */
  readonly persisted: boolean = false;
  /**
   * Set when a password an operator configured was not usable, so the start-up
   * banner can say why the one it is printing is not theirs. Silence here was
   * a bug: a short password in the file was replaced by a generated one and
   * the operator had no way to tell.
   */
  readonly warning?: string;
  private readonly tokenFile?: string;
  private tokens = new Set<string>();

  constructor(opts: ControlAuthOptions = {}) {
    const passwordFile = opts.dir ? join(opts.dir, 'control-password') : undefined;
    this.tokenFile = opts.dir ? join(opts.dir, 'control-tokens.json') : undefined;

    const rawEnv = opts.password;
    const rawFile = passwordFile ? readIfPresent(passwordFile) : undefined;
    const fromEnv = clean(rawEnv);
    const fromFile = clean(rawFile);
    const fromPin = clean(opts.legacyPin);

    this.fromLegacyPin = !fromEnv && !fromFile && !!fromPin;
    this.generated = !fromEnv && !fromFile && !fromPin;
    this.password = fromEnv ?? fromFile ?? fromPin ?? generatePassword();

    // Say so when something was set and rejected. Falling through silently is
    // how an operator ends up typing a password the server never adopted.
    if (rawEnv?.trim() && !fromEnv) {
      this.warning = `PRIMETIME_PASSWORD is shorter than ${MIN_PASSWORD} characters, so it was ignored.`;
    } else if (passwordFile && !fromFile && existsSync(passwordFile)) {
      // Present but unusable, in any of the three ways: too short, unreadable
      // (root-owned after a `sudo vi`, say), or nothing but comments. All three
      // used to fall through as silently as a missing file.
      this.warning = rawFile
        ? `The password in ${passwordFile} is shorter than ${MIN_PASSWORD} characters, so it was ignored. The file was left as it is.`
        : `${passwordFile} could not be read, or holds no password line, so it was ignored. The file was left as it is.`;
    }

    // Persist a generated password so the next boot reuses it. Written 0600 so
    // it is owner-only, because the file is a credential and the data dir it
    // sits in is not. On Windows that mode only toggles the read-only bit, so
    // the file is not protected there the way it is on Linux.
    //
    // Never over an existing file. A file that is present but unusable (too
    // short, or unreadable) is still the operator's: replacing it would throw
    // away what they typed and hide the mistake behind a working login.
    if (this.generated && passwordFile && !existsSync(passwordFile)) {
      try {
        writeFileSync(passwordFile, `${this.password}\n`, { encoding: 'utf8', mode: 0o600 });
        this.persisted = true;
      } catch (err) {
        // A data directory that cannot be written means a different password
        // every boot, which is the whole thing this is meant to stop. The box
        // still starts, but the operator has to be told.
        this.warning = `Could not save the generated password to ${passwordFile} (${(err as Error).message}). It will be different after every restart until that path is writable.`;
      }
    }

    this.loadTokens();
  }

  /**
   * Sessions outlive the process on purpose.
   *
   * Tokens used to live only in memory, so restarting the server mid-evening
   * threw the MC back to the login screen — indistinguishable, from their side,
   * from being timed out. With a stable password there is no reason to make
   * them type it again.
   */
  private loadTokens() {
    if (!this.tokenFile || !existsSync(this.tokenFile)) return;
    try {
      const saved = JSON.parse(readFileSync(this.tokenFile, 'utf8')) as unknown;
      if (!isTokenFile(saved)) return;
      // Tokens are bound to the password, so changing it signs every device out.
      if (saved.passwordHash !== this.hash()) return;
      for (const token of saved.tokens) if (typeof token === 'string') this.tokens.add(token);
    } catch {
      /* a corrupt file just means everyone logs in again */
    }
  }

  private saveTokens() {
    if (!this.tokenFile) return;
    try {
      const body = JSON.stringify({ passwordHash: this.hash(), tokens: [...this.tokens] });
      // Temp file then rename, the same way store.ts writes night.json: a power
      // cut mid-write cannot leave a truncated file. `mode` is only honoured
      // when a file is created, so an existing token file would otherwise keep
      // whatever permissions it already had — chmod makes 0600 stick on every
      // write, not just the first.
      const tmp = `${this.tokenFile}.tmp`;
      writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.tokenFile);
    } catch {
      /* non-fatal: the session is still good until this process stops */
    }
  }

  private hash(value = this.password): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  login(candidate: string): string | undefined {
    // Compared as digests so the check is constant time whatever the lengths
    // are. The old version padded to 16 bytes and sliced, which quietly meant
    // only the first 16 characters of a long password had to match.
    const a = Buffer.from(this.hash(candidate ?? ''), 'hex');
    const b = Buffer.from(this.hash(), 'hex');
    if (!timingSafeEqual(a, b)) return undefined;
    const token = randomBytes(24).toString('hex');
    this.tokens.add(token);
    this.saveTokens();
    return token;
  }

  valid(token?: string): boolean {
    return !!token && this.tokens.has(token);
  }

  /** Same check, reading the bearer token off an HTTP request. */
  validRequest(req: { headers: Record<string, unknown> }): boolean {
    const header = req.headers['authorization'];
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return this.valid(match?.[1]);
  }
}

function clean(value?: string): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length >= MIN_PASSWORD ? trimmed : undefined;
}

/** First non-empty line, so the file can carry a comment above the password. */
function readIfPresent(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) return trimmed;
    }
  } catch {
    /* unreadable file is the same as no file */
  }
  return undefined;
}

/**
 * Three words and two digits: still sayable down a phone, and about two million
 * combinations rather than seventy thousand. The password no longer rotates
 * every boot, so its size is what carries it; this is a sensible default for a
 * clubhouse LAN, not a hardened credential.
 */
function generatePassword(): string {
  const word = () => WORDS[randomInt(WORDS.length)]!;
  return `${word()}-${word()}-${word()}-${randomInt(10, 100)}`;
}

function isTokenFile(value: unknown): value is { passwordHash: string; tokens: unknown[] } {
  if (!value || typeof value !== 'object') return false;
  const v = value as { passwordHash?: unknown; tokens?: unknown };
  return typeof v.passwordHash === 'string' && Array.isArray(v.tokens);
}

export interface HttpDeps {
  clientDir: string;
  imagesDir: string;
  auth: ControlAuth;
  joinInfo: () => {
    url: string;
    urls: string[];
    ssid?: string;
    ssidAlt?: string;
    wifiPassword?: string;
    roomCode: string;
    venueName: string;
  };
  /** Handles /api/author/*; returns true when it took the request. */
  handleAuthor?: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Resolve a URL path inside a root, refusing anything that escapes it. */
function safeJoin(root: string, urlPath: string): string | undefined {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '');
  const candidate = resolve(join(root, normalize(decoded)));
  const rootResolved = resolve(root);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return undefined;
  return candidate;
}

function serveFile(req: IncomingMessage, res: ServerResponse, path: string, immutable = false) {
  const stat = statSync(path);
  // Weak validator built from the file itself, so a repeat request for an
  // unchanged asset costs a 304 rather than the whole file.
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

  if (immutable && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'public, max-age=31536000, immutable' });
    res.end();
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    etag,
    'last-modified': stat.mtime.toUTCString(),
    // Asset filenames carry a content hash, so they can be cached forever. The
    // HTML that points at them must never be: a phone holding yesterday's page
    // would keep loading yesterday's bundle, and the symptom of that is a
    // screen that mysteriously stops updating. `no-cache` only asks the browser
    // to revalidate; `no-store` removes the question.
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store, must-revalidate',
  });
  createReadStream(path).pipe(res);
}

export function createRequestHandler(deps: HttpDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    if (deps.handleAuthor && path.startsWith('/api/author')) {
      if (await deps.handleAuthor(req, res, path)) return;
    }

    if (path === '/api/info') {
      const info = deps.joinInfo();
      // Two answers, because this endpoint was two things at once.
      //
      // It was written when the server was a laptop on the room's own wifi,
      // where "can reach it" and "is in the room" were the same sentence. On a
      // public hostname they are not, and this was handing the room code to
      // anyone who asked — which made the join gate decorative, since the code
      // is the whole of it. The wifi password was going out with it.
      //
      // Unauthenticated callers get what a stranger may have: that the server
      // is up, and the address they already typed. Everything else needs the
      // MC's token. No browser page fetches this at all — every screen gets
      // what it needs over its own websocket — so the only unauthenticated
      // callers left are start-up probes, which want the 200 and nothing more.
      if (!deps.auth.validRequest(req)) {
        sendJson(res, 200, { ok: true, url: info.url, venueName: info.venueName });
        return;
      }
      const qrSvg = await QRCode.toString(info.url, { type: 'svg', margin: 4, errorCorrectionLevel: 'Q' });
      sendJson(res, 200, { ...info, qrSvg });
      return;
    }

    if (path === '/api/control/login' && req.method === 'POST') {
      // The only unauthenticated POST here, so it does not get to buffer an
      // unbounded body: a guest on the clubhouse wifi could otherwise stream
      // until the process runs out of memory, before any credential is checked.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > MAX_LOGIN_BODY) {
          sendJson(res, 413, { error: 'That request was too large.' });
          return;
        }
        chunks.push(buf);
      }
      let password = '';
      try {
        // `pin` is the old field name; a control page cached on the MC's phone
        // from before this change still sends it.
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          password?: unknown;
          pin?: unknown;
        };
        password = String(body.password ?? body.pin ?? '');
      } catch {
        /* fall through to the failure path below */
      }
      const token = deps.auth.login(password);
      if (!token) {
        sendJson(res, 401, { error: 'That password is not right.' });
        return;
      }
      sendJson(res, 200, { token });
      return;
    }

    // Question images, served straight out of the content tree.
    if (path.startsWith('/media/')) {
      const file = safeJoin(deps.imagesDir, path.slice('/media/'.length));
      if (file && existsSync(file) && statSync(file).isFile()) {
        serveFile(req, res, file, true);
        return;
      }
      res.writeHead(404).end('not found');
      return;
    }

    // Four entry points, one per role. `/watch` is served the host bundle on
    // purpose: a watch screen IS the big screen, minus the audio and the join
    // panel, and the page tells the two apart by its own path. A second bundle
    // would be the same code shipped twice and a second place to forget.
    const page =
      path === '/' || path === '/play' ? 'index.html'
      : path === '/host' || path === '/host/' ? 'host/index.html'
      : path === '/watch' || path === '/watch/' ? 'host/index.html'
      : path === '/control' || path === '/control/' ? 'control/index.html'
      : path === '/author' || path === '/author/' ? 'author/index.html'
      : undefined;

    if (page) {
      const file = join(deps.clientDir, page);
      if (existsSync(file)) {
        serveFile(req, res, file);
        return;
      }
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Client bundle not built. Run `npm run build` (or `npm run dev` for the dev server).');
      return;
    }

    const asset = safeJoin(deps.clientDir, path);
    if (asset && existsSync(asset) && statSync(asset).isFile()) {
      serveFile(req, res, asset, path.startsWith('/assets/'));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };
}
