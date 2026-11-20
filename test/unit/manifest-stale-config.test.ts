import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

// resolveWorkspaceManifest() needs `vscode`, which exists only inside the editor: a stand-in whose folder holds a stale
// `.zenwave/config.yml` naming a manifest, and which records every file the resolution touches.
const touched: string[] = [];
const uri = (value: string) => ({ toString: () => value, path: value.replace('file://', '') });
const folder = { name: 'w', index: 0, uri: { ...uri('file:///w'), scheme: 'file' } };
const vscodeStub = {
  Uri: {
    parse: (value: string) => uri(value),
    file: (value: string) => uri(`file://${value}`),
    joinPath: (base: { toString(): string }, ...segments: string[]) => uri([base.toString(), ...segments].join('/')),
  },
  workspace: {
    workspaceFolders: [folder],
    getConfiguration: () => ({ inspect: () => undefined, get: () => undefined }),
    fs: {
      stat: async (target: { toString(): string }) => { touched.push(`stat ${target.toString()}`); return {}; },
      readFile: async (target: { toString(): string }) => {
        touched.push(`read ${target.toString()}`);
        return new TextEncoder().encode('project-manifest: stale.yml\n');
      },
    },
  },
};
const moduleInternals = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = moduleInternals._load;
moduleInternals._load = function load(request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, ...rest);
};

test('a stale .zenwave/config.yml in the folder is neither read nor used', async () => {
  const { resolveWorkspaceManifest } = await import('../../src/lsp/manifest.js');
  const resolved = await resolveWorkspaceManifest();
  assert.equal(resolved.route, 'none');
  assert.equal(resolved.manifestUri, undefined);
  assert.deepEqual(touched, []);
  assert.ok(!resolved.notes.some((note) => note.includes('config.yml')));
});
