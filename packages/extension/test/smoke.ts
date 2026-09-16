import * as vscode from 'vscode';
import { SHIPPED_CATALOGUE } from '../src/sdk/catalogue.js';

const EXTENSION_ID = 'ZenWave360.zenwave-platform';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(name: string): Promise<vscode.Uri> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert(folder, 'No smoke workspace folder');
  const uri = vscode.Uri.joinPath(folder.uri, name);
  await vscode.workspace.fs.stat(uri);
  return uri;
}

async function bounded<T>(promise: PromiseLike<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 20000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function authoring(): Promise<void> {
  const text = 'config {\n  plugins {\n    \n    AsyncAPIGeneratorPlugin {\n      apiFile "orders.yaml"\n    }\n  }\n}';
  const document = await vscode.workspace.openTextDocument({ language: 'zdl', content: text });
  await vscode.window.showTextDocument(document);
  const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider', document.uri, new vscode.Position(2, 4),
  );
  assert(completions, 'No plugin completions returned');
  for (const plugin of SHIPPED_CATALOGUE.plugins) {
    const item = completions.items.find((candidate) =>
      (typeof candidate.label === 'string' ? candidate.label : candidate.label.label) === plugin.name);
    assert(item, `Shipped plugin ${plugin.name} was not suggested`);
    assert(item.detail === `Shipped catalogue: ZenWave SDK ${SHIPPED_CATALOGUE.version}`,
      `Wrong catalogue label on ${plugin.name}: ${item.detail}`);
  }
  const options = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider', document.uri, new vscode.Position(4, 6),
  );
  const apiFile = options?.items.find((item) =>
    (typeof item.label === 'string' ? item.label : item.label.label) === 'apiFile');
  assert(apiFile, 'Known plugin option was not suggested');
  assert(typeof apiFile.documentation !== 'string' &&
    apiFile.documentation?.value.includes('API Specification File'), 'Option completion lacks its description');
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider', document.uri, new vscode.Position(4, 8),
  );
  const markdown = hovers?.flatMap((hover) => hover.contents).map((content) =>
    typeof content === 'string' ? content : content.value).join('\n') ?? '';
  assert(markdown.includes('API Specification File'), 'Known option hover lacks its description');
  assert(markdown.includes(`Shipped catalogue: ZenWave SDK ${SHIPPED_CATALOGUE.version}`),
    'Option hover lacks shipped catalogue version');
  console.log('PASS: shipped plugin completion and known-option hover');
}

interface DesktopConfiguration {
  cliCommand: string;
  shell: string;
  unsupportedShell: string;
  platform: string;
}

async function desktopRuns(document: vscode.TextDocument): Promise<void> {
  const configUri = await fixture('.sdk-smoke.json');
  const configuration = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(configUri))) as DesktopConfiguration;
  const sdk = vscode.workspace.getConfiguration('zenwave.sdk', document.uri);
  const terminal = vscode.workspace.getConfiguration('terminal.integrated');
  const profileKey = `automationProfile.${configuration.platform}`;
  const settings: [vscode.WorkspaceConfiguration, string, unknown][] = [
    [sdk, 'cliCommand', configuration.cliCommand], [sdk, 'environment', 'inherited'],
    [sdk, 'extraArgs', []], [terminal, profileKey, { path: configuration.shell }],
  ];
  const saved = settings.map(([section, key]) => section.inspect(key)?.workspaceValue);
  const opened: vscode.Terminal[] = [];
  let started = 0;
  const subscriptions = [
    vscode.window.onDidOpenTerminal((value) => opened.push(value)),
    vscode.tasks.onDidStartTask((event) => { if (event.execution.task.definition.type === 'zenwave-sdk') started++; }),
  ];
  const request = { uri: document.uri.toString(), plugin: 'FirstPlugin' };
  async function runOnce(): Promise<void> {
    let exitCode: number | undefined;
    let ended: vscode.Disposable | undefined;
    let processEnded: vscode.Disposable | undefined;
    const complete = new Promise<void>((resolve, reject) => {
      processEnded = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution.task.definition.type === 'zenwave-sdk') exitCode = event.exitCode;
      });
      ended = vscode.tasks.onDidEndTask((event) => {
        if (event.execution.task.definition.type !== 'zenwave-sdk') return;
        if (exitCode === 0) resolve(); else reject(new Error(`Fixture SDK exited ${exitCode}`));
      });
    });
    try {
      await bounded(vscode.commands.executeCommand('zenwave.sdk.run', request), 'Run command did not return');
      await bounded(complete, 'Fixture SDK task did not finish');
    } finally { ended?.dispose(); processEnded?.dispose(); }
  }
  async function refuses(): Promise<void> {
    const before = started;
    const terminalsBefore = opened.length;
    let finished = false;
    const command = vscode.commands.executeCommand('zenwave.sdk.run', request).then(() => { finished = true; });
    // Error notifications wait for dismissal. Exercise the real command and let
    // the runner verify its diagnostic in the isolated output-channel log.
    for (let attempt = 0; attempt < 20 && !finished; attempt++) {
      await delay(100);
      await vscode.commands.executeCommand('notifications.clearAll');
    }
    await bounded(command, 'Refused Run did not finish after dismissing its notification');
    assert(started === before, 'Refused Run started a task');
    assert(opened.length === terminalsBefore, 'Refused Run opened a terminal');
  }
  try {
    for (const [section, key, value] of settings) await section.update(key, value, vscode.ConfigurationTarget.Workspace);
    assert(vscode.workspace.isTrusted, 'Desktop smoke workspace must be trusted');
    await runOnce();
    const firstTerminal = vscode.window.terminals.find((value) => opened.includes(value));
    assert(firstTerminal && opened.length === 1, 'First Run must open exactly one task terminal');
    const edit = new vscode.WorkspaceEdit();
    const offset = document.getText().indexOf('build/generated');
    assert(offset >= 0, 'Fixture option to edit was not found');
    edit.replace(document.uri, new vscode.Range(document.positionAt(offset),
      document.positionAt(offset + 'build/generated'.length)), 'build/edited');
    assert(await vscode.workspace.applyEdit(edit), 'Could not edit plugin option');
    await runOnce();
    assert(started === 2 && opened.length === 1 && vscode.window.terminals.includes(firstTerminal),
      'Running after an edit must reuse the same terminal');
    const invocations = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(configUri, '..', 'sdk-invocations.json'),
    ))) as string[][];
    assert(invocations.length === 2, 'Only the two user Runs may invoke the fixture SDK');
    assert(invocations[0]?.includes('targetFolder=build/generated'), 'First Run used wrong option');
    assert(invocations[1]?.includes('targetFolder=build/edited'), 'Second Run ignored edited option');
    await terminal.update(profileKey, { path: configuration.unsupportedShell }, vscode.ConfigurationTarget.Workspace);
    await refuses();
    await terminal.update(profileKey, { path: configuration.shell }, vscode.ConfigurationTarget.Workspace);
    await sdk.update('cliCommand', 'definitely-not-a-zenwave-smoke-executable', vscode.ConfigurationTarget.Workspace);
    await refuses();
    await authoring();
    assert(started === 2, 'Authoring with a missing SDK started a task');
    console.log('PASS: edited Run reuses terminal; unsupported shell and missing executable start no task');
  } finally {
    subscriptions.forEach((value) => value.dispose());
    for (let index = 0; index < settings.length; index++) {
      const [section, key] = settings[index]!;
      await section.update(key, saved[index], vscode.ConfigurationTarget.Workspace);
    }
    opened.forEach((value) => value.dispose());
  }
}

/** Runs in both the desktop extension host and the browser Web Worker host. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert(extension, `${EXTENSION_ID} was not installed in the test host`);

  await extension.activate();
  assert(extension.isActive, `${EXTENSION_ID} did not activate`);

  const document = await vscode.workspace.openTextDocument(await fixture('complete.zdl'));
  assert(document.languageId === 'zdl', `Expected zdl language id, got ${document.languageId}`);

  const commands = await vscode.commands.getCommands(true);
  assert(commands.includes('zenwave.showOutput'), 'zenwave.showOutput was not registered');

  const plugins = await vscode.workspace.openTextDocument(await fixture('sdk-plugins.zdl'));
  await vscode.window.showTextDocument(plugins);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider', plugins.uri,
  );
  const sdkLenses = (lenses ?? []).filter((lens) => lens.command?.command === 'zenwave.sdk.run');
  const desktop = vscode.env.uiKind === vscode.UIKind.Desktop;
  assert(sdkLenses.length === (desktop ? 2 : 0), `Expected ${desktop ? 2 : 0} SDK lenses, got ${sdkLenses.length}`);
  if (desktop) {
    assert(sdkLenses.map((lens) => (lens.command?.arguments?.[0] as { plugin: string }).plugin)
      .sort().join(',') === 'FirstPlugin,SecondPlugin', 'Lenses must only cover enabled plugins');
  }
  console.log(`PASS: ${desktop ? 'desktop enabled-plugin' : 'browser absent'} CodeLens`);
  await authoring();
  if (desktop) await desktopRuns(plugins);
}
