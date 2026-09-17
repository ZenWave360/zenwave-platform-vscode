import * as vscode from 'vscode';
import { activate as activateShared, deactivate as deactivateShared, type ZenwaveExtensionApi } from '../activate.js';
import { DESKTOP_CAPABILITIES } from '../host/capabilities.js';
import { NodeLanguageServerHost } from './language-server.js';
import { NodeSdkProcessService } from './sdk-process.js';

/**
 * Desktop (Node extension host) entry point.
 *
 * This file is the only place allowed to reach for Node APIs. Keep it thin:
 * construct host-specific services, hand them to the shared activation, and let
 * feature code stay host-agnostic.
 */
export async function activate(context: vscode.ExtensionContext): Promise<ZenwaveExtensionApi> {
  const languageServer = new NodeLanguageServerHost(context);
  const serverPath = vscode.workspace.getConfiguration('zenwave.lsp').get<string>('serverPath', '').trim() || undefined;
  const located = await languageServer.locateServer(serverPath);
  return activateShared(
    context,
    { ...DESKTOP_CAPABILITIES, languageServer: located.kind === 'absent' ? 'none' : 'ipc' },
    { sdkProcess: new NodeSdkProcessService(), languageServer },
  );
}

export function deactivate(): void {
  deactivateShared();
}
