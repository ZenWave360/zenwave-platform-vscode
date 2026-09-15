import shippedCatalogueJson from '../../resources/sdk-plugin-catalogue.json';
import type { Logger } from '../host/logger.js';
import type { SdkProcessService, SdkSettings } from './host.js';

export interface CatalogueOption {
  readonly name: string;
  readonly description?: string;
  readonly type?: string;
  readonly defaultValue?: unknown;
  readonly values: readonly string[];
  readonly documentation?: string;
}

export interface CataloguePlugin {
  readonly name: string;
  readonly configClassName: string;
  readonly title?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly documentation?: string;
  readonly options: Readonly<Record<string, CatalogueOption>>;
}

export interface Catalogue {
  readonly origin: 'installed' | 'shipped';
  readonly source: string;
  readonly version: string;
  readonly plugins: readonly CataloguePlugin[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function documentation(value: Record<string, unknown>): string | undefined {
  return (
    optionalString(value.documentation) ??
    optionalString(value.documentationUrl) ??
    optionalString(value.docLink)
  );
}

export function parseCatalogue(raw: unknown, origin: Catalogue['origin']): Catalogue | undefined {
  if (!isObject(raw) || !Array.isArray(raw.plugins)) {
    return undefined;
  }

  const plugins: CataloguePlugin[] = [];
  for (const rawPlugin of raw.plugins) {
    if (!isObject(rawPlugin) || typeof rawPlugin.configClassName !== 'string') {
      continue;
    }
    const pluginDetails = isObject(rawPlugin.plugin) ? rawPlugin.plugin : {};
    const rawOptions = isObject(rawPlugin.options) ? rawPlugin.options : {};
    const options: Record<string, CatalogueOption> = {};
    for (const [optionName, rawOption] of Object.entries(rawOptions)) {
      if (!isObject(rawOption)) {
        continue;
      }
      const optionDescription = optionalString(rawOption.description);
      const optionType = optionalString(rawOption.type);
      const optionDocumentation = documentation(rawOption);
      options[optionName] = {
        name: optionalString(rawOption.name) ?? optionName,
        values: Array.isArray(rawOption.values) ? rawOption.values.map(String) : [],
        ...(optionDescription ? { description: optionDescription } : {}),
        ...(optionType ? { type: optionType } : {}),
        ...('defaultValue' in rawOption ? { defaultValue: rawOption.defaultValue } : {}),
        ...(optionDocumentation ? { documentation: optionDocumentation } : {}),
      };
    }

    const className = rawPlugin.configClassName;
    const title = optionalString(rawPlugin.title) ?? optionalString(pluginDetails.title);
    const summary = optionalString(rawPlugin.summary) ?? optionalString(pluginDetails.summary);
    const description =
      optionalString(rawPlugin.description) ?? optionalString(pluginDetails.description);
    const pluginDocumentation = documentation(rawPlugin) ?? documentation(pluginDetails);
    plugins.push({
      name:
        optionalString(rawPlugin.name) ??
        optionalString(rawPlugin.configClassSimpleName) ??
        className.slice(className.lastIndexOf('.') + 1),
      configClassName: className,
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(description ? { description } : {}),
      ...(pluginDocumentation ? { documentation: pluginDocumentation } : {}),
      options,
    });
  }

  const version = optionalString(raw.version) ?? 'unknown';
  return {
    origin,
    source: optionalString(raw.source) ?? `ZenWave SDK ${version}`,
    version,
    plugins,
  };
}

const parsedShippedCatalogue = parseCatalogue(shippedCatalogueJson, 'shipped');
if (!parsedShippedCatalogue) {
  throw new Error('The shipped SDK plugin catalogue is invalid');
}
const SHIPPED_CATALOGUE: Catalogue = parsedShippedCatalogue;

interface CatalogueState {
  catalogue: Catalogue;
  loading?: Promise<void>;
}

export class PluginCatalogue {
  private readonly states = new Map<string, CatalogueState>();

  constructor(
    private readonly processService: SdkProcessService | undefined,
    private readonly logger: Pick<Logger, 'info' | 'warn'>,
  ) {}

  get(
    key: string,
    cwd: string | undefined,
    settings: SdkSettings,
    maySpawn: boolean,
  ): Catalogue | undefined {
    if (!this.processService || !maySpawn) {
      return SHIPPED_CATALOGUE;
    }

    const state = this.states.get(key) ?? { catalogue: SHIPPED_CATALOGUE };
    this.states.set(key, state);
    if (!state.loading) {
      state.loading = this.load(state, cwd, settings);
    }
    return state.catalogue;
  }

  refresh(key?: string): void {
    if (key) {
      this.states.delete(key);
    } else {
      this.states.clear();
    }
  }

  private async load(
    state: CatalogueState,
    cwd: string | undefined,
    settings: SdkSettings,
  ): Promise<void> {
    const command = `${settings.cliCommand} -h json`;
    try {
      const response = await this.processService?.catalogue(
        settings.cliCommand,
        cwd,
        settings.invocation,
      );
      if (!response || response.exitCode !== 0) {
        throw new Error(response?.stderr.trim() || `exit code ${response?.exitCode ?? 'unknown'}`);
      }
      const start = response.stdout.indexOf('{');
      const end = response.stdout.lastIndexOf('}');
      if (start < 0 || end <= start) {
        throw new Error('stdout did not contain a JSON object');
      }
      const installed = parseCatalogue(JSON.parse(response.stdout.slice(start, end + 1)), 'installed');
      if (!installed) {
        throw new Error('the JSON catalogue shape was not recognised');
      }
      state.catalogue = installed;
      this.logger.info(
        `Loaded ${installed.plugins.length} SDK plugins from ${command} (${installed.version})`,
      );
    } catch (error) {
      state.catalogue = SHIPPED_CATALOGUE;
      this.logger.warn(
        `Could not load SDK plugin catalogue with "${command}" in ${cwd ?? 'the workspace'}; using shipped ${SHIPPED_CATALOGUE.source}. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
