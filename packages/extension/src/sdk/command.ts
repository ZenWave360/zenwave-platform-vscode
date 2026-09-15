import type { ModelValue, ParsedModel, PluginDeclaration } from './model.js';

export interface CommandSettings {
  readonly cliCommand: string;
  readonly extraArgs: readonly string[];
}

export interface SdkInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly commandLine: string;
}

const MAVEN_COORDINATE = /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;
const FILE_PLACEHOLDER = /\$\{this\.file\.path\}/g;

function normalizedPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function splitCommandLine(commandLine: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;

  const trimmed = commandLine.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    const next = trimmed[index + 1];
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
    } else if (character === '\\' && quote !== "'") {
      const escapable =
        quote === '"'
          ? next !== undefined && ['"', '\\', '$', '`'].includes(next)
          : next !== undefined && (/\s/.test(next) || ['"', "'", '\\'].includes(next));
      if (escapable) {
        escaped = true;
      } else {
        word += character;
      }
      started = true;
    } else if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        word += character;
      }
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (escaped) {
    word += '\\';
  }
  if (started) {
    words.push(word);
  }
  return words;
}

const SAFE_SHELL_TOKEN = /^[a-zA-Z0-9_@%+=:,./-]+$/;
const SAFE_DOUBLE_QUOTED_VALUE = /^[^"$`\\\r\n]*$/;

function quoteShellToken(value: string): string {
  if (value.length > 0 && SAFE_SHELL_TOKEN.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function displayArgument(argument: string): string {
  if (SAFE_SHELL_TOKEN.test(argument)) {
    return argument;
  }
  const equals = argument.indexOf('=');
  if (equals > 0) {
    const name = argument.slice(0, equals + 1);
    const value = argument.slice(equals + 1);
    if (SAFE_SHELL_TOKEN.test(name) && SAFE_DOUBLE_QUOTED_VALUE.test(value)) {
      return `${name}"${value}"`;
    }
  }
  return quoteShellToken(argument);
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
    return `${name}=${substituted}`;
  }
  return `${name}=${formatted}`;
}

export function buildSdkInvocation(
  model: ParsedModel,
  plugin: PluginDeclaration,
  filePath: string,
  settings: CommandSettings,
): SdkInvocation {
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
      arguments_.push(`${name}=${normalizedPath(filePath)}`);
    } else {
      arguments_.push(optionArgument(name, value, filePath));
    }
  }
  for (const option of plugin.cliOptions) {
    arguments_.push(`--${option.name}${option.value === undefined ? '' : `=${option.value}`}`);
  }
  arguments_.push(...settings.extraArgs);

  const command = splitCommandLine(settings.cliCommand);
  const executable = command[0] ?? '';
  const invocationArguments = [
    ...command.slice(1),
    ...arguments_.filter((argument) => argument.length > 0),
  ];
  return {
    executable,
    arguments: invocationArguments,
    commandLine: [executable, ...invocationArguments]
      .filter((part) => part.length > 0)
      .map(displayArgument)
      .join(' '),
  };
}

export function buildSdkCommand(
  model: ParsedModel,
  plugin: PluginDeclaration,
  filePath: string,
  settings: CommandSettings,
): string {
  return buildSdkInvocation(model, plugin, filePath, settings).commandLine;
}
