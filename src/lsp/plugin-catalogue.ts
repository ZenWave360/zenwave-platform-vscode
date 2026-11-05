import shippedCatalogue from '../../resources/sdk-plugin-catalogue.json';
import type { Logger } from '../host/logger.js';

/** The catalogue as the server takes it: the SDK's `-h json` shape, `{ source, version, plugins }`. */
export type PluginCatalogue = Readonly<Record<string, unknown>> & { readonly plugins: readonly unknown[] };

/** Where a catalogue comes from. It may throw or answer something that is not a catalogue; the caller copes with both. */
export type PluginCatalogueSource = () => unknown | Promise<unknown>;

/**
 * The catalogue shipped with the extension, bundled into it at build time, so the same file serves the desktop host and
 * the Web Worker host with no file-system access.
 */
export const shippedCatalogueSource: PluginCatalogueSource = () => shippedCatalogue;

function isCatalogue(value: unknown): value is PluginCatalogue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Array.isArray((value as { plugins?: unknown }).plugins);
}

/**
 * The catalogue to send at initialisation, or `undefined` when the source fails: the server then uses its own copy, and
 * the language server still starts (MP-R16). A failure is logged, never thrown.
 */
export async function loadPluginCatalogue(source: PluginCatalogueSource, logger: Pick<Logger, 'info' | 'warn'>): Promise<PluginCatalogue | undefined> {
  try {
    const catalogue = await source();
    if (!isCatalogue(catalogue)) {
      logger.warn('Plugin catalogue: the extension\'s copy is not a catalogue (no plugins list); the language server uses its own');
      return undefined;
    }
    const version = typeof catalogue.version === 'string' ? catalogue.version : 'unknown version';
    logger.info(`Plugin catalogue: sending the extension's copy (${catalogue.plugins.length} plugins, ${version}) to the language server`);
    return catalogue;
  } catch (error) {
    logger.warn(`Plugin catalogue: the extension's copy could not be read (${error instanceof Error ? error.message : String(error)}); the language server uses its own`);
    return undefined;
  }
}
