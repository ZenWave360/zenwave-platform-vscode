import type { LanguageServerStatus } from '../lsp/status.js';
import { documentFailure, ZENWAVE_REQUESTS, type HierarchyNode } from '../lsp/requests.js';
import type { RequestResult } from '../lsp/supervisor.js';

/**
 * Why a tree shows what it shows. Published as a context key so `viewsWelcome`
 * can explain an empty tree, and recorded in the output channel when it changes.
 */
export type TreeState =
  | { readonly kind: 'ready'; readonly nodes: number }
  | { readonly kind: 'loading' }
  | { readonly kind: 'no-server'; readonly reason: string }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'no-manifest' }
  | { readonly kind: 'no-model' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'not-found'; readonly reason: string }
  | { readonly kind: 'unreadable'; readonly problems: number }
  | { readonly kind: 'failed'; readonly reason: string };

export type TreeStateKind = TreeState['kind'];

/** Every state; each but `ready` is explained by a `viewsWelcome` entry. */
export const TREE_STATE_KINDS: readonly TreeStateKind[] = [
  'ready', 'loading', 'no-server', 'unsupported', 'no-manifest', 'no-model', 'empty', 'not-found', 'unreadable', 'failed',
];

/** Whether the tree can ask the server at all; `undefined` when it can. */
export function serverUnavailable(status: LanguageServerStatus, advertisedRequests: readonly string[]): TreeState | undefined {
  if (status.kind === 'starting') return { kind: 'loading' };
  if (status.kind !== 'connected') return { kind: 'no-server', reason: status.reason };
  if (!advertisedRequests.includes(ZENWAVE_REQUESTS.hierarchy)) return { kind: 'unsupported' };
  return undefined;
}

/** What a hierarchy answer means for the tree. */
export function stateFromResult(result: RequestResult<readonly HierarchyNode[]>, nodes: number): TreeState {
  switch (result.kind) {
    case 'ok': return nodes > 0 ? { kind: 'ready', nodes } : { kind: 'empty' };
    case 'no-server': return { kind: 'no-server', reason: result.reason };
    case 'unsupported': return { kind: 'unsupported' };
    case 'failed': {
      const failure = documentFailure(result);
      if (failure?.kind === 'documentUnreadable') return { kind: 'unreadable', problems: failure.diagnostics.length };
      if (failure?.kind === 'documentNotFound') return { kind: 'not-found', reason: result.reason };
      if (failure?.kind === 'unsupportedDocument') return { kind: 'empty' };
      return { kind: 'failed', reason: result.reason };
    }
  }
}

/** One line for the output channel; the same state is not logged twice in a row. */
export function describeState(tree: string, subject: string | undefined, state: TreeState): string {
  const about = subject ? ` for ${subject}` : '';
  switch (state.kind) {
    case 'ready': return `${tree} tree: ${state.nodes} node${state.nodes === 1 ? '' : 's'}${about}`;
    case 'loading': return `${tree} tree: waiting for the ZenWave language server to start`;
    case 'no-server': return `${tree} tree is empty: it needs the ZenWave language server, which is not available (${state.reason})`;
    case 'unsupported': return `${tree} tree is empty: the connected ZenWave language server does not offer ${ZENWAVE_REQUESTS.hierarchy}`;
    case 'no-manifest': return `${tree} tree is empty: no architecture manifest was resolved for this workspace (set zenwave.workspace.manifest or project-manifest in .zenwave/config.yml)`;
    case 'no-model': return `${tree} tree is empty: no ZDL or ZFL document has been focused yet`;
    case 'empty': return `${tree} tree is empty: the language server reports no hierarchy${about}`;
    case 'not-found': return `${tree} tree is empty: the language server could not read${subject ? ` ${subject}` : ' the document'} (${state.reason}). ` +
      'A server running in a browser reads only documents that are open in the editor or reachable over http(s).';
    case 'unreadable': return `${tree} tree: the language server could not read${subject ? ` ${subject}` : ' the document'}` +
      `${state.problems > 0 ? ` (${state.problems} problem${state.problems === 1 ? '' : 's'} reported)` : ''}`;
    case 'failed': return `${tree} tree: ${ZENWAVE_REQUESTS.hierarchy} failed${about}: ${state.reason}`;
  }
}

export function sameState(a: TreeState | undefined, b: TreeState): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
