import * as vscode from 'vscode';
import { SHIPPED_CATALOGUE } from '../src/sdk/catalogue.js';
import { LspSupervisor } from '../src/lsp/supervisor.js';
import type { ZenwaveExtensionApi } from '../src/activate.js';
import type { LanguageServerApi } from '../src/lsp/feature.js';
import { documentFailure } from '../src/lsp/requests.js';
import type { OrganizeOutcome, ReferencesOutcome } from '../src/model/actions.js';

const EXTENSION_ID = 'ZenWave360.zenwave-platform';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function sharedLspFoundation(): Promise<void> {
  let requests = 0;
  const payload = { futureField: ['unchanged'] };
  const supervisor = new LspSupervisor(() => ({
    start: async () => ({ capabilities: { experimental: { customRequests: ['zenwave/workspaceStatus'] } } }),
    stop: async () => {},
    sendRequest: async () => { requests++; return payload; },
    onDidExit: () => ({ dispose: () => {} }),
  }), { info: () => {}, warn: () => {}, error: () => {} });
  assert((await supervisor.request('zenwave/workspaceStatus', undefined)).kind === 'no-server',
    'Disconnected LSP helper did not return no-server');
  await supervisor.start();
  assert((await supervisor.request('zenwave/preview', undefined)).kind === 'unsupported',
    'Unadvertised LSP request was not rejected locally');
  const result = await supervisor.request('zenwave/workspaceStatus', undefined);
  assert(result.kind === 'ok' && result.value === payload && requests === 1,
    'Shared LSP helper must preserve results and avoid unsupported wire requests');
  await supervisor.stop();
  assert(supervisor.state.kind === 'unavailable', 'Shared LSP supervisor did not stop');
  console.log('PASS: shared LSP supervisor and request gates with an injected test transport');
}

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

async function waitFor<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, message: string, ms = 90000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(message);
    await delay(250);
  }
}

function hoverText(hovers: vscode.Hover[] | undefined): string {
  return (hovers ?? []).flatMap((hover) => hover.contents)
    .map((content) => typeof content === 'string' ? content : content.value).join('\n');
}

async function serverHover(uri: vscode.Uri, position: vscode.Position): Promise<string> {
  return waitFor(async () => {
    const text = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position));
    return text.trim().length > 0 ? text : undefined;
  }, `No hover from the language server for ${uri.toString()}`, 30000);
}

async function connected(api: LanguageServerApi, message: string): Promise<void> {
  await api.settled();
  await waitFor(() => api.status.kind === 'connected' || api.status.kind === 'failed' || api.status.kind === 'no-server',
    `${message}: language server did not settle`);
  assert(api.status.kind === 'connected', `${message}: ${JSON.stringify(api.status)}`);
}

const EXPECTED_REQUESTS = ['zenwave/hierarchy', 'zenwave/forwardReferences', 'zenwave/reverseReferences',
  'zenwave/organizeZflServices', 'zenwave/eventFlowViews', 'zenwave/preview', 'zenwave/symbolAt'];

/** The real @zenwave360/lsp-js server, over IPC on the desktop and in a Web Worker in the browser. */
async function realLanguageServer(api: LanguageServerApi, desktop: boolean): Promise<void> {
  assert(api.transport === (desktop ? 'ipc' : 'worker'), `Expected ${desktop ? 'ipc' : 'worker'} transport, got ${api.transport}`);
  await connected(api, 'Initial start');
  assert(api.serverInfo?.name === 'zenwave-lsp', `Unexpected server ${JSON.stringify(api.serverInfo)}`);
  for (const method of EXPECTED_REQUESTS) {
    assert(api.advertisedRequests.includes(method), `Server did not advertise ${method}: ${api.advertisedRequests.join(', ')}`);
  }
  assert(api.manifest.route === 'config' && api.manifest.manifestUri?.endsWith('/zenwave-architecture.yml') &&
    api.manifest.configUri?.endsWith('/.zenwave/config.yml'), `Manifest not resolved from .zenwave/config.yml: ${JSON.stringify(api.manifest)}`);
  console.log(`PASS: ${api.transport} server connected, customRequests discovered, manifest resolved from .zenwave/config.yml`);

  const broken = await vscode.workspace.openTextDocument(await fixture('lsp/broken.zdl'));
  await vscode.window.showTextDocument(broken);
  const diagnostics = await waitFor(() => {
    const found = vscode.languages.getDiagnostics(broken.uri);
    return found.length > 0 ? found : undefined;
  }, 'No diagnostics from the language server for an aggregate of an unknown entity');
  assert(diagnostics[0]!.range.start.line >= 0, 'Diagnostic has no location');
  const orders = await vscode.workspace.openTextDocument(await fixture('lsp/orders.zdl'));
  await vscode.window.showTextDocument(orders);
  await serverHover(orders.uri, new vscode.Position(5, 15));
  const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider', orders.uri, new vscode.Position(5, 15));
  const target = definitions?.[0];
  const targetRange = target && ('targetRange' in target ? target.targetRange : target.range);
  assert(targetRange?.start.line === 0, `Go to Definition did not reach entity Customer: ${JSON.stringify(definitions)}`);
  console.log(`PASS: diagnostic (${diagnostics[0]!.message}), hover and Go to Definition from the real server`);

  const manifestDocument = await vscode.workspace.openTextDocument(await fixture('zenwave-architecture.yml'));
  await vscode.window.showTextDocument(manifestDocument);
  const manifestHover = await serverHover(manifestDocument.uri, new vscode.Position(1, 4));
  assert(manifestHover.includes('###'), `Manifest hover is not the server's: ${manifestHover}`);
  const unrelated = await vscode.workspace.openTextDocument(await fixture('modules/orders/modules/orders/src/main/resources/apis/openapi.yml'));
  await vscode.window.showTextDocument(unrelated);
  await delay(1000);
  const unrelatedHover = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider', unrelated.uri, new vscode.Position(2, 4)));
  assert(unrelatedHover.trim() === '', `Unrelated YAML was served: ${unrelatedHover}`);
  console.log('PASS: the resolved manifest is served by URI and unrelated YAML is not');

  const checkout = await vscode.workspace.openTextDocument(await fixture('lsp/checkout.zfl'));
  await vscode.window.showTextDocument(checkout);
  const uri = checkout.uri.toString();
  const preview = await waitFor(async () => {
    const result = await api.requests.preview(uri);
    return result.kind === 'ok' ? result.value : undefined;
  }, 'zenwave/preview did not answer for the open flow', 30000);
  assert(preview.representations.some((item) => item.id === preview.defaultRepresentationId && item.format === 'MERMAID'),
    'Preview has no default Mermaid representation');
  const views = await api.requests.eventFlowViews(uri);
  assert(views.kind === 'ok' && views.value.flowGraph.schema === 'zfl.eventflow.view@1' &&
    views.value.serviceGraph.schema === 'zfl.services.view@1', `eventFlowViews: ${JSON.stringify(views).slice(0, 300)}`);
  const symbol = await api.requests.symbolAt(uri, { line: 14, character: 30 });
  assert(symbol.kind === 'ok' && symbol.value?.semanticId.endsWith('#flows.CheckoutFlow.commands.createOrder'),
    `symbolAt: ${JSON.stringify(symbol)}`);
  const forward = await api.requests.forwardReferences(symbol.value!.uri, symbol.value!.semanticId);
  assert(forward.kind === 'ok', `forwardReferences: ${JSON.stringify(forward)}`);
  const reverse = await api.requests.reverseReferences(symbol.value!.uri, symbol.value!.semanticId);
  assert(reverse.kind === 'ok', `reverseReferences: ${JSON.stringify(reverse)}`);
  const hierarchy = await api.requests.hierarchy(uri);
  assert(hierarchy.kind === 'ok' && hierarchy.value.length > 0, `hierarchy: ${JSON.stringify(hierarchy).slice(0, 300)}`);
  const organized = await api.requests.organizeZflServices(uri);
  assert(organized.kind === 'ok', `organizeZflServices: ${JSON.stringify(organized)}`);
  const unopened = await api.requests.hierarchy((await fixture('lsp/orders/model.zdl')).toString());
  if (desktop) {
    assert(unopened.kind === 'ok' && unopened.value.length > 0, `hierarchy of an unopened file: ${JSON.stringify(unopened).slice(0, 300)}`);
  } else {
    // A worker server cannot read editor-owned schemes it was not sent (zenwave-lsp d7156e7).
    assert(documentFailure(unopened)?.kind === 'documentNotFound', `worker hierarchy of an unopened document: ${JSON.stringify(unopened)}`);
  }
  const unsupported = await api.request('zenwave/workspaceStatus', {});
  assert(unsupported.kind === 'unsupported', `Unadvertised request: ${JSON.stringify(unsupported)}`);
  const notOpen = await api.requests.preview(`${uri.slice(0, uri.lastIndexOf('/'))}/never-opened.zfl`);
  assert(documentFailure(notOpen)?.kind === 'documentNotFound', `preview of an unopened flow: ${JSON.stringify(notOpen)}`);
  console.log('PASS: typed wrappers for all seven zenwave/* requests over the real wire; unsupported and documentNotFound distinguishable');

  const refused = await api.answerCredential({ uri: 'https://github.com.attacker.example/x', origin: 'https://github.com.attacker.example', attempt: 'initial' });
  assert(refused === null, 'A credential was released to an unauthorised origin');
  console.log('PASS: credential request for an unauthorised origin refused');

  let changes = 0;
  const subscription = api.onDidChange(() => { changes++; });
  try {
    await vscode.commands.executeCommand('zenwave.lsp.restart');
    await connected(api, 'Restart');
    assert(changes > 0, 'Restart did not signal a change');
    const again = await api.requests.preview(uri);
    assert(again.kind === 'ok', `Request after restart: ${JSON.stringify(again).slice(0, 300)}`);
  } finally {
    subscription.dispose();
  }
  console.log('PASS: zenwave.lsp.restart reconnects and requests work again');
}

/** 007 model actions against the real server, in both hosts. Writes nothing to disk (untitled documents only). */
async function modelActions(api: LanguageServerApi): Promise<void> {
  await connected(api, 'Model actions');
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['zenwave.model.forwardReferences', 'zenwave.model.reverseReferences', 'zenwave.zfl.organizeServices']) {
    assert(commands.includes(command), `${command} was not registered`);
  }
  assert(!commands.includes('zenwave.model.conceptsAt'), 'conceptsAt must not exist while no server answers it');

  const checkout = await vscode.workspace.openTextDocument(await fixture('lsp/checkout.zfl'));
  await vscode.window.showTextDocument(checkout);
  const checkoutText = checkout.getText();
  // Cursor on `when CheckoutStarted do createOrder`: the command's forward reference is the ZDL that declares it.
  const forward = await vscode.commands.executeCommand<ReferencesOutcome>('zenwave.model.forwardReferences', checkout.uri, { line: 14, character: 30 });
  assert(forward.kind === 'navigated' && forward.targets.length === 1 && forward.targets[0]!.relationType === 'uses',
    `forwardReferences from a ZFL command: ${JSON.stringify(forward)}`);
  await waitFor(() => vscode.window.activeTextEditor?.document.uri.path.endsWith('/lsp/orders/model.zdl'),
    `A single forward reference did not open the other document: ${vscode.window.activeTextEditor?.document.uri.toString()}`, 10000);
  await vscode.window.showTextDocument(checkout);
  const system = await vscode.commands.executeCommand<ReferencesOutcome>('zenwave.model.forwardReferences', checkout.uri, { line: 2, character: 6 });
  assert(system.kind === 'navigated' && system.targets[0]?.relationType === 'declares-domain', `forwardReferences from a system: ${JSON.stringify(system)}`);
  await vscode.window.showTextDocument(checkout);
  // The cursor in the active editor is used when no position is passed.
  const editor = vscode.window.activeTextEditor!;
  editor.selection = new vscode.Selection(14, 30, 14, 30);
  const fromCursor = await vscode.commands.executeCommand<ReferencesOutcome>('zenwave.model.forwardReferences');
  assert(fromCursor.kind === 'navigated', `forwardReferences from the cursor: ${JSON.stringify(fromCursor)}`);
  await vscode.window.showTextDocument(checkout);
  const reverse = await vscode.commands.executeCommand<ReferencesOutcome>('zenwave.model.reverseReferences', checkout.uri, { line: 14, character: 30 });
  // lsp-js d7156e7 reports no reverse references for any concept of these fixtures (zenwave-specs 001 task 2.19).
  // When the server starts finding them, this assertion is the one to update.
  assert(reverse.kind === 'none' && reverse.targets.length === 0, `reverseReferences: ${JSON.stringify(reverse)}`);
  assert(vscode.window.activeTextEditor?.document.uri.toString() === checkout.uri.toString(), 'No reverse references must not navigate');
  const blank = await vscode.commands.executeCommand<ReferencesOutcome>('zenwave.model.forwardReferences', checkout.uri, { line: 8, character: 0 });
  assert(blank.kind === 'no-symbol', `A blank line must resolve to nothing, quietly: ${JSON.stringify(blank)}`);
  assert(vscode.window.activeTextEditor?.document.uri.toString() === checkout.uri.toString(), 'A blank line must not navigate');
  console.log(`PASS: forward references open the declaring ZDL directly; no reverse references is reported as none; a blank line does nothing`);

  const flow = await vscode.workspace.openTextDocument({ language: 'zfl', content: checkoutText });
  const flowEditor = await vscode.window.showTextDocument(flow);
  await waitFor(async () => (await api.requests.preview(flow.uri.toString())).kind === 'ok', 'The server did not receive the untitled flow', 30000);
  flowEditor.selection = new vscode.Selection(27, 8, 27, 8);
  const organized = await vscode.commands.executeCommand<OrganizeOutcome>('zenwave.zfl.organizeServices');
  assert(organized.kind === 'organized', `organize: ${JSON.stringify(organized)}`);
  assert(flow.getText().includes('commands: createOrder, notifyCustomer') && flow.getText() !== checkoutText,
    `The server's arrangement was not applied: ${flow.getText()}`);
  assert(flowEditor.selection.active.line === 27 && flowEditor.selection.active.character === 8,
    `A cursor after the change moved: ${JSON.stringify(flowEditor.selection.active)}`);
  const organizedText = flow.getText();
  const versionBefore = flow.version;
  const again = await vscode.commands.executeCommand<OrganizeOutcome>('zenwave.zfl.organizeServices', flow.uri);
  assert(again.kind === 'unchanged' && flow.version === versionBefore && flow.getText() === organizedText,
    `Organizing an organized flow must change nothing: ${JSON.stringify(again)} v${versionBefore}→${flow.version}`);
  await vscode.window.showTextDocument(flow);
  await vscode.commands.executeCommand('undo');
  assert(flow.getText() === checkoutText, `One undo did not restore the document exactly:\n${flow.getText()}`);
  console.log('PASS: organize applies the server arrangement as one edit, keeps a later cursor, is idempotent, and one undo restores the text');

  const broken = await vscode.workspace.openTextDocument({ language: 'zfl', content: 'flow Broken {\n    when {{ do\n' });
  await vscode.window.showTextDocument(broken);
  const brokenVersion = broken.version;
  const refused = await waitFor(async () => {
    const outcome = await vscode.commands.executeCommand<OrganizeOutcome>('zenwave.zfl.organizeServices', broken.uri);
    return outcome.kind === 'failed' && outcome.message.includes('is not open') ? undefined : outcome;
  }, 'Organize never reached the broken flow', 30000);
  assert(refused.kind === 'not-organizable' && refused.message.includes('left unchanged'), `organize a broken flow: ${JSON.stringify(refused)}`);
  assert(broken.version === brokenVersion && broken.getText() === 'flow Broken {\n    when {{ do\n', 'A broken flow was modified');
  const model = await vscode.workspace.openTextDocument({ language: 'zdl', content: 'entity A {}\n' });
  await vscode.window.showTextDocument(model);
  const notZfl = await vscode.commands.executeCommand<OrganizeOutcome>('zenwave.zfl.organizeServices');
  assert(notZfl.kind === 'no-document' && model.getText() === 'entity A {}\n', `organize on a ZDL: ${JSON.stringify(notZfl)}`);
  for (const document of [flow, broken, model]) {
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
  console.log('PASS: organize leaves a flow the server cannot process unchanged and says why; ZDL is refused');
}

/** Desktop only: organizes a copied fixture file on disk, and runs the commands with the server turned off. */
async function modelActionsOnDisk(api: LanguageServerApi): Promise<void> {
  const placeOrder = await vscode.workspace.openTextDocument(await fixture('place-order-flow.zfl'));
  await vscode.window.showTextDocument(placeOrder);
  const original = placeOrder.getText();
  assert(!placeOrder.isDirty, 'place-order-flow.zfl starts dirty');
  const organized = await waitFor(async () => {
    const outcome = await vscode.commands.executeCommand<OrganizeOutcome>('zenwave.zfl.organizeServices', placeOrder.uri);
    return outcome.kind === 'failed' ? undefined : outcome;
  }, 'Organize never reached place-order-flow.zfl', 30000);
  assert(organized.kind === 'organized' && placeOrder.isDirty && placeOrder.getText() !== original, `organize place-order-flow.zfl: ${JSON.stringify(organized)}`);
  const organizedText = placeOrder.getText();
  await vscode.commands.executeCommand('undo');
  assert(placeOrder.getText() === original && !placeOrder.isDirty, 'One undo did not restore place-order-flow.zfl exactly and clean');

  const copy = vscode.Uri.joinPath(await fixture('lsp'), 'organized-copy.zfl');
  await vscode.workspace.fs.writeFile(copy, new TextEncoder().encode(organizedText));
  try {
    const document = await vscode.workspace.openTextDocument(copy);
    await vscode.window.showTextDocument(document);
    const version = document.version;
    const unchanged = await waitFor(async () => {
      const outcome = await vscode.commands.executeCommand<OrganizeOutcome>('zenwave.zfl.organizeServices', copy);
      return outcome.kind === 'failed' ? undefined : outcome;
    }, 'Organize never reached the organized copy', 30000);
    assert(unchanged.kind === 'unchanged' && !document.isDirty && document.version === version,
      `An already-organized file was touched: ${JSON.stringify(unchanged)} dirty=${document.isDirty}`);
    console.log('PASS: organize place-order-flow.zfl on disk, one undo restores it clean; an organized file is not dirtied');

    await vscode.workspace.getConfiguration('zenwave').update('lsp.enabled', false, vscode.ConfigurationTarget.Workspace);
    await waitFor(() => api.status.kind === 'disabled', 'zenwave.lsp.enabled=false did not stop the server');
    const noServer = await vscode.commands.executeCommand<OrganizeOutcome>('zenwave.zfl.organizeServices', placeOrder.uri);
    assert(noServer.kind === 'no-server' && noServer.message.includes('needs the ZenWave language server') && placeOrder.getText() === original,
      `organize without a server: ${JSON.stringify(noServer)}`);
    const noServerReferences = await vscode.commands.executeCommand<ReferencesOutcome>('zenwave.model.forwardReferences', placeOrder.uri, { line: 3, character: 6 });
    assert(noServerReferences.kind === 'no-server', `references without a server: ${JSON.stringify(noServerReferences)}`);
    console.log('PASS: invoked without a server, the model actions change nothing and say they need the language server');
  } finally {
    await vscode.workspace.getConfiguration('zenwave').update('lsp.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(copy);
  }
  await connected(api, 'Re-enabled after model actions');
}

/** Desktop only: it edits workspace settings, which the browser host would write into the fixtures on disk. */
async function languageServerSettings(api: LanguageServerApi): Promise<void> {
  const workspace = vscode.workspace.getConfiguration('zenwave');
  const alternative = vscode.Uri.joinPath(await fixture('lsp'), 'alternative-architecture.yml');
  await vscode.workspace.fs.writeFile(alternative, new TextEncoder().encode('domains:\n  billing:\n    services: {}\n'));
  try {
    await workspace.update('lsp.trace.server', 'messages', vscode.ConfigurationTarget.Workspace);
    await workspace.update('workspace.manifest', 'lsp/alternative-architecture.yml', vscode.ConfigurationTarget.Workspace);
    await waitFor(() => api.manifest.route === 'setting' && api.manifest.manifestUri?.endsWith('/lsp/alternative-architecture.yml'),
      `Setting did not take over manifest resolution: ${JSON.stringify(api.manifest)}`);
    await connected(api, 'Restart with the configured manifest');
    const document = await vscode.workspace.openTextDocument(alternative);
    await vscode.window.showTextDocument(document);
    assert((await serverHover(alternative, new vscode.Position(1, 4))).includes('###'), 'Configured manifest is not served');
    // A change to the manifest file reaches the server as workspace/didChangeWatchedFiles (the runner checks the trace).
    await vscode.workspace.fs.writeFile(alternative, new TextEncoder().encode('domains:\n  billing:\n    services: {}\n  shipping:\n    services: {}\n'));
    await delay(3000);
    console.log('PASS: zenwave.workspace.manifest is authoritative and the server is re-initialised without a reload');

    await workspace.update('lsp.serverPath', 'no-such-server.js', vscode.ConfigurationTarget.Workspace);
    await waitFor(() => api.status.kind === 'failed' ? api.status : undefined, `A missing server did not fail: ${JSON.stringify(api.status)}`);
    assert('reason' in api.status && api.status.reason.includes('not a file'), `Failure reason: ${JSON.stringify(api.status)}`);
    const stillEditing = await vscode.workspace.openTextDocument(await fixture('lsp/orders.zdl'));
    assert(stillEditing.languageId === 'zdl', 'Editor lost the language without a server');
    assert((await api.requests.hierarchy(stillEditing.uri.toString())).kind === 'no-server', 'Requests must report no-server');
    await workspace.update('lsp.serverPath', undefined, vscode.ConfigurationTarget.Workspace);
    await connected(api, 'Back to the shipped server');

    await workspace.update('lsp.enabled', false, vscode.ConfigurationTarget.Workspace);
    await waitFor(() => api.status.kind === 'disabled', 'zenwave.lsp.enabled=false did not stop the server');
    await api.settled();
    assert(api.state.kind === 'unavailable', `Disabled server still ${api.state.kind}`);
    await workspace.update('lsp.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    await connected(api, 'Re-enabled');
    console.log('PASS: an invalid serverPath fails once with its reason, and zenwave.lsp.enabled turns the server off and on');
  } finally {
    await workspace.update('workspace.manifest', undefined, vscode.ConfigurationTarget.Workspace);
    await workspace.update('lsp.serverPath', undefined, vscode.ConfigurationTarget.Workspace);
    await workspace.update('lsp.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    await workspace.update('lsp.trace.server', undefined, vscode.ConfigurationTarget.Workspace);
  }
  await waitFor(() => api.manifest.route === 'config', 'Manifest resolution did not return to .zenwave/config.yml');
  await connected(api, 'Restored configuration');
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
  await sharedLspFoundation();
  const api = (extension.exports as ZenwaveExtensionApi).languageServer;
  const desktop = vscode.env.uiKind === vscode.UIKind.Desktop;
  await realLanguageServer(api, desktop);
  await modelActions(api);
  if (desktop) await modelActionsOnDisk(api);
  if (desktop) await languageServerSettings(api);

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
  assert(sdkLenses.length === (desktop ? 2 : 0), `Expected ${desktop ? 2 : 0} SDK lenses, got ${sdkLenses.length}`);
  if (desktop) {
    assert(sdkLenses.map((lens) => (lens.command?.arguments?.[0] as { plugin: string }).plugin)
      .sort().join(',') === 'FirstPlugin,SecondPlugin', 'Lenses must only cover enabled plugins');
  }
  console.log(`PASS: ${desktop ? 'desktop enabled-plugin' : 'browser absent'} CodeLens`);
  await authoring();
  if (desktop) await desktopRuns(plugins);
}
