import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinTargets, normalizePublicUrl, wifiInfo } from './join.js';

// What a hundred people type into a phone. The LAN path can only be tested by
// faking interfaces, so these functions were pulled out to be testable plain.

test('a bare host is taken as https, which is what an operator means', () => {
  assert.equal(normalizePublicUrl('trivia.gmdeckard.com').url, 'https://trivia.gmdeckard.com');
  assert.equal(normalizePublicUrl('  trivia.gmdeckard.com  ').url, 'https://trivia.gmdeckard.com');
});

test('an explicit scheme and port are kept', () => {
  assert.equal(normalizePublicUrl('https://trivia.example.com').url, 'https://trivia.example.com');
  assert.equal(normalizePublicUrl('http://gmdeckard.com:8080').url, 'http://gmdeckard.com:8080');
});

test('a default port is dropped and a path is discarded', () => {
  // Every route hangs off the root, so a path here only ever 404s.
  assert.equal(normalizePublicUrl('https://trivia.example.com:443').url, 'https://trivia.example.com');
  assert.equal(normalizePublicUrl('https://trivia.example.com/trivia/').url, 'https://trivia.example.com');
});

test('nothing configured is not an error', () => {
  assert.deepEqual(normalizePublicUrl(undefined), {});
  assert.deepEqual(normalizePublicUrl('   '), {});
});

test('an unusable value is reported rather than silently dropped', () => {
  // Silence here would put the server's own private address on the big screen
  // with nothing on it to say why.
  assert.match(normalizePublicUrl('ws://trivia.example.com').error ?? '', /http or https/);
  assert.match(normalizePublicUrl('http://').error ?? '', /not a URL|no host/);
});

test('a configured public URL is the only thing advertised', () => {
  const t = joinTargets({
    publicUrl: 'https://trivia.gmdeckard.com',
    lan: ['10.1.0.4', '169.254.9.9'],
    port: 8080,
  });
  assert.equal(t.url, 'https://trivia.gmdeckard.com');
  // The private LAN address must not ride along: a screen showing a domain
  // and an IP sends half the room to the wrong one.
  assert.deepEqual(t.urls, ['https://trivia.gmdeckard.com']);
  assert.equal(t.isPublic, true);
});

test('two names are both kept, the first one canonical', () => {
  const r = normalizePublicUrl('trivia.gmdeckard.com, trivia2.gmdeckard.com');
  assert.equal(r.url, 'https://trivia.gmdeckard.com');
  assert.deepEqual(r.urls, ['https://trivia.gmdeckard.com', 'https://trivia2.gmdeckard.com']);
  assert.equal(r.error, undefined);
});

test('a duplicate name is not advertised twice', () => {
  const r = normalizePublicUrl('trivia.gmdeckard.com, https://trivia.gmdeckard.com/');
  assert.deepEqual(r.urls, ['https://trivia.gmdeckard.com']);
});

test('one bad name is reported and the good ones survive', () => {
  // The whole box dropping back to a private address over a typo in the
  // second name is the failure this avoids, and it would happen at ten to
  // seven.
  const r = normalizePublicUrl('trivia.gmdeckard.com, ws://trivia2.gmdeckard.com');
  assert.deepEqual(r.urls, ['https://trivia.gmdeckard.com']);
  assert.match(r.error ?? '', /http or https/);
});

test('the QR code follows the name the screen was opened with', () => {
  // The point of the whole thing: a room scans the code off the big screen,
  // so it has to send them to the address in that screen's own address bar.
  const configured = ['https://trivia.gmdeckard.com', 'https://trivia2.gmdeckard.com'];
  const onSecond = joinTargets({
    publicUrls: configured,
    requestHost: 'trivia2.gmdeckard.com',
    lan: ['10.1.0.4'],
    port: 8080,
  });
  assert.equal(onSecond.url, 'https://trivia2.gmdeckard.com');
  // Both names still ride in `urls`, which is what the start-up banner prints.
  assert.deepEqual(onSecond.urls, configured);
  assert.equal(onSecond.isPublic, true);

  const onFirst = joinTargets({ publicUrls: configured, requestHost: 'trivia.gmdeckard.com', lan: [], port: 8080 });
  assert.equal(onFirst.url, 'https://trivia.gmdeckard.com');
});

test('a Host with a port still matches, and case does not matter', () => {
  const configured = ['https://trivia.gmdeckard.com', 'https://trivia2.gmdeckard.com'];
  assert.equal(
    joinTargets({ publicUrls: configured, requestHost: 'TRIVIA2.GMDECKARD.COM:443', lan: [], port: 8080 }).url,
    'https://trivia2.gmdeckard.com',
  );
});

test('an unconfigured Host gets the canonical name, not itself', () => {
  // An allowlist and not an echo. A forged Host must not put a stranger's
  // domain into a QR code a room is about to scan.
  const configured = ['https://trivia.gmdeckard.com', 'https://trivia2.gmdeckard.com'];
  for (const host of ['evil.example.com', '', undefined]) {
    assert.equal(
      joinTargets({ publicUrls: configured, requestHost: host, lan: [], port: 8080 }).url,
      'https://trivia.gmdeckard.com',
    );
  }
});

test('a Host header changes nothing on the LAN path', () => {
  // No public name configured means the room is on the venue's own network and
  // the Host is a private address the server already worked out itself.
  const t = joinTargets({ requestHost: 'trivia.gmdeckard.com', lan: ['192.168.1.50'], port: 8080 });
  assert.equal(t.url, 'http://192.168.1.50:8080');
  assert.equal(t.isPublic, false);
});

test('with no public URL the LAN addresses are used, best first', () => {
  const t = joinTargets({ lan: ['192.168.1.50', '172.18.0.1'], port: 8080 });
  assert.equal(t.url, 'http://192.168.1.50:8080');
  assert.deepEqual(t.urls, ['http://192.168.1.50:8080', 'http://172.18.0.1:8080']);
  assert.equal(t.isPublic, false);
});

test('no addresses at all still yields something the operator can open', () => {
  const t = joinTargets({ lan: [], port: 8080 });
  assert.equal(t.url, 'http://localhost:8080');
  assert.deepEqual(t.urls, []);
});

test('wifi is shown only when it was configured', () => {
  // It used to default to the travel router the game was carried in with,
  // which named a network that is not being broadcast on any other deployment.
  assert.deepEqual(wifiInfo({}), {});
  assert.deepEqual(wifiInfo({ PRIMETIME_SSID: '   ' }), {});
  assert.deepEqual(wifiInfo({ PRIMETIME_SSID_ALT: 'orphan-5G' }), {});
});

test('a configured network carries its alt radio and password', () => {
  assert.deepEqual(
    wifiInfo({
      PRIMETIME_SSID: 'primetime-trivia',
      PRIMETIME_SSID_ALT: 'primetime-trivia-5G',
      PRIMETIME_WIFI_PASSWORD: 'delpueblo',
    }),
    { ssid: 'primetime-trivia', ssidAlt: 'primetime-trivia-5G', wifiPassword: 'delpueblo' },
  );
  assert.deepEqual(wifiInfo({ PRIMETIME_SSID: 'Clubhouse-Guest' }), {
    ssid: 'Clubhouse-Guest',
    ssidAlt: undefined,
    wifiPassword: undefined,
  });
});
