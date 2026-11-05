import type * as vscode from 'vscode';
import { activate as activateShared, deactivate as deactivateShared, type ZenwaveExtensionApi } from '../activate.js';
import { WEB_CAPABILITIES } from '../host/capabilities.js';
import { WorkerLanguageServerHost } from './language-server.js';

/**
 * Web (Web Worker extension host) entry point — vscode.dev, github.dev and
 * browser-based Codespaces.
 *
 * Nothing reachable from here may import a Node API.
 */
export async function activate(context: vscode.ExtensionContext): Promise<ZenwaveExtensionApi> {
  const languageServer = new WorkerLanguageServerHost(context);
  const located = await languageServer.locateServer(undefined);
  return activateShared(
    context,
    { ...WEB_CAPABILITIES, languageServer: located.kind === 'absent' ? 'none' : 'worker' },
    { languageServer },
  );
}

export function deactivate(): void {
  deactivateShared();
}
