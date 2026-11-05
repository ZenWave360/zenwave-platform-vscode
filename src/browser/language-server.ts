import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  RevealOutputChannelOn,
  type LanguageClientOptions,
} from 'vscode-languageclient/browser';
import { CLIENT_ID, CLIENT_NAME, type LanguageServerHost, type ServerLocation } from '../lsp/client.js';

/** Where the build copies `@zenwave360/lsp-js/worker` inside the extension. */
export const BUNDLED_WORKER_SERVER = ['dist', 'server', 'browser', 'zenwave-lsp-worker.js'] as const;

/** The part of the DOM `Worker` used here; the extension's type library has no DOM. */
interface WorkerLike {
  addEventListener(type: 'error', listener: (event: { readonly message?: string }) => void): void;
  terminate(): void;
}
declare const Worker: (new (url: string) => WorkerLike) | undefined;

class QuietLanguageClient extends LanguageClient {
  override error(message: string, data?: unknown): void {
    super.error(message, data, false);
  }
}

/** Web: `@zenwave360/lsp-js/worker` in a Web Worker, spoken to with `postMessage`. */
export class WorkerLanguageServerHost implements LanguageServerHost {
  readonly transport = 'worker' as const;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get bundledServer(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, ...BUNDLED_WORKER_SERVER);
  }

  async locateServer(serverPath: string | undefined): Promise<ServerLocation> {
    const ignored = serverPath ? ' (zenwave.lsp.serverPath applies to the desktop host and is ignored here)' : '';
    if (typeof Worker === 'undefined') {
      return { kind: 'absent', reason: `this host cannot create a Web Worker${ignored}` };
    }
    try {
      await vscode.workspace.fs.stat(this.bundledServer);
    } catch {
      return { kind: 'absent', reason: `this build ships no worker language server (${BUNDLED_WORKER_SERVER.join('/')} is missing)${ignored}` };
    }
    const location = this.bundledServer.toString(true);
    return { kind: 'found', location, description: `${location} (shipped with the extension)${ignored}` };
  }

  createClient(location: string, options: LanguageClientOptions, callbacks: { onClosed(reason: string): void }) {
    if (typeof Worker === 'undefined') throw new Error('this host cannot create a Web Worker');
    const worker = new Worker(location);
    let closed = false;
    const close = (reason: string): void => {
      if (closed) return;
      closed = true;
      callbacks.onClosed(reason);
    };
    worker.addEventListener('error', (event) => {
      close(`the language server worker failed: ${event.message || 'script error'}`);
    });
    const client = new QuietLanguageClient(CLIENT_ID, CLIENT_NAME, {
      ...options,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      initializationFailedHandler: () => false,
      connectionOptions: { maxRestartCount: 0 },
      errorHandler: {
        error: () => ({ action: ErrorAction.Continue, handled: true }),
        closed: () => {
          close('the language server worker closed its connection');
          return { action: CloseAction.DoNotRestart, handled: true };
        },
      },
    }, worker);
    return { client, dispose: () => worker.terminate() };
  }
}
