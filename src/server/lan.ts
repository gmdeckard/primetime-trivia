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
 * A 169.254 address. The adapter asked for a DHCP lease and never got one, so
 * the OS made an address up. It is a real address on a real interface and it
 * routes nowhere: two machines that both failed DHCP on the same segment can
 * sometimes reach each other, and nothing else can.
 */
export function isLinkLocalAddress(ip: string): boolean {
  return /^169\.254\./.test(ip);
}

/**
 * True when nothing we can see is worth advertising: every address is a
 * failed-DHCP link-local, or WSL's own NAT.
 *
 * Separate from `hasNoReachableAddress` because the cause and the fix are
 * different. That one is a WSL networking mode and the fix is `.wslconfig`.
 * This one is a laptop that never got a lease, and the fix is in the room:
 * the wrong SSID, a router still booting, or a cable in the wrong port.
 */
export function hasOnlyUnusableAddresses(addresses: string[]): boolean {
  if (!addresses.length) return false;
  return addresses.every((ip) => isLinkLocalAddress(ip) || isWslNatAddress(ip));
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
  return addresses.every((ip) => isWslNatAddress(ip) || isLinkLocalAddress(ip));
}

/** An address the room might be able to reach, with the adapter it sits on. */
export interface LanCandidate {
  address: string;
  iface: string;
}

/**
 * Work out the address players should type in. With no internet there is no
 * DNS, so the LAN IP is the real join path and everything else (mDNS, a
 * printed QR) is built on top of it.
 */
export function lanCandidates(): LanCandidate[] {
  // The operator's override wins over any guess. On a workstation with
  // virtualisation installed there can be several plausible-looking private
  // addresses and only one the room can reach; this is the way to say which.
  const pinned = process.env.PRIMETIME_HOST_IP?.trim();
  if (pinned) return [{ address: pinned, iface: 'PRIMETIME_HOST_IP' }];

  const out: LanCandidate[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      out.push({ address: addr.address, iface });
    }
  }
  return rankLanCandidates(out);
}

export function lanAddresses(): string[] {
  return lanCandidates().map((c) => c.address);
}

// Prefer the ranges a consumer or travel router actually hands out, so we
// don't advertise a Docker bridge or a VPN tunnel as the join address.
const addressRank = (ip: string) => {
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
  if (isLinkLocalAddress(ip)) return 9;
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
};

/**
 * Interfaces that exist for containers, virtual machines and VPN tunnels
 * rather than for the room.
 *
 * Address band alone cannot tell these apart from the venue wifi. Docker's
 * default bridge is 172.17.0.1 and its user networks run up through 172.31,
 * which is the same band a venue router hands out: at a venue on 172.16.0.x
 * the wifi address and two Docker bridges all score the same, and the winner
 * is whatever order the OS listed the adapters in. The name is the fact the
 * band only guesses at.
 *
 * `br-` with the hyphen is Docker's own naming for a user network. A plain
 * `br0` is deliberately not matched: that is how a real bridged LAN is named.
 */
export function isVirtualInterface(name: string): boolean {
  return /^(docker\d|br-|virbr|veth|vmnet|vboxnet|tun\d|tap\d|wg\d|utun|zt)/i.test(name);
}

// A virtual adapter loses to every physical one whatever the bands say, and
// the penalty clears the whole address scale so it cannot be ranked back up.
const candidateRank = (c: LanCandidate) =>
  (isVirtualInterface(c.iface) ? 100 : 0) + addressRank(c.address);

/**
 * A short warning for a candidate the operator is about to pick, or '' when
 * there is nothing to say.
 *
 * Advisory only: the operator chooses, so a missing note costs a little
 * confidence and a WRONG note costs the night. That asymmetry decides the WSL
 * case below.
 */
export function candidateNote(c: LanCandidate, siblings?: LanCandidate[]): string {
  if (c.iface === 'PRIMETIME_HOST_IP') return 'pinned by PRIMETIME_HOST_IP';
  if (isLinkLocalAddress(c.address)) return 'no DHCP reply on this adapter — not a usable address';
  if (isVirtualInterface(c.iface)) return 'virtual adapter (container/VM/VPN) — phones cannot reach it';
  if (c.address.startsWith('192.168.55.')) return 'USB rescue link — only a cable reaches this';
  if (c.address.startsWith('192.168.56.')) return 'VirtualBox host-only — phones cannot reach it';
  if (c.address.startsWith('192.168.137.')) return 'Windows hotspot/ICS — only devices on that hotspot';
  if (c.address === '10.255.255.254') return "WSL's own gateway — phones cannot reach it";
  // A 172.16-31 address under WSL may be the VM's private NAT network, or may
  // be a venue router that genuinely uses that range. Telling them apart needs
  // the NAT gateway to be present too. Without that check this flags a real
  // venue address as unreachable and the operator picks around the only one
  // that works.
  if (isWsl() && isWslNatAddress(c.address) && (siblings ?? []).some((s) => s.address === '10.255.255.254')) {
    return "likely WSL's private NAT network — phones cannot reach it";
  }
  return '';
}

/** Exported so the ordering itself can be tested without real interfaces. */
export function rankLanCandidates(candidates: LanCandidate[]): LanCandidate[] {
  return candidates.slice().sort((a, b) => candidateRank(a) - candidateRank(b));
}

/** Exported so the ordering itself can be tested without real interfaces. */
export function rankLanAddresses(addresses: string[]): string[] {
  return addresses.slice().sort((a, b) => addressRank(a) - addressRank(b));
}

export function primaryLanAddress(): string | undefined {
  return lanAddresses()[0];
}
