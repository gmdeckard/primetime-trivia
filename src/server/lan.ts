import { networkInterfaces } from 'node:os';

/**
 * Work out the address players should type in. With no internet there is no
 * DNS, so the LAN IP is the real join path and everything else (mDNS, a
 * printed QR) is built on top of it.
 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      out.push(addr.address);
    }
  }
  return rankLanAddresses(out);
}

// Prefer the ranges a consumer or travel router actually hands out, so we
// don't advertise a Docker bridge or a VPN tunnel as the join address.
const rank = (ip: string) => {
  // 192.168.55.x is the Jetson's USB gadget bridge. It is a real address on
  // a real interface, it sorts into the same 192.168 band as the wifi, and
  // it is reachable only by something plugged into the USB port. Advertise
  // it on the big screen and every tablet in the room scans a QR code for an
  // address it can never reach, with nothing on screen to say why. It is the
  // rescue path, so it stays in the list, but it goes last.
  if (ip.startsWith('192.168.55.')) return 8;
  if (/^169\.254\./.test(ip)) return 9;
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
};

/** Exported so the ordering itself can be tested without real interfaces. */
export function rankLanAddresses(addresses: string[]): string[] {
  return addresses.slice().sort((a, b) => rank(a) - rank(b));
}

export function primaryLanAddress(): string | undefined {
  return lanAddresses()[0];
}
