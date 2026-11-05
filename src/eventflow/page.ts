/**
 * Turns the upstream page's built `index.html` into the HTML a VS Code webview
 * can load. Pure: the webview's URI mapping and CSP source are passed in.
 *
 * - `./assets/…` references are rewritten to webview resource URIs, because
 *   relative URLs do not resolve against a webview's HTML string.
 * - A content security policy allows scripts and styles from the extension's own
 *   resources only, plus this file's one nonce'd host script and style. Nothing
 *   remote, no `unsafe-inline`, no `unsafe-eval`.
 * - The host script runs before the page's module script. It acquires the VS Code
 *   API once and leaves it on `window.__zenwaveVsCodeApi`, where the page reuses
 *   it (a second `acquireVsCodeApi()` throws). It reports asset load failures,
 *   shows the editor's explained states, and answers probes about what rendered.
 *   It never reads or changes the messages the page receives.
 */

export interface PageResources {
  /** Maps a path relative to the page directory (`assets/index-x.js`) to a webview URI string. */
  readonly assetUri: (relativePath: string) => string;
  /** `webview.cspSource`. */
  readonly cspSource: string;
  readonly nonce: string;
}

const ASSET_REFERENCE = /\b(src|href)="\.\/(assets\/[^"?#]+)"/g;
const ANY_REFERENCE = /\b(?:src|href)="([^"]*)"/g;

export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src ${cspSource} 'nonce-${nonce}'`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
  ].join('; ');
}

export function createNonce(random: (bytes: Uint8Array) => Uint8Array = (bytes) => globalThis.crypto.getRandomValues(bytes)): string {
  return [...random(new Uint8Array(18))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hostHead(resources: PageResources): string {
  return [
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(resources.cspSource, resources.nonce)}">`,
    `<style nonce="${resources.nonce}">${HOST_STYLE}</style>`,
    `<script nonce="${resources.nonce}">${HOST_SCRIPT}</script>`,
  ].join('\n');
}

/**
 * The page for a webview. Throws when the built page does not look like the one
 * this extension knows how to load: no asset references, or references the
 * rewrite would leave pointing somewhere other than the extension's resources.
 */
export function buildPageHtml(indexHtml: string, resources: PageResources): string {
  let assets = 0;
  const rewritten = indexHtml.replace(ASSET_REFERENCE, (_match, attribute: string, relative: string) => {
    assets++;
    return `${attribute}="${resources.assetUri(relative)}"`;
  });
  if (assets === 0) throw new Error('The EventFlow page references no ./assets/ files');
  for (const match of rewritten.matchAll(ANY_REFERENCE)) {
    const reference = match[1] ?? '';
    const local = [...indexHtml.matchAll(ASSET_REFERENCE)].some((asset) => reference === resources.assetUri(asset[2] ?? ''));
    if (!local) throw new Error(`The EventFlow page references ${reference}, which is not one of its ./assets/ files`);
  }
  const head = /<head[^>]*>/i.exec(rewritten);
  if (!head) throw new Error('The EventFlow page has no <head>');
  const at = head.index + head[0].length;
  return `${rewritten.slice(0, at)}\n${hostHead(resources)}\n${rewritten.slice(at)}`;
}

/** A page with the host script only, for when the EventFlow page itself cannot be loaded. */
export function buildFallbackHtml(resources: Omit<PageResources, 'assetUri'>): string {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n${hostHead({ ...resources, assetUri: () => '' })}\n</head>\n<body><div id="root"></div></body>\n</html>`;
}

export const HOST_STYLE = [
  '#zenwave-host-state{position:fixed;z-index:2147483000;box-sizing:border-box;font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground,#333)}',
  '#zenwave-host-state[hidden]{display:none}',
  '#zenwave-host-state.overlay{top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:var(--vscode-editor-background,#fff)}',
  '#zenwave-host-state.banner{top:0;left:0;right:0;display:flex;align-items:center;gap:12px;padding:6px 12px;background:var(--vscode-editorWidget-background,#f3f3f3);border-bottom:1px solid var(--vscode-editorWidget-border,#ccc)}',
  '#zenwave-host-state .zw-box{max-width:40rem;padding:24px;text-align:center}',
  '#zenwave-host-state.banner .zw-box{max-width:none;padding:0;text-align:left;flex:1}',
  '#zenwave-host-state .zw-title{font-weight:600;margin:0 0 8px}',
  '#zenwave-host-state.banner .zw-title{margin:0;display:inline}',
  '#zenwave-host-state .zw-detail{opacity:.85;margin:0 0 16px;white-space:pre-wrap}',
  '#zenwave-host-state.banner .zw-detail{display:inline;margin:0 0 0 8px}',
  '#zenwave-host-state button{margin:4px;padding:4px 12px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;cursor:pointer;color:var(--vscode-button-foreground,#fff);background:var(--vscode-button-background,#0e639c);font:inherit}',
  '#zenwave-host-state button:hover{background:var(--vscode-button-hoverBackground,#0b5a8e)}',
].join('');

/** Plain ES5-style script: it must run as a classic inline script before the page's modules. */
export const HOST_SCRIPT = `(function () {
  'use strict';
  var api = acquireVsCodeApi();
  window.__zenwaveVsCodeApi = api;
  function post(message) { api.postMessage(message); }
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== window && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
      post({ type: 'zenwave.host.loadError', payload: { message: 'Could not load ' + (target.src || target.href) } });
    } else if (event.message) {
      post({ type: 'zenwave.host.loadError', payload: { message: String(event.message) } });
    }
  }, true);
  var violations = [];
  document.addEventListener('securitypolicyviolation', function (event) {
    violations.push(event.violatedDirective + ' ' + (event.blockedURI || 'inline'));
  });
  var shown = null;
  var element = null;
  function show(state) {
    shown = state;
    if (!document.body) { document.addEventListener('DOMContentLoaded', function () { show(shown); }, { once: true }); return; }
    if (!element) { element = document.createElement('div'); element.id = 'zenwave-host-state'; element.setAttribute('role', 'status'); document.body.appendChild(element); }
    while (element.firstChild) element.removeChild(element.firstChild);
    if (!state) { element.hidden = true; element.className = ''; return; }
    element.hidden = false;
    element.className = state.mode === 'banner' ? 'banner' : 'overlay';
    element.setAttribute('data-kind', state.kind);
    var box = document.createElement('div'); box.className = 'zw-box';
    var title = document.createElement('p'); title.className = 'zw-title'; title.textContent = state.title; box.appendChild(title);
    if (state.detail) { var detail = document.createElement('p'); detail.className = 'zw-detail'; detail.textContent = state.detail; box.appendChild(detail); }
    var actions = document.createElement('div');
    (state.actions || []).forEach(function (action) {
      var button = document.createElement('button'); button.type = 'button'; button.textContent = action.label;
      button.addEventListener('click', function () { post({ type: 'zenwave.host.action', payload: { command: action.command } }); });
      actions.appendChild(button);
    });
    box.appendChild(actions);
    element.appendChild(box);
  }
  function selectedView() {
    var checked = document.querySelector('.view-selector input:checked');
    return checked ? String(checked.value) : '';
  }
  function probe(requestId) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.react-flow__node[data-id]'));
    var root = document.getElementById('root');
    post({ type: 'zenwave.host.probeResult', payload: {
      requestId: requestId,
      nodeIds: nodes.map(function (node) { return node.getAttribute('data-id'); }),
      highlightedNodeIds: nodes.filter(function (node) {
        return node.classList.contains('eventflow-node-highlighted') || node.querySelector('.eventflow-node-highlighted') !== null;
      }).map(function (node) { return node.getAttribute('data-id'); }),
      text: root ? String(root.innerText || root.textContent || '').slice(0, 20000) : '',
      stateKind: shown ? shown.kind : undefined,
      stateMode: shown ? shown.mode : undefined,
      viewSelector: selectedView() || undefined,
      stylesheets: Array.prototype.filter.call(document.styleSheets, function (sheet) { return !!sheet.href; }).length,
      cspViolations: violations.slice()
    } });
  }
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'zenwave.host.state') show(message.payload || null);
    if (message.type === 'zenwave.host.probe' && message.payload) probe(message.payload.requestId);
    if (message.type === 'zenwave.host.selectView' && message.payload) {
      var input = document.querySelector('.view-selector input[value="' + (message.payload.viewMode === 'services' ? 'services' : 'flow') + '"]');
      if (input) input.click();
    }
  });
})();`;
