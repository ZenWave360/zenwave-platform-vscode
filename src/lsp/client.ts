import type * as vscode from 'vscode';
// Types only: the value exports of the bare package are the Node build. Host
// entry points import `vscode-languageclient/node` or `/browser` themselves.
import type { BaseLanguageClient, LanguageClientOptions } from 'vscode-languageclient';
import type { LspTransport } from './supervisor.js';

/** Which kind of server process a host runs. `none` is a host or build with no server. */
export type LanguageServerTransport = 'ipc' | 'worker' | 'none';

export type ServerLocation =
  | { readonly kind: 'found'; readonly location: string; readonly description: string }
  /** Nothing to run in this build: a clean fallback, not a failure. */
  | { readonly kind: 'absent'; readonly reason: string }
  /** The user pointed at something that cannot be run: a failure to start. */
  | { readonly kind: 'invalid'; readonly reason: string };

export interface ClientCallbacks {
  /** The connection closed or errored outside a requested stop. */
  readonly onClosed: (reason: string) => void;
}

/** What a host entry point supplies: how to find its server and how to connect to it. */
export interface LanguageServerHost {
  readonly transport: Exclude<LanguageServerTransport, 'none'>;
  locateServer(serverPath: string | undefined): Promise<ServerLocation>;
  createClient(location: string, options: LanguageClientOptions, callbacks: ClientCallbacks): HostClient;
}

export interface HostClient {
  readonly client: BaseLanguageClient;
  /** Releases what the host created beyond the client (a Worker, for instance). */
  dispose(): void;
}

export const CLIENT_ID = 'zenwave.lsp';
export const CLIENT_NAME = 'ZenWave Language Server';

export interface ServerRequestHandler {
  readonly method: string;
  readonly handle: (params: unknown) => Promise<unknown>;
}

/**
 * Adapts a `vscode-languageclient` client to the supervisor's transport. The
 * client does not restart the server on its own and shows no notifications:
 * the supervisor owns the lifecycle and the extension owns what the user sees.
 */
export function languageClientTransport(
  host: LanguageServerHost,
  location: string,
  options: LanguageClientOptions,
  handlers: readonly ServerRequestHandler[],
): LspTransport {
  let exitListener: ((reason: string) => void) | undefined;
  let stopping = false;
  const created = host.createClient(location, options, {
    onClosed: (reason) => { if (!stopping) exitListener?.(reason); },
  });
  const { client } = created;
  for (const handler of handlers) client.onRequest(handler.method, (params: unknown) => handler.handle(params));
  return {
    start: async () => {
      await client.start();
      return client.initializeResult;
    },
    stop: async () => {
      stopping = true;
      try {
        if (client.needsStop()) await client.stop(2000);
      } catch {
        // A server that already went away cannot be shut down politely.
      } finally {
        created.dispose();
      }
    },
    sendRequest: (method, params) => client.sendRequest(method, params),
    onDidExit: (listener) => {
      exitListener = listener;
      return { dispose: () => { if (exitListener === listener) exitListener = undefined; } };
    },
  };
}

export interface SharedClientOptions {
  readonly documentSelector: NonNullable<LanguageClientOptions['documentSelector']>;
  readonly initializationOptions: unknown;
  readonly outputChannel: vscode.OutputChannel;
  readonly traceOutputChannel: vscode.OutputChannel;
  readonly synchronize: { fileEvents: vscode.FileSystemWatcher[] };
}

export function sharedClientOptions(
  documentSelector: SharedClientOptions['documentSelector'],
  initializationOptions: unknown,
  outputChannel: vscode.OutputChannel,
  fileEvents: vscode.FileSystemWatcher[],
): SharedClientOptions {
  return {
    documentSelector,
    initializationOptions,
    outputChannel,
    traceOutputChannel: outputChannel,
    synchronize: { fileEvents },
  };
}
