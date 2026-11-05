import { documentFailure, ZENWAVE_REQUESTS } from '../lsp/requests.js';
import type { RequestResult } from '../lsp/supervisor.js';
import type { StateAction, StatePresentation } from './protocol.js';

/**
 * Why a diagram editor shows what it shows. Keyed on what happened to the
 * request, never on what the view model contains: the extension does not read
 * the model (see the spec, "The view model passes through the extension untouched").
 */
export type DataState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'rendered' }
  | { readonly kind: 'no-server'; readonly reason: string }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'unreadable'; readonly problems: readonly string[] }
  | { readonly kind: 'not-found'; readonly reason: string }
  | { readonly kind: 'unsupported-document'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

export type PageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly protocolVersion: number }
  | { readonly kind: 'failed'; readonly message: string };

export type DiagramStateKind = DataState['kind'] | 'page-failed';

/** Every explained state: each but `rendered` has its own wording and actions. */
export const DIAGRAM_STATE_KINDS: readonly DiagramStateKind[] = [
  'loading', 'rendered', 'no-server', 'unsupported', 'unreadable', 'not-found', 'unsupported-document', 'failed', 'page-failed',
];

export const SHOW_OUTPUT: StateAction = { label: 'Show Output', command: 'zenwave.showOutput' };
export const SHOW_STATUS: StateAction = { label: 'Show Language Server Status', command: 'zenwave.lsp.showStatus' };
export const SHOW_PROBLEMS: StateAction = { label: 'Show Problems', command: 'workbench.actions.view.problems' };

function diagnosticMessage(diagnostic: unknown): string | undefined {
  const message = typeof diagnostic === 'object' && diagnostic !== null ? (diagnostic as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : undefined;
}

/** What a document request's answer (`eventFlowViews`, `preview`) means for the editor. */
export function dataStateFromResult(result: RequestResult<unknown>): DataState {
  switch (result.kind) {
    case 'ok': return { kind: 'rendered' };
    case 'no-server': return { kind: 'no-server', reason: result.reason };
    case 'unsupported': return { kind: 'unsupported' };
    case 'failed': {
      const failure = documentFailure(result);
      if (failure?.kind === 'documentUnreadable') {
        return { kind: 'unreadable', problems: failure.diagnostics.map(diagnosticMessage).filter((message): message is string => message !== undefined) };
      }
      if (failure?.kind === 'documentNotFound') return { kind: 'not-found', reason: result.reason };
      if (failure?.kind === 'unsupportedDocument') return { kind: 'unsupported-document', reason: result.reason };
      return { kind: 'failed', reason: result.reason };
    }
  }
}

/** One line for the output channel. Names the document and the outcome; never the model. */
export function describeOutcome(fileName: string, state: DataState): string {
  const subject = `EventFlow diagram for ${fileName}`;
  switch (state.kind) {
    case 'loading': return `${subject}: producing`;
    case 'rendered': return `${subject}: rendered`;
    case 'no-server': return `${subject}: needs the ZenWave language server, which is not available (${state.reason})`;
    case 'unsupported': return `${subject}: the connected ZenWave language server does not offer ${ZENWAVE_REQUESTS.eventFlowViews}`;
    case 'unreadable': return `${subject}: the language server could not read the document` +
      (state.problems.length > 0 ? ` (${state.problems.length} problem${state.problems.length === 1 ? '' : 's'}: ${state.problems.join('; ')})` : '');
    case 'not-found': return `${subject}: the language server has not received the document (${state.reason})`;
    case 'unsupported-document': return `${subject}: the language server does not produce flow views for it (${state.reason})`;
    case 'failed': return `${subject}: ${ZENWAVE_REQUESTS.eventFlowViews} failed: ${state.reason}`;
  }
}

/**
 * What the editor shows over the page, or `null` for nothing. With a diagram
 * already on screen a failure becomes a banner above it, so typing through a
 * broken declaration never blanks the diagram.
 */
export function presentState(fileName: string, page: PageState, data: DataState, hasDiagram: boolean): StatePresentation | null {
  if (page.kind === 'failed') {
    return {
      mode: 'overlay', kind: 'page-failed', title: 'The EventFlow diagram page could not be loaded.',
      detail: `${page.message}\nReinstalling or updating the ZenWave extension restores it; the details are in the ZenWave output.`,
      actions: [SHOW_OUTPUT],
    };
  }
  const mode = hasDiagram ? 'banner' : 'overlay';
  const kept = hasDiagram ? ' Showing the last diagram produced.' : '';
  switch (data.kind) {
    case 'rendered': return null;
    case 'loading':
      return hasDiagram ? null : { mode, kind: 'loading', title: `Producing the flow diagram for ${fileName}…`, actions: [] };
    case 'no-server':
      return {
        mode, kind: 'no-server', title: `The diagram needs the ZenWave language server, which is not available here.${kept}`,
        detail: `${data.reason}.`, actions: [SHOW_STATUS],
      };
    case 'unsupported':
      return {
        mode, kind: 'unsupported', title: `The connected ZenWave language server cannot produce flow diagrams.${kept}`,
        detail: `It does not offer ${ZENWAVE_REQUESTS.eventFlowViews}. A newer version of the server does.`, actions: [SHOW_STATUS, SHOW_OUTPUT],
      };
    case 'unreadable':
      return {
        mode, kind: 'unreadable', title: `${fileName} could not be read.${kept}`,
        detail: 'Fix the problems reported for it and the diagram follows.', actions: [SHOW_PROBLEMS, SHOW_OUTPUT],
      };
    case 'not-found':
      return {
        mode, kind: 'not-found', title: `The ZenWave language server has not received ${fileName}.${kept}`,
        detail: 'The diagram follows once the document is open in the editor.', actions: [SHOW_OUTPUT],
      };
    case 'unsupported-document':
      return {
        mode, kind: 'unsupported-document', title: `The ZenWave language server does not produce a flow diagram for ${fileName}.${kept}`,
        detail: 'Flow diagrams are produced for ZFL documents.', actions: [SHOW_OUTPUT],
      };
    case 'failed':
      return {
        mode, kind: 'failed', title: `The flow diagram could not be produced.${kept}`,
        detail: 'The reason is recorded in the ZenWave output.', actions: [SHOW_OUTPUT],
      };
  }
}
