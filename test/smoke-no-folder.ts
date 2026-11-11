import * as vscode from 'vscode';
import type { ZenwaveExtensionApi } from '../src/activate.js';
import { remoteArchitecture } from './smoke-remote.js';

const EXTENSION_ID = 'ZenWave360.zenwave-platform';

/** The smoke in a window with no folder: the manifest choice is a session override and nothing is written to disk. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) throw new Error(`${EXTENSION_ID} was not installed in the test host`);
  await extension.activate();
  const { languageServer } = extension.exports as ZenwaveExtensionApi;
  await remoteArchitecture(languageServer, false);
}
