import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The page of the EventFlow webview package the extension ships: `webview-toolbar/`, with the
 * Flow / Systems selector. The package's minimal `webview/` page is for hosts that draw their own
 * selector, such as IntelliJ, and is not shipped.
 */
export const PAGE_DIRECTORIES = ['webview-toolbar'];

/** The page directory to ship, or undefined when the package has no built page. */
export function chooseEventFlowPage(packageDirectory) {
  for (const name of PAGE_DIRECTORIES) {
    const page = path.join(packageDirectory, name);
    if (fs.existsSync(path.join(page, 'index.html')) && fs.existsSync(path.join(page, 'protocol.json'))) return { name, page };
  }
  return undefined;
}
