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
  // Prefer the ranges a consumer or travel router actually hands out, so we
  // don't advertise a Docker bridge or a VPN tunnel as the join address.
  const rank = (ip: string) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

export function primaryLanAddress(): string | undefined {
  return lanAddresses()[0];
}
