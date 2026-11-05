import { FOLLOWING_VIEW_TYPE } from './protocol.js';

/** What the following preview is told about the editor that just took focus (MP-R31). */
export interface FollowCandidate {
  readonly uri: string;
  /** A ZDL or ZFL that is not untitled: `isPreviewableDocument` and `followsLanguage`. A ZW is not followed. */
  readonly previewable: boolean;
  /** One side of a diff is not a model the user is working on. */
  readonly inDiff: boolean;
}

/**
 * The document the following preview shows after an editor took focus, or `undefined` to leave it as it is.
 * Only a text editor of a model it can preview moves it: the preview itself, an EventFlow diagram, another
 * language, a view and "no editor" are all left alone (MP-R31).
 */
export function followTarget(candidate: FollowCandidate | undefined, shown: string | undefined): string | undefined {
  if (!candidate || !candidate.previewable || candidate.inDiff) return undefined;
  return candidate.uri === shown ? undefined : candidate.uri;
}

/** Whether the following preview follows a document of this language: ZDL and ZFL, not ZW (MP-R31). */
export function followsLanguage(languageId: string | undefined, path: string): boolean {
  if (languageId !== undefined) return languageId === 'zdl' || languageId === 'zfl';
  return /\.(zdl|zfl)$/i.test(path);
}

/** The tab title: it names the file shown (MP-R31). */
export function followingTitle(fileName: string | undefined): string {
  return fileName === undefined ? 'Following Preview' : `Following: ${fileName}`;
}

/** A webview tab's `viewType` carries the host's prefix; the tab is the following preview's when it ends with ours. */
export function isFollowingViewType(viewType: string): boolean {
  return viewType === FOLLOWING_VIEW_TYPE || viewType.endsWith(`-${FOLLOWING_VIEW_TYPE}`);
}

/**
 * What the following preview remembers for each file it has shown, for the window's lifetime: the value is the
 * file's own session, which holds the mode, the selected diagram and the scroll position (MP-R31).
 */
export class FollowingMemory<T> {
  private readonly entries = new Map<string, T>();

  /** What was remembered for the document, or a fresh one at its defaults the first time. */
  recall(documentUri: string, create: () => T): T {
    let entry = this.entries.get(documentUri);
    if (entry === undefined) {
      entry = create();
      this.entries.set(documentUri, entry);
    }
    return entry;
  }

  has(documentUri: string): boolean {
    return this.entries.has(documentUri);
  }
}
