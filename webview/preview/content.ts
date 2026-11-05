/**
 * The page's content bundle: Markdown to sanitised HTML, and sanitised HTML. A script of its own,
 * loaded by the page the first time a Markdown or HTML representation is shown, so a preview
 * of a diagram alone does not carry it (the Mermaid bundle is loaded the same way).
 */
import { renderMarkdown } from './markdown.js';
import { sanitiseHtml } from './sanitise.js';

export interface PreviewContent {
  markdownToHtml(source: string): string;
  sanitiseHtml(html: string): string;
}

(window as unknown as { zenwavePreviewContent: PreviewContent }).zenwavePreviewContent = {
  markdownToHtml: (source) => sanitiseHtml(renderMarkdown(source)),
  sanitiseHtml,
};
