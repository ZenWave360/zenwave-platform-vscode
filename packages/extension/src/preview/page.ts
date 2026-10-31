/**
 * The HTML of a preview webview. Pure: the webview's URI mapping and CSP source
 * are passed in.
 *
 * Scripts run only from the extension's own resources and this page's one nonce,
 * with no remote origin and no `unsafe-eval`; everything else is `default-src 'none'`.
 *
 * Markdown and HTML representations are inserted only after the content bundle has
 * sanitised them, and the policy gives them no `img-src` beyond the extension's own
 * files and `data:`, so nothing in them reaches a network.
 *
 * Styles are the one exception: `style-src` allows `'unsafe-inline'`, on this page
 * only. Mermaid measures text in the live document with `<style>` elements and
 * `style` attributes it inserts itself, and offers no way to nonce them. Under a
 * nonce-only policy it drew class diagrams and flowcharts at other sizes than it
 * does when its styles apply (a 199x337 class diagram became 240x349 once they
 * did, and a flowchart label wrapped differently), with a violation reported for
 * every style it inserted. A page with no network access cannot be made to fetch
 * anything by CSS, and what Mermaid draws is sanitised by Mermaid first.
 */

export interface PreviewPageResources {
  /** `webview.cspSource`. */
  readonly cspSource: string;
  readonly nonce: string;
  /** The page script, the page stylesheet and the Mermaid bundle, as webview URI strings. */
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly mermaidUri: string;
  /** The content bundle: Markdown and the sanitiser. */
  readonly contentUri: string;
}

export function previewContentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src ${cspSource} 'nonce-${nonce}'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
  ].join('; ');
}

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function buildPreviewHtml(resources: PreviewPageResources): string {
  const { cspSource, nonce } = resources;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attribute(previewContentSecurityPolicy(cspSource, nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZenWave Preview</title>
<link rel="stylesheet" href="${attribute(resources.styleUri)}">
</head>
<body data-mermaid-src="${attribute(resources.mermaidUri)}" data-content-src="${attribute(resources.contentUri)}">
<header id="controls" hidden>
<label id="render-mode-field" hidden>Render mode <select id="render-mode"></select></label>
<label id="diagram-field" hidden>Diagram <select id="diagram"></select></label>
</header>
<div id="state" role="status" hidden></div>
<main id="view" tabindex="-1"></main>
<script nonce="${attribute(nonce)}" src="${attribute(resources.scriptUri)}"></script>
</body>
</html>`;
}

function text(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A static page for when the preview page itself cannot be loaded: it has no
 * script of its own to explain anything, so the explanation is written in.
 * Styled with the editor's variables through the same external stylesheet.
 */
export function buildFailedHtml(resources: Pick<PreviewPageResources, 'cspSource' | 'nonce' | 'styleUri'>, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attribute(previewContentSecurityPolicy(resources.cspSource, resources.nonce))}">
<title>ZenWave Preview</title>
<link rel="stylesheet" href="${attribute(resources.styleUri)}">
</head>
<body>
<div id="state" class="overlay" role="status" data-kind="page-failed"><div class="box"><p class="title">The preview page could not be loaded.</p><p class="detail">${text(message)}\nReinstalling or updating the ZenWave extension restores it; the details are in the ZenWave output.</p></div></div>
</body>
</html>`;
}
