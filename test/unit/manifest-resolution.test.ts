import assert from 'node:assert/strict';
import test from 'node:test';
import {
  architectureSettings,
  chooseManifest,
  describeManifest,
  hasScheme,
  initializationOptions,
  isAbsolutePath,
  isPlainRemoteManifestName,
  isRemoteManifest,
  literalGlob,
  manifestDocumentUri,
  manifestFilters,
  parseManifestUrl,
  relativeSegments,
  resolveRemoteManifestName,
  sameArchitectureSettings,
  sameInitialization,
} from '../../src/lsp/manifest-resolution.js';
import { DEFAULT_REMOTE_MANIFEST_NAME } from '../../src/lsp/resources.js';

test('references are classified without file-system path handling', () => {
  assert.equal(hasScheme('https://example.com/m.yml'), true);
  assert.equal(hasScheme('vscode-vfs://github/o/r/m.yml'), true);
  assert.equal(hasScheme('C:\\work\\m.yml'), false, 'a drive letter is not a scheme');
  assert.equal(isAbsolutePath('C:\\work\\m.yml'), true);
  assert.equal(isAbsolutePath('/work/m.yml'), true);
  assert.equal(isAbsolutePath('arch/m.yml'), false);
  assert.deepEqual(relativeSegments('./arch\\sub//m.yml'), ['arch', 'sub', 'm.yml']);
});

const settingFolder = {
  folderName: 'a', folderUri: 'file:///c%3A/a',
  setting: { value: 'arch.yml', manifestUri: 'file:///c%3A/a/arch.yml' },
};
test('the setting is authoritative, and the first folder that has one wins', () => {
  const second = { folderName: 'b', folderUri: 'file:///d%3A/b', setting: { value: 'other.yml', manifestUri: 'file:///d%3A/b/other.yml' } };
  const resolved = chooseManifest([{ folderName: 'x', folderUri: 'file:///x' }, settingFolder, second]);
  assert.equal(resolved.route, 'setting');
  assert.equal(resolved.manifestUri, 'file:///c%3A/a/arch.yml');
  assert.equal(resolved.notes.length, 1);
  assert.match(resolved.notes[0]!, /other\.yml; ignored, folder "a" comes first/);
  assert.match(describeManifest(resolved), /from the zenwave\.workspace\.manifest setting \(folder "a"\)/);
});

test('the same setting inherited by every folder is not reported as a conflict', () => {
  const resolved = chooseManifest([settingFolder, { ...settingFolder, folderName: 'a2' }]);
  assert.deepEqual(resolved.notes, []);
});

test('no setting starts without a manifest and says so', () => {
  const resolved = chooseManifest([{ folderName: 'x', folderUri: 'file:///x' }]);
  assert.equal(resolved.route, 'none');
  assert.equal(resolved.manifestUri, undefined);
  assert.match(describeManifest(resolved), /starting without a manifest/);
  assert.doesNotMatch(describeManifest(resolved), /config\.yml/);
  assert.deepEqual(chooseManifest([]), { route: 'none', notes: [] });
});

test('initialization options carry the shape the server parses, and a changed manifest means a new initialisation', () => {
  const config = chooseManifest([settingFolder]);
  assert.deepEqual(initializationOptions(config, true), {
    zenwave: {
      projectManifestUri: settingFolder.setting.manifestUri,
      clientCapabilities: { credentialRequest: true },
      remoteManifestName: '.zenwave-manifest.yml',
      allowedDomains: [],
    },
  });
  assert.deepEqual(initializationOptions(chooseManifest([]), false), {
    zenwave: {
      clientCapabilities: { credentialRequest: false },
      remoteManifestName: '.zenwave-manifest.yml',
      allowedDomains: [],
    },
  });
  assert.equal(sameInitialization(config, { ...config, notes: ['x'] }), true);
  assert.equal(sameInitialization(config, chooseManifest([])), false);
});

test('initialization options always send the remote manifest name and the allowed domains', () => {
  const custom = initializationOptions(chooseManifest([]), true, undefined, {
    remoteManifestName: ' architecture.yml ',
    allowedDomains: [' github.com ', '', 'github.com', '*.githubusercontent.com', ' *.githubusercontent.com ', 12, null],
  });
  assert.deepEqual(custom.zenwave, {
    clientCapabilities: { credentialRequest: true },
    remoteManifestName: 'architecture.yml',
    allowedDomains: ['github.com', '*.githubusercontent.com'],
  });
  // A name that is not a plain file name is replaced before it is sent, so the server is given the same name.
  const rejectedName = initializationOptions(chooseManifest([]), true, undefined, {
    remoteManifestName: '../secret.yml',
    allowedDomains: ['GitHub.com', 'github.com'],
  });
  assert.equal(rejectedName.zenwave.remoteManifestName, '.zenwave-manifest.yml');
  assert.deepEqual(rejectedName.zenwave.allowedDomains, ['github.com'],
    'GitHub.com is lowercased and collapses with github.com before it is sent');
  assert.equal('remoteManifestNameWarning' in rejectedName.zenwave, false, 'the warning is logged by the client, not sent');
  assert.deepEqual(architectureSettings('  ', 'github.com'), {
    remoteManifestName: '.zenwave-manifest.yml',
    allowedDomains: [],
    remoteManifestNameWarning: "remoteManifestName '  ' is not a plain file name; using '.zenwave-manifest.yml'",
  });
  assert.deepEqual(architectureSettings(undefined, undefined), {
    remoteManifestName: '.zenwave-manifest.yml',
    allowedDomains: [],
  });
  assert.equal(architectureSettings(null, []).remoteManifestNameWarning, undefined);
});

test('a remote manifest name that is not a plain file name falls back and warns, and the selector stays one file', () => {
  const rejected = [
    '', ' ', '.', '..', '...', '../secret.yml', 'foo/../bar.yml', 'a/b.yml', 'a\\b.yml', 'a%2e.yml', 'x..y.yml',
    'a#fragment', 'a?query', 'arch*.yml', 'arch[1].yml', 'pre{a,b}.yml', 'a]b.yml', '*',
    'a\nb.yml', 'a\rb.yml', 'a\tb.yml', 'a\u0000b.yml', 'a\u007Fb.yml', 'a\u009Fb.yml',
    'a'.repeat(256),
  ];
  const local = (uri: string): { scheme: string; pattern: string } => ({ scheme: 'file', pattern: uri });
  for (const raw of rejected) {
    const resolved = resolveRemoteManifestName(raw);
    assert.equal(resolved.name, DEFAULT_REMOTE_MANIFEST_NAME, JSON.stringify(raw));
    assert.equal(resolved.warning, `remoteManifestName '${raw}' is not a plain file name; using '${DEFAULT_REMOTE_MANIFEST_NAME}'`, JSON.stringify(raw));
    assert.equal(manifestDocumentUri('https://example.org/m.yml', raw), 'zenwave:/.zenwave-manifest.yml', JSON.stringify(raw));
    assert.deepEqual(manifestFilters('https://example.org/m.yml', local, raw), [{ scheme: 'zenwave', pattern: '/.zenwave-manifest.yml' }], JSON.stringify(raw));
    assert.equal(isPlainRemoteManifestName(raw.trim()), false, JSON.stringify(raw));
  }
  const accepted = ['architecture.yml', '.custom.yml', '.zenwave-manifest.yml', 'my manifest.yml', 'a'.repeat(255)];
  for (const raw of accepted) {
    const resolved = resolveRemoteManifestName(raw);
    assert.equal(resolved.name, raw, raw);
    assert.equal(resolved.warning, undefined, raw);
    assert.equal(isPlainRemoteManifestName(raw), true, raw);
  }
  assert.deepEqual(resolveRemoteManifestName('  architecture.yml  '), { name: 'architecture.yml' });
  assert.equal(resolveRemoteManifestName(undefined).warning, undefined);
  assert.equal(resolveRemoteManifestName(12).name, DEFAULT_REMOTE_MANIFEST_NAME);
  assert.equal(sameArchitectureSettings(architectureSettings('../secret.yml', []), architectureSettings('arch*.yml', [])), true,
    'two rejected names initialise the server the same way');
  assert.equal(sameArchitectureSettings(architectureSettings('architecture.yml', []), architectureSettings('*', [])), false);
});

test('a change of the remote manifest name or the allowed domains is a new initialisation', () => {
  const current = architectureSettings('.zenwave-manifest.yml', ['github.com']);
  assert.equal(sameArchitectureSettings(current, architectureSettings('  .zenwave-manifest.yml  ', [' github.com ', 'github.com', ''])), true);
  assert.deepEqual(architectureSettings('.zenwave-manifest.yml', ['GitHub.com']).allowedDomains, ['github.com']);
  assert.equal(sameArchitectureSettings(current, architectureSettings('.zenwave-manifest.yml', ['GitHub.com'])), true,
    'GitHub.com and github.com initialise the server the same way');
  assert.equal(sameArchitectureSettings(current, architectureSettings('architecture.yml', ['github.com'])), false);
  assert.equal(sameArchitectureSettings(current, architectureSettings('.zenwave-manifest.yml', ['github.com', '*.githubusercontent.com'])), false);
  assert.equal(sameArchitectureSettings(current, architectureSettings('.zenwave-manifest.yml', [])), false);
});

test('a manifest file name never widens into a glob', () => {
  assert.equal(literalGlob('zenwave-architecture.yml'), 'zenwave-architecture.yml');
  assert.equal(literalGlob('arch[1]*{a,b}.yml'), 'arch?1???a?b?.yml');
});

test('a session choice takes the place of the setting, outranks the setting and is described as unsaved', () => {
  const resolved = chooseManifest([settingFolder], 'https://example.org/zenwave-architecture.yml');
  assert.equal(resolved.route, 'override');
  assert.equal(resolved.manifestUri, 'https://example.org/zenwave-architecture.yml');
  assert.ok(resolved.notes.some((note) => note.includes('session choice comes first')));
  assert.match(describeManifest(resolved), /for this session \(not saved\)/);
  assert.deepEqual(chooseManifest([], 'https://example.org/m.yml').notes, []);
});

test('the order is override, setting, none', () => {
  assert.equal(chooseManifest([settingFolder], 'file:///o.yml').route, 'override');
  assert.equal(chooseManifest([settingFolder]).route, 'setting');
  assert.equal(chooseManifest([]).route, 'none');
});

test('URL accepts http and https addresses only', () => {
  assert.deepEqual(parseManifestUrl('  https://example.org/a/zenwave-architecture.yml '), { url: 'https://example.org/a/zenwave-architecture.yml' });
  assert.deepEqual(parseManifestUrl('http://localhost:8080/m.yml'), { url: 'http://localhost:8080/m.yml' });
  for (const refused of ['', 'ftp://example.org/m.yml', 'file:///m.yml', 'example.org/m.yml', 'https://', 'https://a b/m.yml', 'C:\\m.yml']) {
    assert.ok('problem' in parseManifestUrl(refused), refused + ' is refused');
  }
});

test('a remote manifest is served as the zenwave: document and selected by exact scheme and path', () => {
  const local = (uri: string): { scheme: string; pattern: string } => ({ scheme: 'file', pattern: uri });
  assert.equal(isRemoteManifest('https://example.org/m.yml'), true);
  assert.equal(isRemoteManifest('file:///c%3A/m.yml'), false);
  assert.equal(manifestDocumentUri('https://example.org/m.yml'), 'zenwave:/.zenwave-manifest.yml');
  assert.equal(manifestDocumentUri('file:///m.yml'), 'file:///m.yml');
  assert.deepEqual(manifestFilters('https://example.org/m.yml', local), [{ scheme: 'zenwave', pattern: '/.zenwave-manifest.yml' }]);
  assert.deepEqual(manifestFilters('file:///m.yml', local), [{ scheme: 'file', pattern: 'file:///m.yml' }]);
  assert.deepEqual(manifestFilters(undefined, local), []);
  assert.equal(manifestDocumentUri('https://example.org/m.yml', ' architecture.yml '), 'zenwave:/architecture.yml');
  assert.equal(manifestDocumentUri('file:///m.yml', 'architecture.yml'), 'file:///m.yml');
  assert.deepEqual(manifestFilters('https://example.org/m.yml', local, 'architecture.yml'), [{ scheme: 'zenwave', pattern: '/architecture.yml' }]);
  assert.equal(manifestDocumentUri('https://example.org/m.yml', '  '), 'zenwave:/.zenwave-manifest.yml');
});
