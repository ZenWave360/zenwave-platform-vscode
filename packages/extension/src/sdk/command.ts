import type { ModelValue, ParsedModel, PluginDeclaration } from './model.js';
import type { ShellFamily } from './shell.js';

export interface CommandSettings {
  readonly cliCommand: string;
  readonly extraArgs: readonly string[];
}

const MAVEN_COORDINATE = /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;
const FILE_PLACEHOLDER = /\$\{this\.file\.path\}/g;

function normalizedPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

/** Splits a configured command or a source-form CLI value into words, POSIX style. */
export function splitCommandLine(commandLine: string): string[] {
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

/**
 * Characters that are literal when unquoted. PowerShell treats `,` as an array
 * operator, a leading `@` as splatting and `--%` as stop-parsing, so its set is
 * narrower.
 */
const SAFE_TOKEN: Record<ShellFamily, RegExp> = {
  posix: /^[a-zA-Z0-9_@%+=:,./-]+$/,
  powershell: /^[a-zA-Z0-9_+=:./-]+$/,
};

/** Double quotes are readable, but only safe when nothing inside them expands. */
const SAFE_IN_DOUBLE_QUOTES = /^[^"$`\\\r\n“”„]*$/;

function strongQuote(value: string, shell: ShellFamily): string {
  return shell === 'posix'
    ? `'${value.replaceAll("'", `'\\''`)}'`
    : // PowerShell also closes a single-quoted string on typographic single quotes.
      `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`;
}

/** Quotes one argument so the shell passes it to the SDK literally. */
export function quoteArgument(argument: string, shell: ShellFamily): string {
  if (SAFE_TOKEN[shell].test(argument)) {
    return argument;
  }
  const equals = argument.indexOf('=');
  if (equals > 0) {
    const name = argument.slice(0, equals + 1);
    const value = argument.slice(equals + 1);
    if (SAFE_TOKEN[shell].test(name) && SAFE_IN_DOUBLE_QUOTES.test(value)) {
      return `${name}"${value}"`;
    }
  }
  return strongQuote(argument, shell);
}

function quoteExecutable(executable: string, shell: ShellFamily): string {
  if (SAFE_TOKEN[shell].test(executable)) {
    return executable;
  }
  // A quoted string in PowerShell's command position is a value, not a call.
  return shell === 'powershell'
    ? `& ${strongQuote(executable, shell)}`
    : strongQuote(executable, shell);
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

function substitutePath(value: string, filePath: string): string {
  return value.replace(FILE_PLACEHOLDER, normalizedPath(filePath));
}

function cliOptionArgument(
  option: PluginDeclaration['cliOptions'][number],
  filePath: string,
): string {
  if (option.value === undefined) {
    return `--${option.name}`;
  }
  // The parser reports CLI values in source form, quotes included.
  const substituted = substitutePath(option.value, filePath);
  const words = splitCommandLine(substituted);
  return `--${option.name}=${words.length === 1 ? words[0]! : substituted}`;
}

/** The SDK arguments for a plugin declaration, unquoted and in order. */
export function buildSdkArguments(
  model: ParsedModel,
  plugin: PluginDeclaration,
  filePath: string,
  settings: CommandSettings,
): string[] {
  const options = new Map<string, ModelValue>();
  if (plugin.inherit) {
    for (const [name, value] of Object.entries(model.config)) {
      options.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(plugin.config)) {
    options.set(name, value);
  }
  if (!options.has('zdlFile') && !options.has('zdlFiles')) {
    options.set('zdlFile', normalizedPath(filePath));
  }

  const dependencies = model.imports
    .map((modelImport) => modelImport.value)
    .filter((value) => MAVEN_COORDINATE.test(value));

  const args = ['-p', plugin.name];
  if (dependencies.length > 0) {
    args.push('--deps', dependencies.join(','));
  }
  for (const [name, value] of options) {
    args.push(`${name}=${substitutePath(formatValue(value), filePath)}`);
  }
  for (const option of plugin.cliOptions) {
    args.push(cliOptionArgument(option, filePath));
  }
  args.push(...settings.extraArgs);
  return args.filter((argument) => argument.length > 0);
}

/**
 * An argument no quoting can deliver intact, if any. Windows PowerShell drops
 * double quotes inside arguments to native commands, and a batch file such as
 * `jbang.cmd` then re-parses what is left, so a `"` could expose `&` or `|` to
 * cmd.exe. Such a run is refused rather than attempted.
 */
export function findUnquotableArgument(
  model: ParsedModel,
  plugin: PluginDeclaration,
  filePath: string,
  settings: CommandSettings,
  shell: ShellFamily,
): string | undefined {
  if (shell !== 'powershell') {
    return undefined;
  }
  return [
    ...splitCommandLine(settings.cliCommand),
    ...buildSdkArguments(model, plugin, filePath, settings),
  ].find((argument) => argument.includes('"'));
}

/**
 * The command line for a plugin, quoted for the shell it will run in. It is
 * both what runs and what the user is shown, so every value the model or the
 * settings supply reaches the SDK as one literal argument.
 */
export function buildSdkCommand(
  model: ParsedModel,
  plugin: PluginDeclaration,
  filePath: string,
  settings: CommandSettings,
  shell: ShellFamily,
): string {
  const [executable, ...prefix] = splitCommandLine(settings.cliCommand);
  return [
    ...(executable ? [quoteExecutable(executable, shell)] : []),
    ...[...prefix, ...buildSdkArguments(model, plugin, filePath, settings)].map((argument) =>
      quoteArgument(argument, shell),
    ),
  ].join(' ');
}
