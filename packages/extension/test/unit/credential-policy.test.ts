import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredOrigin,
  decideCredential,
  originOf,
  readCredentialOrigins,
  readCredentialRequest,
  redact,
  type CredentialOrigin,
} from '../../src/lsp/credential-policy.js';

const { origins } = readCredentialOrigins([
  { origin: 'https://github.com', source: 'github' },
  { origin: 'https://artifacts.example.com:8443', source: 'stored', key: 'PRIVATE-TOKEN' },
]);

function ask(uri: string, origin = originOf(uri) ?? uri, list: readonly CredentialOrigin[] = origins) {
  return decideCredential({ uri, origin, attempt: 'initial' }, list);
}

test('origins are compared as scheme, host and port together', () => {
  assert.equal(originOf('HTTPS://GitHub.com:443/o/r/raw/main/m.zdl?x=1#f'), 'https://github.com');
  assert.equal(originOf('http://example.com:80/'), 'http://example.com');
  assert.equal(originOf('https://example.com:8443/a'), 'https://example.com:8443');
  assert.equal(originOf('file:///etc/passwd'), undefined);
  assert.equal(originOf('https://github.com@evil.example/'), undefined, 'user information is refused outright');
  assert.equal(originOf('not a url'), undefined);
});

test('only a bare origin can be authorised', () => {
  assert.equal(configuredOrigin(' https://GitHub.com/ '), 'https://github.com');
  for (const broad of ['https://github.com/org', 'https://*.github.com', 'github.com', 'https://github.com?x', 'ftp://github.com', '.*']) {
    assert.equal(configuredOrigin(broad), undefined, broad);
  }
  const read = readCredentialOrigins([{ origin: 'github.com' }, { origin: 'https://ok.example' }, 'junk']);
  assert.equal(read.origins.length, 1);
  assert.equal(read.problems.length, 2);
  assert.deepEqual(read.origins[0], { origin: 'https://ok.example', source: 'stored', type: 'HEADER', key: 'Authorization', valuePrefix: '' });
  assert.equal(origins[0]!.valuePrefix, 'Bearer ');
});

test('an authorised origin is released with its own configuration, and only that one', () => {
  const decision = ask('https://github.com/acme/orders/raw/main/model.zdl');
  assert.equal(decision.release, true);
  if (decision.release) assert.equal(decision.entry.source, 'github');
  const port = ask('https://artifacts.example.com:8443/repo/x.yml');
  assert.equal(port.release && port.entry.key, 'PRIVATE-TOKEN');
  assert.equal(port.release && port.entry.origin, 'https://artifacts.example.com:8443');
});

test('a manifest naming an unauthorised host is refused, with the reason', () => {
  const decision = ask('https://attacker.example/steal');
  assert.equal(decision.release, false);
  if (!decision.release) assert.match(decision.reason, /https:\/\/attacker\.example is not an origin the user authorised/);
});

test('lookalike hosts, other ports and other schemes are refused', () => {
  for (const uri of [
    'https://github.com.attacker.example/x',
    'https://attacker.example/github.com/x',
    'https://notgithub.com/x',
    'https://github.com:8443/x',
    'http://github.com/x',
    'https://artifacts.example.com/repo/x.yml',
    'https://raw.githubusercontent.com/o/r/main/x',
  ]) {
    assert.equal(ask(uri).release, false, uri);
  }
});

test('a stated origin that disagrees with the URL is refused, as a redirect to another origin would be', () => {
  assert.equal(ask('https://attacker.example/x', 'https://github.com').release, false);
  assert.equal(ask('https://github.com/x', 'https://github.com/').release, true);
  assert.equal(ask('https://github.com/x', 'https://github.com/x').release, false);
});

test('malformed requests are refused and logged locations never carry a query', () => {
  assert.equal(readCredentialRequest(null), undefined);
  assert.equal(readCredentialRequest({ uri: 'https://github.com', origin: 'https://github.com', attempt: 'later' }), undefined);
  assert.deepEqual(readCredentialRequest({ uri: 'https://github.com/x', origin: 'https://github.com', attempt: 'rejected', status: 401 }),
    { uri: 'https://github.com/x', origin: 'https://github.com', attempt: 'rejected', status: 401 });
  assert.equal(redact('https://example.com/a/b?private_token=secret#frag'), 'https://example.com/a/b');
});
