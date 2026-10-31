/**
 * What the extension and the preview page say to each other. Pure: no editor API
 * and no DOM, so the page script and the unit tests share it.
 *
 * The page is this extension's own (`webview/preview`), not an upstream package,
 * so there is no protocol version to pin: it is built from the same commit.
 */
import type { StatePresentation } from '../eventflow/protocol.js';

/** The custom editor's view type. */
export const PREVIEW_VIEW_TYPE = 'zenwave.preview';

/** How the server renders ZFL sequence variants (`zenwave/preview` `sequenceRenderMode`). */
export type RenderMode = 'ALT_BLOCKS' | 'SEPARATE_VARIANTS';

export const DEFAULT_RENDER_MODE: RenderMode = 'ALT_BLOCKS';

export const RENDER_MODES: readonly { readonly value: RenderMode; readonly label: string }[] = [
  { value: 'ALT_BLOCKS', label: 'Alt blocks' },
  { value: 'SEPARATE_VARIANTS', label: 'Separate variants' },
];

export function isRenderMode(value: unknown): value is RenderMode {
  return RENDER_MODES.some((mode) => mode.value === value);
}

/** One representation as the server gave it. `format` is a string so a format added later reaches the page and is reported there. */
export interface PageRepresentation {
  readonly id: string;
  readonly title: string;
  readonly format: string;
  readonly content: string;
}

/** A short fingerprint of a representation's content, so the page and a test can say which content is drawn without carrying it. */
export function contentHash(content: string): string {
  let hash = 5381;
  for (let index = 0; index < content.length; index++) hash = ((hash * 33) ^ content.charCodeAt(index)) >>> 0;
  return `${content.length}:${hash.toString(16)}`;
}

/** What the controls show. The host decides it; the page draws it. */
export interface RenderPayload {
  readonly representations: readonly PageRepresentation[];
  /** The id of the representation to show. */
  readonly selectedId: string;
  readonly renderMode: RenderMode;
  /** Whether the render mode selector is offered: only a document that has sequence variants. */
  readonly showRenderMode: boolean;
}

/** Host to page. */
export type OutboundMessage =
  | { readonly type: 'zenwave.preview.render'; readonly payload: RenderPayload }
  | { readonly type: 'zenwave.host.state'; readonly payload: StatePresentation | null }
  | { readonly type: 'zenwave.host.probe'; readonly payload: { readonly requestId: number; readonly followLink?: string } };

/** What a Markdown or HTML representation turned into on the page. */
export interface PreviewContentProbe {
  readonly headings: number;
  readonly tables: number;
  readonly codeBlocks: number;
  /** `img` elements in the content, and how many of them have a `src` that is not `data:`. */
  readonly images: number;
  readonly remoteImages: number;
  /** Elements that must never survive sanitising: script, frame, form, style, link, event handler attributes. */
  readonly hostile: number;
  readonly diagrams: { readonly drawn: number; readonly failed: number };
  /** Links inside the page, and those with no element carrying their anchor. */
  readonly fragments: readonly string[];
  readonly unresolved: readonly string[];
  /** Links in the content that are not to a fragment of the page. */
  readonly otherLinks: number;
  /** Every resource the page has requested, by URL. */
  readonly resources: readonly string[];
  /** The diagrams drawn (every SVG of the preview area), in order, with the colours they are painted in (computed, as `rgb(...)`). */
  readonly diagramColours: readonly {
    /** `aria-roledescription` of the SVG: `classDiagram`, `stateDiagram`, `flowchart-v2`, `sequence`. */
    readonly kind: string;
    /** Text colours, except the multiplicity labels (`terminals`). */
    readonly inks: readonly string[];
    readonly fills: readonly string[];
    /** Strokes of relations, transitions and flowchart links. */
    readonly lines: readonly string[];
    /** Text and fill of the title bar of a flowchart subgraph. */
    readonly clusterInks: readonly string[];
    readonly clusterFills: readonly string[];
    /** Text of the multiplicity labels at the ends of a class relation. */
    readonly terminals: readonly string[];
  }[];
}

/** What the page reports when probed. For tests and diagnostics. */
export interface PreviewProbe {
  readonly mermaidLoaded: boolean;
  /** The `src` of every script the page loaded. */
  readonly scripts: readonly string[];
  readonly renderModeSelector: { readonly visible: boolean; readonly value: string; readonly options: readonly string[] };
  readonly diagramSelector: { readonly visible: boolean; readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[] };
  /** The id of the representation drawn now, if any. */
  readonly renderedId: string | undefined;
  /** `contentHash` of the content drawn now. */
  readonly renderedHash: string | undefined;
  readonly svgCount: number;
  readonly content: PreviewContentProbe;
  /** The rendered text of the preview area. */
  readonly text: string;
  /** What the page says in place of a diagram (an unsupported format, a diagram that failed). */
  readonly notice: string | undefined;
  readonly theme: 'light' | 'dark';
  /** The Mermaid theme the drawn diagram was rendered with. */
  readonly renderedTheme: string | undefined;
  readonly renders: number;
  /** The heading the `followLink` of this probe led to: its tag, text and position among the page's headings. Absent when no link was followed or none resolved. */
  readonly followed: { readonly tag: string; readonly text: string; readonly headingIndex: number } | undefined;
  readonly scrollTop: number;
  readonly stateKind: string | undefined;
  readonly stateMode: string | undefined;
  /** Elements Mermaid left in the document outside the preview area. */
  readonly strayElements: number;
  /** Content security policy violations the page reported, as directive and blocked URI. */
  readonly cspViolations: readonly string[];
}

/** Inbound messages from the page, by type. Anything else is ignored. */
export type InboundMessage =
  | { readonly type: 'zenwave.preview.ready' }
  | { readonly type: 'zenwave.preview.selectRepresentation'; readonly payload: { readonly id: string } }
  | { readonly type: 'zenwave.preview.selectRenderMode'; readonly payload: { readonly mode: RenderMode } }
  | { readonly type: 'zenwave.preview.diagramFailed'; readonly payload: { readonly id: string; readonly message: string } }
  | { readonly type: 'zenwave.host.loadError'; readonly payload: { readonly message: string } }
  | { readonly type: 'zenwave.host.action'; readonly payload: { readonly command: string } }
  | { readonly type: 'zenwave.host.probeResult'; readonly payload: PreviewProbe & { readonly requestId: number } };

export function inboundMessage(message: unknown): InboundMessage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, payload } = message as { type?: unknown; payload?: unknown };
  const object = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined;
  switch (type) {
    case 'zenwave.preview.ready':
      return { type };
    case 'zenwave.preview.selectRepresentation':
      return typeof object?.id === 'string' ? { type, payload: { id: object.id } } : undefined;
    case 'zenwave.preview.selectRenderMode':
      return isRenderMode(object?.mode) ? { type, payload: { mode: object.mode } } : undefined;
    case 'zenwave.preview.diagramFailed':
      return typeof object?.id === 'string' ? { type, payload: { id: object.id, message: typeof object.message === 'string' ? object.message : 'unknown error' } } : undefined;
    case 'zenwave.host.loadError':
      return { type, payload: { message: typeof object?.message === 'string' ? object.message : 'unknown error' } };
    case 'zenwave.host.action':
      return typeof object?.command === 'string' ? { type, payload: { command: object.command } } : undefined;
    case 'zenwave.host.probeResult':
      return typeof object?.requestId === 'number' ? { type, payload: object as unknown as PreviewProbe & { requestId: number } } : undefined;
    default:
      return undefined;
  }
}
