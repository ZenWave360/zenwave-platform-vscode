import { parseZdl } from '@zenwave360/dsl';

export type ModelValue = string | number | boolean | null | readonly ModelValue[] | ModelObject;

export interface ModelObject {
  readonly [key: string]: ModelValue;
}

export interface SourceRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export interface CliOption {
  readonly name: string;
  readonly value?: string;
}

export interface PluginDeclaration {
  readonly name: string;
  readonly disabled: boolean;
  readonly inherit: boolean;
  readonly config: Readonly<Record<string, ModelValue>>;
  readonly cliOptions: readonly CliOption[];
  readonly location: SourceRange;
  readonly offsets: readonly [number, number];
}

export interface ModelImport {
  readonly key?: string;
  readonly value: string;
}

export interface ParsedModel {
  readonly config: Readonly<Record<string, ModelValue>>;
  readonly cliOptions: readonly CliOption[];
  readonly plugins: readonly PluginDeclaration[];
  readonly imports: readonly ModelImport[];
  readonly locations: Readonly<Record<string, SourceRange>>;
}

type Parser = (text: string) => ParsedModel | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asModelValue(value: unknown): ModelValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    // Kotlin/JS reports integers as Long objects; their string form is exact.
    const text = String(value);
    return text === '[object Object]' ? undefined : text;
  }
  if (Array.isArray(value)) {
    const values = value.map(asModelValue);
    return values.every((item) => item !== undefined) ? (values as ModelValue[]) : undefined;
  }
  if (isObject(value)) {
    const result: Record<string, ModelValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const parsed = asModelValue(item);
      if (parsed !== undefined) {
        result[key] = parsed;
      }
    }
    return result;
  }
  return undefined;
}

function asObject(value: unknown): Record<string, ModelValue> {
  const parsed = asModelValue(value);
  return isObject(parsed) ? parsed : {};
}

function locationNumbers(value: unknown): readonly number[] | undefined {
  if (!isObject(value) && !Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as ArrayLike<unknown>;
  const numbers = Array.from({ length: 6 }, (_, index) => candidate[index]);
  return numbers.every((item) => typeof item === 'number') ? (numbers as number[]) : undefined;
}

/** Columns mix inclusive rule ends and exclusive token ends; offsets are exclusive. */
export function toSourceRange(value: unknown, text: string): SourceRange | undefined {
  const tuple = locationNumbers(value);
  if (!tuple) {
    return undefined;
  }
  const [, endOffset, startLine, startColumn] = tuple;
  if (
    startLine === undefined ||
    startColumn === undefined ||
    endOffset === undefined || endOffset < 0 || endOffset > text.length
  ) {
    return undefined;
  }
  const endLines = text.slice(0, endOffset).split('\n');
  return {
    start: { line: Math.max(0, startLine - 1), character: startColumn },
    end: { line: endLines.length - 1, character: endLines.at(-1)?.length ?? 0 },
  };
}

function locationOffsets(value: unknown): readonly [number, number] | undefined {
  const tuple = locationNumbers(value);
  const start = tuple?.[0];
  const end = tuple?.[1];
  return start === undefined || end === undefined ? undefined : [start, end - 1];
}

function readsAsInheritance(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.replaceAll(/\s/g, '').toLowerCase() !== 'inheritfalse';
  }
  return value !== false;
}

function cliOptions(value: unknown): readonly CliOption[] {
  if (!isObject(value)) {
    return [];
  }
  return Object.entries(value).map(([name, optionValue]) => ({
    name,
    ...(optionValue === null || optionValue === undefined ? {} : { value: String(optionValue) }),
  }));
}

export function parseModel(text: string): ParsedModel | undefined {
  let value: unknown;
  try {
    value = parseZdl(text);
  } catch {
    return undefined;
  }
  if (!isObject(value)) {
    return undefined;
  }

  const rawLocations = isObject(value.locations) ? value.locations : {};
  const locations: Record<string, SourceRange> = {};
  for (const [key, rawLocation] of Object.entries(rawLocations)) {
    const location = toSourceRange(rawLocation, text);
    if (location) {
      locations[key] = location;
    }
  }

  const plugins: PluginDeclaration[] = [];
  if (Array.isArray(value.pluginsList)) {
    for (const [index, rawPlugin] of value.pluginsList.entries()) {
      if (!isObject(rawPlugin)) {
        continue;
      }
      const name = typeof rawPlugin.name === 'string' ? rawPlugin.name : `plugin${index}`;
      const rawLocation = rawLocations[`pluginsList.${index}`];
      const location = toSourceRange(rawLocation, text);
      const offsets = locationOffsets(rawLocation);
      if (!location || !offsets) {
        continue;
      }

      // ANTLR recovers an unfinished declaration at EOF. A lens for that partial
      // declaration would be executable but misleading, so require its reported
      // source slice to end with the declaration's closing brace.
      if (!text.slice(offsets[0], offsets[1] + 1).trimEnd().endsWith('}')) {
        continue;
      }

      const options = isObject(rawPlugin.options) ? rawPlugin.options : {};
      plugins.push({
        name,
        disabled: rawPlugin.disabled === true,
        inherit: readsAsInheritance(options.inherit),
        config: asObject(rawPlugin.config),
        cliOptions: cliOptions(rawPlugin.cliOptions),
        location,
        offsets,
      });
    }
  }

  const imports: ModelImport[] = [];
  if (Array.isArray(value.imports)) {
    for (const item of value.imports) {
      if (!isObject(item) || typeof item.value !== 'string') {
        continue;
      }
      imports.push({
        value: item.value,
        ...(typeof item.key === 'string' ? { key: item.key } : {}),
      });
    }
  }

  return {
    config: asObject(value.config),
    cliOptions: cliOptions(value.cliOptions),
    plugins,
    imports,
    locations,
  };
}

export class ModelCache {
  private readonly entries = new Map<string, { version: number; model: ParsedModel | undefined }>();

  constructor(private readonly parser: Parser = parseModel, private readonly capacity = 8) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('ModelCache capacity must be a positive integer');
    }
  }

  get(uri: string, version: number, text: string): ParsedModel | undefined {
    const previous = this.entries.get(uri);
    const entry = previous?.version === version ? previous : { version, model: this.parser(text) };
    this.entries.delete(uri);
    this.entries.set(uri, entry);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return entry.model;
  }
}

export function pluginAtOffset(
  model: ParsedModel,
  offset: number,
): PluginDeclaration | undefined {
  return model.plugins.find(
    (plugin) => plugin.offsets[0] <= offset && offset <= plugin.offsets[1],
  );
}

/** The declaration to run: the instance at `offset` when several share a type name. */
export function findRunnablePlugin(
  model: ParsedModel,
  name: string,
  offset?: number,
): PluginDeclaration | undefined {
  const enabled = model.plugins.filter((plugin) => plugin.name === name && !plugin.disabled);
  if (offset !== undefined) {
    const atOffset = enabled.find(
      (plugin) => plugin.offsets[0] <= offset && offset <= plugin.offsets[1],
    );
    if (atOffset) {
      return atOffset;
    }
  }
  return enabled[0];
}

const COMPLETION_PLUGIN = '__ZenWaveCompletionPlugin__';

/** Uses the upstream parser as a context oracle instead of duplicating ZDL grammar rules. */
export function isPluginNamePosition(text: string, offset: number): boolean {
  let start = offset;
  let end = offset;
  while (start > 0 && /[\w.-]/.test(text[start - 1] ?? '')) {
    start -= 1;
  }
  while (end < text.length && /[\w.-]/.test(text[end] ?? '')) {
    end += 1;
  }
  const candidate = `${text.slice(0, start)}${COMPLETION_PLUGIN} {}${text.slice(end)}`;
  return parseModel(candidate)?.plugins.some((plugin) => plugin.name === COMPLETION_PLUGIN) ?? false;
}
