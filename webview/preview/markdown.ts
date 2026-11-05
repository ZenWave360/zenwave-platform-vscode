/**
 * Markdown to HTML for the preview page. Pure: no DOM, so the unit tests run it as it is.
 *
 * Raw HTML in the Markdown is not interpreted (`html: false`): it is shown as the text it is.
 * The only exception is a collapsible section, and only on the exact lines `dsl-docs` writes
 * (MP-R21): `<details>`, `<details open>`, `<summary>` with its text and the closing
 * `</summary>` on that same line, and `</details>` or `</summary>` alone. A near miss, such as
 * `<details onclick="x">`, stays text. What comes out is still sanitised before it reaches the
 * page (see `sanitise.ts`).
 *
 * Headings carry the anchor the server wrote for them in `data-anchor`, and the page turns it
 * into the element id once the markup has been sanitised: the sanitiser drops ids that would
 * shadow a property of `document`, and a heading may be called "Forms" or "Images".
 */
import MarkdownIt from 'markdown-it';

/**
 * The anchor of each heading, in page order. The same rule `dsl-docs` writes its links with
 * (`internal/Anchors.kt`, the one GitHub and VS Code use): lowercase, characters other than
 * letters, digits, space, `_` and `-` dropped, spaces to `-`, and a repeated anchor
 * gets `-1`, `-2`, ... in heading order.
 */
export function anchorSlugs(headings: readonly string[]): string[] {
  const used = new Set<string>();
  const counts = new Map<string, number>();
  return headings.map((text) => {
    const base = text.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');
    let candidate = base;
    while (used.has(candidate)) {
      const next = (counts.get(base) ?? 0) + 1;
      counts.set(base, next);
      candidate = `${base}-${next}`;
    }
    used.add(candidate);
    return candidate;
  });
}

const COLLAPSIBLE_LINES = new Set(['<details>', '<details open>', '</details>', '</summary>']);

/** `<summary>text</summary>` as its own line. The text is not empty and holds no further markup. */
function isSummaryLine(line: string): boolean {
  const prefix = '<summary>';
  const suffix = '</summary>';
  if (!line.startsWith(prefix) || !line.endsWith(suffix)) return false;
  const text = line.slice(prefix.length, -suffix.length);
  return text.trim().length > 0 && !text.includes('<') && !text.includes('>');
}

function isCollapsibleLine(line: string): boolean {
  return COLLAPSIBLE_LINES.has(line) || isSummaryLine(line);
}

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

// One exact line, and only at the top level. `html: false` still turns every other tag into text.
// Silent so a following line can end a paragraph; the line is emitted only once parsing reaches it.
markdown.block.ruler.before('html_block', 'zenwave_collapsible', (state, startLine, endLine, silent) => {
  if (startLine >= endLine) return false;
  const begin = state.bMarks[startLine];
  const end = state.eMarks[startLine];
  if (begin === undefined || end === undefined) return false;
  if (!isCollapsibleLine(state.src.slice(begin, end))) return false;
  if (silent) return true;
  if (state.parentType !== 'root') return false;
  state.line = startLine + 1;
  const token = state.push('html_block', '', 0);
  token.content = `${state.src.slice(begin, end)}\n`;
  token.map = [startLine, state.line];
  return true;
}, { alt: ['paragraph', 'reference', 'blockquote'] });

markdown.core.ruler.push('zenwave_heading_anchors', (state) => {
  const opens: { readonly open: (typeof state.tokens)[number]; readonly source: string }[] = [];
  state.tokens.forEach((token, index) => {
    if (token.type === 'heading_open') opens.push({ open: token, source: state.tokens[index + 1]?.content ?? '' });
  });
  const slugs = anchorSlugs(opens.map((heading) => heading.source));
  opens.forEach(({ open }, index) => {
    if (slugs[index]) open.attrSet('data-anchor', slugs[index]!);
  });
});

/** The language of the fenced blocks the page draws as diagrams. */
export const DIAGRAM_FENCE = 'mermaid';

/** The CSS selector of a fenced block of that language, in the HTML this module produces. */
export const DIAGRAM_SELECTOR = `pre > code.language-${DIAGRAM_FENCE}`;

/** Unsanitised HTML for a Markdown document. */
export function renderMarkdown(source: string): string {
  return markdown.render(source);
}
