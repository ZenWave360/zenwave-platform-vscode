/**
 * Markdown to HTML for the preview page. Pure: no DOM, so the unit tests run it as it is.
 *
 * Raw HTML in the Markdown is not interpreted (it is shown as the text it is), and what comes
 * out is still sanitised before it reaches the page (see `sanitise.ts`).
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

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

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
