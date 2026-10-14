import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import QRCode from 'qrcode';

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

/**
 * The control view can rename teams, change scores and see every answer, so it
 * needs a gate. On a shared clubhouse network the threat isn't a hacker, it's
 * a curious guest who opens /control on their phone because the host screen
 * told them the address. A six-digit PIN read off the MC's screen is the right
 * amount of friction.
 */
export class ControlAuth {
  readonly pin: string;
  private tokens = new Set<string>();

  constructor(pin?: string) {
    this.pin = pin && /^\d{4,8}$/.test(pin) ? pin : String(randomInt(100000, 1000000));
  }

  login(candidate: string): string | undefined {
    const a = Buffer.from(candidate.padEnd(16, '\0').slice(0, 16));
    const b = Buffer.from(this.pin.padEnd(16, '\0').slice(0, 16));
    if (!timingSafeEqual(a, b)) return undefined;
    const token = randomBytes(24).toString('hex');
    this.tokens.add(token);
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

export interface HttpDeps {
  clientDir: string;
  imagesDir: string;
  auth: ControlAuth;
  joinInfo: () => { url: string; urls: string[]; ssid?: string; roomCode: string; venueName: string };
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
      const qrSvg = await QRCode.toString(info.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      sendJson(res, 200, { ...info, qrSvg });
      return;
    }

    if (path === '/api/control/login' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let pin = '';
      try {
        pin = String((JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { pin?: unknown }).pin ?? '');
      } catch {
        /* fall through to the failure path below */
      }
      const token = deps.auth.login(pin);
      if (!token) {
        sendJson(res, 401, { error: 'That PIN is not right.' });
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

    // Three entry points, one per role.
    const page =
      path === '/' || path === '/play' ? 'index.html'
      : path === '/host' || path === '/host/' ? 'host/index.html'
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
