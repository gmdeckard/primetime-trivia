/**
 * Where to tell players to go.
 *
 * Two deployments, and they disagree about what the join address even is.
 *
 * On the LAN the server works the address out itself, because there is no DNS
 * in a room with no internet and the LAN IP is the only name anything has.
 * Behind a public domain that detection is worse than useless: the box's own
 * address is a private one behind the tunnel or proxy, and advertising it puts
 * an address on
 * the big screen that nothing in the room can reach.
 *
 * So a configured public URL wins outright. And one box can be reached on more
 * than one name, so what wins is the configured name this particular screen
 * was opened with: the QR code has to agree with the address bar above it.
 *
 * These are pure functions on purpose: the LAN path is only testable by faking
 * interfaces, and this is the part that decides what a hundred people type
 * into a phone.
 */

/** A public URL that was configured, or why it was rejected. */
export interface PublicUrlResult {
  /** The canonical address: the first one configured. */
  url?: string;
  /** Every address this box answers on, in the order they were configured. */
  urls?: string[];
  error?: string;
}

/**
 * Clean up the configured public address or addresses, or say why one cannot
 * be used.
 *
 * A bare host is accepted and assumed https, because that is what an operator
 * means when they type `trivia.example.com`, and because the alternative is a
 * server that refuses to start an hour before trivia over a missing scheme.
 *
 * More than one, comma separated, is allowed, and that is the answer to one
 * box answering on two names. They are not alternatives for the operator to
 * pick between: every screen is told the name it was itself opened with, so
 * the QR code on the big screen points back at the address already in the
 * operator's address bar. The first one configured is canonical, and is what
 * anything with no request to look at gets.
 *
 * A bad entry is reported and the good ones are kept. One typo in the second
 * name should not drop the whole box back to advertising a private address at
 * ten to seven.
 */
export function normalizePublicUrl(raw: string | undefined): PublicUrlResult {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return {};

  const urls: string[] = [];
  let error: string | undefined;
  for (const entry of entries) {
    const one = normalizeOne(entry);
    if (one.error) {
      error ??= one.error;
      continue;
    }
    if (one.url && !urls.includes(one.url)) urls.push(one.url);
  }
  if (urls.length === 0) return error ? { error } : {};
  return error ? { url: urls[0], urls, error } : { url: urls[0], urls };
}

/** One already-trimmed entry, cleaned up or rejected. */
function normalizeOne(trimmed: string): PublicUrlResult {

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { error: `PRIMETIME_PUBLIC_URL is not a URL: ${trimmed}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `PRIMETIME_PUBLIC_URL must be http or https, not ${parsed.protocol}` };
  }
  if (!parsed.hostname) return { error: `PRIMETIME_PUBLIC_URL has no host: ${trimmed}` };

  // Keep an explicit port, drop a default one, and drop any path: every route
  // this server serves hangs off the root, so a path here would only ever
  // produce a join URL that 404s.
  const port = parsed.port ? `:${parsed.port}` : '';
  return { url: `${parsed.protocol}//${parsed.hostname}${port}` };
}

/** What the big screen, the QR code and the banner should advertise. */
export interface JoinTargets {
  /** The one address to put on the screen and in the QR code. */
  url: string;
  /** Every address worth printing in the start-up banner. */
  urls: string[];
  /** True when a public URL was configured, so LAN detection is not in play. */
  isPublic: boolean;
}

/** The `host[:port]` a configured URL answers on, lowercased. */
function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').toLowerCase();
}

/**
 * The configured address matching the name this request arrived on.
 *
 * Why a request header decides anything: one box can answer on two names, and
 * the QR code on the big screen has to point back at the name the operator
 * opened rather than at whichever name is first in the config. A phone that
 * scanned a code for the other name would be sent to the other box, which on
 * a night when that box is switched off is a dead page.
 *
 * It is an allowlist and not an echo, on purpose. Only a name somebody
 * configured can be advertised, so a forged Host header gets the canonical
 * address instead of putting a stranger's domain in a QR code a room is about
 * to scan.
 */
function matchConfigured(configured: string[], requestHost: string | undefined): string | undefined {
  const want = requestHost?.trim().toLowerCase();
  if (!want) return undefined;
  const bare = want.split(':')[0];
  return (
    configured.find((url) => hostOf(url) === want) ??
    configured.find((url) => hostOf(url).split(':')[0] === bare)
  );
}

export function joinTargets(opts: {
  publicUrl?: string;
  publicUrls?: string[];
  /** The Host header this screen arrived on, when there is one to read. */
  requestHost?: string;
  lan: string[];
  port: number;
}): JoinTargets {
  const configured = opts.publicUrls?.length
    ? opts.publicUrls
    : opts.publicUrl
      ? [opts.publicUrl]
      : [];
  if (configured.length > 0) {
    // Deliberately not alongside the LAN addresses. A big screen showing a
    // domain AND a private IP invites half the room to type the wrong one.
    const url = matchConfigured(configured, opts.requestHost) ?? configured[0]!;
    return { url, urls: configured, isPublic: true };
  }
  const urls = opts.lan.map((addr) => `http://${addr}:${opts.port}`);
  return { url: urls[0] ?? `http://localhost:${opts.port}`, urls, isPublic: false };
}

/** What the host screen should say about wifi, which is usually nothing. */
export interface WifiInfo {
  ssid?: string;
  ssidAlt?: string;
  wifiPassword?: string;
}

/**
 * Wifi details, and only when someone configured them.
 *
 * This used to default to the SSID of the travel router the game was carried
 * in with, which was right for exactly one deployment and wrong everywhere
 * else: on a public domain the room is on the venue's own wifi, and a big
 * screen naming a network that is not being broadcast sends people hunting
 * through their phone settings for it. Nothing configured now means nothing
 * shown, and the host screen renumbers its steps accordingly.
 */
export function wifiInfo(env: NodeJS.ProcessEnv = process.env): WifiInfo {
  const ssid = env.PRIMETIME_SSID?.trim();
  if (!ssid) return {};
  return {
    ssid,
    ssidAlt: env.PRIMETIME_SSID_ALT?.trim() || undefined,
    wifiPassword: env.PRIMETIME_WIFI_PASSWORD?.trim() || undefined,
  };
}
