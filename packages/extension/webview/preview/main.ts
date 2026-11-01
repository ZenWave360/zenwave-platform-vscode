/**
 * The preview page: draws what the extension posts and reports what the user
 * chooses. It holds no model knowledge. Every representation is data: Mermaid
 * text is drawn locally by the Mermaid bundle shipped in the extension, loaded
 * the first time a diagram is shown. Markdown and HTML are made into sanitised
 * markup by the content bundle, loaded the first time one is shown, and the
 * fenced `mermaid` blocks of a Markdown page are drawn the same way, each on its
 * own. Any other format is named and left unshown rather than interpreted.
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
  type PreviewContentProbe,
  type PreviewProbe,
  type RenderMode,
  type RenderPayload,
} from '../../src/preview/protocol.js';

interface Mermaid {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ readonly svg: string }>;
}

interface PreviewContent {
  markdownToHtml(source: string): string;
  sanitiseHtml(html: string): string;
}

/** The fenced diagram blocks in the HTML the content bundle makes (see `markdown.ts`). */
const DIAGRAM_SELECTOR = 'pre > code.language-mermaid';

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
let contentLoading: Promise<PreviewContent> | undefined;
let configuredTheme: Theme | undefined;

/** Loads a script shipped with the extension, under the page's nonce. */
function loadScript(src: string, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.nonce = nonce;
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`The ${what} shipped with the extension could not be loaded`));
    document.head.appendChild(script);
  });
}

/** Loads the Mermaid bundle from the extension the first time a diagram needs it. */
function loadMermaid(): Promise<Mermaid> {
  mermaidLoading ??= loadScript(document.body.dataset.mermaidSrc ?? '', 'Mermaid bundle').then(() => {
    // A heading called "Mermaid" makes `window.mermaid` an element before the bundle runs, so look for the function.
    const loaded = (window as unknown as { mermaid?: Mermaid }).mermaid;
    if (typeof loaded?.render !== 'function') throw new Error('The Mermaid bundle did not define mermaid');
    return loaded;
  }).catch((error: unknown) => {
    mermaidLoading = undefined;
    throw error;
  });
  return mermaidLoading;
}

/** Loads the Markdown and sanitiser bundle from the extension the first time a Markdown or HTML representation is shown. */
function loadContent(): Promise<PreviewContent> {
  contentLoading ??= loadScript(document.body.dataset.contentSrc ?? '', 'content bundle').then(() => {
    const loaded = (window as unknown as { zenwavePreviewContent?: PreviewContent }).zenwavePreviewContent;
    if (!loaded) throw new Error('The content bundle did not define its converter');
    return loaded;
  }).catch((error: unknown) => {
    contentLoading = undefined;
    throw error;
  });
  return contentLoading;
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
  return `This representation is in the ${format} format, which this version of the preview cannot show yet.`;
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
  if (current.format === 'MARKDOWN' || current.format === 'HTML') {
    await showDocument(current, token, theme, hash, sameDiagram);
    return;
  }
  if (current.format !== 'MERMAID') {
    drawn = undefined;
    showNotice(unsupportedFormat(current.format));
    return;
  }
  let svg: SVGElement;
  try {
    const mermaid = await loadMermaid();
    if (token !== renderToken) return;
    configure(mermaid, theme);
    svg = await drawDiagram(mermaid, current.content);
    if (token !== renderToken) return;
  } catch (error) {
    if (token !== renderToken) return;
    failed(current, error);
    return;
  }
  swapIn(svg, current.id, hash, theme, sameDiagram);
}

/** One diagram, drawn off the page: Mermaid renders into a scratch element it removes again, and the result is returned. */
async function drawDiagram(mermaid: Mermaid, text: string): Promise<SVGElement> {
  const id = `zw-${++renders}`;
  try {
    return adoptSvg((await mermaid.render(id, text)).svg);
  } finally {
    discardStrays(id);
  }
}

function failed(current: PageRepresentation, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  drawn = undefined;
  showNotice(`${current.title} could not be drawn: ${message}`, current.content);
  post({ type: 'zenwave.preview.diagramFailed', payload: { id: current.id, message } });
}

/** Puts what was built in place of what was shown. The same representation redrawn after an edit keeps its place; another one starts at the top. */
function swapIn(node: Node, id: string, hash: string, theme: Theme, keepPlace: boolean): void {
  const scrollTop = view.scrollTop;
  const scrollLeft = view.scrollLeft;
  notice = undefined;
  view.replaceChildren(node);
  drawn = { id, hash, theme };
  view.scrollTop = keepPlace ? scrollTop : 0;
  view.scrollLeft = keepPlace ? scrollLeft : 0;
}

/**
 * A Markdown or HTML representation: sanitised by the content bundle, built away from the page (so a
 * redraw never shows half a document), its fenced diagrams drawn each on its own, then swapped in.
 * A diagram that cannot be drawn says so where it is and the rest of the page is unaffected.
 */
async function showDocument(current: PageRepresentation, token: number, theme: Theme, hash: string, keepPlace: boolean): Promise<void> {
  const article = document.createElement('article');
  article.className = 'document';
  try {
    const content = await loadContent();
    if (token !== renderToken) return;
    const markup = current.format === 'MARKDOWN' ? content.markdownToHtml(current.content) : content.sanitiseHtml(current.content);
    // A template is inert: nothing in it loads or runs until it has been sanitised and adopted.
    const template = document.createElement('template');
    template.innerHTML = markup;
    article.appendChild(document.importNode(template.content, true));
    if (current.format === 'MARKDOWN') {
      for (const heading of article.querySelectorAll<HTMLElement>('[data-anchor]')) heading.id = heading.dataset.anchor ?? '';
      const blocks = [...article.querySelectorAll<HTMLElement>(DIAGRAM_SELECTOR)].map((code) => code.parentElement as HTMLElement);
      if (blocks.length > 0) {
        const mermaid = await loadMermaid();
        if (token !== renderToken) return;
        configure(mermaid, theme);
        for (const block of blocks) {
          const source = block.textContent ?? '';
          const box = document.createElement('div');
          try {
            box.className = 'zw-diagram';
            box.appendChild(await drawDiagram(mermaid, source));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            box.className = 'zw-diagram-error';
            const text = document.createElement('p');
            text.textContent = `This diagram could not be drawn: ${message}`;
            const pre = document.createElement('pre');
            pre.textContent = source;
            box.replaceChildren(text, pre);
            post({ type: 'zenwave.preview.diagramFailed', payload: { id: current.id, message } });
          }
          if (token !== renderToken) return;
          block.replaceWith(box);
        }
      }
    }
  } catch (error) {
    if (token !== renderToken) return;
    failed(current, error);
    return;
  }
  swapIn(article, current.id, hash, theme, keepPlace);
}

/** A link to `#anchor` scrolls to it inside the page. The sanitiser keeps no other link; a plain anchor that remained would still not navigate the webview. */
view.addEventListener('click', (event) => {
  const link = (event.target as Element | null)?.closest('a');
  if (!link || !view.contains(link)) return;
  event.preventDefault();
  const href = link.getAttribute('href') ?? '';
  if (href.startsWith('#') && href.length > 1) anchorTarget(anchorName(href))?.scrollIntoView({ block: 'start' });
});

function anchorName(href: string): string {
  const anchor = href.slice(1);
  try { return decodeURIComponent(anchor); } catch { return anchor; }
}

function anchorTarget(anchor: string): Element | undefined {
  return [...view.querySelectorAll('[id]')].find((element) => element.id === anchor);
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

function contentProbe(): PreviewContentProbe {
  const all = (selector: string): Element[] => [...view.querySelectorAll(selector)];
  const links = all('a[href]').map((link) => link.getAttribute('href') ?? '');
  const fragments = links.filter((href) => href.startsWith('#'));
  const source = (image: Element): string => image.getAttribute('src') ?? '';
  return {
    headings: all('h1, h2, h3, h4, h5, h6').length,
    tables: all('table').length,
    codeBlocks: all('pre').length,
    images: all('img').length,
    remoteImages: all('img').filter((image) => source(image) !== '' && !source(image).startsWith('data:')).length,
    // The diagrams are Mermaid's own SVG, which carries styles of its own; the content around them must carry none of these.
    hostile: all('script, iframe, frame, object, embed, form, style, link, meta, base, [onclick], [onerror], [onload], [onmouseover], [style]').filter((element) => !element.closest('svg')).length,
    diagrams: { drawn: all('.zw-diagram svg').length, failed: all('.zw-diagram-error').length },
    fragments,
    unresolved: fragments.filter((href) => anchorTarget(anchorName(href)) === undefined),
    otherLinks: links.length - fragments.length,
    resources: performance.getEntriesByType('resource').map((entry) => entry.name),
    diagramColours: all('svg').map((svg) => {
      const unique = (values: string[]): string[] => [...new Set(values)];
      const inks = [...svg.querySelectorAll('text, foreignObject span, foreignObject p')].filter((element) => !element.closest('.edgeTerminals')).map((element) => {
        const style = getComputedStyle(element);
        return element instanceof SVGElement && element.tagName.toLowerCase() === 'text' ? style.fill : style.color;
      });
      const fills = [...svg.querySelectorAll('.node rect, .node polygon, .node path, .node circle, g.statediagram-state rect')].map((element) => getComputedStyle(element).fill);
      const paint = (selector: string, property: 'stroke' | 'fill'): string[] => unique([...svg.querySelectorAll(selector)].map((element) => getComputedStyle(element)[property]));
      const ink = (element: Element): string => (element instanceof SVGElement ? getComputedStyle(element).fill : getComputedStyle(element).color);
      return {
        kind: svg.getAttribute('aria-roledescription') ?? '',
        inks: unique(inks),
        fills: unique(fills),
        lines: paint('path.transition, path.flowchart-link, path.relation', 'stroke'),
        clusterInks: unique([...svg.querySelectorAll('.cluster-label text, .cluster-label span, .cluster-label p')].map(ink)),
        clusterFills: paint('.cluster > rect', 'fill'),
        terminals: unique([...svg.querySelectorAll('.edgeTerminals text, .edgeTerminals tspan')].map(ink)),
      };
    }),
  };
}

function probe(requestId: number, followLink?: string): void {
  if (followLink !== undefined) [...view.querySelectorAll<HTMLElement>('a[href]')].find((link) => link.getAttribute('href') === followLink)?.click();
  const target = followLink === undefined ? undefined : anchorTarget(anchorName(followLink));
  const followed = target && /^H[1-6]$/.test(target.tagName)
    ? { tag: target.tagName, text: target.textContent ?? '', headingIndex: [...view.querySelectorAll('h1, h2, h3, h4, h5, h6')].indexOf(target) }
    : undefined;
  const strays = [...document.body.children].filter((child) => /^d?zw-\d+$/.test(child.id)).length;
  post({
    type: 'zenwave.host.probeResult',
    payload: {
      requestId,
      mermaidLoaded: typeof (window as unknown as { mermaid?: { render?: unknown } }).mermaid?.render === 'function',
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
      content: contentProbe(),
      text: String(view.innerText || view.textContent || '').slice(0, 20000),
      notice,
      theme: currentTheme(),
      renderedTheme: drawn?.theme,
      renders,
      followed,
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
      probe(message.payload.requestId, message.payload.followLink);
      return;
  }
});

diagramSelect.addEventListener('change', () => post({ type: 'zenwave.preview.selectRepresentation', payload: { id: diagramSelect.value } }));
renderModeSelect.addEventListener('change', () => post({ type: 'zenwave.preview.selectRenderMode', payload: { mode: renderModeSelect.value as RenderMode } }));

// A colour theme change restyles the page through the editor's variables and redraws the diagram in the matching Mermaid theme.
new MutationObserver(() => { if (payload && drawn && drawn.theme !== currentTheme()) void show(); })
  .observe(document.body, { attributes: true, attributeFilter: ['class'] });

post({ type: 'zenwave.preview.ready' });
