import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandAvailability } from '../../src/model/availability.js';
import {
  decideOrganize,
  FULL_ORGANIZE_ACCEPT,
  FULL_ORGANIZE_CONFIRMATION,
  organizeLenses,
  resolveOrganize,
} from '../../src/model/organize.js';
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
    contributes: { commands: { command: string; title?: string }[]; menus: Record<string, { command: string; when?: string }[]> };
  };
  const expectations: Record<string, { requests: string[]; language: RegExp; title: string; capability?: RegExp; hidesCapability?: boolean }> = {
    'zenwave.model.forwardReferences': { requests: ['zenwave/symbolAt', 'zenwave/forwardReferences'], language: /editorLangId =~ \/\^\(zdl\|zw\|zfl\)\$\//, title: 'Go to What This References' },
    'zenwave.model.reverseReferences': { requests: ['zenwave/symbolAt', 'zenwave/reverseReferences'], language: /editorLangId =~ \/\^\(zdl\|zw\|zfl\)\$\//, title: 'Go to What References This' },
    'zenwave.zfl.organizeServices': { requests: ['zenwave/organizeZflServices'], language: /editorLangId == zfl/, title: 'Organize ZFL Services in Full', hidesCapability: true },
    'zenwave.zfl.addMissingServices': { requests: ['zenwave/organizeZflServices'], language: /editorLangId == zfl/, title: 'Add Missing ZFL Services', capability: /zenwave\.organizeModesAvailable/ },
  };
  const titles = new Map(manifest.contributes.commands.map((item) => [item.command, item.title]));
  for (const [command, expected] of Object.entries(expectations)) {
    assert.equal(titles.get(command), expected.title, `${command} title`);
    for (const menu of ['commandPalette', 'editor/context']) {
      const entries = (manifest.contributes.menus[menu] ?? []).filter((item) => item.command === command);
      assert.equal(entries.length, 1, `${command} in ${menu}`);
      const when = entries[0]!.when ?? '';
      assert.match(when, /zenwave\.languageServerAvailable/, `${command} in ${menu}: ${when}`);
      assert.match(when, expected.language, `${command} in ${menu}: ${when}`);
      for (const request of expected.requests) {
        assert.ok(when.includes(`'${request}' in zenwave.languageServerRequests`), `${command} in ${menu} needs ${request}: ${when}`);
      }
      if (expected.capability) assert.match(when, expected.capability, `${command} in ${menu}: ${when}`);
      if (expected.hidesCapability) assert.doesNotMatch(when, /zenwave\.organizeModesAvailable/, `${command} in ${menu} stays available on an older server: ${when}`);
    }
  }
  assert.ok(!manifest.contributes.commands.some((item) => item.command === 'zenwave.model.conceptsAt'),
    'conceptsAt is not offered while no server answers a concepts-at-a-position request');
});

/** A document position, counting a CRLF pair as one line break the way the editor does. */
function point(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let character = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') {
      line++;
      character = 0;
      i++;
    } else if (text[i] === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}

test('organize lenses sit on the systems keyword, above the block, and ignore decoys', () => {
  assert.deepEqual(point('a\r\nb', 3), { line: 1, character: 0 });
  const text = [
    '// systems {',
    '/* systems { */',
    '"systems {"',
    'config {',
    '  systems { name: "x" }',
    '}',
    '/**',
    ' * block comment mentioning systems {',
    ' */',
    '@zdl("orders.zdl")',
    'systems // the brace is on the next line',
    '{',
    '}',
    '',
  ].join('\n');
  const lenses = organizeLenses(text, true);
  assert.deepEqual(lenses.map((lens) => lens.title), ['Add missing', 'Full']);
  assert.deepEqual(lenses.map((lens) => lens.action), ['additive', 'full']);
  assert.equal(lenses[0]!.start, lenses[1]!.start);
  assert.equal(text.slice(lenses[0]!.start, lenses[0]!.end), 'systems');
  assert.deepEqual(point(text, lenses[0]!.start), { line: 10, character: 0 });
  assert.equal(text[lenses[0]!.end], ' ');

  const indented = 'flow F {\r\n}\r\n  systems{\r\n}\r\n';
  const older = organizeLenses(indented, false);
  assert.deepEqual(older.map((lens) => lens.title), ['Full']);
  assert.deepEqual(point(indented, older[0]!.start), { line: 2, character: 2 });
  assert.equal(indented.slice(older[0]!.start, older[0]!.end), 'systems');

  const noBlock = 'flow F {\n  start Go {\n  }\n}\nmysystems {\n}\n';
  assert.deepEqual(organizeLenses(noBlock, true), []);
  assert.deepEqual(organizeLenses(noBlock, false), []);
});

test('the mode sent is additive, full, or absent on an older server', () => {
  assert.deepEqual(decideOrganize('additive', true), { kind: 'send', mode: 'additive' });
  assert.deepEqual(decideOrganize('full', true, 'accepted'), { kind: 'send', mode: 'full' });
  assert.deepEqual(decideOrganize('full', false, 'accepted'), { kind: 'send', mode: undefined });
  assert.deepEqual(decideOrganize('additive', false), { kind: 'unsupported' });
  // A stray answer does not cancel Add missing, and does not change the mode it sends.
  assert.deepEqual(decideOrganize('additive', true, 'cancelled'), { kind: 'send', mode: 'additive' });
});

test('Full asks for confirmation, and cancel sends nothing', () => {
  for (const organizeModes of [true, false]) {
    const pending = decideOrganize('full', organizeModes);
    assert.equal(pending.kind, 'confirm');
    if (pending.kind !== 'confirm') continue;
    assert.equal(pending.message, FULL_ORGANIZE_CONFIRMATION);
    assert.match(pending.message, /also removes .*what no flow uses/);
    assert.equal(pending.accept, FULL_ORGANIZE_ACCEPT);
    assert.deepEqual(decideOrganize('full', organizeModes, 'cancelled'), { kind: 'cancelled' });
  }
  assert.equal(decideOrganize('additive', true).kind, 'send', 'Add missing does not ask');
});

test('an older server shows only Full and is not asked for Add missing', () => {
  const text = 'systems {\n}\n';
  assert.deepEqual(organizeLenses(text, false).map((lens) => lens.action), ['full']);
  assert.deepEqual(organizeLenses(text, true).map((lens) => lens.action), ['additive', 'full']);
  assert.equal(decideOrganize('additive', false).kind, 'unsupported');
  assert.deepEqual(decideOrganize('full', false, 'accepted'), { kind: 'send', mode: undefined });
  // The request decision does not look at the text, so a document with no systems block still sends.
  assert.deepEqual(decideOrganize('additive', true), { kind: 'send', mode: 'additive' });
  assert.deepEqual(organizeLenses('flow Only {\n}\n', true), []);
});

test('Full asks in a modal with its one button, and only that button sends (MA-R5)', async () => {
  for (const organizeModes of [true, false]) {
    const asked: unknown[][] = [];
    const accepted = await resolveOrganize('full', organizeModes, async (message, options, accept) => { asked.push([message, options, accept]); return accept; });
    assert.deepEqual(asked, [[FULL_ORGANIZE_CONFIRMATION, { modal: true }, FULL_ORGANIZE_ACCEPT]]);
    assert.deepEqual(accepted, { kind: 'send', mode: organizeModes ? 'full' : undefined });
    for (const answer of [undefined, 'Cancel', '']) {
      assert.deepEqual(await resolveOrganize('full', organizeModes, async () => answer), { kind: 'cancelled' }, `answer ${String(answer)} cancels`);
    }
  }
});

test('Add missing never asks, and an older server refuses it before asking (MA-R5)', async () => {
  const never = async (): Promise<string | undefined> => { throw new Error('asked'); };
  assert.deepEqual(await resolveOrganize('additive', true, never), { kind: 'send', mode: 'additive' });
  assert.deepEqual(await resolveOrganize('additive', false, never), { kind: 'unsupported' });
});

test('the lens is the top-level systems block, not a flow or start named systems', () => {
  const named = 'flow systems {\n  start systems {\n  }\n}\n';
  assert.deepEqual(organizeLenses(named, true), []);
  const after = 'flow systems {\n}\nsystems {\n}\n';
  const lenses = organizeLenses(after, true);
  assert.equal(lenses.length, 2);
  assert.equal(after.slice(lenses[0]!.start, lenses[0]!.end), 'systems');
  assert.equal(lenses[0]!.start, after.lastIndexOf('systems'));
  const sameLine = 'flow systems { }  systems { }';
  assert.equal(organizeLenses(sameLine, false)[0]!.start, sameLine.lastIndexOf('systems'));
});
