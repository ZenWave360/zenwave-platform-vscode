import * as vscode from 'vscode';
import type { HostCapabilities } from '../host/capabilities.js';
import type { Logger } from '../host/logger.js';
import { SHIPPED_CATALOGUE, type Catalogue, type CatalogueOption } from './catalogue.js';
import { buildSdkCommand, findUnquotableArgument, splitCommandLine } from './command.js';
import { readSdkSettings, taskShell, type SdkProcessService, type SdkSettings } from './host.js';
import { loginShellArguments, shellFamily, type ShellFamily } from './shell.js';
import {
  findRunnablePlugin,
  isPluginNamePosition,
  ModelCache,
  pluginAtOffset,
  type SourceRange,
} from './model.js';

const TASK_TYPE = 'zenwave-sdk';
const RUN_COMMAND = 'zenwave.sdk.run';

interface RunPluginRequest {
  readonly uri: string;
  readonly plugin: string;
  readonly offset?: number;
}

/**
 * VS Code derives a task's identity, and so its dedicated terminal, from the
 * properties registered for this task type. `command` makes the assembled
 * command line part of that identity: the same command reuses a terminal, while
 * a different one opens another, including two runs of the same plugin.
 */
interface ZenWaveTaskDefinition extends vscode.TaskDefinition {
  readonly type: typeof TASK_TYPE;
  readonly plugin: string;
  readonly file: string;
  readonly command?: string;
}

function asRange(range: SourceRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function directoryOf(uri: vscode.Uri): string {
  const filePath = uri.fsPath;
  const separator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return separator < 0 ? filePath : filePath.slice(0, separator);
}

function asTaskDefinition(value: vscode.TaskDefinition): ZenWaveTaskDefinition | undefined {
  if (
    value.type !== TASK_TYPE ||
    typeof value.plugin !== 'string' ||
    typeof value.file !== 'string'
  ) {
    return undefined;
  }
  return {
    type: TASK_TYPE,
    plugin: value.plugin,
    file: value.file,
    ...(typeof value.command === 'string' ? { command: value.command } : {}),
  };
}

function fileUri(
  file: string,
  scope: vscode.WorkspaceFolder | vscode.TaskScope | undefined,
): vscode.Uri {
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(file) || typeof scope !== 'object') {
    return vscode.Uri.file(file);
  }
  return vscode.Uri.joinPath(scope.uri, file);
}

type ShellResolution =
  | { readonly family: ShellFamily; readonly shell: string }
  | { readonly refusal: string };

function resolveShell(settings: SdkSettings, platform: string): ShellResolution {
  const shell = taskShell(settings, platform).trim();
  if (!shell) {
    return {
      refusal:
        settings.invocation.environment === 'loginShell'
          ? 'No usable login shell: zenwave.sdk.loginShell is empty and VS Code reports no preferred terminal shell.'
          : 'VS Code reports no shell to run tasks in.',
    };
  }
  const family = shellFamily(shell);
  if (!family) {
    const setting =
      settings.invocation.environment === 'loginShell'
        ? 'zenwave.sdk.loginShell'
        : 'terminal.integrated.automationProfile, or zenwave.sdk.environment with zenwave.sdk.loginShell,';
    return {
      refusal: `ZenWave SDK runs only through a POSIX shell (bash, zsh, sh) or PowerShell, where every value from the model can be quoted safely; the task shell is "${shell}". Set ${setting} to one of those shells.`,
    };
  }
  return { family, shell };
}

interface TaskContext {
  readonly models: ModelCache;
  readonly processService: SdkProcessService;
}

/** Builds the task from the stored command, or from the model as it is now. */
async function buildTask(
  definition: ZenWaveTaskDefinition,
  scope: vscode.WorkspaceFolder | vscode.TaskScope,
  context: TaskContext,
  offset?: number,
): Promise<vscode.Task | string> {
  const uri = fileUri(definition.file, scope);
  const settings = readSdkSettings(uri);
  const resolution = resolveShell(settings, context.processService.platform);
  if ('refusal' in resolution) {
    return resolution.refusal;
  }

  let commandLine = definition.command;
  if (commandLine === undefined) {
    const document = await vscode.workspace.openTextDocument(uri);
    const model = context.models.get(document.uri.toString(), document.version, document.getText());
    const plugin = model
      ? findRunnablePlugin(model, definition.plugin, offset)
      : undefined;
    if (!model || !plugin) {
      return `Plugin ${definition.plugin} is not a runnable declaration in ${uri.fsPath}.`;
    }

    const unquotable = findUnquotableArgument(
      model,
      plugin,
      uri.fsPath,
      settings,
      resolution.family,
    );
    if (unquotable !== undefined) {
      return `Refusing to run ${definition.plugin} through PowerShell: the argument ${JSON.stringify(unquotable)} contains a double quote, which PowerShell cannot pass to the SDK intact. Remove the double quote, or run through a POSIX shell (zenwave.sdk.environment loginShell with zenwave.sdk.loginShell set to bash).`;
    }
    commandLine = buildSdkCommand(model, plugin, uri.fsPath, settings, resolution.family);
  }

  const cwd = directoryOf(uri);
  const [executable] = splitCommandLine(settings.cliCommand);
  if (!executable) {
    return 'zenwave.sdk.cliCommand is empty.';
  }
  // A login shell has its own PATH, which only running it would reveal; that
  // case is diagnosed from the exit status instead.
  if (
    settings.invocation.environment === 'inherited' &&
    !context.processService.findExecutable(executable, cwd)
  ) {
    return [
      `Could not find "${executable}" (from zenwave.sdk.cliCommand "${settings.cliCommand}") on the PATH VS Code inherited.`,
      `Searched PATH=${context.processService.searchPath()}`,
      'If it works in your own terminal, your shell profile adds it to PATH: set zenwave.sdk.environment to loginShell.',
    ].join('\n');
  }

  const options: vscode.ShellExecutionOptions = { cwd };
  if (settings.invocation.environment === 'loginShell') {
    options.executable = resolution.shell;
    options.shellArgs = [...(loginShellArguments(resolution.shell) ?? [])];
  }
  const task = new vscode.Task(
    {
      type: TASK_TYPE,
      plugin: definition.plugin,
      file: definition.file,
      command: commandLine,
    } satisfies ZenWaveTaskDefinition,
    scope,
    `Run ${definition.plugin}`,
    'ZenWave SDK',
    new vscode.ShellExecution(commandLine, options),
    [],
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: false,
    echo: true,
    focus: false,
  };
  return task;
}

class SdkTaskProvider implements vscode.TaskProvider {
  constructor(
    private readonly context: TaskContext,
    private readonly logger: Logger,
  ) {}

  provideTasks(): vscode.Task[] {
    return [];
  }

  async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
    const definition = asTaskDefinition(task.definition);
    if (!definition) {
      return undefined;
    }
    const resolved = await buildTask(
      definition,
      task.scope ?? vscode.TaskScope.Workspace,
      this.context,
    );
    if (typeof resolved === 'string') {
      this.logger.warn(resolved);
      return undefined;
    }
    return resolved;
  }
}

class SdkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly context: TaskContext) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const model = this.context.models.get(
      document.uri.toString(),
      document.version,
      document.getText(),
    );
    if (!model) {
      return [];
    }
    const settings = readSdkSettings(document.uri);
    const resolution = resolveShell(settings, this.context.processService.platform);
    return model.plugins
      .filter((plugin) => !plugin.disabled)
      .map(
        (plugin) =>
          new vscode.CodeLens(asRange(plugin.location), {
            title: '$(play) Run with ZenWave SDK',
            tooltip:
              'refusal' in resolution
                ? resolution.refusal
                : buildSdkCommand(model, plugin, document.uri.fsPath, settings, resolution.family),
            command: RUN_COMMAND,
            arguments: [
              {
                uri: document.uri.toString(),
                plugin: plugin.name,
                offset: plugin.offsets[0],
              } satisfies RunPluginRequest,
            ],
          }),
      );
  }

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function catalogueLabel(catalogue: Catalogue): string {
  return `Shipped catalogue: ${catalogue.source}`;
}

function optionDetails(option: CatalogueOption): string {
  const details = [
    option.type ? `Type: ${option.type}` : undefined,
    option.defaultValue !== undefined ? `Default: ${String(option.defaultValue)}` : undefined,
    option.values.length > 0 ? `Allowed: ${option.values.join(', ')}` : undefined,
  ];
  return details.filter((detail): detail is string => detail !== undefined).join(' · ');
}

function optionMarkdown(option: CatalogueOption, catalogue: Catalogue): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  if (option.description) {
    markdown.appendMarkdown(`${option.description}\n\n`);
  }
  const details = optionDetails(option);
  if (details) {
    markdown.appendMarkdown(`${details}\n\n`);
  }
  if (option.documentation) {
    markdown.appendMarkdown(`[Documentation](${option.documentation})\n\n`);
  }
  markdown.appendMarkdown(`_${catalogueLabel(catalogue)}_`);
  return markdown;
}

function pluginMarkdown(
  plugin: Catalogue['plugins'][number],
  catalogue: Catalogue,
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  const heading = plugin.title || plugin.name;
  markdown.appendMarkdown(`**${heading}**\n\n`);
  if (plugin.summary) {
    markdown.appendMarkdown(`${plugin.summary}\n\n`);
  }
  if (plugin.description) {
    markdown.appendMarkdown(`${plugin.description}\n\n`);
  }
  if (plugin.documentation) {
    markdown.appendMarkdown(`[Documentation](${plugin.documentation})\n\n`);
  }
  markdown.appendMarkdown(`_${catalogueLabel(catalogue)}_`);
  return markdown;
}

class SdkAuthoringProvider implements vscode.CompletionItemProvider, vscode.HoverProvider {
  private readonly catalogue = SHIPPED_CATALOGUE;

  constructor(private readonly models: ModelCache) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const model = this.models.get(document.uri.toString(), document.version, text);
    const declaration = model ? pluginAtOffset(model, offset) : undefined;

    if (declaration) {
      const plugin = this.catalogue.plugins.find(
        (candidate) => candidate.name === declaration.name,
      );
      return plugin
        ? Object.values(plugin.options).map((option) => {
            const item = new vscode.CompletionItem(
              option.name,
              vscode.CompletionItemKind.Property,
            );
            item.insertText = new vscode.SnippetString(`${option.name} \${1:value}`);
            item.detail = optionDetails(option);
            item.documentation = optionMarkdown(option, this.catalogue);
            return item;
          })
        : [];
    }
    if (!isPluginNamePosition(text, offset)) {
      return [];
    }
    return this.catalogue.plugins.map((plugin) => {
      const item = new vscode.CompletionItem(plugin.name, vscode.CompletionItemKind.Class);
      item.insertText = new vscode.SnippetString(`${plugin.name} {\n\t\${0}\n}`);
      item.detail = catalogueLabel(this.catalogue);
      item.documentation = pluginMarkdown(plugin, this.catalogue);
      return item;
    });
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const wordRange = document.getWordRangeAtPosition(position, /[\w.-]+/);
    if (!wordRange) {
      return undefined;
    }
    const model = this.models.get(document.uri.toString(), document.version, document.getText());
    const declaration = model ? pluginAtOffset(model, document.offsetAt(position)) : undefined;
    const plugin = declaration
      ? this.catalogue.plugins.find((candidate) => candidate.name === declaration.name)
      : undefined;
    if (!declaration || !plugin) {
      return undefined;
    }
    const word = document.getText(wordRange);
    if (word === declaration.name) {
      return new vscode.Hover(pluginMarkdown(plugin, this.catalogue), wordRange);
    }
    const option = plugin.options[word];
    return option ? new vscode.Hover(optionMarkdown(option, this.catalogue), wordRange) : undefined;
  }
}

function isRunRequest(value: unknown): value is RunPluginRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uri' in value &&
    typeof value.uri === 'string' &&
    'plugin' in value &&
    typeof value.plugin === 'string' &&
    (!('offset' in value) || typeof (value as { offset: unknown }).offset === 'number')
  );
}

async function reportRefusal(message: string, logger: Logger): Promise<void> {
  logger.error(message);
  const choice = await vscode.window.showErrorMessage(message, 'Show Output');
  if (choice === 'Show Output') {
    logger.show();
  }
}

async function runPlugin(
  request: unknown,
  capabilities: HostCapabilities,
  context: TaskContext | undefined,
  logger: Logger,
): Promise<void> {
  if (!capabilities.canRunProcesses || !context) {
    const message = 'ZenWave SDK cannot run in this extension host.';
    logger.warn(message);
    await vscode.window.showErrorMessage(message);
    return;
  }
  if (!vscode.workspace.isTrusted) {
    const message = 'Trust this workspace before running ZenWave SDK code generation.';
    logger.warn(message);
    await vscode.window.showErrorMessage(message);
    return;
  }
  if (!isRunRequest(request)) {
    logger.warn('Ignored zenwave.sdk.run without a plugin declaration.');
    return;
  }

  const uri = vscode.Uri.parse(request.uri);
  const task = await buildTask(
    { type: TASK_TYPE, plugin: request.plugin, file: uri.fsPath },
    vscode.workspace.getWorkspaceFolder(uri) ?? vscode.TaskScope.Workspace,
    context,
    request.offset,
  );
  if (typeof task === 'string') {
    await reportRefusal(task, logger);
    return;
  }
  await vscode.tasks.executeTask(task);
}

/** Exit status 127 is how POSIX shells report a command they could not find. */
function diagnoseMissingCommand(event: vscode.TaskProcessEndEvent, logger: Logger): void {
  const definition = asTaskDefinition(event.execution.task.definition);
  if (!definition || event.exitCode !== 127) {
    return;
  }
  const settings = readSdkSettings(vscode.Uri.file(definition.file));
  const through =
    settings.invocation.environment === 'loginShell'
      ? `login shell "${settings.invocation.loginShell}"`
      : 'the environment VS Code inherited';
  void reportRefusal(
    `ZenWave SDK command "${settings.cliCommand}" was not found when running ${definition.plugin} in ${through}. Check zenwave.sdk.cliCommand, and that the shell's profile puts it on PATH.`,
    logger,
  );
}

export function registerSdkFeature(
  context: vscode.ExtensionContext,
  capabilities: HostCapabilities,
  logger: Logger,
  processService?: SdkProcessService,
): void {
  const models = new ModelCache();
  const authoring = new SdkAuthoringProvider(models);
  const taskContext =
    capabilities.canRunProcesses && processService ? { models, processService } : undefined;

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider([{ language: 'zdl' }, { language: 'zw' }], authoring),
    vscode.languages.registerHoverProvider([{ language: 'zdl' }, { language: 'zw' }], authoring),
    vscode.commands.registerCommand(RUN_COMMAND, (request: unknown) =>
      runPlugin(request, capabilities, taskContext, logger),
    ),
  );

  if (taskContext) {
    const codeLenses = new SdkCodeLensProvider(taskContext);
    context.subscriptions.push(
      codeLenses,
      vscode.languages.registerCodeLensProvider([{ language: 'zdl' }, { language: 'zw' }], codeLenses),
      vscode.tasks.registerTaskProvider(TASK_TYPE, new SdkTaskProvider(taskContext, logger)),
      vscode.tasks.onDidEndTaskProcess((event) => diagnoseMissingCommand(event, logger)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('zenwave.sdk') ||
          event.affectsConfiguration('terminal.integrated.automationProfile')
        ) {
          codeLenses.refresh();
        }
      }),
    );
  }
}
