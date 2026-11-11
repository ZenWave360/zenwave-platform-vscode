import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseManifest,
  describeManifest,
  hasScheme,
  initializationOptions,
  isAbsolutePath,
  isRemoteManifest,
  literalGlob,
  manifestDocumentUri,
  manifestFilters,
  parseManifestUrl,
  projectManifestOf,
  relativeSegments,
  sameInitialization,
} from '../../src/lsp/manifest-resolution.js';

test('project-manifest is read the way zenwave-lsp ZenwaveWorkspaceConfig reads it', () => {
  assert.equal(projectManifestOf('project-manifest: arcadia-editions-architecture/zenwave-architecture.yml\n'),
    'arcadia-editions-architecture/zenwave-architecture.yml');
  assert.equal(projectManifestOf('# comment\nproperties:\n  a: b\nproject-manifest: m.yml # the manifest\r\n'), 'm.yml');
  assert.equal(projectManifestOf('project-manifest:\n'), undefined);
  assert.equal(projectManifestOf('other: x'), undefined);
});

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
const configFolder = {
  folderName: 'b', folderUri: 'file:///d%3A/b',
  config: { configUri: 'file:///d%3A/b/.zenwave/config.yml', manifestUri: 'file:///d%3A/b/architecture/zenwave-architecture.yml' },
};

test('the setting is authoritative and nothing else is used', () => {
  const resolved = chooseManifest([configFolder, settingFolder]);
  assert.equal(resolved.route, 'setting');
  assert.equal(resolved.manifestUri, 'file:///c%3A/a/arch.yml');
  assert.equal(resolved.configUri, undefined);
  assert.ok(resolved.notes.some((note) => note.includes('not consulted')));
  assert.match(describeManifest(resolved), /from the zenwave\.workspace\.manifest setting \(folder "a"\)/);
});

test('a folder configuration is used when no setting names a manifest', () => {
  const resolved = chooseManifest([{ folderName: 'x', folderUri: 'file:///x' }, configFolder]);
  assert.deepEqual(resolved, {
    route: 'config', manifestUri: configFolder.config.manifestUri, configUri: configFolder.config.configUri, folderName: 'b', notes: [],
  });
  assert.match(describeManifest(resolved), /zenwave-architecture\.yml, from file:\/\/\/d%3A\/b\/\.zenwave\/config\.yml/);
});

test('multi-root folders without a common ancestor resolve once, first folder wins, and the rest is said', () => {
  const second = {
    folderName: 'c', folderUri: 'file:///e%3A/c',
    config: { configUri: 'file:///e%3A/c/.zenwave/config.yml', manifestUri: 'file:///e%3A/c/other.yml' },
  };
  const resolved = chooseManifest([configFolder, second]);
  assert.equal(resolved.manifestUri, configFolder.config.manifestUri);
  assert.equal(resolved.notes.length, 1);
  assert.match(resolved.notes[0]!, /other\.yml; ignored, folder "b" comes first/);
  assert.match(describeManifest(resolved), /note: /);
});

test('the same setting inherited by every folder is not reported as a conflict', () => {
  const resolved = chooseManifest([settingFolder, { ...settingFolder, folderName: 'a2' }]);
  assert.deepEqual(resolved.notes, []);
});

test('no configuration starts without a manifest and says so', () => {
  const resolved = chooseManifest([{
    folderName: 'x', folderUri: 'file:///x', config: { configUri: 'file:///x/.zenwave/config.yml', problem: "has no 'project-manifest'; ignored" },
  }]);
  assert.equal(resolved.route, 'none');
  assert.equal(resolved.manifestUri, undefined);
  assert.match(describeManifest(resolved), /starting without a manifest/);
  assert.match(describeManifest(resolved), /has no 'project-manifest'/);
  assert.deepEqual(chooseManifest([]), { route: 'none', notes: [] });
});

test('initialization options carry the shape the server parses, and a changed manifest means a new initialisation', () => {
  const config = chooseManifest([configFolder]);
  assert.deepEqual(initializationOptions(config, true), {
    zenwave: {
      configUri: configFolder.config.configUri,
      projectManifestUri: configFolder.config.manifestUri,
      clientCapabilities: { credentialRequest: true },
    },
  });
  assert.deepEqual(initializationOptions(chooseManifest([]), false), { zenwave: { clientCapabilities: { credentialRequest: false } } });
  assert.equal(sameInitialization(config, { ...config, notes: ['x'] }), true);
  assert.equal(sameInitialization(config, chooseManifest([settingFolder])), false);
});

test('a manifest file name never widens into a glob', () => {
  assert.equal(literalGlob('zenwave-architecture.yml'), 'zenwave-architecture.yml');
  assert.equal(literalGlob('arch[1]*{a,b}.yml'), 'arch?1???a?b?.yml');
});

test('a session choice takes the place of the setting, outranks the configuration and is described as unsaved', () => {
  const resolved = chooseManifest([configFolder, settingFolder], 'https://example.org/zenwave-architecture.yml');
  assert.equal(resolved.route, 'override');
  assert.equal(resolved.manifestUri, 'https://example.org/zenwave-architecture.yml');
  assert.ok(resolved.notes.some((note) => note.includes('session choice comes first')));
  assert.match(describeManifest(resolved), /for this session \(not saved\)/);
  assert.deepEqual(chooseManifest([], 'https://example.org/m.yml').notes, []);
});

test('the order is override, setting, configuration, none', () => {
  assert.equal(chooseManifest([configFolder, settingFolder], 'file:///o.yml').route, 'override');
  assert.equal(chooseManifest([configFolder, settingFolder]).route, 'setting');
  assert.equal(chooseManifest([configFolder]).route, 'config');
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
});
