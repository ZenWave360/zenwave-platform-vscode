import { SHOW_OUTPUT, SHOW_PROBLEMS, SHOW_STATUS, dataStateFromResult, type DataState } from '../eventflow/diagram-state.js';
import type { StatePresentation } from '../eventflow/protocol.js';
import { ZENWAVE_REQUESTS, type Preview } from '../lsp/requests.js';
import type { RequestResult } from '../lsp/supervisor.js';

/**
 * Why a preview shows what it shows (MP-R8). Keyed on what happened to the
 * request, never on what the representations contain. The kinds are the
 * diagram editor's, plus `empty`: the server answered with nothing to show.
 */
export type PreviewDataState = DataState | { readonly kind: 'empty' };

export type PreviewPageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly message: string };

export const PREVIEW_STATE_KINDS: readonly string[] = [
  'loading', 'rendered', 'no-server', 'unsupported', 'unreadable', 'not-found', 'unsupported-document', 'failed', 'empty', 'page-failed',
];

/** What a `preview` answer means for the editor. */
export function previewStateFromResult(result: RequestResult<Preview>): PreviewDataState {
  if (result.kind === 'ok' && result.value.representations.length === 0) return { kind: 'empty' };
  return dataStateFromResult(result);
}

/** One line for the output channel. Names the document and the outcome; never the content. */
export function describePreviewOutcome(fileName: string, state: PreviewDataState): string {
  const subject = `Preview of ${fileName}`;
  switch (state.kind) {
    case 'loading': return `${subject}: requesting`;
    case 'rendered': return `${subject}: received`;
    case 'empty': return `${subject}: the language server returned no representation`;
    case 'no-server': return `${subject}: needs the ZenWave language server, which is not available (${state.reason})`;
    case 'unsupported': return `${subject}: the connected ZenWave language server does not offer ${ZENWAVE_REQUESTS.preview}`;
    case 'unreadable': return `${subject}: the language server could not read the document` +
      (state.problems.length > 0 ? ` (${state.problems.length} problem${state.problems.length === 1 ? '' : 's'}: ${state.problems.join('; ')})` : '');
    case 'not-found': return `${subject}: the language server has not received the document (${state.reason})`;
    case 'unsupported-document': return `${subject}: the language server does not produce a preview for it (${state.reason})`;
    case 'failed': return `${subject}: ${ZENWAVE_REQUESTS.preview} failed: ${state.reason}`;
  }
}

/**
 * What the editor shows over the page, or `null` for nothing. With a preview
 * already on screen a failure becomes a banner above it, so typing through a
 * broken declaration never blanks it.
 */
export function presentPreviewState(fileName: string, page: PreviewPageState, data: PreviewDataState, hasPreview: boolean): StatePresentation | null {
  if (page.kind === 'failed') {
    return {
      mode: 'overlay', kind: 'page-failed', title: 'The preview page could not be loaded.',
      detail: `${page.message}\nReinstalling or updating the ZenWave extension restores it; the details are in the ZenWave output.`,
      actions: [SHOW_OUTPUT],
    };
  }
  const mode = hasPreview ? 'banner' : 'overlay';
  const kept = hasPreview ? ' Showing the last preview produced.' : '';
  switch (data.kind) {
    case 'rendered': return null;
    case 'loading':
      return hasPreview ? null : { mode, kind: 'loading', title: `Producing the preview of ${fileName}…`, actions: [] };
    case 'no-server':
      return {
        mode, kind: 'no-server', title: `The preview needs the ZenWave language server, which is not available here.${kept}`,
        detail: `${data.reason}.`, actions: [SHOW_STATUS],
      };
    case 'unsupported':
      return {
        mode, kind: 'unsupported', title: `The connected ZenWave language server cannot produce previews.${kept}`,
        detail: `It does not offer ${ZENWAVE_REQUESTS.preview}. A newer version of the server does.`, actions: [SHOW_STATUS, SHOW_OUTPUT],
      };
    case 'unreadable':
      return {
        mode, kind: 'unreadable', title: `${fileName} could not be read.${kept}`,
        detail: 'Fix the problems reported for it and the preview follows.', actions: [SHOW_PROBLEMS, SHOW_OUTPUT],
      };
    case 'not-found':
      return {
        mode, kind: 'not-found', title: `The ZenWave language server has not received ${fileName}.${kept}`,
        detail: 'The preview follows once the document is open in the editor.', actions: [SHOW_OUTPUT],
      };
    case 'unsupported-document':
      return {
        mode, kind: 'unsupported-document', title: `The ZenWave language server does not produce a preview for ${fileName}.${kept}`,
        detail: 'Previews are produced for ZDL and ZFL documents.', actions: [SHOW_OUTPUT],
      };
    case 'failed':
      return {
        mode, kind: 'failed', title: `The preview could not be produced.${kept}`,
        detail: 'The reason is recorded in the ZenWave output.', actions: [SHOW_OUTPUT],
      };
    case 'empty':
      return {
        mode, kind: 'empty', title: `The ZenWave language server has nothing to preview for ${fileName}.${kept}`,
        actions: [SHOW_OUTPUT],
      };
  }
}
