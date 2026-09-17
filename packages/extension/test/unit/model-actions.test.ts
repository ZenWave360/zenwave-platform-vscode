import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandAvailability } from '../../src/model/availability.js';
import { applyReplacement, minimalReplacement, withLineEnding } from '../../src/model/text-replacement.js';

const ALL = ['zenwave/symbolAt', 'zenwave/forwardReferences', 'zenwave/reverseReferences', 'zenwave/organizeZflServices'];

test('availability distinguishes no server, a starting server and a server without the request', () => {
  assert.equal(commandAvailability('Organize', ['zenwave/organizeZflServices'],
    { status: { kind: 'connected' }, advertisedRequests: ALL }).kind, 'available');

  const none = commandAvailability('Organize', ['zenwave/organizeZflServices'],
    { status: { kind: 'no-server', reason: 'no language server transport is available in this host' }, advertisedRequests: [] });
  assert.equal(none.kind, 'no-server');
  assert.match('message' in none ? none.message : '', /needs the ZenWave language server.*no language server transport/);

  const disabled = commandAvailability('Organize', ['zenwave/organizeZflServices'],
    { status: { kind: 'disabled', reason: 'zenwave.lsp.enabled is off' }, advertisedRequests: ALL });
  assert.equal(disabled.kind, 'no-server', 'advertised requests of a server that is not connected do not count');

  assert.match((commandAvailability('Organize', [], { status: { kind: 'starting' }, advertisedRequests: [] }) as { message: string }).message,
    /still starting/);

  const older = commandAvailability('Go to what this references', ['zenwave/symbolAt', 'zenwave/forwardReferences'],
    { status: { kind: 'connected' }, advertisedRequests: ['zenwave/forwardReferences'], serverVersion: '0.0.9' });
  assert.equal(older.kind, 'unsupported');
  assert.deepEqual('missing' in older ? older.missing : [], ['zenwave/symbolAt']);
  assert.match('message' in older ? older.message : '', /not supported by the connected ZenWave language server \(0\.0\.9\): it does not offer zenwave\/symbolAt/);
});

test('a rewrite becomes the smallest replacement that reproduces it', () => {
  const current = 'systems {\n  service S {\n    commands: a\n  }\n}\n';
  const next = 'systems {\n  service S {\n    commands: a, b\n  }\n}\n';
  const replacement = minimalReplacement(current, next);
  assert.deepEqual(replacement, { start: current.indexOf('\n  }'), end: current.indexOf('\n  }'), text: ', b' });
  assert.equal(applyReplacement(current, replacement!), next);
  assert.equal(minimalReplacement(current, current), undefined, 'equal text is no edit at all');
});

test('replacements never split a CRLF or a surrogate pair, and reproduce the result', () => {
  const cases: [string, string][] = [
    ['a\r\nb', 'a\r\nc\r\nb'],
    ['a\r\n', 'a\r\n\r\n'],
    ['x\u{1F600}y', 'x\u{1F601}y'],
    ['', 'new'],
    ['old', ''],
    ['aaa', 'aaaa'],
    ['abcabc', 'abc'],
  ];
  for (const [current, next] of cases) {
    const replacement = minimalReplacement(current, next)!;
    assert.equal(applyReplacement(current, replacement), next, JSON.stringify([current, next]));
    for (const [text, offset] of [[current, replacement.start], [current, replacement.end]] as const) {
      const before = text.charCodeAt(offset - 1);
      assert.ok(!(before === 13 && text.charCodeAt(offset) === 10), `split CRLF in ${JSON.stringify(text)} at ${offset}`);
      assert.ok(!(before >= 0xd800 && before <= 0xdbff), `split surrogate in ${JSON.stringify(text)} at ${offset}`);
    }
  }
});

test('a server answer in LF compares equal to an unchanged CRLF document', () => {
  assert.equal(withLineEnding('a\nb\n', '\r\n'), 'a\r\nb\r\n');
  assert.equal(withLineEnding('a\r\nb\n', '\n'), 'a\nb\n');
  assert.equal(minimalReplacement('a\r\nb\r\n', withLineEnding('a\nb\n', '\r\n')), undefined);
});

test('each model action is offered only with a connected server advertising its requests, and organize only for ZFL', () => {
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')) as {
    contributes: { commands: { command: string }[]; menus: Record<string, { command: string; when?: string }[]> };
  };
  const expectations: Record<string, { requests: string[]; language: RegExp }> = {
    'zenwave.model.forwardReferences': { requests: ['zenwave/symbolAt', 'zenwave/forwardReferences'], language: /editorLangId =~ \/\^\(zdl\|zfl\)\$\// },
    'zenwave.model.reverseReferences': { requests: ['zenwave/symbolAt', 'zenwave/reverseReferences'], language: /editorLangId =~ \/\^\(zdl\|zfl\)\$\// },
    'zenwave.zfl.organizeServices': { requests: ['zenwave/organizeZflServices'], language: /editorLangId == zfl/ },
  };
  for (const [command, expected] of Object.entries(expectations)) {
    assert.ok(manifest.contributes.commands.some((item) => item.command === command), `${command} is contributed`);
    for (const menu of ['commandPalette', 'editor/context']) {
      const entries = (manifest.contributes.menus[menu] ?? []).filter((item) => item.command === command);
      assert.equal(entries.length, 1, `${command} in ${menu}`);
      const when = entries[0]!.when ?? '';
      assert.match(when, /zenwave\.languageServerAvailable/, `${command} in ${menu}: ${when}`);
      assert.match(when, expected.language, `${command} in ${menu}: ${when}`);
      for (const request of expected.requests) {
        assert.ok(when.includes(`'${request}' in zenwave.languageServerRequests`), `${command} in ${menu} needs ${request}: ${when}`);
      }
    }
  }
  assert.ok(!manifest.contributes.commands.some((item) => item.command === 'zenwave.model.conceptsAt'),
    'conceptsAt is not offered while no server answers a concepts-at-a-position request');
});
