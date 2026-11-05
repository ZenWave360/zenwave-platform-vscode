import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  RevealOutputChannelOn,
  TransportKind,
  type LanguageClientOptions,
} from 'vscode-languageclient/node';
import { CLIENT_ID, CLIENT_NAME, type LanguageServerHost, type ServerLocation } from '../lsp/client.js';

/** Where the build copies `@zenwave360/lsp-js/node` inside the extension. */
export const BUNDLED_NODE_SERVER = 'dist/server/node/zenwave-lsp-server.js';

/** The extension reports what it sees; notifications are the extension's decision, not the client's. */
class QuietLanguageClient extends LanguageClient {
  override error(message: string, data?: unknown): void {
    super.error(message, data, false);
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Desktop: `@zenwave360/lsp-js` forked as a Node child process, spoken to over IPC. */
export class NodeLanguageServerHost implements LanguageServerHost {
  readonly transport = 'ipc' as const;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get bundledServer(): string {
    return this.context.asAbsolutePath(BUNDLED_NODE_SERVER);
  }

  async locateServer(serverPath: string | undefined): Promise<ServerLocation> {
    if (serverPath) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const resolved = path.isAbsolute(serverPath) || !folder || folder.uri.scheme !== 'file'
        ? path.resolve(serverPath)
        : path.resolve(folder.uri.fsPath, serverPath);
      return isFile(resolved)
        ? { kind: 'found', location: resolved, description: `${resolved} (zenwave.lsp.serverPath)` }
        : { kind: 'invalid', reason: `zenwave.lsp.serverPath names ${resolved}, which is not a file` };
    }
    return isFile(this.bundledServer)
      ? { kind: 'found', location: this.bundledServer, description: `${this.bundledServer} (shipped with the extension)` }
      : { kind: 'absent', reason: `this build ships no language server (${BUNDLED_NODE_SERVER} is missing)` };
  }

  createClient(location: string, options: LanguageClientOptions, callbacks: { onClosed(reason: string): void }) {
    const module = { module: location, transport: TransportKind.ipc };
    const client = new QuietLanguageClient(CLIENT_ID, CLIENT_NAME, { run: module, debug: module }, {
      ...options,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      initializationFailedHandler: () => false,
      connectionOptions: { maxRestartCount: 0 },
      errorHandler: {
        error: () => ({ action: ErrorAction.Continue, handled: true }),
        closed: () => {
          callbacks.onClosed('the language server process exited');
          return { action: CloseAction.DoNotRestart, handled: true };
        },
      },
    });
    return { client, dispose: () => {} };
  }
}
