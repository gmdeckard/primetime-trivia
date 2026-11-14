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
 * So a configured public URL wins outright. These are pure functions on
 * purpose: the LAN path is only testable by faking interfaces, and this is the
 * part that decides what a hundred people type into a phone.
 */

/** A public URL that was configured, or why it was rejected. */
export interface PublicUrlResult {
  url?: string;
  error?: string;
}

/**
 * Clean up a configured public URL, or say why it cannot be used.
 *
 * A bare host is accepted and assumed https, because that is what an operator
 * means when they type `trivia.example.com`, and because the alternative is a
 * server that refuses to start an hour before trivia over a missing scheme.
 */
export function normalizePublicUrl(raw: string | undefined): PublicUrlResult {
  const trimmed = raw?.trim();
  if (!trimmed) return {};

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

export function joinTargets(opts: { publicUrl?: string; lan: string[]; port: number }): JoinTargets {
  if (opts.publicUrl) {
    // Deliberately not alongside the LAN addresses. A big screen showing a
    // domain AND a private IP invites half the room to type the wrong one.
    return { url: opts.publicUrl, urls: [opts.publicUrl], isPublic: true };
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
