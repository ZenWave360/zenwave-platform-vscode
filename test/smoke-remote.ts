import * as vscode from 'vscode';
import type { LanguageServerApi } from '../src/lsp/feature.js';

/** The loopback server scripts/smoke-remote.mjs starts: test/fixtures/remote over http, with CORS, no internet. */
export const REMOTE_PORT = 47813;
export const REMOTE_MANIFEST = `http://127.0.0.1:${REMOTE_PORT}/arch/zenwave-architecture.yml`;

const OPENAPI = 'zenwave:/orders/0.1.0/openapi.yml';
const ZDL = 'zenwave:/orders/0.1.0/domain-model.zdl';
const README = 'zenwave:/orders/0.1.0/README.md';
const REMOTE_MANIFEST_DOCUMENT = 'zenwave:/.zenwave-manifest.yml';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, message: string, ms = 90000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(message);
    await delay(250);
  }
}

async function connected(api: LanguageServerApi, message: string): Promise<void> {
  await api.settled();
  await waitFor(() => api.status.kind === 'connected' || api.status.kind === 'failed' || api.status.kind === 'no-server',
    `${message}: language server did not settle`);
  assert(api.status.kind === 'connected', `${message}: ${JSON.stringify(api.status)}`);
}

async function rejectedAsReadOnly(operation: string, body: () => Thenable<unknown>): Promise<void> {
  try {
    await body();
  } catch (error) {
    assert(error instanceof vscode.FileSystemError && error.code === 'NoPermissions', `${operation} was not refused as read-only: ${String(error)}`);
    return;
  }
  throw new Error(`${operation} on a zenwave: document succeeded`);
}

async function opened(api: LanguageServerApi, address: string, name: string, languageId: string): Promise<vscode.TextDocument> {
  const outcome = await api.openResource(address);
  assert(outcome.kind === 'opened' && outcome.via === 'zenwave', `Opening ${address}: ${JSON.stringify(outcome)}`);
  const editor = vscode.window.activeTextEditor;
  assert(editor?.document.uri.toString() === address, `${address} is not the active editor: ${editor?.document.uri.toString()}`);
  assert(vscode.window.tabGroups.activeTabGroup.activeTab?.label === name, `The tab of ${address} is "${vscode.window.tabGroups.activeTabGroup.activeTab?.label}", not "${name}"`);
  assert(editor.document.languageId === languageId, `${address} opened as ${editor.document.languageId}, not ${languageId}`);
  return editor.document;
}

/**
 * AN/4.1 to AN/4.3, against a loopback http server (scripts/smoke-remote.mjs): the manifest is a URL, the server serves
 * `zenwave:` documents from it, the provider is read-only, and only model documents and the manifest reach the server.
 * With a folder open the choice is written to the workspace setting; without one it is a session override and nothing is
 * written.
 */
export async function remoteArchitecture(api: LanguageServerApi, hasFolder: boolean): Promise<void> {
  assert((vscode.workspace.workspaceFolders?.length ?? 0) > 0 === hasFolder, `Expected ${hasFolder ? 'a' : 'no'} workspace folder`);
  await connected(api, 'Before choosing a remote manifest');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  const chosen = await api.chooseManifest({ url: REMOTE_MANIFEST });
  assert(chosen.kind === 'chosen' && chosen.scope === (hasFolder ? 'setting' : 'session') && chosen.manifest === REMOTE_MANIFEST, `Choosing: ${JSON.stringify(chosen)}`);
  await connected(api, 'Restart with the remote manifest');
  assert(api.manifest.manifestUri === REMOTE_MANIFEST && api.manifest.route === (hasFolder ? 'setting' : 'override'), `Manifest: ${JSON.stringify(api.manifest)}`);
  const setting = vscode.workspace.getConfiguration('zenwave.workspace').inspect<string>('manifest');
  assert(hasFolder ? setting?.workspaceValue === REMOTE_MANIFEST : setting?.workspaceValue === undefined && setting?.globalValue === undefined,
    `Setting after choosing: ${JSON.stringify(setting)}`);
  for (const request of ['zenwave/statResource', 'zenwave/readResource']) {
    assert(api.advertisedRequests.includes(request), `The server does not advertise ${request}`);
  }
  console.log(`PASS: Choose Architecture Manifest… with ${hasFolder ? 'a folder writes the workspace setting' : 'no folder keeps a session override and writes nothing'}, and the server restarts with the URL`);

  // A remote OpenAPI file opens under the scheme with its own name and language, and the server is never sent it.
  const openapi = await opened(api, OPENAPI, 'openapi.yml', 'yaml');
  assert(openapi.getText().includes('Remote Orders API'), `The OpenAPI content: ${openapi.getText()}`);
  const readme = await opened(api, README, 'README.md', 'markdown');
  assert(readme.getText().includes('Remote Orders'), `The Markdown content: ${readme.getText()}`);
  await delay(2000);
  assert(!api.sentToServer.includes(OPENAPI) && !api.sentToServer.includes(README), `A non-model document reached the server: ${api.sentToServer.join()}`);
  console.log('PASS: a remote openapi.yml and README.md open under zenwave: with their file names and language ids, and no didOpen reached the server');

  // Every write is refused.
  const uri = vscode.Uri.parse(OPENAPI, true);
  assert((await vscode.workspace.fs.stat(uri)).permissions === vscode.FilePermission.Readonly, 'The provider does not report the document read-only');
  await rejectedAsReadOnly('writeFile', () => vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('changed')));
  await rejectedAsReadOnly('delete', () => vscode.workspace.fs.delete(uri));
  await rejectedAsReadOnly('rename', () => vscode.workspace.fs.rename(uri, vscode.Uri.parse('zenwave:/orders/0.1.0/renamed.yml', true)));
  await rejectedAsReadOnly('createDirectory', () => vscode.workspace.fs.createDirectory(vscode.Uri.parse('zenwave:/orders/0.1.0/new', true)));
  console.log('PASS: the zenwave: provider rejects every write and reports the document read-only');

  // A remote ZDL is a model document: sent to the server, which answers for it.
  const zdl = await opened(api, ZDL, 'domain-model.zdl', 'zdl');
  assert(zdl.getText().includes('RemoteOrder'), `The ZDL content: ${zdl.getText()}`);
  await waitFor(() => api.sentToServer.includes(ZDL), `A zenwave: ZDL was not sent to the server: ${api.sentToServer.join()}`, 30000);
  const hierarchy = await waitFor(async () => {
    const answer = await api.requests.hierarchy(ZDL);
    return answer.kind === 'ok' && JSON.stringify(answer.value).includes('RemoteOrder') ? answer : undefined;
  }, 'The server has no hierarchy for the remote ZDL', 30000);
  assert(hierarchy.kind === 'ok', 'unreachable');
  console.log('PASS: a remote domain-model.zdl opens as zdl, is sent to the server and has a hierarchy');

  // The remote manifest is a document too, selected by exact scheme and path, and read-only.
  await vscode.commands.executeCommand('zenwave.explorer.openManifest');
  await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === REMOTE_MANIFEST_DOCUMENT, `The manifest did not open as ${REMOTE_MANIFEST_DOCUMENT}: ${vscode.window.activeTextEditor?.document.uri.toString()}`, 30000);
  await waitFor(() => api.sentToServer.includes(REMOTE_MANIFEST_DOCUMENT), `The remote manifest was not sent to the server: ${api.sentToServer.join()}`, 30000);
  await rejectedAsReadOnly('writeFile on the manifest', () => vscode.workspace.fs.writeFile(vscode.Uri.parse(REMOTE_MANIFEST_DOCUMENT, true), new TextEncoder().encode('domains: {}')));
  console.log('PASS: the remote manifest opens as zenwave:/.zenwave-manifest.yml, is sent to the server and cannot be written');

  // An address the manifest does not declare is refused, not reported missing.
  const refused = await api.openResource('zenwave:/other/1.0.0/x.yml');
  assert(refused.kind === 'failed' && refused.reason === 'not-declared', `An undeclared address: ${JSON.stringify(refused)}`);
  console.log('PASS: an undeclared zenwave: address is refused as not declared');

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  if (hasFolder) {
    await vscode.workspace.getConfiguration('zenwave.workspace').update('manifest', undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor(() => api.manifest.route !== 'setting', 'Manifest resolution did not leave the remote setting');
    await connected(api, 'Restored the workspace manifest');
  }
}
