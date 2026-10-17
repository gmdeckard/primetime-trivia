#!/usr/bin/env node
/**
 * Print the addresses a phone in the room might be able to reach, one per
 * line, best first: `address<TAB>interface<TAB>note`.
 *
 * This exists so the startup scripts can offer a choice without recomputing
 * the answer. start-server.sh used to work the address out itself with
 * `ip ... | head -1` and got it wrong in exactly the places that matter; the
 * rule since then is that the server owns this and everything else asks. A
 * shell picker that re-derived the list would walk straight back into that.
 */
import { lanCandidates, candidateNote } from './lan.js';

const candidates = lanCandidates();
for (const c of candidates) {
  process.stdout.write(`${c.address}\t${c.iface}\t${candidateNote(c, candidates)}\n`);
}
