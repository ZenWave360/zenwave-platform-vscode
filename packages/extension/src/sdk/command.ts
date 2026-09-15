import type { ModelValue, ParsedModel, PluginDeclaration } from './model.js';

export interface CommandSettings {
  readonly cliCommand: string;
  readonly extraArgs: readonly string[];
}

const MAVEN_COORDINATE = /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;
const FILE_PLACEHOLDER = /\$\{this\.file\.path\}/g;

function normalizedPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function quoteInjectedPath(filePath: string): string {
  const normalized = normalizedPath(filePath);
  return /\s/.test(normalized) ? `"${normalized}"` : normalized;
}

function formatValue(value: ModelValue): string {
  if (Array.isArray(value)) {
    return value.map(formatValue).join(',');
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

function optionArgument(name: string, value: ModelValue, filePath: string): string {
  const formatted = formatValue(value);
  if (formatted.includes('${this.file.path}')) {
    const substituted = formatted.replace(FILE_PLACEHOLDER, normalizedPath(filePath));
    return `${name}=${/\s/.test(substituted) ? `"${substituted}"` : substituted}`;
  }
  return `${name}=${/\s/.test(formatted) ? `"${formatted}"` : formatted}`;
}

export function buildSdkCommand(
  model: ParsedModel,
  plugin: PluginDeclaration,
  filePath: string,
  settings: CommandSettings,
): string {
  const options = new Map<string, ModelValue>();
  if (plugin.inherit) {
    for (const [name, value] of Object.entries(model.config)) {
      options.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(plugin.config)) {
    options.set(name, value);
  }
  const defaultedZdlFile = !options.has('zdlFile') && !options.has('zdlFiles');
  if (defaultedZdlFile) {
    options.set('zdlFile', normalizedPath(filePath));
  }

  const dependencies = model.imports
    .map((modelImport) => modelImport.value)
    .filter((value) => MAVEN_COORDINATE.test(value));

  const arguments_: string[] = ['-p', plugin.name];
  if (dependencies.length > 0) {
    arguments_.push('--deps', dependencies.join(','));
  }
  for (const [name, value] of options) {
    if (defaultedZdlFile && name === 'zdlFile') {
      arguments_.push(`${name}=${quoteInjectedPath(filePath)}`);
    } else {
      arguments_.push(optionArgument(name, value, filePath));
    }
  }
  for (const option of plugin.cliOptions) {
    arguments_.push(`--${option.name}${option.value === undefined ? '' : `=${option.value}`}`);
  }
  arguments_.push(...settings.extraArgs);

  return [settings.cliCommand.trim(), ...arguments_.filter((argument) => argument.length > 0)]
    .join(' ')
    .trim();
}
