import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Preview } from '../../src/lsp/requests.js';
import { DIAGRAM_SELECTOR, anchorSlugs, renderMarkdown } from '../../webview/preview/markdown.js';

const here = dirname(fileURLToPath(import.meta.url));
const page = (JSON.parse(readFileSync(join(here, '../fixtures/lsp-samples/preview-zdl.json'), 'utf8')) as { result: Preview }).result.representations[0]!.content;

const unescape = (text: string): string => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('headings get the anchors dsl-docs wrote its links with: lowercase, punctuation dropped, a repeat numbered in page order', () => {
  assert.deepEqual(anchorSlugs(['Domain events', 'Order (v2)', 'Domain events', 'Domain events', 'snake_case-name']), [
    'domain-events', 'order-v2', 'domain-events-1', 'domain-events-2', 'snake_case-name',
  ]);
  assert.deepEqual(anchorSlugs(['Aggregates', 'Aggregates-1', 'Aggregates']), ['aggregates', 'aggregates-1', 'aggregates-2'],
    'a number already taken by a heading is skipped');
});

test('every link of the sample page points to a heading the page renders', () => {
  const html = renderMarkdown(page);
  const anchors = new Set([...html.matchAll(/<h[1-6] data-anchor="([^"]+)"/g)].map((match) => match[1]!));
  const links = [...html.matchAll(/<a href="#([^"]+)"/g)].map((match) => decodeURIComponent(match[1]!));
  assert.ok(links.length >= 10, `the sample has a table of contents: ${links.length} links`);
  assert.deepEqual(links.filter((link) => !anchors.has(link)), []);
  assert.ok(anchors.has('aggregates') && anchors.has('aggregates-1') && anchors.has('domain-events-1'), `repeated headings: ${[...anchors].join()}`);
});

test('fenced mermaid blocks are found, with their text untouched, frontmatter included', () => {
  const html = renderMarkdown(page);
  const fences = [...html.matchAll(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g)].map((match) => unescape(match[1]!));
  assert.equal(fences.length, (page.match(/^```mermaid$/gm) ?? []).length);
  assert.ok(fences.length >= 3);
  assert.ok(fences.some((text) => text.startsWith('---\nconfig:')), 'a block opens with its frontmatter');
  for (const text of fences) assert.ok(page.includes('```mermaid\n' + text + '```'), 'the text of a block is the text of the fence');
  assert.equal(DIAGRAM_SELECTOR, 'pre > code.language-mermaid');
  assert.ok(!/language-mermaid/.test(renderMarkdown('```js\nmermaid\n```\n')), 'only the mermaid language is a diagram');
});

test('raw HTML in Markdown is shown as text, not interpreted, and a script link is not made a link', () => {
  const html = renderMarkdown('<script>window.x = 1</script>\n\n<img src="https://remote.invalid/a.png" onerror="x()">\n\n[bad](javascript:alert(1))\n');
  assert.ok(!/<script|<img/.test(html), html);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!/href="javascript:/.test(html), html);
});

test('tables, code and lists render as the elements a theme can style', () => {
  const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | `2` |\n\n- one\n- two\n');
  assert.ok(html.includes('<table>') && html.includes('<th>a</th>') && html.includes('<code>2</code>') && html.includes('<li>one</li>'), html);
});
