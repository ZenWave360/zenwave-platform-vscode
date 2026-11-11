/**
 * What the `zenwave:` scheme means to the client, without an editor.
 *
 * The server owns the scheme: it decides what an address resolves to, where the
 * bytes come from and what a failure says (AR-R4 to AR-R6). Nothing here
 * resolves or fetches; it turns the server's answers into what the provider
 * and the opening command need, so those stay thin and this stays testable.
 */
import type { RequestResult } from './supervisor.js';
import type { ResourceContent, ResourceStat } from './requests.js';

export const ZENWAVE_SCHEME = 'zenwave';

/** The address the server serves a remote manifest under (AR-Q1). The leading dot is a segment no owner id has. */
export const REMOTE_MANIFEST_ADDRESS = 'zenwave:/.zenwave-manifest.yml';
export const REMOTE_MANIFEST_PATH = '/.zenwave-manifest.yml';

export type ResourceFailureReason = 'too-old' | 'not-declared' | 'unresolved' | 'no-server' | 'failed';

export interface ResourceFailure {
  readonly reason: ResourceFailureReason;
  readonly message: string;
}

interface Candidate { readonly source?: unknown; readonly url?: unknown; readonly message?: unknown }

function candidatesOf(data: unknown): string[] {
  const list = (data as { candidates?: unknown } | null | undefined)?.candidates;
  if (!Array.isArray(list)) return [];
  return list.map((entry: Candidate) => {
    const where = `${typeof entry?.source === 'string' ? entry.source : 'source'} ${typeof entry?.url === 'string' ? entry.url : ''}`.trim();
    return typeof entry?.message === 'string' ? `${where}: ${entry.message}` : where;
  });
}

/**
 * Why a `zenwave/statResource` or `zenwave/readResource` did not answer, in words for the user, or `undefined` when it did.
 * A server too old for the request is told apart from a file that is missing (LC-R6).
 */
export function resourceFailure(uri: string, result: RequestResult): ResourceFailure | undefined {
  switch (result.kind) {
    case 'ok': return undefined;
    case 'unsupported':
      return { reason: 'too-old', message: `The ZenWave language server is too old to serve ${uri}: it does not answer ${result.method}. Update the extension or the server.` };
    case 'no-server':
      return { reason: 'no-server', message: `No ZenWave language server is running to serve ${uri}: ${result.reason}` };
    case 'failed': {
      const kind = (result.data as { kind?: unknown } | null | undefined)?.kind;
      if (kind === 'resourceNotDeclared') {
        return { reason: 'not-declared', message: `${uri} is not declared by the architecture manifest` };
      }
      if (kind === 'resourceUnresolved') {
        const tried = candidatesOf(result.data);
        return { reason: 'unresolved', message: tried.length > 0 ? `No source could produce ${uri}. Tried:\n${tried.map((line) => `  ${line}`).join('\n')}` : `No source could produce ${uri}` };
      }
      return { reason: 'failed', message: `${uri}: ${result.reason}` };
    }
  }
}

/** Where an address is opened: the plain `file:` document the server named for a workspace-resolved entry, otherwise through the scheme (AR-R4). */
export function openTarget(stat: ResourceStat, address: string): { readonly via: 'file' | 'zenwave'; readonly uri: string } {
  return stat.source.kind === 'workspace' && typeof stat.source.fileUri === 'string' && stat.source.fileUri.length > 0
    ? { via: 'file', uri: stat.source.fileUri }
    : { via: 'zenwave', uri: address };
}

/** The bytes of a `zenwave/readResource` answer. */
export function contentBytes(content: ResourceContent): Uint8Array {
  if (content.encoding === 'utf8') return new TextEncoder().encode(content.content);
  const binary = atob(content.content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
