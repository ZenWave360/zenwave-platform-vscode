/**
 * Turning a server's whole-document rewrite into the smallest replacement that
 * produces it. Pure text handling: nothing here knows what the text means.
 */

export interface TextReplacement {
  /** Offset in the current text where the replaced part starts. */
  readonly start: number;
  /** Offset in the current text where the replaced part ends (exclusive). */
  readonly end: number;
  readonly text: string;
}

/** Brings a server's `\n` text to the document's line ending, so an unchanged document compares equal. */
export function withLineEnding(text: string, eol: '\n' | '\r\n'): string {
  const normalised = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? normalised : normalised.replace(/\n/g, '\r\n');
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** Would cutting `text` at `offset` split a CRLF pair or a surrogate pair? */
function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  return (before === 13 && text.charCodeAt(offset) === 10) || isHighSurrogate(before);
}

/**
 * The single replacement that turns `current` into `next`, touching only the
 * part between their common prefix and common suffix; `undefined` when they are
 * equal. Keeping the replacement small is what leaves cursors and folded
 * regions outside the change where they were.
 */
export function minimalReplacement(current: string, next: string): TextReplacement | undefined {
  if (current === next) return undefined;
  const limit = Math.min(current.length, next.length);
  let prefix = 0;
  while (prefix < limit && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  while (prefix > 0 && (splitsPair(current, prefix) || splitsPair(next, prefix))) prefix--;
  let suffix = 0;
  while (suffix < limit - prefix &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix++;
  while (suffix > 0 && (splitsPair(current, current.length - suffix) || splitsPair(next, next.length - suffix))) suffix--;
  return { start: prefix, end: current.length - suffix, text: next.slice(prefix, next.length - suffix) };
}

/** Applies a replacement to text; used to check that the replacement reproduces the server's result. */
export function applyReplacement(current: string, replacement: TextReplacement): string {
  return current.slice(0, replacement.start) + replacement.text + current.slice(replacement.end);
}
