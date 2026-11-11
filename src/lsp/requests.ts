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
  conceptAt: 'zenwave/conceptAt',
  statResource: 'zenwave/statResource',
  readResource: 'zenwave/readResource',
} as const;

export type ZenwaveRequestMethod = typeof ZENWAVE_REQUESTS[keyof typeof ZENWAVE_REQUESTS];

/** Anything able to issue a request with the four-way result; the supervisor is one. */
export interface RequestIssuer {
  request(method: string, params: unknown): Promise<RequestResult>;
}

export interface LspPosition { readonly line: number; readonly character: number }
export interface LspRange { readonly start: LspPosition; readonly end: LspPosition }

/** An architectural concept covering the requested position, named by the server. */
export interface ArchitectureConcept {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly identityOrigin: string;
}

/** The concepts the server found, plus whether its limit omitted further matches. */
export interface ConceptsAt {
  readonly concepts: readonly ArchitectureConcept[];
  readonly truncated: boolean;
}

/** `zenwave/statResource` (AR-R4): what a `zenwave:` address resolves to. `fileUri` is present only for the `workspace` source. */
export interface ResourceStat {
  readonly uri: string;
  readonly type: 'file';
  readonly size: number;
  readonly readonly: true;
  readonly source: { readonly kind: string; readonly fileUri?: string };
}

/** `zenwave/readResource` (AR-R5): the content as text, or as base64 when it is not text. */
export interface ResourceContent {
  readonly uri: string;
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
}

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
  /** Manifest resource version, when the declaration has one. */
  readonly version?: string;
  /** Server-owned `zenwave:` address for an architecture resource. */
  readonly address?: string;
  /** Why this manifest entry is visible but cannot be opened yet. */
  readonly disabledReason?: string;
}

/** A view model as the server produced it; `schema` names its shape. */
export type ViewModel = { readonly schema: string } & Readonly<Record<string, unknown>>;

export interface EventFlowViews {
  readonly flowGraph: ViewModel;
  readonly serviceGraph: ViewModel;
  /** The flow's variants, in the server's order; absent from a server that does not list them. */
  readonly variants?: readonly FlowVariant[];
  /** Echoed when `lanes` was sent to a server that advertised `flowLanes` (EF-R24). */
  readonly lanes?: 'systems' | 'services';
  /** Present when `positions` was sent to a server that advertised `savedPositions` (LVR-R18). */
  readonly savedPositions?: SavedPositionsAnswer;
}

export type SavedPositionsAnswer =
  | { readonly applied: true }
  | { readonly applied: false; readonly reason?: 'missing-nodes' | 'invalid' | 'lanes'; readonly missing?: readonly string[] };

export interface FlowVariant {
  readonly id: string;
  readonly title: string;
}

/** `mode` of `zenwave/organizeZflServices`. Absent on the wire means `full`. */
export type OrganizeServicesMode = 'full' | 'additive';

export type SequenceRenderMode = 'SEPARATE_VARIANTS' | 'ALT_BLOCKS' | 'AUTO';

export interface PreviewRepresentation {
  readonly id: string;
  readonly title: string;
  readonly format: 'MARKDOWN' | 'MERMAID' | 'HTML';
  readonly content: string;
  /** The kind of element, in `diagrams` mode only (LVR-R17). */
  readonly group?: string;
}

/** What `zenwave/preview` is asked for: the page (`docs`, the default) or one diagram per element (`diagrams`). */
export type PreviewMode = 'docs' | 'diagrams';

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
   *
   * `mode` is sent only when the server advertised `organizeModes`. `full` rebuilds the block; `additive`
   * adds what the flows use and removes nothing. Omitting it is what an older server already does, and it
   * is `full`.
   */
  async organizeZflServices(uri: string, mode?: OrganizeServicesMode): Promise<RequestResult<string | null>> {
    const params = mode === undefined ? { uri } : { uri, mode };
    return expect(ZENWAVE_REQUESTS.organizeZflServices,
      await this.issuer.request(ZENWAVE_REQUESTS.organizeZflServices, params),
      (value) => value === null || typeof value === 'string');
  }

  /**
   * `variant` is sent only when given, and only to a server that advertised `flowVariants`; then `flowGraph` is that variant's view.
   * `positions` (a saved file's `flow`) is sent only for the full diagram, and only to a server that advertised `savedPositions`.
   * `lanes` is sent only when the diagram is drawn in lanes, and only to a server that advertised `flowLanes` (EF-R24).
   */
  async eventFlowViews(uri: string, variant?: string, positions?: Readonly<Record<string, unknown>>, lanes?: 'systems' | 'services'): Promise<RequestResult<EventFlowViews>> {
    const params = { textDocument: { uri }, ...(variant === undefined ? {} : { variant }), ...(positions === undefined ? {} : { positions }), ...(lanes === undefined ? {} : { lanes }) };
    return expect(ZENWAVE_REQUESTS.eventFlowViews,
      await this.issuer.request(ZENWAVE_REQUESTS.eventFlowViews, params),
      (value) => isObject(value) && isObject(value.flowGraph) && isObject(value.serviceGraph));
  }

  async preview(uri: string, sequenceRenderMode?: SequenceRenderMode, mode?: PreviewMode): Promise<RequestResult<Preview>> {
    const params = {
      textDocument: { uri },
      ...(sequenceRenderMode === undefined ? {} : { sequenceRenderMode }),
      ...(mode === undefined ? {} : { mode }),
    };
    return expect(ZENWAVE_REQUESTS.preview, await this.issuer.request(ZENWAVE_REQUESTS.preview, params),
      (value) => isObject(value) && Array.isArray(value.representations) && typeof value.defaultRepresentationId === 'string');
  }

  /** The symbol at a position, as the reference requests accept it; `null` when nothing is there. */
  async symbolAt(uri: string, position: LspPosition): Promise<RequestResult<SymbolAt | null>> {
    return expect(ZENWAVE_REQUESTS.symbolAt,
      await this.issuer.request(ZENWAVE_REQUESTS.symbolAt, { textDocument: { uri }, position: { line: position.line, character: position.character } }),
      (value) => value === null || (isObject(value) && typeof value.uri === 'string' && typeof value.semanticId === 'string'));
  }

  /** What a `zenwave:` address resolves to, and where it came from (AR-R4). Fetches nothing the server does not already hold. */
  async statResource(uri: string): Promise<RequestResult<ResourceStat>> {
    return expect(ZENWAVE_REQUESTS.statResource, await this.issuer.request(ZENWAVE_REQUESTS.statResource, { uri }),
      (value) => isObject(value) && typeof value.size === 'number' && isObject(value.source) && typeof value.source.kind === 'string');
  }

  /** The content of a `zenwave:` address (AR-R5). */
  async readResource(uri: string): Promise<RequestResult<ResourceContent>> {
    return expect(ZENWAVE_REQUESTS.readResource, await this.issuer.request(ZENWAVE_REQUESTS.readResource, { uri }),
      (value) => isObject(value) && typeof value.content === 'string' && (value.encoding === 'utf8' || value.encoding === 'base64'));
  }

  /** Architectural concepts covering a document position. Older JVM servers return the concepts array directly. */
  async conceptAt(uri: string, position: LspPosition): Promise<RequestResult<ConceptsAt>> {
    const result = await this.issuer.request(ZENWAVE_REQUESTS.conceptAt, { uri, position: { line: position.line, character: position.character } });
    if (result.kind !== 'ok') return result;
    const concepts = conceptsAt(result.value);
    return concepts
      ? { kind: 'ok', value: concepts }
      : { kind: 'failed', reason: `Language server answered ${ZENWAVE_REQUESTS.conceptAt} with an unexpected shape` };
  }
}

function isConcept(value: unknown): value is ArchitectureConcept {
  return isObject(value) && typeof value.id === 'string' && typeof value.kind === 'string' &&
    typeof value.name === 'string' && typeof value.identityOrigin === 'string';
}

function conceptsAt(value: unknown): ConceptsAt | undefined {
  // The present JVM adapter returns its `List<ArchitectureConceptRef>` directly.
  if (Array.isArray(value)) return value.every(isConcept) ? { concepts: value, truncated: false } : undefined;
  if (!isObject(value) || typeof value.truncated !== 'boolean') return undefined;
  // `elements` is the core DTO's field. Accept `concepts` as well while the
  // request is being carried to the JavaScript server.
  const concepts = Array.isArray(value.elements) ? value.elements : value.concepts;
  return Array.isArray(concepts) && concepts.every(isConcept)
    ? { concepts, truncated: value.truncated }
    : undefined;
}
