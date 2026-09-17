import type { RequestResult } from './supervisor.js';

/**
 * Typed wrappers for the `zenwave/*` requests the language server answers today.
 *
 * Shapes are taken from the wire samples of `@zenwave360/lsp-js` 0.1.0-SNAPSHOT
 * (zenwave-lsp d7156e7) and the store contract `001-ide-client-contracts`
 * (lsp-visualization-requests). View models and preview content are forwarded
 * unchanged: what they mean belongs to the server and the renderer, so they are
 * typed only as far as a caller needs to route them.
 */
export const ZENWAVE_REQUESTS = {
  hierarchy: 'zenwave/hierarchy',
  forwardReferences: 'zenwave/forwardReferences',
  reverseReferences: 'zenwave/reverseReferences',
  organizeZflServices: 'zenwave/organizeZflServices',
  eventFlowViews: 'zenwave/eventFlowViews',
  preview: 'zenwave/preview',
  symbolAt: 'zenwave/symbolAt',
} as const;

export type ZenwaveRequestMethod = typeof ZENWAVE_REQUESTS[keyof typeof ZENWAVE_REQUESTS];

/** Anything able to issue a request with the four-way result; the supervisor is one. */
export interface RequestIssuer {
  request(method: string, params: unknown): Promise<RequestResult>;
}

export interface LspPosition { readonly line: number; readonly character: number }
export interface LspRange { readonly start: LspPosition; readonly end: LspPosition }

export interface RelatedResource {
  readonly targetKind: string;
  readonly label: string;
  readonly uri: string;
  readonly range?: LspRange;
  readonly category?: string;
  readonly relationType?: string;
}

/** `zenwave/forwardReferences` and `zenwave/reverseReferences` answer these. */
export type NavigationTarget = RelatedResource;

export interface HierarchyNode {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly language?: string;
  readonly sourceUri: string;
  readonly sourceRange: LspRange;
  readonly children: readonly HierarchyNode[];
  readonly relatedResources: readonly RelatedResource[];
  readonly uiHints: Readonly<Record<string, unknown>>;
  /** Ids of the same document's `zenwave/eventFlowViews` nodes and groups; empty when none. */
  readonly viewNodeIds: readonly string[];
}

/** A view model as the server produced it; `schema` names its shape. */
export type ViewModel = { readonly schema: string } & Readonly<Record<string, unknown>>;

export interface EventFlowViews {
  readonly flowGraph: ViewModel;
  readonly serviceGraph: ViewModel;
}

export type SequenceRenderMode = 'SEPARATE_VARIANTS' | 'ALT_BLOCKS' | 'AUTO';

export interface PreviewRepresentation {
  readonly id: string;
  readonly title: string;
  readonly format: 'MARKDOWN' | 'MERMAID' | 'HTML';
  readonly content: string;
}

export interface Preview {
  readonly representations: readonly PreviewRepresentation[];
  readonly defaultRepresentationId: string;
}

export interface SymbolAt {
  readonly uri: string;
  readonly semanticId: string;
  readonly range?: LspRange;
}

/** Why the server could not answer for a document (`data.kind` of a -32803 error). */
export type DocumentFailureKind = 'documentUnreadable' | 'documentNotFound' | 'unsupportedDocument';

export const REQUEST_FAILED = -32803;
export const INVALID_PARAMS = -32602;

export interface DocumentFailure {
  readonly kind: DocumentFailureKind;
  /** LSP diagnostics, present for `documentUnreadable`. */
  readonly diagnostics: readonly unknown[];
}

/**
 * Reads the document failure a ZenWave request reported, if that is what the
 * failure was. Anything else — a timeout, malformed params, an unknown kind — is
 * `undefined`, and the caller treats it as a plain failure.
 */
export function documentFailure(result: RequestResult): DocumentFailure | undefined {
  if (result.kind !== 'failed' || result.code !== REQUEST_FAILED) return undefined;
  const data = result.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const { kind, diagnostics } = data as { kind?: unknown; diagnostics?: unknown };
  if (kind !== 'documentUnreadable' && kind !== 'documentNotFound' && kind !== 'unsupportedDocument') return undefined;
  return { kind, diagnostics: Array.isArray(diagnostics) ? diagnostics : [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows an `ok` answer to the expected top-level shape. A server that answers
 * with something else is reported as a failure rather than handed to a caller
 * that would then fail somewhere less obvious.
 */
function expect<T>(method: string, result: RequestResult, valid: (value: unknown) => boolean): RequestResult<T> {
  if (result.kind !== 'ok') return result;
  return valid(result.value)
    ? { kind: 'ok', value: result.value as T }
    : { kind: 'failed', reason: `Language server answered ${method} with an unexpected shape` };
}

const isArray = (value: unknown): boolean => Array.isArray(value);

/** One typed method per request. Every method answers with the four-way result, never throws. */
export class ZenwaveRequests {
  constructor(private readonly issuer: RequestIssuer) {}

  /** Hierarchy for a document, open or not (a browser-hosted server reads only `http(s)` documents it has not been sent). */
  async hierarchy(uri: string): Promise<RequestResult<readonly HierarchyNode[]>> {
    return expect(ZENWAVE_REQUESTS.hierarchy, await this.issuer.request(ZENWAVE_REQUESTS.hierarchy, { uri }), isArray);
  }

  async forwardReferences(uri: string, semanticId: string): Promise<RequestResult<readonly NavigationTarget[]>> {
    return expect(ZENWAVE_REQUESTS.forwardReferences,
      await this.issuer.request(ZENWAVE_REQUESTS.forwardReferences, { uri, semanticId }), isArray);
  }

  async reverseReferences(uri: string, semanticId: string): Promise<RequestResult<readonly NavigationTarget[]>> {
    return expect(ZENWAVE_REQUESTS.reverseReferences,
      await this.issuer.request(ZENWAVE_REQUESTS.reverseReferences, { uri, semanticId }), isArray);
  }

  /**
   * The whole ZFL text with its services organised (equal to the current text when nothing changes), or `null`
   * when the server could not process the document, e.g. a syntax error (observed with lsp-js d7156e7).
   */
  async organizeZflServices(uri: string): Promise<RequestResult<string | null>> {
    return expect(ZENWAVE_REQUESTS.organizeZflServices,
      await this.issuer.request(ZENWAVE_REQUESTS.organizeZflServices, { uri }),
      (value) => value === null || typeof value === 'string');
  }

  async eventFlowViews(uri: string): Promise<RequestResult<EventFlowViews>> {
    return expect(ZENWAVE_REQUESTS.eventFlowViews,
      await this.issuer.request(ZENWAVE_REQUESTS.eventFlowViews, { textDocument: { uri } }),
      (value) => isObject(value) && isObject(value.flowGraph) && isObject(value.serviceGraph));
  }

  async preview(uri: string, sequenceRenderMode?: SequenceRenderMode): Promise<RequestResult<Preview>> {
    const params = sequenceRenderMode === undefined
      ? { textDocument: { uri } }
      : { textDocument: { uri }, sequenceRenderMode };
    return expect(ZENWAVE_REQUESTS.preview, await this.issuer.request(ZENWAVE_REQUESTS.preview, params),
      (value) => isObject(value) && Array.isArray(value.representations) && typeof value.defaultRepresentationId === 'string');
  }

  /** The symbol at a position, as the reference requests accept it; `null` when nothing is there. */
  async symbolAt(uri: string, position: LspPosition): Promise<RequestResult<SymbolAt | null>> {
    return expect(ZENWAVE_REQUESTS.symbolAt,
      await this.issuer.request(ZENWAVE_REQUESTS.symbolAt, { textDocument: { uri }, position: { line: position.line, character: position.character } }),
      (value) => value === null || (isObject(value) && typeof value.uri === 'string' && typeof value.semanticId === 'string'));
  }
}
