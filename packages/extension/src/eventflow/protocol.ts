/**
 * What the extension and the upstream EventFlow page (`@zenwave360/vistas-eventflow-webview`)
 * say to each other. Pure: no editor API, so every rule is testable.
 *
 * The page's messages are the vistas package's (`index.d.ts`). The `zenwave.host.*`
 * messages are this extension's own, exchanged with the small host script it adds
 * to the page (see `page.ts`); the upstream page ignores unknown message types.
 */

/** The custom editor's view type. */
export const EVENTFLOW_VIEW_TYPE = 'zenwave.eventflow';

/** The page protocol this extension speaks; pinned with the package in package.json `zenwaveEventFlowWebview`. */
export const EVENTFLOW_PROTOCOL = 'zenwave.eventflow.webview';
export const EVENTFLOW_PROTOCOL_VERSION = 1;

export type ViewMode = 'flow' | 'services';

export interface DisplaySettings {
  readonly humanizeLabels: boolean;
}

/** Host → page, per the vistas protocol. `flowGraph` and `serviceGraph` are the server's, by reference. */
export type PageMessage =
  | { readonly type: 'renderBundle'; readonly payload: { readonly flowGraph: unknown; readonly serviceGraph: unknown; readonly viewMode: ViewMode; readonly displaySettings: DisplaySettings } }
  | { readonly type: 'setViewMode'; readonly payload: { readonly viewMode: ViewMode } }
  | { readonly type: 'setDisplaySettings'; readonly payload: { readonly displaySettings: DisplaySettings } }
  | { readonly type: 'highlightNode'; readonly payload: { readonly nodeId: string | null } };

/** Host → host script. */
export type HostMessage =
  | { readonly type: 'zenwave.host.state'; readonly payload: StatePresentation | null }
  | { readonly type: 'zenwave.host.probe'; readonly payload: { readonly requestId: number } };

export type OutboundMessage = PageMessage | HostMessage;

export interface StateAction {
  readonly label: string;
  readonly command: string;
}

/** What the host script shows over (or above) the diagram. */
export interface StatePresentation {
  /** `overlay` covers the page: nothing to show. `banner` sits above a diagram still on screen. */
  readonly mode: 'overlay' | 'banner';
  readonly kind: string;
  readonly title: string;
  readonly detail?: string;
  readonly actions: readonly StateAction[];
}

/** What the host script reports from the rendered page when probed. For tests and diagnostics. */
export interface PageProbe {
  /** `data-id` of every rendered diagram node. */
  readonly nodeIds: readonly string[];
  /** `data-id` of the nodes carrying the renderer's highlight class. */
  readonly highlightedNodeIds: readonly string[];
  /** The rendered text of the diagram, for label checks. */
  readonly text: string;
  /** The `kind` of the state the host script is showing, if any. */
  readonly stateKind: string | undefined;
  readonly stateMode: string | undefined;
  /** Stylesheets loaded from a URL (the page's own CSS). */
  readonly stylesheets: number;
  /** Content security policy violations the page reported, as directive and blocked URI. */
  readonly cspViolations: readonly string[];
}

export type Readiness =
  | { readonly kind: 'ready'; readonly protocolVersion: number }
  | { readonly kind: 'mismatch'; readonly message: string };

/**
 * Reads a `webviewReady` message. A page that states no version predates
 * versioning; one that states another version speaks another protocol. Both are
 * load failures that say so, rather than a diagram that breaks silently.
 */
export function readiness(payload: unknown): Readiness {
  const stated = typeof payload === 'object' && payload !== null ? payload as { protocol?: unknown; protocolVersion?: unknown } : {};
  if (stated.protocolVersion === undefined) {
    return { kind: 'mismatch', message: `The EventFlow page states no protocol version; this extension needs ${EVENTFLOW_PROTOCOL} version ${EVENTFLOW_PROTOCOL_VERSION}.` };
  }
  if (stated.protocol !== EVENTFLOW_PROTOCOL || stated.protocolVersion !== EVENTFLOW_PROTOCOL_VERSION) {
    return {
      kind: 'mismatch',
      message: `The EventFlow page speaks ${String(stated.protocol)} version ${String(stated.protocolVersion)}; this extension needs ${EVENTFLOW_PROTOCOL} version ${EVENTFLOW_PROTOCOL_VERSION}.`,
    };
  }
  return { kind: 'ready', protocolVersion: stated.protocolVersion };
}

/** Inbound messages from the page and the host script, by type. Anything else is ignored. */
export type InboundMessage =
  | { readonly type: 'webviewReady'; readonly payload?: unknown }
  | { readonly type: 'zenwave.host.loadError'; readonly payload: { readonly message: string } }
  | { readonly type: 'zenwave.host.action'; readonly payload: { readonly command: string } }
  | { readonly type: 'zenwave.host.probeResult'; readonly payload: PageProbe & { readonly requestId: number } };

export function inboundMessage(message: unknown): InboundMessage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, payload } = message as { type?: unknown; payload?: unknown };
  const object = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined;
  switch (type) {
    case 'webviewReady':
      return { type, payload };
    case 'zenwave.host.loadError':
      return { type, payload: { message: typeof object?.message === 'string' ? object.message : 'unknown error' } };
    case 'zenwave.host.action':
      return typeof object?.command === 'string' ? { type, payload: { command: object.command } } : undefined;
    case 'zenwave.host.probeResult':
      return typeof object?.requestId === 'number' ? { type, payload: object as unknown as PageProbe & { requestId: number } } : undefined;
    default:
      return undefined;
  }
}
