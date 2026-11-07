import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Tests for `choose_host_ip` in start-server.sh.
 *
 * Nothing used to execute either start script, which is how a fatal `set -e`
 * bug shipped and sat for nineteen days behind a green suite: the whole
 * function is shell, and `npm test` only ever ran TypeScript.
 *
 * The function is lifted out of the real script with sed rather than copied
 * here, so these tests cannot drift from what actually runs. `node` is stubbed
 * to print a canned candidate list, which is the one thing the function shells
 * out for, and the answers are fed on stdin.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAB = '\t';

/**
 * Run choose_host_ip against a canned candidate list and canned keystrokes.
 *
 * `tty` is simulated rather than real: the function gates on `[ -t 0 ]`, and a
 * test harness has no terminal, so the lifted copy gets that test replaced.
 * Everything else is the script's own code.
 */
function runChooser(opts: {
  list: string;
  input?: string;
  env?: Record<string, string>;
  tty?: boolean;
}): { out: string; picked: string } {
  const tty = opts.tty ?? true;
  const script = `
set -euo pipefail
cd "${repoRoot}"
eval "$(sed -n '/^choose_host_ip() {/,/^}/p' start-server.sh)"
node() { [ -n "$STUB_LIST" ] && printf '%s\\n' "$STUB_LIST"; }
${tty ? '' : 'exec 0</dev/null'}
choose_host_ip
echo "PICKED=\${PRIMETIME_HOST_IP:-}"
`;
  // The [ -t 0 ] gate cannot be satisfied from a test harness, so for the tty
  // cases the test replaces that one line and leaves the rest untouched.
  const prepared = tty
    ? script.replace(
        `eval "$(sed -n '/^choose_host_ip() {/,/^}/p' start-server.sh)"`,
        `eval "$(sed -n '/^choose_host_ip() {/,/^}/p' start-server.sh | sed 's@^  \\[ -t 0 \\] || return 0$@  :@')"`,
      )
    : script;
  const out = execFileSync('bash', ['-c', prepared], {
    input: opts.input ?? '',
    encoding: 'utf8',
    env: { ...process.env, STUB_LIST: opts.list, ...(opts.env ?? {}) },
  });
  const picked = /^PICKED=(.*)$/m.exec(out)?.[1] ?? '';
  return { out, picked };
}

const CLEAN_ONE = `192.168.1.50${TAB}eth0${TAB}`;
const LINK_LOCAL_ONE = `169.254.183.44${TAB}eth0${TAB}no DHCP reply on this adapter — not a usable address`;
const TWO = `192.168.1.50${TAB}eth0${TAB}\n169.254.183.44${TAB}eth1${TAB}no DHCP reply on this adapter — not a usable address`;

test('a single clean candidate still prompts, and Enter pins it', () => {
  // It used to return early here, which left nothing pinned: the server went
  // on re-ranking live interfaces on every host-screen update, so a lease that
  // dropped mid-night moved the big screen onto a 169.254 address while the
  // startup banner still read correctly. Enter must export the address, not
  // just agree with it.
  const { out, picked } = runChooser({ list: CLEAN_ONE, input: '\n' });
  assert.match(out, /Which address/);
  assert.match(out, /Enter for 1/);
  assert.equal(picked, '192.168.1.50');
});

test('a single FLAGGED candidate does prompt, and typing an address wins', () => {
  // The Netgear case: the laptop got no lease, so its only address is a
  // 169.254 one. The old code skipped the prompt on count==1 and advertised it.
  const { out, picked } = runChooser({ list: LINK_LOCAL_ONE, input: 'o\n192.168.1.77\n' });
  assert.match(out, /Which address/);
  assert.match(out, /none of them is a safe default/);
  assert.equal(picked, '192.168.1.77');
});

test('with no candidate at all it still offers to take an address', () => {
  const { out, picked } = runChooser({ list: '', input: '10.0.0.5\n' });
  assert.match(out, /No network address found/);
  assert.equal(picked, '10.0.0.5');
});

test('Enter takes the first candidate that carries no warning', () => {
  const flaggedFirst = `169.254.9.9${TAB}eth1${TAB}no DHCP reply on this adapter — not a usable address\n192.168.1.50${TAB}eth0${TAB}`;
  const { out, picked } = runChooser({ list: flaggedFirst, input: '\n' });
  assert.match(out, /Enter for 2/);
  assert.equal(picked, '192.168.1.50');
});

test('a numbered pick selects that candidate', () => {
  const { picked } = runChooser({ list: TWO, input: '2\n' });
  assert.equal(picked, '169.254.183.44');
});

test('PRIMETIME_SERVER_IP is accepted, with a note naming the real variable', () => {
  // Not a name this project uses, but the one people reach for. An override
  // that is silently dropped is how an operator stops looking for the problem.
  const { out, picked } = runChooser({
    list: TWO,
    env: { PRIMETIME_SERVER_IP: '192.168.1.99' },
  });
  assert.equal(picked, '192.168.1.99');
  assert.match(out, /the variable is PRIMETIME_HOST_IP/i);
});

test('PRIMETIME_HOST_IP still wins outright and asks nothing', () => {
  const { out, picked } = runChooser({ list: TWO, env: { PRIMETIME_HOST_IP: '192.168.1.40' } });
  assert.equal(picked, '192.168.1.40');
  assert.doesNotMatch(out, /Which address/);
});

test('PRIMETIME_HOST_IP beats PRIMETIME_SERVER_IP when both are set', () => {
  const { picked } = runChooser({
    list: TWO,
    env: { PRIMETIME_HOST_IP: '192.168.1.40', PRIMETIME_SERVER_IP: '10.1.1.1' },
  });
  assert.equal(picked, '192.168.1.40');
});

test('three bad answers fall through rather than block the night', () => {
  const { out, picked } = runChooser({ list: TWO, input: 'x\n9\nnope\n' });
  assert.equal(picked, '');
  assert.match(out, /Falling back to the automatic pick/);
});

test('PRIMETIME_NO_PICK skips the prompt entirely', () => {
  const { out, picked } = runChooser({ list: TWO, env: { PRIMETIME_NO_PICK: '1' } });
  assert.equal(picked, '');
  assert.doesNotMatch(out, /Which address/);
});

test('no terminal means no prompt, and the function still returns clean', () => {
  // This is the exact shape of the bug that shipped: under `set -e` a bare
  // `return` here killed the script before the server was ever launched.
  const { out, picked } = runChooser({ list: TWO, tty: false });
  assert.equal(picked, '');
  assert.doesNotMatch(out, /Which address/);
  assert.match(out, /PICKED=/, 'execution must continue past the function');
});
