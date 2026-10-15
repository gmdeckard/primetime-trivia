import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlAuth } from './http.js';

/**
 * The control password is the one credential in the product, and the thing it
 * has to be is boring: the same every night, surviving a restart, and not
 * quietly accepting something close to it.
 */

/** Root ignores permission bits, and this box gets installed with sudo. */
const asRoot = process.getuid?.() === 0;

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'primetime-auth-'));
  dirs.push(dir);
  return dir;
}

test('an explicit password beats the file, the file beats the old PIN', () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'control-password'), 'from-the-file\n');

  const env = new ControlAuth({ password: 'from-the-env', legacyPin: '123456', dir });
  assert.equal(env.password, 'from-the-env');
  assert.equal(env.generated, false);

  const file = new ControlAuth({ legacyPin: '123456', dir });
  assert.equal(file.password, 'from-the-file');
  assert.equal(file.fromLegacyPin, false);

  const pin = new ControlAuth({ legacyPin: '123456', dir: freshDir() });
  assert.equal(pin.password, '123456', 'an existing box set up with PRIMETIME_PIN must keep working');
  assert.equal(pin.fromLegacyPin, true);
});

test('a password file may carry a comment above the password', () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'control-password'), '# MC password for Thursday nights\n\nbrass-lantern-42\n');
  assert.equal(new ControlAuth({ dir }).password, 'brass-lantern-42');
});

test('with nothing configured it generates once and then reuses it', () => {
  const dir = freshDir();
  const first = new ControlAuth({ dir });
  assert.equal(first.generated, true);
  assert.ok(first.password.length >= 8, 'a generated password should not be guessable by a guest');

  const onDisk = readFileSync(join(dir, 'control-password'), 'utf8').trim();
  assert.equal(onDisk, first.password, 'it must be written down or it is not a set password');

  // This is the whole point: the MC is not told a new one every night.
  const second = new ControlAuth({ dir });
  assert.equal(second.password, first.password);
  assert.equal(first.persisted, true, 'the banner tells the operator it was saved, so it has to have been');
  assert.equal(second.generated, false, 'the second boot reads the file rather than making one up');
});

/*
 * Value: protects=a password the server made up for itself lands in a file
 *   only its owner can read;
 *   fails_when=the 0600 mode is dropped from the write, which would leave the
 *   one credential in the product world-readable in a data directory that also
 *   holds night.json and is routinely copied off the box;
 *   why_new=the generate-once test checks the contents of that file but not
 *   its permissions, and permissions are the reason the comment singles the
 *   write out; seam=none;
 *   no_claim=says nothing about the mode of control-tokens.json, nor about a
 *   password file an operator wrote by hand.
 */
test('a generated password is written where only its owner can read it', () => {
  const dir = freshDir();
  const auth = new ControlAuth({ dir });
  assert.equal(auth.generated, true);

  const mode = statSync(join(dir, 'control-password')).mode & 0o777;
  assert.equal(mode, 0o600, 'the data dir gets copied around; the credential in it must not be readable');
});

/*
 * Value: protects=a half-written control-tokens.json costs the MC one login
 *   rather than stopping the server from starting;
 *   fails_when=loadTokens stops guarding the JSON parse, or a bad file is
 *   allowed to validate — a power cut during a save would then either crash
 *   the box an hour before trivia or hand out a stale session;
 *   why_new=the restart test only covers a well-formed file, and the comment
 *   on loadTokens names the corrupt case as the one it is swallowing;
 *   seam=none;
 *   no_claim=says nothing about concurrent writers or partial token lists.
 */
/*
 * Value: protects=a saved session token is no more readable than the password
 *   it stands in for;
 *   fails_when=saveTokens stops forcing 0600 — writeFileSync only applies mode
 *   when it creates a file, so a token file that ever existed with looser
 *   permissions would keep them while holding live bearer tokens, in a data
 *   dir the code comments describe as routinely copied off the box;
 *   why_new=the password-file mode test explicitly disclaims this file;
 *   seam=none;
 *   no_claim=says nothing about the directory's own permissions.
 */
test('the saved token file is no more readable than the password file', { skip: asRoot ? 'permission bits do not apply to root' : false }, () => {
  const dir = freshDir();
  const auth = new ControlAuth({ password: 'clubhouse-thursday', dir });
  assert.ok(auth.login('clubhouse-thursday'), 'a login is what writes the file');
  assert.equal(statSync(join(dir, 'control-tokens.json')).mode & 0o777, 0o600, 'a live session token is a credential too');

  // Written again on the next login: mode is only honoured on create, so this
  // is the rewrite that used to keep whatever permissions were already there.
  assert.ok(auth.login('clubhouse-thursday'));
  assert.equal(statSync(join(dir, 'control-tokens.json')).mode & 0o777, 0o600, 'including on every rewrite, not just the first');
});

test('a corrupt token file costs one login, not a boot', () => {
  const dir = freshDir();
  const first = new ControlAuth({ password: 'clubhouse-thursday', dir });
  const stale = first.login('clubhouse-thursday')!;

  // What a power cut mid-save leaves behind.
  writeFileSync(join(dir, 'control-tokens.json'), '{"passwordHash":"dead","tok');

  const restarted = new ControlAuth({ password: 'clubhouse-thursday', dir });
  assert.equal(restarted.valid(stale), false, 'a file that cannot be read must not be trusted');

  const fresh = restarted.login('clubhouse-thursday');
  assert.ok(fresh, 'and the MC can simply type the password again');
  assert.equal(
    new ControlAuth({ password: 'clubhouse-thursday', dir }).valid(fresh),
    true,
    'that login should also repair the file, so the next restart is quiet',
  );
});

test('too short to be a password falls through to the next source', () => {
  const dir = freshDir();
  const auth = new ControlAuth({ password: 'ab', legacyPin: '4242', dir });
  assert.equal(auth.password, '4242', 'a two-character password is a typo, not a choice');
  assert.match(auth.warning ?? '', /PRIMETIME_PASSWORD/, 'and the operator has to be told it was ignored');
});

/*
 * Value: protects=a password file an operator wrote by hand is never replaced
 *   by a generated one, and they are told when the value in it was not usable;
 *   fails_when=the generated-password write stops checking for an existing
 *   file, or the rejection stops setting a warning — either way the operator
 *   types what they put in the file, is refused, and has nothing on screen
 *   explaining why the server adopted a different password;
 *   why_new=the generate-once test only covers an empty directory, so the
 *   collision between "too short, fall through" and "generate and persist"
 *   was never exercised; seam=none;
 *   no_claim=says nothing about a file that is present but unreadable.
 */
test('a short password in the file is refused, not overwritten', () => {
  const dir = freshDir();
  const file = join(dir, 'control-password');
  writeFileSync(file, 'abc\n');

  const auth = new ControlAuth({ dir });
  assert.equal(auth.generated, true, 'three characters is not a usable password');
  assert.notEqual(auth.password, 'abc');
  assert.equal(
    readFileSync(file, 'utf8'),
    'abc\n',
    "the operator's own file must survive: replacing it hides the mistake",
  );
  assert.match(auth.warning ?? '', /shorter than 4/, 'and the banner has to say why their password does not work');
  assert.equal(auth.persisted, false, 'nothing was written, so the banner must not claim it was saved');
});

/*
 * Value: protects=a password file the server cannot read is reported rather
 *   than treated as an absent one;
 *   fails_when=readIfPresent's catch goes back to being indistinguishable from
 *   "no file" — an operator who ran `sudo vi control-password` then gets a new
 *   generated password every boot with nothing on screen explaining it;
 *   why_new=sibling of the short-password case through a different branch: the
 *   value is unreadable rather than rejected; seam=none;
 *   no_claim=says nothing about a file readable but holding a valid password.
 */
test('an unreadable password file is reported, not treated as missing', { skip: asRoot ? 'permission bits do not apply to root' : false }, () => {
  const dir = freshDir();
  const file = join(dir, 'control-password');
  writeFileSync(file, 'clubhouse-thursday\n');
  chmodSync(file, 0o000);
  try {
    const auth = new ControlAuth({ dir });
    assert.equal(auth.generated, true, 'it could not read the configured password');
    assert.match(auth.warning ?? '', /could not be read/, 'so it has to say so rather than look like a fresh box');
    assert.equal(auth.persisted, false, 'and it must not overwrite the file it could not read');
  } finally {
    chmodSync(file, 0o600);
  }
});

test('a password file holding only comments is reported too', () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'control-password'), '# put the password here\n\n');
  const auth = new ControlAuth({ dir });
  assert.equal(auth.generated, true);
  assert.match(auth.warning ?? '', /no password line/, 'an operator who left the template unfilled should be told');
});

test('an unwritable data dir still boots, and says the password will not stick', { skip: asRoot ? 'permission bits do not apply to root' : false }, () => {
  const dir = freshDir();
  chmodSync(dir, 0o500); // readable, not writable
  try {
    const auth = new ControlAuth({ dir });
    assert.ok(auth.password.length >= 8, 'the box still has to start an hour before trivia');
    assert.ok(auth.login(auth.password), 'and the printed password still works for this run');
    assert.match(auth.warning ?? '', /different after every restart/, 'but the operator must know it will not persist');
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('a login survives a restart, and a password change ends it', () => {
  const dir = freshDir();
  const auth = new ControlAuth({ password: 'clubhouse-thursday', dir });
  const token = auth.login('clubhouse-thursday');
  assert.ok(token);

  // The clubhouse box gets restarted mid-evening. The MC should not be thrown
  // back to a login screen by that, which is indistinguishable from a timeout.
  const restarted = new ControlAuth({ password: 'clubhouse-thursday', dir });
  assert.equal(restarted.valid(token), true, 'a restart must not sign the MC out');

  const changed = new ControlAuth({ password: 'a-different-password', dir });
  assert.equal(changed.valid(token), false, 'changing the password must sign every device out');
});

test('a near miss is rejected, whatever its length', () => {
  const auth = new ControlAuth({ password: 'a-deliberately-long-host-password' });
  assert.equal(auth.login(''), undefined);
  assert.equal(auth.login('a-deliberately-l'), undefined, 'the first 16 characters must not be enough');
  assert.equal(auth.login('a-deliberately-long-host-passwor'), undefined);
  assert.equal(auth.login('A-Deliberately-Long-Host-Password'), undefined, 'case matters');
  assert.ok(auth.login('a-deliberately-long-host-password'), 'the real one still works');
});

test('without a directory it still works, just without persistence', () => {
  const auth = new ControlAuth({ password: 'in-memory-only' });
  const token = auth.login('in-memory-only');
  assert.ok(token);
  assert.equal(auth.valid(token), true);
});
