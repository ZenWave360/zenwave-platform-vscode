import * as vscode from 'vscode';
import type { ZenwaveRequests } from './requests.js';
import { contentBytes, openTarget, resourceFailure, ZENWAVE_SCHEME, type ResourceFailure } from './resources.js';

const READ_ONLY = 'zenwave: documents are read-only';

function fileSystemError(failure: ResourceFailure): vscode.FileSystemError {
  return failure.reason === 'not-declared' ? vscode.FileSystemError.NoPermissions(failure.message) : vscode.FileSystemError.Unavailable(failure.message);
}

/**
 * The `zenwave:` scheme (LC-R6): a read-only facade over `zenwave/statResource` and `zenwave/readResource`.
 * The server resolves, caches and chooses the source; this class only delivers its answers, so it holds no
 * state and every write is refused.
 */
export class ZenwaveFileSystemProvider implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;

  constructor(private readonly requests: ZenwaveRequests) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const address = uri.toString();
    const result = await this.requests.statResource(address);
    const failure = resourceFailure(address, result);
    if (failure || result.kind !== 'ok') throw fileSystemError(failure ?? { reason: 'failed', message: address });
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: result.value.size, permissions: vscode.FilePermission.Readonly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const address = uri.toString();
    const result = await this.requests.readResource(address);
    const failure = resourceFailure(address, result);
    if (failure || result.kind !== 'ok') throw fileSystemError(failure ?? { reason: 'failed', message: address });
    return contentBytes(result.value);
  }

  readDirectory(uri: vscode.Uri): never { throw vscode.FileSystemError.FileNotFound(uri); }
  createDirectory(): never { throw vscode.FileSystemError.NoPermissions(READ_ONLY); }
  writeFile(): never { throw vscode.FileSystemError.NoPermissions(READ_ONLY); }
  delete(): never { throw vscode.FileSystemError.NoPermissions(READ_ONLY); }
  rename(): never { throw vscode.FileSystemError.NoPermissions(READ_ONLY); }

  dispose(): void { this.changes.dispose(); }
}

export type OpenResourceOutcome =
  | { readonly kind: 'opened'; readonly via: 'file' | 'zenwave'; readonly uri: string }
  | { readonly kind: 'failed'; readonly reason: ResourceFailure['reason']; readonly message: string };

/**
 * Opens an address the way AR-R4 says: the plain `file:` document when the server resolved it to the workspace,
 * otherwise through the scheme. Asks the server once; the read that follows is served from its cache (AR-R10).
 */
export async function openResource(requests: ZenwaveRequests, address: string): Promise<OpenResourceOutcome> {
  const result = await requests.statResource(address);
  const failure = resourceFailure(address, result);
  if (failure || result.kind !== 'ok') return { kind: 'failed', reason: failure?.reason ?? 'failed', message: failure?.message ?? address };
  const target = openTarget(result.value, address);
  try {
    await vscode.window.showTextDocument(vscode.Uri.parse(target.uri, true), { preview: true });
  } catch (error) {
    return { kind: 'failed', reason: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'opened', via: target.via, uri: target.uri };
}

export function registerResourceProvider(context: vscode.ExtensionContext, requests: ZenwaveRequests): void {
  const provider = new ZenwaveFileSystemProvider(requests);
  context.subscriptions.push(
    provider,
    vscode.workspace.registerFileSystemProvider(ZENWAVE_SCHEME, provider, { isCaseSensitive: true, isReadonly: true }),
  );
}
