import { networkInterfaces } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

/**
 * True when this is a WSL VM rather than Windows or a real Linux box.
 *
 * It matters because WSL's default networking is NAT: the VM gets its own
 * private network, and nothing on the venue wifi can reach a server inside it
 * however correct the server looks from the machine it runs on.
 */
export function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Addresses that exist inside WSL's NAT and mean nothing to a phone. */
export function isWslNatAddress(ip: string): boolean {
  // 10.255.255.254 is the gateway WSL hands the VM, and 172.16-31 is the range
  // its virtual adapter sits in.
  return ip === '10.255.255.254' || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/**
 * True when every address we can see is one only this machine can use, so the
 * banner is about to advertise a join URL that cannot work.
 *
 * The 10.255.255.254 gateway has to be present to call it. On its own, a
 * 172.16-31 address proves nothing: plenty of real networks use that range,
 * and under WSL's mirrored mode a venue router handing out 172.20.x would
 * otherwise be told its perfectly good address was unreachable.
 */
export function hasNoReachableAddress(addresses: string[]): boolean {
  if (!addresses.some((ip) => ip === '10.255.255.254')) return false;
  return addresses.every((ip) => isWslNatAddress(ip) || /^169\.254\./.test(ip));
}

/**
 * Work out the address players should type in. With no internet there is no
 * DNS, so the LAN IP is the real join path and everything else (mDNS, a
 * printed QR) is built on top of it.
 */
export function lanAddresses(): string[] {
  // The operator's override wins over any guess. On a workstation with
  // virtualisation installed there can be several plausible-looking private
  // addresses and only one the room can reach; this is the way to say which.
  const pinned = process.env.PRIMETIME_HOST_IP?.trim();
  if (pinned) return [pinned];

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
  // The same trap as the USB bridge, on a Windows host. VirtualBox host-only
  // networks are 192.168.56.x and Windows Mobile Hotspot / ICS is
  // 192.168.137.x. Both are real addresses on real adapters, both sort into
  // the same 192.168 band as the wifi, and neither is reachable from a phone
  // on the venue's router. Left unranked they tie with the address that works
  // and the winner depends on the order the OS lists adapters.
  if (ip.startsWith('192.168.56.') || ip.startsWith('192.168.137.')) return 7;
  // WSL's NAT gateway. A real address on a real interface, and the one thing
  // in the list a phone on the venue wifi can never reach.
  if (ip === '10.255.255.254') return 7;
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
