/**
 * The preview page: draws what the extension posts and reports what the user
 * chooses. It holds no model knowledge. Every representation is data: Mermaid
 * text is drawn locally by the Mermaid bundle shipped in the extension, loaded
 * the first time a diagram is shown, and any other format is named and left
 * unshown rather than interpreted.
 *
 * Scripts run under a nonce; the one thing the policy lets inline is style, which
 * Mermaid needs to measure what it draws (see `src/preview/page.ts`).
 */
import type { StatePresentation } from '../../src/eventflow/protocol.js';
import {
  RENDER_MODES,
  contentHash,
  type InboundMessage,
  type OutboundMessage,
  type PageRepresentation,
  type PreviewProbe,
  type RenderMode,
  type RenderPayload,
} from '../../src/preview/protocol.js';

interface Mermaid {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ readonly svg: string }>;
}

declare const acquireVsCodeApi: () => { postMessage(message: InboundMessage): void };

const api = acquireVsCodeApi();
const nonce = (document.currentScript as HTMLScriptElement | null)?.nonce ?? '';
const post = (message: InboundMessage): void => api.postMessage(message);

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const controls = element<HTMLElement>('controls');
const renderModeField = element<HTMLElement>('render-mode-field');
const renderModeSelect = element<HTMLSelectElement>('render-mode');
const diagramField = element<HTMLElement>('diagram-field');
const diagramSelect = element<HTMLSelectElement>('diagram');
const stateBox = element<HTMLElement>('state');
const view = element<HTMLElement>('view');

const violations: string[] = [];
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`);
});
window.addEventListener('error', (event) => {
  if (event.message) post({ type: 'zenwave.host.loadError', payload: { message: String(event.message) } });
});

type Theme = 'light' | 'dark';

function currentTheme(): Theme {
  const classes = document.body.classList;
  return classes.contains('vscode-dark') || classes.contains('vscode-high-contrast') ? 'dark' : 'light';
}

let mermaidLoading: Promise<Mermaid> | undefined;
let configuredTheme: Theme | undefined;

/** Loads the Mermaid bundle from the extension the first time a diagram needs it. */
function loadMermaid(): Promise<Mermaid> {
  mermaidLoading ??= new Promise<Mermaid>((resolve, reject) => {
    const script = document.createElement('script');
    script.nonce = nonce;
    script.src = document.body.dataset.mermaidSrc ?? '';
    script.onload = () => {
      const loaded = (window as unknown as { mermaid?: Mermaid }).mermaid;
      if (loaded) resolve(loaded);
      else reject(new Error('The Mermaid bundle did not define mermaid'));
    };
    script.onerror = () => {
      mermaidLoading = undefined;
      reject(new Error('The Mermaid bundle shipped with the extension could not be loaded'));
    };
    document.head.appendChild(script);
  });
  return mermaidLoading;
}

function configure(mermaid: Mermaid, theme: Theme): void {
  if (configuredTheme === theme) return;
  const fontFamily = getComputedStyle(document.body).fontFamily;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: theme === 'dark' ? 'dark' : 'default',
    fontFamily,
    // Text labels, not HTML in a foreignObject: smaller, selectable, and no inline styles to carry.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
  });
  configuredTheme = theme;
}

/** The SVG Mermaid returned (already sanitised by Mermaid), parsed away from the page and imported as an element. */
function adoptSvg(markup: string): SVGElement {
  const source = new DOMParser().parseFromString(markup, 'text/html').body.querySelector('svg');
  if (!source) throw new Error('Mermaid returned no diagram');
  return document.importNode(source, true) as unknown as SVGElement;
}

let payload: RenderPayload | undefined;
let drawn: { readonly id: string; readonly hash: string; readonly theme: Theme } | undefined;
let notice: string | undefined;
let renders = 0;
let renderToken = 0;
let shownState: StatePresentation | null = null;

function unsupportedFormat(format: string): string {
  const name = format === 'MARKDOWN' ? 'Markdown' : format === 'HTML' ? 'HTML' : `the ${format} format`;
  return `This representation is in ${name}, which this version of the preview cannot show yet.`;
}

function discardStrays(id: string): void {
  for (const stray of document.querySelectorAll(`body > #d${id}, body > #${id}`)) stray.remove();
}

function showNotice(message: string, source?: string): void {
  notice = message;
  view.replaceChildren();
  const box = document.createElement('div');
  box.className = 'notice';
  const text = document.createElement('p');
  text.textContent = message;
  box.appendChild(text);
  if (source) {
    const pre = document.createElement('pre');
    pre.textContent = source;
    box.appendChild(pre);
  }
  view.appendChild(box);
}

async function show(): Promise<void> {
  if (!payload) return;
  syncControls(payload);
  const current = payload.representations.find((item) => item.id === payload!.selectedId);
  if (!current) return;
  const theme = currentTheme();
  const hash = contentHash(current.content);
  if (drawn && drawn.id === current.id && drawn.hash === hash && drawn.theme === theme) return;
  const token = ++renderToken;
  const sameDiagram = drawn?.id === current.id;
  if (current.format !== 'MERMAID') {
    drawn = undefined;
    showNotice(unsupportedFormat(current.format));
    return;
  }
  const id = `zw-${++renders}`;
  let svg: SVGElement;
  try {
    const mermaid = await loadMermaid();
    if (token !== renderToken) return;
    configure(mermaid, theme);
    const output = await mermaid.render(id, current.content);
    if (token !== renderToken) return;
    svg = adoptSvg(output.svg);
  } catch (error) {
    discardStrays(id);
    if (token !== renderToken) return;
    const message = error instanceof Error ? error.message : String(error);
    drawn = undefined;
    showNotice(`${current.title} could not be drawn: ${message}`, current.content);
    post({ type: 'zenwave.preview.diagramFailed', payload: { id: current.id, message } });
    return;
  }
  discardStrays(id);
  const scrollTop = view.scrollTop;
  const scrollLeft = view.scrollLeft;
  notice = undefined;
  view.replaceChildren(svg);
  drawn = { id: current.id, hash, theme };
  // The same diagram redrawn after an edit keeps its place; another one starts at the top.
  view.scrollTop = sameDiagram ? scrollTop : 0;
  view.scrollLeft = sameDiagram ? scrollLeft : 0;
}

function fill(select: HTMLSelectElement, options: readonly { readonly value: string; readonly label: string }[], value: string): void {
  const same = select.options.length === options.length &&
    options.every((option, index) => select.options[index]?.value === option.value && select.options[index]?.textContent === option.label);
  if (!same) {
    select.replaceChildren(...options.map((option) => {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      return node;
    }));
  }
  select.value = value;
}

function syncControls(current: RenderPayload): void {
  renderModeField.hidden = !current.showRenderMode;
  diagramField.hidden = current.representations.length <= 1;
  controls.hidden = renderModeField.hidden && diagramField.hidden;
  fill(renderModeSelect, RENDER_MODES, current.renderMode);
  fill(diagramSelect, current.representations.map((item: PageRepresentation) => ({ value: item.id, label: item.title })), current.selectedId);
}

function showState(state: StatePresentation | null): void {
  shownState = state;
  stateBox.replaceChildren();
  if (!state) {
    stateBox.hidden = true;
    stateBox.className = '';
    view.hidden = false;
    return;
  }
  stateBox.hidden = false;
  stateBox.className = state.mode;
  stateBox.setAttribute('data-kind', state.kind);
  // An overlay is all the page shows: nothing to draw, so the controls and the drawing stay out of the way.
  view.hidden = state.mode === 'overlay';
  if (state.mode === 'overlay') controls.hidden = true;
  else if (payload) syncControls(payload);
  const box = document.createElement('div');
  box.className = 'box';
  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = state.title;
  box.appendChild(title);
  if (state.detail) {
    const detail = document.createElement('p');
    detail.className = 'detail';
    detail.textContent = state.detail;
    box.appendChild(detail);
  }
  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const action of state.actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => post({ type: 'zenwave.host.action', payload: { command: action.command } }));
    actions.appendChild(button);
  }
  box.appendChild(actions);
  stateBox.appendChild(box);
}

function probe(requestId: number): void {
  const strays = [...document.body.children].filter((child) => /^d?zw-\d+$/.test(child.id)).length;
  post({
    type: 'zenwave.host.probeResult',
    payload: {
      requestId,
      mermaidLoaded: Boolean((window as unknown as { mermaid?: unknown }).mermaid),
      scripts: [...document.scripts].map((script) => script.src).filter((src) => src !== ''),
      renderModeSelector: {
        visible: !renderModeField.hidden && !controls.hidden,
        value: renderModeSelect.value,
        options: [...renderModeSelect.options].map((option) => option.textContent ?? ''),
      },
      diagramSelector: {
        visible: !diagramField.hidden && !controls.hidden,
        value: diagramSelect.value,
        options: [...diagramSelect.options].map((option) => ({ value: option.value, label: option.textContent ?? '' })),
      },
      renderedId: drawn?.id,
      renderedHash: drawn?.hash,
      svgCount: view.querySelectorAll('svg').length,
      text: String(view.innerText || view.textContent || '').slice(0, 20000),
      notice,
      theme: currentTheme(),
      renderedTheme: drawn?.theme,
      renders,
      scrollTop: view.scrollTop,
      stateKind: shownState?.kind,
      stateMode: shownState?.mode,
      strayElements: strays,
      cspViolations: [...violations],
    } satisfies PreviewProbe & { requestId: number },
  });
}

window.addEventListener('message', (event: MessageEvent<OutboundMessage>) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'zenwave.preview.render':
      payload = message.payload;
      void show();
      return;
    case 'zenwave.host.state':
      showState(message.payload);
      return;
    case 'zenwave.host.probe':
      probe(message.payload.requestId);
      return;
  }
});

diagramSelect.addEventListener('change', () => post({ type: 'zenwave.preview.selectRepresentation', payload: { id: diagramSelect.value } }));
renderModeSelect.addEventListener('change', () => post({ type: 'zenwave.preview.selectRenderMode', payload: { mode: renderModeSelect.value as RenderMode } }));

// A colour theme change restyles the page through the editor's variables and redraws the diagram in the matching Mermaid theme.
new MutationObserver(() => { if (payload && drawn && drawn.theme !== currentTheme()) void show(); })
  .observe(document.body, { attributes: true, attributeFilter: ['class'] });

post({ type: 'zenwave.preview.ready' });
