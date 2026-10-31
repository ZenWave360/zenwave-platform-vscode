import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Which page of the EventFlow webview package the extension ships: `webview-toolbar/`
 * (with a Flow / Systems selector) when the package has it, otherwise `webview/`.
 * Both have the same files and the same protocol, so the extension loads either from
 * the same place. Remove the fallback, and with it this module's `webview/` branch,
 * when the pin in package.json (`zenwaveEventFlowWebview`) moves to a version that ships `webview-toolbar/`.
 */
export const PAGE_DIRECTORIES = ['webview-toolbar', 'webview'];

/** The page directory to ship, or undefined when the package has no built page at all. */
export function chooseEventFlowPage(packageDirectory) {
  for (const name of PAGE_DIRECTORIES) {
    const page = path.join(packageDirectory, name);
    if (fs.existsSync(path.join(page, 'index.html')) && fs.existsSync(path.join(page, 'protocol.json'))) return { name, page };
  }
  return undefined;
}
