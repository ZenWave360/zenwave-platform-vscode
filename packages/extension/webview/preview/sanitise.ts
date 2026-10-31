/**
 * The one place server content becomes markup. Everything a Markdown or HTML representation
 * says goes through here before the page inserts it.
 *
 * What is kept is reading content: text, headings, lists, tables, code, emphasis, `#anchor`
 * links and ids. Nothing runs (no script, event handler, frame, form or style), and nothing is
 * fetched: a link is kept only when it points inside the page, and an image only when its
 * bytes are in the markup (`data:`). The page's policy is `default-src 'none'` as well, so a
 * failure here is still not a request.
 */
import DOMPurify from 'dompurify';

const config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'picture'],
  FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'target', 'ping', 'rel'],
  // Anything but a fragment is not a link of this page; `data:` images are allowed by DOMPurify's own rule for `img`.
  ALLOWED_URI_REGEXP: /^#/,
  ALLOW_DATA_ATTR: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

export function sanitiseHtml(html: string): string {
  return DOMPurify.sanitize(html, config);
}
