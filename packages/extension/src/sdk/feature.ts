import * as vscode from 'vscode';
import type { HostCapabilities } from '../host/capabilities.js';
import type { Logger } from '../host/logger.js';
import {
  catalogueCacheKey,
  PluginCatalogue,
  type Catalogue,
  type CatalogueOption,
} from './catalogue.js';
import { buildSdkCommand, buildSdkInvocation } from './command.js';
import { readSdkSettings, type SdkProcessService, type SdkSettings } from './host.js';
import { loginShellArguments, resolveLoginShell } from './shell.js';
import {
  isPluginNamePosition,
  ModelCache,
  pluginAtOffset,
  type PluginDeclaration,
  type SourceRange,
} from './model.js';

const TASK_TYPE = 'zenwave-sdk';
const RUN_COMMAND = 'zenwave.sdk.run';
const REFRESH_COMMAND = 'zenwave.sdk.refreshPlugins';

interface RunPluginRequest {
  readonly uri: string;
  readonly plugin: string;
}

interface ZenWaveTaskDefinition extends vscode.TaskDefinition {
  readonly type: typeof TASK_TYPE;
  readonly plugin: string;
  readonly cwd: string;
  readonly command: string;
  readonly executable?: string;
  readonly arguments?: readonly string[];
  readonly environment: SdkSettings['invocation']['environment'];
  readonly loginShell: string;
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

function taskDefinition(
  plugin: PluginDeclaration,
  cwd: string,
  invocation: ReturnType<typeof buildSdkInvocation>,
  settings: SdkSettings,
): ZenWaveTaskDefinition {
  return {
    type: TASK_TYPE,
    plugin: plugin.name,
    cwd,
    command: invocation.commandLine,
    executable: invocation.executable,
    arguments: invocation.arguments,
    environment: settings.invocation.environment,
    loginShell: settings.invocation.loginShell,
  };
}

function createTask(
  definition: ZenWaveTaskDefinition,
  scope: vscode.WorkspaceFolder | vscode.TaskScope = vscode.TaskScope.Workspace,
): vscode.Task {
  const options: vscode.ShellExecutionOptions = { cwd: definition.cwd };
  if (definition.environment === 'loginShell') {
    options.executable = definition.loginShell;
    options.shellArgs = [...loginShellArguments(definition.loginShell)];
  }
  const execution = new vscode.ShellExecution(definition.command, options);
  const task = new vscode.Task(
    definition,
    scope,
    `Run ${definition.plugin}`,
    'ZenWave SDK',
    execution,
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

function asTaskDefinition(value: vscode.TaskDefinition): ZenWaveTaskDefinition | undefined {
  if (
    value.type === TASK_TYPE &&
    typeof value.plugin === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.command === 'string'
  ) {
    return {
      ...value,
      type: TASK_TYPE,
      plugin: value.plugin,
      cwd: value.cwd,
      command: value.command,
      ...(typeof value.executable === 'string' ? { executable: value.executable } : {}),
      ...(Array.isArray(value.arguments) &&
      value.arguments.every((argument: unknown) => typeof argument === 'string')
        ? { arguments: value.arguments as string[] }
        : {}),
      environment: value.environment === 'loginShell' ? 'loginShell' : 'inherited',
      loginShell: resolveLoginShell(
        typeof value.loginShell === 'string' ? value.loginShell : undefined,
        vscode.env.shell,
      ),
    };
  }
  return undefined;
}

class SdkTaskProvider implements vscode.TaskProvider {
  provideTasks(): vscode.Task[] {
    return [];
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const definition = asTaskDefinition(task.definition);
    return definition
      ? createTask(definition, task.scope ?? vscode.TaskScope.Workspace)
      : undefined;
  }
}

class SdkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly models: ModelCache) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const model = this.models.get(document.uri.toString(), document.version, document.getText());
    if (!model) {
      return [];
    }
    const settings = readSdkSettings(document.uri);
    return model.plugins
      .filter((plugin) => !plugin.disabled)
      .map((plugin) => {
        const commandLine = buildSdkCommand(model, plugin, document.uri.fsPath, settings);
        return new vscode.CodeLens(asRange(plugin.location), {
          title: '$(play) Run with ZenWave SDK',
          tooltip: commandLine,
          command: RUN_COMMAND,
          arguments: [{ uri: document.uri.toString(), plugin: plugin.name } satisfies RunPluginRequest],
        });
      });
  }

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function sourceLabel(catalogue: Catalogue): string {
  return catalogue.origin === 'shipped'
    ? `Shipped catalogue: ${catalogue.source}`
    : catalogue.source;
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
  markdown.appendMarkdown(`_${sourceLabel(catalogue)}_`);
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
  markdown.appendMarkdown(`_${sourceLabel(catalogue)}_`);
  return markdown;
}

class SdkAuthoringProvider
  implements vscode.CompletionItemProvider, vscode.HoverProvider
{
  constructor(
    private readonly capabilities: HostCapabilities,
    private readonly models: ModelCache,
    private readonly catalogue: PluginCatalogue,
  ) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const model = this.models.get(document.uri.toString(), document.version, text);
    const declaration = model ? pluginAtOffset(model, offset) : undefined;
    const pluginNamePosition = declaration ? false : isPluginNamePosition(text, offset);
    if (!declaration && !pluginNamePosition) {
      return [];
    }

    const settings = readSdkSettings(document.uri);
    const cwd = this.capabilities.hasLocalFileSystem ? directoryOf(document.uri) : undefined;
    const catalogue = this.catalogue.get(
      catalogueCacheKey(cwd, settings),
      cwd,
      settings,
      this.capabilities.canRunProcesses && vscode.workspace.isTrusted,
    );
    if (declaration) {
      const plugin = catalogue.plugins.find((candidate) => candidate.name === declaration.name);
      return plugin
        ? Object.values(plugin.options).map((option) => {
            const item = new vscode.CompletionItem(
              option.name,
              vscode.CompletionItemKind.Property,
            );
            item.insertText = new vscode.SnippetString(`${option.name} \${1:value}`);
            item.detail = optionDetails(option);
            item.documentation = optionMarkdown(option, catalogue);
            return item;
          })
        : [];
    }

    return catalogue.plugins.map((plugin) => {
      const item = new vscode.CompletionItem(plugin.name, vscode.CompletionItemKind.Class);
      item.insertText = new vscode.SnippetString(`${plugin.name} {\n\t\${0}\n}`);
      item.detail = sourceLabel(catalogue);
      item.documentation = pluginMarkdown(plugin, catalogue);
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
    if (!declaration) {
      return undefined;
    }
    const settings = readSdkSettings(document.uri);
    const cwd = this.capabilities.hasLocalFileSystem ? directoryOf(document.uri) : undefined;
    const catalogue = this.catalogue.get(
      catalogueCacheKey(cwd, settings),
      cwd,
      settings,
      this.capabilities.canRunProcesses && vscode.workspace.isTrusted,
    );
    if (!catalogue) {
      return undefined;
    }
    const plugin = catalogue.plugins.find((candidate) => candidate.name === declaration.name);
    if (!plugin) {
      return undefined;
    }
    const word = document.getText(wordRange);
    if (word === declaration.name) {
      return new vscode.Hover(pluginMarkdown(plugin, catalogue), wordRange);
    }
    const option = plugin.options[word];
    return option ? new vscode.Hover(optionMarkdown(option, catalogue), wordRange) : undefined;
  }
}

function isRunRequest(value: unknown): value is RunPluginRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uri' in value &&
    typeof value.uri === 'string' &&
    'plugin' in value &&
    typeof value.plugin === 'string'
  );
}

async function runPlugin(
  request: unknown,
  capabilities: HostCapabilities,
  models: ModelCache,
  processService: SdkProcessService | undefined,
  logger: Logger,
): Promise<void> {
  if (!capabilities.canRunProcesses || !processService) {
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
  const document = await vscode.workspace.openTextDocument(uri);
  const model = models.get(document.uri.toString(), document.version, document.getText());
  const plugin = model?.plugins.find(
    (candidate) => candidate.name === request.plugin && !candidate.disabled,
  );
  if (!model || !plugin) {
    logger.warn(`Plugin ${request.plugin} is no longer runnable in ${uri.toString()}.`);
    return;
  }

  const settings = readSdkSettings(uri);
  const cwd = directoryOf(uri);
  const probe = await processService.probe(settings.cliCommand, cwd, settings.invocation);
  if (!probe.found) {
    logger.error(probe.diagnosis);
    await vscode.window.showErrorMessage(probe.diagnosis, 'Show Output').then((choice) => {
      if (choice === 'Show Output') {
        logger.show();
      }
    });
    return;
  }

  const invocation = buildSdkInvocation(model, plugin, uri.fsPath, settings);
  await vscode.tasks.executeTask(createTask(taskDefinition(plugin, cwd, invocation, settings)));
}

export function registerSdkFeature(
  context: vscode.ExtensionContext,
  capabilities: HostCapabilities,
  logger: Logger,
  processService?: SdkProcessService,
): void {
  const models = new ModelCache();
  const catalogue = new PluginCatalogue(processService, logger);
  const authoring = new SdkAuthoringProvider(capabilities, models, catalogue);

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: 'zdl' }, authoring),
    vscode.languages.registerHoverProvider({ language: 'zdl' }, authoring),
    vscode.commands.registerCommand(RUN_COMMAND, (request: unknown) =>
      runPlugin(request, capabilities, models, processService, logger),
    ),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      catalogue.refresh();
      logger.info('SDK plugin catalogue refresh requested.');
    }),
  );

  if (capabilities.canRunProcesses && processService) {
    const codeLenses = new SdkCodeLensProvider(models);
    context.subscriptions.push(
      codeLenses,
      vscode.languages.registerCodeLensProvider({ language: 'zdl' }, codeLenses),
      vscode.tasks.registerTaskProvider(TASK_TYPE, new SdkTaskProvider()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('zenwave.sdk')) {
          catalogue.refresh();
          codeLenses.refresh();
        }
      }),
    );
  }
}
