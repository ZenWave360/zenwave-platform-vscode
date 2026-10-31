import * as vscode from 'vscode';
import { SHIPPED_CATALOGUE } from '../src/sdk/catalogue.js';
import rawShippedCatalogue from '../resources/sdk-plugin-catalogue.json';
import recordedDomainPage from './fixtures/lsp-samples/preview-zdl.json';
import { LspSupervisor } from '../src/lsp/supervisor.js';
import type { ZenwaveExtensionApi } from '../src/activate.js';
import type { LanguageServerApi } from '../src/lsp/feature.js';
import { documentFailure } from '../src/lsp/requests.js';
import type { OrganizeOutcome, ReferencesOutcome } from '../src/model/actions.js';
import type { HierarchyTreeApi, ModelExplorerApi, OpenRelatedOutcome } from '../src/explorer/feature.js';
import { findNode, type ExplorerNode } from '../src/explorer/hierarchy-model.js';
import type { EventFlowApi, EventFlowEditorApi, EventFlowOpenOutcome } from '../src/eventflow/feature.js';
import type { PreviewApi, PreviewEditorApi, PreviewOpenOutcome, PreviewSelectOutcome } from '../src/preview/feature.js';
import { contentHash, type PreviewProbe } from '../src/preview/protocol.js';
import { outcomeOf } from '../src/preview/selection.js';
import type { Preview } from '../src/lsp/requests.js';

const EXTENSION_ID = 'ZenWave360.zenwave-platform';

const SHIPPED_CATALOGUE_RAW = rawShippedCatalogue as { plugins: readonly unknown[] } & Record<string, unknown>;

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

const EXPLORER_COMMANDS = ['zenwave.explorer.refresh', 'zenwave.explorer.openNode', 'zenwave.explorer.openRelated', 'zenwave.explorer.openManifest'];

const labels = (nodes: readonly ExplorerNode[] | undefined): string[] => (nodes ?? []).map((item) => item.node.label);
const roots = (tree: HierarchyTreeApi): ExplorerNode[] => (tree.tree?.roots ?? []) as ExplorerNode[];

function node(tree: HierarchyTreeApi, label: string, kind: string): ExplorerNode | undefined {
  return tree.tree && findNode(tree.tree, (candidate) => candidate.node.label === label && candidate.node.kind === kind);
}

async function treeState(tree: HierarchyTreeApi, kind: string, message: string, ms = 60000): Promise<void> {
  await waitFor(() => tree.state.kind === kind, `${message}: ${JSON.stringify(tree.state)} for ${tree.documentUri}`, ms);
  await tree.settled();
  assert(tree.state.kind === kind, `${message}: ${JSON.stringify(tree.state)} for ${tree.documentUri}`);
}

function activeTabUri(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputText ? input.uri.toString() : undefined;
}

/** 006, before any document is opened: the container exists and the architecture tree needs no editor. */
async function explorerBeforeAnyDocument(api: LanguageServerApi, explorer: ModelExplorerApi, desktop: boolean): Promise<void> {
  await connected(api, 'Explorer');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const commands = await vscode.commands.getCommands(true);
  for (const command of EXPLORER_COMMANDS) assert(commands.includes(command), `${command} was not registered`);
  await vscode.commands.executeCommand('workbench.view.extension.zenwave');
  const { architecture, model } = explorer;
  assert(vscode.window.tabGroups.all.every((group) => group.tabs.length === 0), 'An editor is open before the explorer check');

  if (desktop) {
    await treeState(architecture, 'ready', 'Architecture tree with no editor open');
    const children = await architecture.provider.getChildren();
    const manifest = children?.[0];
    assert(manifest, 'No manifest root');
    const item = await architecture.provider.getTreeItem(manifest);
    assert(item.label === 'zenwave-architecture.yml', `Manifest root label: ${String(item.label)}`);
    assert(labels(manifest.children).join() === 'orders,fulfillment', `Domains: ${labels(manifest.children)}`);
    const shipping = node(architecture, 'shipping', 'subdomain');
    assert(shipping?.parent?.node.label === 'fulfillment' && labels(shipping.children).join() === 'shipping-api',
      `Subdomain under its domain: ${JSON.stringify(shipping?.node)}`);
    assert(architecture.view.description === 'zenwave-architecture.yml', `Architecture description: ${architecture.view.description}`);
    console.log('PASS: the ZenWave container shows the architecture manifest domains and subdomains with no editor open');
  } else {
    // A server in a Web Worker cannot read a vscode-test-web: document nobody opened (zenwave-lsp d7156e7):
    // the tree says so, once, instead of rendering an empty box or retrying.
    await treeState(architecture, 'not-found', 'Architecture tree in the browser for an unopened manifest');
    assert(roots(architecture).length === 0, 'A not-found manifest must not render nodes');
    const requests = architecture.stats.requests;
    await delay(2000);
    assert(architecture.stats.requests === requests && architecture.state.kind === 'not-found', 'The not-found state retried by itself');
    assert(await vscode.commands.executeCommand<boolean>('zenwave.explorer.openManifest'), 'Open Architecture Manifest did nothing');
    await treeState(architecture, 'ready', 'Architecture tree once the user opened the manifest');
    assert(labels(roots(architecture)[0]?.children).join() === 'orders,fulfillment', `Domains after opening: ${labels(roots(architecture)[0]?.children)}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('PASS: in the browser the architecture tree explains an unreadable manifest without retrying, and populates once the user opens it');
  }
  await treeState(model, 'no-model', 'Model tree with no model focused');
  assert(roots(model).length === 0, 'Model tree has nodes with no model focused');
  console.log('PASS: the model tree invites opening a model when none is focused');
}

/** 006 model tree against the real server, in both hosts. Writes nothing to disk. */
async function explorerTrees(api: LanguageServerApi, explorer: ModelExplorerApi, eventflow: EventFlowApi): Promise<void> {
  await connected(api, 'Explorer trees');
  const { model } = explorer;
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const checkoutUri = await fixture('lsp/checkout.zfl');
  const ordersZdl = await fixture('lsp/orders/model.zdl');
  const checkout = checkoutUri.toString();
  const zdl = ordersZdl.toString();
  // Opened (not shown) so that a server in a browser, which cannot read files, has the ZDL models too.
  await vscode.workspace.openTextDocument(ordersZdl);
  await vscode.workspace.openTextDocument(await fixture('orders-checkout-api/domain-model.zdl'));
  const checkoutDocument = await vscode.workspace.openTextDocument(checkoutUri);
  await vscode.window.showTextDocument(checkoutDocument);
  await waitFor(() => model.documentUri === checkout && node(model, 'Orders', 'system')?.node.sourceUri === zdl,
    `Model tree for checkout.zfl with Orders declared in the ZDL: ${JSON.stringify(model.state)} ${model.documentUri}`);
  await treeState(model, 'ready', 'Model tree for checkout.zfl');
  assert(model.view.description === 'checkout.zfl', `Model tree does not name its document: ${model.view.description}`);
  const orders = node(model, 'Orders', 'system')!;
  const service = orders.children.find((child) => child.node.kind === 'service');
  assert(service?.node.label === 'OrderService' && labels(service.children).join() === 'createOrder,notifyCustomer',
    `Commands under their service: ${labels(service?.children)}`);
  const ordersItem = await model.provider.getTreeItem(orders);
  assert(ordersItem.description === 'model.zdl' && (ordersItem.iconPath as vscode.ThemeIcon).id === 'server-environment' &&
    ordersItem.contextValue === 'zenwave.hierarchy.system.related', `Orders item: ${String(ordersItem.description)} ${(ordersItem.iconPath as vscode.ThemeIcon).id} ${ordersItem.contextValue}`);
  console.log('PASS: model tree names checkout.zfl, shows the system declared in its @zdl model and each command under its service');

  const placeOrderUri = await fixture('place-order-flow.zfl');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(placeOrderUri));
  await waitFor(() => model.documentUri === placeOrderUri.toString() && model.state.kind === 'ready' && node(model, 'OrdersCheckout', 'system') ? true : undefined,
    `Model tree did not move to place-order-flow.zfl: ${model.documentUri} ${JSON.stringify(model.state)}`);
  await model.settled();
  const systems = roots(model).find((root) => root.node.kind === 'section' && root.node.label === 'systems');
  assert(labels(systems?.children).join() === 'OrdersCheckout,CatalogInventory,PaymentsProcessing,FulfillmentShipping,NotificationsConsumer',
    `place-order-flow systems: ${labels(systems?.children)}`);
  const checkoutSystem = node(model, 'OrdersCheckout', 'system')!;
  assert(checkoutSystem.node.sourceUri.endsWith('/orders-checkout-api/domain-model.zdl'), `OrdersCheckout declared in: ${checkoutSystem.node.sourceUri}`);
  assert(labels(checkoutSystem.children[0]?.children).join() === 'startOrderCheckout,confirmOrder,cancelOrder',
    `OrdersCheckoutService commands: ${labels(checkoutSystem.children[0]?.children)}`);
  const payments = node(model, 'PaymentsProcessingService', 'service');
  assert(labels(payments?.children).includes('authorizePayment') && labels(payments?.children).includes('retryPayment'),
    `PaymentsProcessingService commands: ${labels(payments?.children)}`);
  console.log('PASS: place-order-flow.zfl: five systems, one declared in its annotated ZDL, commands under their services');

  // Not a model: the tree keeps the last model rather than emptying.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(await fixture('README.md')));
  const panel = vscode.window.createWebviewPanel('zenwave.smoke', 'Not a model', vscode.ViewColumn.Active, {});
  await delay(1000);
  await model.settled();
  assert(model.documentUri === placeOrderUri.toString() && model.state.kind === 'ready' && roots(model).length > 0,
    `A Markdown editor or a webview changed the model tree: ${model.documentUri} ${JSON.stringify(model.state)}`);
  panel.dispose();
  console.log('PASS: focusing a Markdown file or a webview keeps the last model on screen');

  // Deliberately moving back to the flow retargets; drilling into its ZDL does not.
  await vscode.window.showTextDocument(checkoutDocument);
  await waitFor(() => model.documentUri === checkout && node(model, 'Orders', 'system')?.node.sourceUri === zdl, 'Model tree did not return to checkout.zfl');
  await model.settled();
  const opened = await vscode.commands.executeCommand<string>('zenwave.explorer.openNode', node(model, 'Orders', 'system'));
  assert(opened === zdl, `Selecting a system opened ${opened}`);
  await waitFor(() => activeTabUri() === zdl, 'The ZDL declaring Orders is not the active tab', 10000);
  await delay(1000);
  await model.settled();
  assert(model.documentUri === checkout && node(model, 'Orders', 'system'), `Drilling into the ZDL retargeted the tree: ${model.documentUri}`);
  const declared = node(model, 'OrderService', 'service')!;
  assert(await vscode.commands.executeCommand<string>('zenwave.explorer.openNode', declared) === zdl, 'Selecting a service did not open its ZDL');
  const zdlEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === zdl);
  assert(zdlEditor?.selection.active.line === declared.node.sourceRange.start.line,
    `Not at the declaration: ${JSON.stringify(zdlEditor?.selection.active)} vs ${JSON.stringify(declared.node.sourceRange)}`);
  await delay(500);
  await model.settled();
  assert(model.documentUri === checkout, `Navigating inside the ZDL retargeted the tree: ${model.documentUri}`);
  console.log('PASS: selecting a system opens the ZDL declaring it at the declaration, and the tree keeps showing the flow');

  const related = node(model, 'Orders', 'system')!;
  const back = related.node.relatedResources.findIndex((resource) => resource.relationType === 'referenced-by');
  const toFlow = await vscode.commands.executeCommand<OpenRelatedOutcome>('zenwave.explorer.openRelated', related, back);
  assert(toFlow.kind === 'opened' && toFlow.uri === checkout, `referenced-by related resource: ${JSON.stringify(toFlow)}`);
  const domain = related.node.relatedResources.findIndex((resource) => resource.relationType === 'declares-domain');
  const toZdl = await vscode.commands.executeCommand<OpenRelatedOutcome>('zenwave.explorer.openRelated', related, domain);
  assert(toZdl.kind === 'opened' && toZdl.uri === zdl, `declares-domain related resource: ${JSON.stringify(toZdl)}`);
  const none = await vscode.commands.executeCommand<OpenRelatedOutcome>('zenwave.explorer.openRelated', node(model, 'CheckoutFlow', 'flow'));
  assert(none.kind === 'none', `A node without related resources: ${JSON.stringify(none)}`);
  console.log('PASS: related resources open from a node in both directions; a node without any says so');

  // Cursor to tree, and tree selection to the real EventFlow diagram open beside the flow (004).
  await vscode.window.showTextDocument(checkoutDocument, vscode.ViewColumn.One);
  await vscode.commands.executeCommand('zenwave.eventflow.openToSide', checkoutUri);
  const diagram = await renderedDiagram(eventflow, checkout);
  assert(explorer.diagramPanels.panelsFor(checkout).length === 1, 'The diagram did not register with the explorer once its page was ready');
  await vscode.commands.executeCommand('zenwave.model.focus');
  const editor = await vscode.window.showTextDocument(checkoutDocument, vscode.ViewColumn.One);
  await waitFor(() => model.view.visible && model.documentUri === checkout, 'Model view not visible');
  await model.settled();
  editor.selection = new vscode.Selection(21, 8, 21, 8);
  await waitFor(() => model.view.selection[0]?.node.kind === 'policy' && model.view.selection[0].node.label === 'OrderCreated',
    `The cursor in a when block did not reveal it: ${model.view.selection[0]?.node.label}`, 15000);
  await waitFor(() => diagram.session.highlighted === 'policy:OrderCreated:notifyCustomer' && diagram.session.posted.includes('highlightNode'),
    `Tree selection did not reach the diagram: ${diagram.session.highlighted}`, 10000);
  editor.selection = new vscode.Selection(11, 2, 11, 2);
  await waitFor(() => model.view.selection[0]?.node.kind === 'start', `The cursor in a start did not reveal it: ${model.view.selection[0]?.node.label}`, 15000);
  await waitFor(async () => (await diagram.probe()).highlightedNodeIds.join() === 'event:CheckoutStarted',
    `The diagram page did not highlight the selected start node: ${JSON.stringify(await diagram.probe().catch((error: unknown) => String(error)))}`, 15000);
  assert(model.lastReflection === 'highlighted', `Reflection: ${model.lastReflection}`);
  await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputCustom));
  await waitFor(() => eventflow.editorsFor(checkout).length === 0 && explorer.diagramPanels.panelsFor(checkout).length === 0,
    'Closing the diagram did not unregister it');
  console.log('PASS: moving the cursor reveals the declaration in the tree, and the selection highlights the node in the open EventFlow diagram');

  // Typing: the largest flow fixture, many edits in quick succession, few requests.
  const typed = await vscode.workspace.openTextDocument({ language: 'zfl', content: (await vscode.workspace.openTextDocument(placeOrderUri)).getText() });
  const typedEditor = await vscode.window.showTextDocument(typed);
  await waitFor(() => model.documentUri === typed.uri.toString() && model.state.kind === 'ready', 'Model tree did not follow an untitled flow');
  await model.settled();
  const before = model.stats;
  const end = typed.lineAt(40).range.end;
  for (let key = 0; key < 60; key++) {
    await typedEditor.edit((edit) => key % 2 === 0
      ? edit.insert(end, 'x')
      : edit.delete(new vscode.Range(end, end.translate(0, 1))));
  }
  await delay(100);
  await model.settled();
  const after = model.stats;
  assert(after.requests - before.requests <= 2 && after.renders - before.renders <= 2 && model.state.kind === 'ready',
    `60 edits caused ${after.requests - before.requests} hierarchy requests and ${after.renders - before.renders} tree updates`);
  console.log(`PASS: 60 edits to a ${typed.lineCount}-line flow caused ${after.requests - before.requests} hierarchy request(s) and ${after.renders - before.renders} tree update(s)`);

  const broken = await vscode.workspace.openTextDocument({ language: 'zfl', content: 'flow Broken {\n    when {{ do\n' });
  await vscode.window.showTextDocument(broken);
  await waitFor(() => vscode.languages.getDiagnostics(broken.uri).length > 0, 'No diagnostics for the broken flow', 30000);
  // lsp-js d7156e7 answers a partial hierarchy for a flow with syntax errors rather than documentUnreadable
  // (spec question in the client-006 handoff); the tree shows it and says the document has errors.
  await waitFor(() => model.documentUri === broken.uri.toString() && model.tree?.documentUri === broken.uri.toString() &&
    (model.state.kind === 'unreadable' || (model.view.message ?? '').includes('has ')) ? true : undefined,
  'Model tree did not report the broken flow', 30000);
  await model.settled();
  const brokenState: string = model.state.kind;
  assert(brokenState === 'unreadable' || /has \d+ errors?; its hierarchy may be incomplete/.test(model.view.message ?? ''),
    `A flow with syntax errors: ${JSON.stringify(model.state)} ${model.view.message}`);
  console.log(`PASS: a flow with syntax errors is reported (${brokenState}: ${model.view.message})`);
  for (const document of [typed, broken]) {
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

const EVENTFLOW_COMMANDS = ['zenwave.eventflow.open', 'zenwave.eventflow.openToSide', 'zenwave.eventflow.showText',
  'zenwave.eventflow.showServiceView', 'zenwave.eventflow.showFlowView', 'zenwave.eventflow.showLabelsAsWritten', 'zenwave.eventflow.showHumanizedLabels'];

const allTabs = (): vscode.Tab[] => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
const isDiagramTab = (tab: vscode.Tab | undefined, uri: string): boolean =>
  tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === 'zenwave.eventflow' && tab.input.uri.toString() === uri;
const isTextTab = (tab: vscode.Tab | undefined, uri: string): boolean => tab?.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri;

interface Graphs { readonly flowGraph: { readonly nodes: readonly { readonly id: string; readonly label?: string }[] }; readonly serviceGraph: { readonly nodes: readonly { readonly id: string }[] } }

/** The diagram editor for a document once its page said it loaded and rendered a diagram, with no state shown over it. */
async function renderedDiagram(eventflow: EventFlowApi, uri: string): Promise<EventFlowEditorApi> {
  const editor = await waitFor(() => eventflow.editorsFor(uri)[0], `No EventFlow diagram editor for ${uri}`, 30000);
  await waitFor(() => editor.session.page.kind === 'ready' ? true : editor.session.page.kind === 'failed' ? (() => { throw new Error(`EventFlow page failed: ${JSON.stringify(editor.session.page)}`); })() : undefined,
    `The EventFlow page never sent webviewReady for ${uri}: ${JSON.stringify(editor.session.page)}`, 60000);
  await waitFor(() => editor.session.lastRenderBundle !== undefined && editor.session.state === null,
    `No diagram rendered for ${uri}: ${JSON.stringify(editor.session.state)} ${JSON.stringify(editor.session.data)}`, 60000);
  const probe = await waitFor(async () => {
    const answer = await editor.probe().catch(() => undefined);
    return answer && answer.nodeIds.length > 0 ? answer : undefined;
  }, `The EventFlow page rendered no nodes for ${uri}`, 30000);
  assert(probe.cspViolations.length === 0, `The EventFlow page reported content security policy violations: ${probe.cspViolations.join('; ')}`);
  assert(probe.stylesheets >= 1, 'The EventFlow page stylesheet did not load');
  return editor;
}

/** The server's own answer for the document, to compare with what the editor posted. */
async function serverViews(api: LanguageServerApi, uri: string): Promise<Graphs> {
  const views = await api.requests.eventFlowViews(uri);
  assert(views.kind === 'ok', `eventFlowViews for ${uri}: ${JSON.stringify(views).slice(0, 300)}`);
  return views.value as unknown as Graphs;
}

/** 004 EventFlow diagram editor against the real server and the real vistas page, in both hosts. Writes nothing to disk. */
async function eventflowDiagrams(api: LanguageServerApi, explorer: ModelExplorerApi, eventflow: EventFlowApi): Promise<void> {
  await connected(api, 'EventFlow diagrams');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const commands = await vscode.commands.getCommands(true);
  for (const command of EVENTFLOW_COMMANDS) assert(commands.includes(command), `${command} was not registered`);
  const placeOrderUri = await fixture('place-order-flow.zfl');
  const placeOrder = placeOrderUri.toString();
  const checkoutUri = await fixture('lsp/checkout.zfl');
  const checkout = checkoutUri.toString();

  // Opening a flow the ordinary way gives the text editor.
  await vscode.commands.executeCommand('vscode.open', placeOrderUri);
  await waitFor(() => isTextTab(vscode.window.tabGroups.activeTabGroup.activeTab, placeOrder), 'Opening a .zfl did not give the text editor', 10000);
  assert(eventflow.editors.length === 0, 'Opening a .zfl opened a diagram');
  console.log('PASS: opening a .zfl file gives the text editor, not the diagram');

  // Beside: from the palette route (the active tab), the diagram opens in the next column and focus stays in the text.
  const beside = await vscode.commands.executeCommand<EventFlowOpenOutcome>('zenwave.eventflow.openToSide');
  assert(beside.kind === 'opened' && beside.documentUri === placeOrder, `openToSide: ${JSON.stringify(beside)}`);
  const flow = await renderedDiagram(eventflow, placeOrder);
  const diagramTab = allTabs().find((tab) => isDiagramTab(tab, placeOrder));
  assert(diagramTab && diagramTab.group.viewColumn === vscode.ViewColumn.Two, `The diagram is not in the column beside: ${diagramTab?.group.viewColumn}`);
  assert(diagramTab.label === 'place-order-flow.zfl', `The diagram tab does not name its document: ${diagramTab.label}`);
  assert(isTextTab(vscode.window.tabGroups.activeTabGroup.activeTab, placeOrder), 'Focus left the text editor when the diagram opened beside it');
  assert(JSON.stringify(flow.session.readyPayload) === JSON.stringify({ protocol: 'zenwave.eventflow.webview', protocolVersion: 1 }),
    `webviewReady payload: ${JSON.stringify(flow.session.readyPayload)}`);
  console.log('PASS: the diagram opens beside the text, named for its document, focus stays in the text, and the page reports webviewReady with protocol version 1');

  // Verbatim: what was posted is the server's answer, and the page drew those nodes.
  const views = await serverViews(api, placeOrder);
  const posted = flow.session.lastRenderBundle!;
  assert(JSON.stringify(posted.flowGraph) === JSON.stringify(views.flowGraph) && JSON.stringify(posted.serviceGraph) === JSON.stringify(views.serviceGraph),
    'renderBundle does not carry the server answer field for field');
  assert(posted.viewMode === 'flow' && JSON.stringify(posted.displaySettings) === '{"humanizeLabels":true}', `renderBundle controls: ${posted.viewMode} ${JSON.stringify(posted.displaySettings)}`);
  const flowIds = views.flowGraph.nodes.map((node) => node.id).sort();
  const drawn = await waitFor(async () => {
    const probe = await flow.probe();
    return JSON.stringify([...probe.nodeIds].sort()) === JSON.stringify(flowIds) ? probe : undefined;
  }, `The page did not draw the server's flow nodes: ${JSON.stringify((await flow.probe()).nodeIds)} vs ${JSON.stringify(flowIds)}`, 30000);
  console.log(`PASS: renderBundle carries zenwave/eventFlowViews verbatim and the page draws all ${drawn.nodeIds.length} flow nodes`);

  // Controls, per editor: services view, labels as written.
  const camel = views.flowGraph.nodes.map((node) => node.label ?? '').find((label) => /[a-z][A-Z]/.test(label));
  assert(camel, 'No camel-case label to check humanised labels with');
  assert(!drawn.text.includes(camel), `Labels are not humanised by default: ${camel}`);
  assert(await vscode.commands.executeCommand<boolean>('zenwave.eventflow.showLabelsAsWritten', placeOrderUri), 'Labels toggle found no diagram');
  await waitFor(async () => (await flow.probe()).text.includes(camel), `Labels as written did not show ${camel}`, 15000);
  assert(await vscode.commands.executeCommand<boolean>('zenwave.eventflow.showServiceView', placeOrderUri), 'View toggle found no diagram');
  const serviceIds = views.serviceGraph.nodes.map((node) => node.id);
  await waitFor(async () => {
    const probe = await flow.probe();
    return serviceIds.every((id) => probe.nodeIds.includes(id)) && !flowIds.every((id) => probe.nodeIds.includes(id));
  }, 'The service view was not drawn', 15000);
  assert(flow.session.viewMode === 'services' && flow.session.posted.includes('setViewMode') && flow.session.posted.includes('setDisplaySettings'),
    `Controls were not relayed: ${flow.session.posted.join()}`);
  console.log('PASS: the title-bar toggles switch this diagram to the service view and to labels as written');

  // EF-R3: the page's own selector and the title-bar toggle end in the same state. A page without a selector (the
  // published 0.1.0) has nothing to drive, so these checks are skipped, not failed.
  if ((await flow.probe()).viewSelector === undefined) {
    console.log('SKIP: the EventFlow page has no view selector (webview/ page, pin 0.1.0): selector, viewModeChanged and context key checks not run');
  } else {
    const selectorShows = (view: string) => async () => (await flow.probe()).viewSelector === view;
    const drawsFlow = async () => { const probe = await flow.probe(); return flowIds.every((id) => probe.nodeIds.includes(id)); };
    await waitFor(selectorShows('services'), 'The selector did not follow the title-bar command to services', 15000);
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
    await waitFor(() => flow.panel.active && eventflow.active === flow, 'The diagram did not take focus', 10000);
    assert(eventflow.contextViewMode === 'services', `Context key after focusing the diagram: ${eventflow.contextViewMode}`);
    const postedViewModes = (): number => flow.session.posted.filter((type) => type === 'setViewMode').length;
    const before = postedViewModes();
    flow.session.selectView('flow');
    await waitFor(async () => flow.session.viewMode === 'flow' && (await drawsFlow()) && eventflow.contextViewMode === 'flow' ? true : undefined,
      `Choosing Flow in the selector: session ${flow.session.viewMode}, context key ${eventflow.contextViewMode}`, 15000);
    assert(postedViewModes() === before, 'The extension posted setViewMode back for a change the page made');
    await flow.session.refresh();
    assert(flow.session.lastRenderBundle?.viewMode === 'flow', `A re-render after the selector change carries ${flow.session.lastRenderBundle?.viewMode}`);
    assert(await vscode.commands.executeCommand<boolean>('zenwave.eventflow.showServiceView', placeOrderUri), 'View toggle found no diagram');
    await waitFor(async () => (await flow.probe()).viewSelector === 'services' && eventflow.contextViewMode === 'services' ? true : undefined,
      `The selector did not follow the title command: context key ${eventflow.contextViewMode}`, 15000);
    assert(flow.session.viewMode === 'services', `Session after the title command: ${flow.session.viewMode}`);
    // A change in a diagram that is not focused leaves the focused editor's context key alone.
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    await waitFor(() => !flow.panel.active, 'The diagram kept focus', 10000);
    flow.session.selectView('flow');
    await waitFor(() => flow.session.viewMode === 'flow' ? true : undefined, 'The selector change was not recorded', 15000);
    assert(eventflow.contextViewMode === 'services', `An unfocused diagram changed the context key to ${eventflow.contextViewMode}`);
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
    await waitFor(() => eventflow.contextViewMode === 'flow' ? true : undefined, `Focusing the diagram did not publish its view: ${eventflow.contextViewMode}`, 10000);
    assert(await vscode.commands.executeCommand<boolean>('zenwave.eventflow.showServiceView', placeOrderUri), 'View toggle found no diagram');
    await waitFor(async () => (await flow.probe()).viewSelector === 'services' && eventflow.contextViewMode === 'services' ? true : undefined, 'The service view was not restored', 15000);
    console.log('PASS: choosing a view in the page selector updates the session and context key without echoing to the page, survives a re-render, and the title command moves the selector; an unfocused diagram leaves the context key alone');
  }

  // In place: the text tab of checkout.zfl becomes its diagram at the same position; a second diagram keeps its own choices.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(checkoutUri), { viewColumn: vscode.ViewColumn.One, preview: false });
  const groupOne = (): vscode.TabGroup => vscode.window.tabGroups.all.find((group) => group.viewColumn === vscode.ViewColumn.One)!;
  const textIndex = groupOne().tabs.findIndex((tab) => isTextTab(tab, checkout));
  assert(textIndex >= 0, 'checkout.zfl text tab not found');
  const inPlace = await vscode.commands.executeCommand<EventFlowOpenOutcome>('zenwave.eventflow.open', checkoutUri);
  assert(inPlace.kind === 'opened', `open in place: ${JSON.stringify(inPlace)}`);
  const second = await renderedDiagram(eventflow, checkout);
  await waitFor(() => groupOne().tabs.findIndex((tab) => isDiagramTab(tab, checkout)) === textIndex && !groupOne().tabs.some((tab) => isTextTab(tab, checkout)),
    `The in-place diagram did not take the text tab's position ${textIndex}: ${groupOne().tabs.map((tab) => tab.label).join()}`, 10000);
  const checkoutViews = await serverViews(api, checkout);
  await waitFor(async () => JSON.stringify([...(await second.probe()).nodeIds].sort()) === JSON.stringify(checkoutViews.flowGraph.nodes.map((node) => node.id).sort()),
    'The second diagram does not show its own flow', 30000);
  assert(second.session.viewMode === 'flow' && flow.session.viewMode === 'services' && flow.documentUri === placeOrder && second.documentUri === checkout,
    'Two diagrams do not keep their own document and view');
  console.log('PASS: opening in place replaces the text tab at its position; two diagrams keep their own document and view');

  // 006: focusing a diagram keeps the model tree populated for its document.
  await waitFor(() => explorer.model.documentUri === checkout && explorer.model.state.kind === 'ready', `Model tree with the checkout diagram focused: ${explorer.model.documentUri} ${JSON.stringify(explorer.model.state)}`);
  console.log('PASS: with a diagram focused the model tree shows that diagram\'s document');

  // With a diagram focused there is no active text editor: a palette command finds the document through the tab.
  await waitFor(() => isDiagramTab(vscode.window.tabGroups.activeTabGroup.activeTab, checkout), 'The checkout diagram is not the active tab', 10000);
  assert(vscode.window.activeTextEditor === undefined, 'A text editor is active while the diagram has focus');
  const fromTab = await vscode.commands.executeCommand<EventFlowOpenOutcome>('zenwave.eventflow.open');
  assert(fromTab.kind === 'opened' && fromTab.documentUri === checkout && eventflow.editorsFor(checkout).length === 1,
    `A command without an argument did not find the diagram's document: ${JSON.stringify(fromTab)}`);
  console.log('PASS: with no active text editor, a command resolves the model document from the focused diagram tab');

  // VS Code's own way back (Reopen Editor With... → Text Editor) replaces the diagram with the text.
  if ((await vscode.commands.getCommands(true)).includes('workbench.action.reopenTextEditor')) {
    await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
    await waitFor(() => isTextTab(vscode.window.tabGroups.activeTabGroup.activeTab, checkout) && groupOne().tabs.findIndex((tab) => isTextTab(tab, checkout)) === textIndex,
      `Reopen with the text editor did not give the text back in place: ${groupOne().tabs.map((tab) => tab.label).join()}`, 10000);
    await vscode.commands.executeCommand('zenwave.eventflow.open', checkoutUri);
    await renderedDiagram(eventflow, checkout);
    await waitFor(() => groupOne().tabs.findIndex((tab) => isDiagramTab(tab, checkout)) === textIndex, 'Reopening the diagram in place moved it', 10000);
    console.log('PASS: VS Code\'s reopen-with-text returns to the text in place, and the diagram opens in place again');
  }

  // Back to the text, in the same place.
  const back = await vscode.commands.executeCommand<EventFlowOpenOutcome>('zenwave.eventflow.showText', checkoutUri);
  assert(back.kind === 'opened', `showText: ${JSON.stringify(back)}`);
  await waitFor(() => groupOne().tabs.findIndex((tab) => isTextTab(tab, checkout)) === textIndex && !groupOne().tabs.some((tab) => isDiagramTab(tab, checkout)),
    `Going back to the text did not keep the position: ${groupOne().tabs.map((tab) => tab.label).join()}`, 10000);
  await waitFor(() => eventflow.editorsFor(checkout).length === 0, 'The replaced diagram editor was not disposed');
  console.log('PASS: Show ZFL Text replaces the diagram with the text at the same position');

  // 006 → 004: a tree selection highlights in the place-order diagram (flow view).
  assert(await vscode.commands.executeCommand<boolean>('zenwave.eventflow.showFlowView', placeOrderUri), 'Flow toggle found no diagram');
  await vscode.commands.executeCommand('vscode.openWith', placeOrderUri, 'zenwave.eventflow', { viewColumn: vscode.ViewColumn.Two });
  const { model } = explorer;
  await waitFor(() => model.documentUri === placeOrder && model.state.kind === 'ready' && model.tree ? true : undefined,
    `Model tree did not follow the focused place-order diagram: ${model.documentUri} ${JSON.stringify(model.state)}`);
  await model.settled();
  await vscode.commands.executeCommand('zenwave.model.focus');
  await waitFor(() => model.view.visible, 'Model view not visible');
  const renderedIds = (await flow.probe()).nodeIds;
  const matched = findNode(model.tree!, (candidate) => candidate.node.viewNodeIds.length > 0 && renderedIds.includes(candidate.node.viewNodeIds[0]!));
  const unmatched = findNode(model.tree!, (candidate) => candidate.node.viewNodeIds.length === 0);
  assert(matched && unmatched, 'No tree nodes with and without a diagram counterpart');
  await model.view.reveal(matched, { select: true, focus: false });
  await waitFor(async () => (await flow.probe()).highlightedNodeIds.join() === matched.node.viewNodeIds[0],
    `Selecting ${matched.node.label} did not highlight ${matched.node.viewNodeIds[0]} in the page`, 15000);
  await model.view.reveal(unmatched, { select: true, focus: false });
  await waitFor(async () => (await flow.probe()).highlightedNodeIds.length === 0, `Selecting ${unmatched.node.label} did not clear the highlight`, 15000);
  assert(model.lastReflection === 'no-counterpart', `Reflection: ${model.lastReflection}`);
  const violations = (await flow.probe()).cspViolations;
  assert(violations.length === 0, `Content security policy violations after switching views and labels: ${violations.join('; ')}`);
  console.log(`PASS: selecting ${matched.node.label} in the model tree highlights ${matched.node.viewNodeIds[0]} in the diagram page; a node without a counterpart clears it`);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => eventflow.editors.length === 0 && explorer.diagramPanels.panelsFor(placeOrder).length === 0, 'Closing all editors left diagram editors registered');
}

/** Desktop only: edits and rewrites the copied fixture, and stops the server, with a diagram open. */
async function eventflowOnDisk(api: LanguageServerApi, eventflow: EventFlowApi): Promise<void> {
  await connected(api, 'EventFlow on disk');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const placeOrderUri = await fixture('place-order-flow.zfl');
  const placeOrder = placeOrderUri.toString();
  const original = await vscode.workspace.fs.readFile(placeOrderUri);
  const document = await vscode.workspace.openTextDocument(placeOrderUri);
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  await vscode.commands.executeCommand('zenwave.eventflow.openToSide', placeOrderUri);
  const diagram = await renderedDiagram(eventflow, placeOrder);
  await vscode.commands.executeCommand('zenwave.eventflow.showServiceView', placeOrderUri);
  await vscode.commands.executeCommand('zenwave.eventflow.showLabelsAsWritten', placeOrderUri);
  const endLine = document.getText().split('\n').findIndex((line) => line.trim() === 'end {');
  assert(endLine > 0, 'place-order-flow.zfl has no end block');
  try {
    // Typing a new command: the diagram follows without flashing an empty state, and keeps its choices.
    const bundles = (): number => diagram.session.posted.filter((type) => type === 'renderBundle').length;
    const before = bundles();
    const states: string[] = [];
    const watch = setInterval(() => { states.push(diagram.session.state?.mode ?? 'none'); }, 20);
    try {
      const text = '    when OrderCancelled do smokeAuditOrder {\n        service OrdersCheckout.OrdersCheckoutService\n        emits OrderAudited\n    }\n\n';
      // Typed one character at a time, as fast as the editor takes them.
      let offset = document.offsetAt(new vscode.Position(endLine, 0));
      const requestsBefore = diagram.session.requests;
      for (const character of text) {
        await editor.edit((edit) => edit.insert(document.positionAt(offset), character));
        offset += character.length;
      }
      await waitFor(async () => (await diagram.probe()).nodeIds.some((id) => id.includes('smokeAuditOrder')), 'The typed command did not appear in the diagram', 30000);
      const typedRequests = diagram.session.requests - requestsBefore;
      assert(typedRequests < text.length / 4, `${text.length} keystrokes caused ${typedRequests} eventFlowViews requests`);
      console.log(`PASS: ${text.length} keystrokes caused ${typedRequests} eventFlowViews request(s), and the last text typed is the one drawn`);
      // A declaration that is briefly incomplete: the diagram stays, with a banner, never an overlay.
      await editor.edit((edit) => edit.insert(new vscode.Position(endLine, 0), '    when {{ do\n'));
      await waitFor(() => diagram.session.data.kind === 'unreadable', `A broken flow was not reported: ${JSON.stringify(diagram.session.data)}`, 30000);
      const kept = await diagram.probe();
      assert(kept.stateKind === 'unreadable' && kept.stateMode === 'banner' && kept.nodeIds.some((id) => id.includes('smokeAuditOrder')),
        `The last good diagram was not kept under a banner: ${kept.stateKind} ${kept.stateMode} ${kept.nodeIds.length}`);
      await editor.edit((edit) => edit.delete(new vscode.Range(endLine, 0, endLine + 1, 0)));
      await waitFor(() => diagram.session.state === null && diagram.session.data.kind === 'rendered', 'The diagram did not recover when the flow was fixed', 30000);
    } finally {
      clearInterval(watch);
    }
    assert(!states.includes('overlay'), `An empty state flashed while editing: ${[...new Set(states)].join()}`);
    assert(allTabs().filter((tab) => isDiagramTab(tab, placeOrder)).map((tab) => tab.group.viewColumn).join() === String(vscode.ViewColumn.Two) &&
      isTextTab(vscode.window.tabGroups.activeTabGroup.activeTab, placeOrder), 'Re-rendering moved the diagram or took the focus');
    assert(bundles() > before && diagram.session.lastRenderBundle?.viewMode === 'services' && diagram.session.lastRenderBundle.displaySettings.humanizeLabels === false,
      `Choices did not survive the re-render: ${JSON.stringify({ viewMode: diagram.session.lastRenderBundle?.viewMode, displaySettings: diagram.session.lastRenderBundle?.displaySettings })}`);
    console.log(`PASS: typing a command re-renders the diagram (${bundles() - before} renders, ${diagram.session.requests} requests so far), a broken flow keeps the last diagram under a banner, and the view choices survive`);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await waitFor(() => !document.isDirty, 'Could not revert place-order-flow.zfl');

    // On disk: rewriting the file re-renders the diagram from the new content.
    const onDisk = new TextDecoder().decode(original).replace('    end {', '    when OrderCancelled do diskAuditOrder {\n        service OrdersCheckout.OrdersCheckoutService\n    }\n\n    end {');
    await vscode.workspace.fs.writeFile(placeOrderUri, new TextEncoder().encode(onDisk));
    await waitFor(async () => (await diagram.probe()).nodeIds.some((id) => id.includes('diskAuditOrder')), 'A change on disk did not reach the diagram', 30000);
    console.log('PASS: a change to the file on disk re-renders the diagram');
  } finally {
    await vscode.workspace.fs.writeFile(placeOrderUri, original);
  }
  await waitFor(async () => !(await diagram.probe()).nodeIds.some((id) => id.includes('diskAuditOrder')), 'Restoring the file did not re-render the diagram', 30000);

  const settings = vscode.workspace.getConfiguration('zenwave');
  try {
    await settings.update('lsp.enabled', false, vscode.ConfigurationTarget.Workspace);
    await waitFor(() => diagram.session.state?.kind === 'no-server', `The open diagram did not say it needs the server: ${JSON.stringify(diagram.session.state)}`, 30000);
    const banner = await diagram.probe();
    assert(banner.stateKind === 'no-server' && banner.stateMode === 'banner' && banner.nodeIds.length > 0, `No-server with a diagram on screen: ${banner.stateKind} ${banner.stateMode}`);
    await vscode.commands.executeCommand('zenwave.eventflow.openToSide', await fixture('lsp/checkout.zfl'));
    const fresh = await waitFor(() => eventflow.editorsFor((vscode.Uri.joinPath(placeOrderUri, '..', 'lsp', 'checkout.zfl')).toString())[0], 'No diagram for checkout.zfl', 30000);
    await waitFor(() => fresh.session.page.kind === 'ready' && fresh.session.state?.kind === 'no-server', `A new diagram without a server: ${JSON.stringify(fresh.session.state)}`, 60000);
    const overlay = await waitFor(async () => { const probe = await fresh.probe(); return probe.stateKind === 'no-server' ? probe : undefined; }, 'The page does not show the no-server state', 15000);
    assert(overlay.stateMode === 'overlay' && overlay.nodeIds.length === 0 && fresh.session.state?.actions.some((action) => action.command === 'zenwave.lsp.showStatus'),
      `No-server without a diagram: ${JSON.stringify(fresh.session.state)}`);
    console.log('PASS: with the server stopped, an open diagram keeps its drawing under a banner and a new one says it needs the language server');
  } finally {
    await settings.update('lsp.enabled', undefined, vscode.ConfigurationTarget.Workspace);
  }
  await connected(api, 'Re-enabled after the EventFlow check');
  await waitFor(() => diagram.session.state === null && diagram.session.data.kind === 'rendered', 'The diagram did not recover when the server returned', 60000);
  console.log('PASS: when the server returns the diagram renders again');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Desktop only: edits the copied manifest and configuration, and stops the server. */
async function explorerOnDisk(api: LanguageServerApi, explorer: ModelExplorerApi): Promise<void> {
  const { architecture, model } = explorer;
  await connected(api, 'Explorer on disk');
  await treeState(architecture, 'ready', 'Architecture tree before editing the manifest');
  const manifestUri = await fixture('zenwave-architecture.yml');
  const original = await vscode.workspace.fs.readFile(manifestUri);
  const text = new TextDecoder().decode(original);
  try {
    await vscode.workspace.fs.writeFile(manifestUri, new TextEncoder().encode(`${text}  billing:\n    services:\n      billing-api:\n        repository: "file:///workspace/billing-api"\n`));
    await waitFor(() => labels(roots(architecture)[0]?.children).includes('billing'), `A domain added to the manifest on disk did not appear: ${labels(roots(architecture)[0]?.children)}`, 30000);
  } finally {
    await vscode.workspace.fs.writeFile(manifestUri, original);
  }
  await waitFor(() => !labels(roots(architecture)[0]?.children).includes('billing'), 'The restored manifest still shows billing', 30000);
  console.log('PASS: saving a domain into the manifest shows it in the architecture tree, and removing it removes it');

  const checkout = await vscode.workspace.openTextDocument(await fixture('lsp/checkout.zfl'));
  await vscode.window.showTextDocument(checkout);
  await waitFor(() => model.documentUri === checkout.uri.toString(), 'Model tree did not follow checkout.zfl');
  await treeState(model, 'ready', 'Model tree before stopping the server');
  const settings = vscode.workspace.getConfiguration('zenwave');
  try {
    await settings.update('lsp.enabled', false, vscode.ConfigurationTarget.Workspace);
    await treeState(architecture, 'no-server', 'Architecture tree with the server stopped');
    await treeState(model, 'no-server', 'Model tree with the server stopped');
    assert(roots(architecture).length === 0 && roots(model).length === 0, 'Trees keep nodes with the server stopped');
  } finally {
    await settings.update('lsp.enabled', undefined, vscode.ConfigurationTarget.Workspace);
  }
  await connected(api, 'Re-enabled after the explorer check');
  await treeState(architecture, 'ready', 'Architecture tree after the server restarted');
  await treeState(model, 'ready', 'Model tree after the server restarted');
  console.log('PASS: with the server stopped both trees say they need it, and repopulate when it returns');

  const config = await fixture('.zenwave/config.yml');
  const configText = await vscode.workspace.fs.readFile(config);
  try {
    await vscode.workspace.fs.delete(config);
    await waitFor(() => api.manifest.route === 'none', `Deleting .zenwave/config.yml did not unresolve the manifest: ${JSON.stringify(api.manifest)}`);
    await connected(api, 'Restarted without a manifest');
    await treeState(architecture, 'no-manifest', 'Architecture tree without a manifest');
    assert(roots(architecture).length === 0, 'Architecture tree has nodes without a manifest');
    await treeState(model, 'ready', 'Model tree without a manifest');
    assert(model.documentUri === checkout.uri.toString() && node(model, 'Orders', 'system'), 'Model tree stopped working without a manifest');
  } finally {
    await vscode.workspace.fs.writeFile(config, configText);
  }
  await waitFor(() => api.manifest.route === 'config', 'Restored .zenwave/config.yml was not resolved');
  await connected(api, 'Restarted with the manifest restored');
  await treeState(architecture, 'ready', 'Architecture tree with the manifest restored');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('PASS: without a manifest the architecture tree says so while the model tree keeps working');
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
    [sdk, 'extraArgs', ['--smoke-delay=1500']], [terminal, profileKey, { path: configuration.shell }],
  ];
  const saved = settings.map(([section, key]) => section.inspect(key)?.workspaceValue);
  const opened: vscode.Terminal[] = [];
  const openedCount = (): number => opened.length;
  let started = 0;
  const subscriptions = [
    vscode.window.onDidOpenTerminal((value) => opened.push(value)),
    vscode.tasks.onDidStartTask((event) => { if (event.execution.task.definition.type === 'zenwave-sdk') started++; }),
  ];
  const firstOffset = document.getText().indexOf('FirstPlugin');
  const secondOffset = document.getText().indexOf('FirstPlugin', firstOffset + 1);
  assert(firstOffset >= 0 && secondOffset > firstOffset, 'Duplicate FirstPlugin fixtures were not found');
  const request = { uri: document.uri.toString(), plugin: 'FirstPlugin', offset: firstOffset };
  const secondRequest = { uri: document.uri.toString(), plugin: 'FirstPlugin', offset: secondOffset };
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
    assert(openedCount() === terminalsBefore, 'Refused Run opened a terminal');
  }
  async function runTogether(requests: readonly { uri: string; plugin: string; offset: number }[]): Promise<void> {
    let ended = 0;
    let failure: Error | undefined;
    let taskEnded: vscode.Disposable | undefined;
    let processEnded: vscode.Disposable | undefined;
    const complete = new Promise<void>((resolve, reject) => {
      processEnded = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution.task.definition.type !== 'zenwave-sdk') return;
        if (event.exitCode !== undefined && event.exitCode !== 0) {
          failure = new Error(`Fixture SDK exited ${event.exitCode}`);
        }
      });
      taskEnded = vscode.tasks.onDidEndTask((event) => {
        if (event.execution.task.definition.type !== 'zenwave-sdk') return;
        if (++ended === requests.length) {
          if (failure) reject(failure); else resolve();
        }
      });
    });
    try {
      await Promise.all(requests.map((value) => bounded(
        vscode.commands.executeCommand('zenwave.sdk.run', value),
        'Parallel Run command did not return',
      )));
      const running = vscode.tasks.taskExecutions.filter(
        (execution) => execution.task.definition.type === 'zenwave-sdk',
      );
      assert(running.length === requests.length, 'Different commands must run at the same time');
      await bounded(complete, 'Parallel fixture SDK tasks did not finish');
    } finally {
      taskEnded?.dispose();
      processEnded?.dispose();
    }
  }
  try {
    for (const [section, key, value] of settings) await section.update(key, value, vscode.ConfigurationTarget.Workspace);
    assert(vscode.workspace.isTrusted, 'Desktop smoke workspace must be trusted');
    await runTogether([request, secondRequest]);
    const startsAfterParallel = started;
    assert(startsAfterParallel === 2 && openedCount() === 2,
      'Different commands from the same plugin type must open two task terminals');
    await runOnce();
    const startsAfterSameCommand = started;
    assert(startsAfterSameCommand === 3 && openedCount() === 2,
      'The same command must reuse its task terminal');
    const edit = new vscode.WorkspaceEdit();
    const offset = document.getText().indexOf('build/generated');
    assert(offset >= 0, 'Fixture option to edit was not found');
    edit.replace(document.uri, new vscode.Range(document.positionAt(offset),
      document.positionAt(offset + 'build/generated'.length)), 'build/edited');
    assert(await vscode.workspace.applyEdit(edit), 'Could not edit plugin option');
    await runOnce();
    const startedAfterEdit = started;
    const terminalsAfterEdit = openedCount();
    assert(startedAfterEdit === 4 && terminalsAfterEdit === 3, 'A different command must open a new terminal');
    await runOnce();
    const startedAfterRepeat = started;
    const terminalsAfterRepeat = openedCount();
    assert(startedAfterRepeat === 5 && terminalsAfterRepeat === 3,
      'The same command must reuse its terminal');
    const invocations = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(configUri, '..', 'sdk-invocations.json'),
    ))) as string[][];
    assert(invocations.length === 5, 'Only the five user Runs may invoke the fixture SDK');
    assert(invocations.filter((args) => args.includes('targetFolder=build/generated')).length === 2,
      'The original command must run twice');
    assert(invocations.filter((args) => args.includes('targetFolder=build/other')).length === 1,
      'The second same-type declaration must run its own command');
    assert(invocations.filter((args) => args.includes('targetFolder=build/edited')).length === 2,
      'The edited command must run twice');
    assert(invocations.every((args) => args.filter((argument) => argument === '--force').length === 1),
      'Every inheriting plugin command must contain the shared --force flag exactly once');
    await terminal.update(profileKey, { path: configuration.unsupportedShell }, vscode.ConfigurationTarget.Workspace);
    await refuses();
    await terminal.update(profileKey, { path: configuration.shell }, vscode.ConfigurationTarget.Workspace);
    await sdk.update('cliCommand', 'definitely-not-a-zenwave-smoke-executable', vscode.ConfigurationTarget.Workspace);
    await refuses();
    await authoring();
    assert(startedAfterRepeat === 5 && started === startedAfterRepeat, 'Authoring with a missing SDK started a task');
    console.log('PASS: different same-plugin commands run concurrently; different command opens a new terminal, same command reuses it; unsupported shell and missing executable start no task');
  } finally {
    subscriptions.forEach((value) => value.dispose());
    for (let index = 0; index < settings.length; index++) {
      const [section, key] = settings[index]!;
      await section.update(key, saved[index], vscode.ConfigurationTarget.Workspace);
    }
    opened.forEach((value) => value.dispose());
  }
}

const editorCount = (api: PreviewApi): number => api.editors.length;

const PREVIEW_COMMANDS = ['zenwave.preview.open', 'zenwave.preview.openToSide', 'zenwave.preview.showText', 'zenwave.preview.selectDiagram', 'zenwave.preview.selectRenderMode'];

const isPreviewTab = (tab: vscode.Tab | undefined, uri: string): boolean =>
  tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === 'zenwave.preview' && tab.input.uri.toString() === uri;

const baseName = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

/** What the server answers for a document right now (the reference the page is compared with). */
async function serverPreview(api: LanguageServerApi, uri: string, mode?: 'ALT_BLOCKS' | 'SEPARATE_VARIANTS'): Promise<Preview> {
  return waitFor(async () => {
    const result = await api.requests.preview(uri, mode);
    return result.kind === 'ok' ? result.value : undefined;
  }, `zenwave/preview did not answer for ${uri}`, 30000);
}

/** The preview for a document once its page said it loaded and drew its selected diagram, with no violation of the page's policy. */
async function renderedPreview(preview: PreviewApi, uri: string): Promise<PreviewEditorApi> {
  const editor = await waitFor(() => preview.editorsFor(uri)[0], `No preview editor for ${uri}`, 30000);
  await waitFor(() => editor.session.page.kind === 'ready' ? true : editor.session.page.kind === 'failed' ? (() => { throw new Error(`Preview page failed: ${JSON.stringify(editor.session.page)}`); })() : undefined,
    `The preview page never said it loaded for ${uri}: ${JSON.stringify(editor.session.page)}`, 60000);
  const probe = await waitFor(async () => {
    const answer = await editor.probe().catch(() => undefined);
    return answer && answer.svgCount > 0 && answer.renderedId === editor.session.selectedId ? answer : undefined;
  }, `The preview drew nothing for ${uri}: ${JSON.stringify(editor.session.state)} ${JSON.stringify(editor.session.data)}`, 90000);
  assert(probe.cspViolations.length === 0, `The preview page reported content security policy violations: ${probe.cspViolations.join('; ')}`);
  assert(probe.strayElements === 0, `Mermaid left ${probe.strayElements} elements in the page`);
  return editor;
}

async function drawing(editor: PreviewEditorApi, id: string, hash: string, message: string): Promise<PreviewProbe> {
  return waitFor(async () => {
    const probe = await editor.probe().catch(() => undefined);
    return probe && probe.renderedId === id && probe.renderedHash === hash && probe.svgCount === 1 && probe.notice === undefined ? probe : undefined;
  }, message, 60000);
}

/** 005 model preview against the real server, the real page and the bundled Mermaid, in both hosts. Writes nothing to disk. */
async function previewModels(api: LanguageServerApi, preview: PreviewApi, desktop: boolean): Promise<void> {
  await connected(api, 'Model previews');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const commands = await vscode.commands.getCommands(true);
  for (const command of PREVIEW_COMMANDS) assert(commands.includes(command), `${command} was not registered`);
  const checkoutUri = await fixture('lsp/checkout.zfl');
  const checkout = checkoutUri.toString();
  const ordersUri = await fixture('lsp/orders.zdl');
  const orders = ordersUri.toString();
  const completeUri = await fixture('complete.zdl');
  const complete = completeUri.toString();

  // 005/7.2: opening a model the ordinary way gives the text editor, never the preview.
  for (const [uri, name] of [[ordersUri, orders], [checkoutUri, checkout]] as const) {
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(() => isTextTab(vscode.window.tabGroups.activeTabGroup.activeTab, name), `Opening ${name} did not give the text editor`, 10000);
  }
  assert(editorCount(preview) === 0, 'Opening a model file opened a preview');
  console.log('PASS: opening a .zdl or .zfl file gives the text editor, not the preview');

  // MP-R1 beside, a ZFL flow: the preview opens in the next column, named for its document, with focus staying in the text.
  const checkoutText = await vscode.workspace.openTextDocument(checkoutUri);
  await vscode.window.showTextDocument(checkoutText, { viewColumn: vscode.ViewColumn.One, preview: false });
  const beside = await vscode.commands.executeCommand<PreviewOpenOutcome>('zenwave.preview.openToSide');
  assert(beside.kind === 'opened' && beside.documentUri === checkout, `openToSide: ${JSON.stringify(beside)}`);
  const flow = await renderedPreview(preview, checkout);
  const flowTab = allTabs().find((tab) => isPreviewTab(tab, checkout));
  assert(flowTab && flowTab.group.viewColumn === vscode.ViewColumn.Two, `The preview is not in the column beside: ${flowTab?.group.viewColumn}`);
  assert(flowTab.label === 'checkout.zfl', `The preview tab does not name its document: ${flowTab.label}`);
  assert(isTextTab(vscode.window.tabGroups.activeTabGroup.activeTab, checkout), 'Focus left the text editor when the preview opened beside it');
  console.log('PASS: the preview opens beside the text, named for its document, and focus stays in the text');

  // 005/7.3: the representations are the server's, in its order and under its titles, starting on its default; each one draws.
  const alt = await serverPreview(api, checkout);
  assert(alt.representations.length >= 3 && alt.representations[0]!.id === 'flowchart', `Unexpected ZFL representations: ${alt.representations.map((item) => item.id).join()}`);
  let probe = await flow.probe();
  assert(probe.diagramSelector.visible && probe.diagramSelector.options.map((option) => option.label).join('|') === alt.representations.map((item) => item.title).join('|'),
    `Diagram selector: ${JSON.stringify(probe.diagramSelector)} vs ${alt.representations.map((item) => item.title).join('|')}`);
  assert(probe.diagramSelector.options.map((option) => option.value).join() === alt.representations.map((item) => item.id).join(), 'The selector order is not the server order');
  assert(probe.diagramSelector.value === alt.defaultRepresentationId && alt.defaultRepresentationId !== 'flowchart', `The preview did not start on the default: ${probe.diagramSelector.value}`);
  assert(probe.renderModeSelector.visible && probe.renderModeSelector.value === 'ALT_BLOCKS' && probe.renderModeSelector.options.join('|') === 'Alt blocks|Separate variants', `Render mode selector: ${JSON.stringify(probe.renderModeSelector)}`);
  assert(probe.scripts.map(baseName).sort().join() === 'mermaid.min.js,preview.js', `Scripts the page loaded: ${probe.scripts.join()}`);
  assert(probe.mermaidLoaded && probe.scripts.every((src) => src.includes('/dist/preview-webview/')), `A script did not come from the extension's preview-webview directory: ${probe.scripts.join()}`);
  for (const item of alt.representations) {
    assert(await vscode.commands.executeCommand<PreviewSelectOutcome>('zenwave.preview.selectDiagram', { documentUri: checkout, representationId: item.id }).then((outcome) => outcome.kind === 'selected'), `Could not select ${item.id}`);
    const drawn = await drawing(flow, item.id, contentHash(item.content), `${item.title} was not drawn`);
    assert(drawn.text.trim().length > 0 && drawn.renderedTheme !== undefined, `${item.title} drew no text`);
  }
  await vscode.commands.executeCommand('zenwave.preview.selectDiagram', { documentUri: checkout, representationId: alt.defaultRepresentationId });
  console.log(`PASS: the ZFL preview offers the server's ${alt.representations.length} representations in its order and titles, starts on its default, and draws each one with the bundled Mermaid`);

  // A ZDL model: the server's Markdown page, rendered, its diagrams drawn, and no selector for a single representation (MP-R10, MP-R15).
  await vscode.commands.executeCommand('zenwave.preview.openToSide', ordersUri);
  const model = await renderedPreview(preview, orders);
  const ordersAnswer = await serverPreview(api, orders);
  const page = ordersAnswer.representations[0]!;
  assert(ordersAnswer.representations.length === 1 && page.format === 'MARKDOWN', `The ZDL answer is not one Markdown page: ${ordersAnswer.representations.map((item) => `${item.id}:${item.format}`).join()}`);
  const fences = (page.content.match(/^```mermaid$/gm) ?? []).length;
  assert(fences >= 1, 'The ZDL page has no diagram');
  probe = await waitFor(async () => {
    const answer = await model.probe().catch(() => undefined);
    return answer && answer.renderedHash === contentHash(page.content) && answer.content.diagrams.drawn === fences ? answer : undefined;
  }, 'The ZDL page was not drawn with its diagrams', 60000);
  assert(!probe.diagramSelector.visible && !probe.renderModeSelector.visible, `A selector with no choice is shown: ${JSON.stringify([probe.diagramSelector.visible, probe.renderModeSelector.visible])}`);
  assert(probe.text.includes('Customer') && probe.content.headings > 0 && probe.notice === undefined, `The Markdown page does not read as a page: ${probe.text.slice(0, 200)}`);
  assert(probe.content.diagrams.failed === 0 && probe.svgCount === fences, `Diagrams: ${JSON.stringify(probe.content.diagrams)} svg=${probe.svgCount} of ${fences}`);
  assert(probe.content.fragments.length > 0 && probe.content.unresolved.length === 0, `Anchors of the page that do not resolve: ${probe.content.unresolved.join()}`);
  assert(probe.content.hostile === 0 && probe.content.remoteImages === 0 && probe.cspViolations.length === 0, `Unsafe content or policy violations: ${JSON.stringify(probe.content)} ${probe.cspViolations.join()}`);
  assert(probe.scripts.map(baseName).sort().join() === 'content.js,mermaid.min.js,preview.js', `Scripts the ZDL page loaded: ${probe.scripts.join()}`);
  console.log(`PASS: a ZDL preview renders the server's Markdown page with its ${fences} diagram(s) drawn, every anchor resolving, and no selector`);

  // 005/7.5: two models previewed at once, each keeping its own document; asking again reveals rather than duplicates (MP-R1, MP-R3).
  assert(editorCount(preview) === 2 && preview.editorsFor(checkout).length === 1 && preview.editorsFor(orders).length === 1, 'Two previews are not two editors');
  const groups = vscode.window.tabGroups.all.length;
  for (const uri of [checkoutUri, ordersUri]) {
    const again = await vscode.commands.executeCommand<PreviewOpenOutcome>('zenwave.preview.openToSide', uri);
    assert(again.kind === 'opened', `A second request: ${JSON.stringify(again)}`);
  }
  assert(editorCount(preview) === 2 && allTabs().filter((tab) => isPreviewTab(tab, checkout)).length === 1 && allTabs().filter((tab) => isPreviewTab(tab, orders)).length === 1 &&
    vscode.window.tabGroups.all.length === groups, `Asking again opened another preview: ${allTabs().map((tab) => tab.label).join()}`);
  assert(flow.session.state === null && model.session.state === null && flow.documentUri === checkout && model.documentUri === orders, 'The two previews do not keep their own document');
  const [flowProbe, modelProbe] = [await flow.probe(), await model.probe()];
  assert(flowProbe.renderedHash !== modelProbe.renderedHash && flowProbe.renderedId === alt.defaultRepresentationId, 'The two previews do not show their own diagrams');
  console.log('PASS: two models previewed at once keep their own document and diagram, and asking again reveals the existing preview');

  // 005/7.8: with a preview focused there is no active text editor, and a command still finds the document through the tab.
  await vscode.commands.executeCommand('vscode.openWith', ordersUri, 'zenwave.preview', { viewColumn: vscode.ViewColumn.Two });
  await waitFor(() => isPreviewTab(vscode.window.tabGroups.activeTabGroup.activeTab, orders), 'The orders preview is not the active tab', 10000);
  for (const command of ['zenwave.preview.openToSide', 'zenwave.preview.open']) {
    const fromTab = await vscode.commands.executeCommand<PreviewOpenOutcome>(command);
    assert(fromTab.kind === 'opened' && fromTab.documentUri === orders && preview.editorsFor(orders).length === 1,
      `${command} without an argument did not find the preview's document: ${JSON.stringify(fromTab)}`);
  }
  console.log('PASS: with no active text editor, the preview commands resolve the model document from the focused preview tab');

  // MP-R2, 005/7.4: in place, the preview takes the text tab's position; Reopen Editor With... and Show Model Text give the text back there.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(completeUri), { viewColumn: vscode.ViewColumn.One, preview: false });
  const groupOne = (): vscode.TabGroup => vscode.window.tabGroups.all.find((group) => group.viewColumn === vscode.ViewColumn.One)!;
  const textIndex = groupOne().tabs.findIndex((tab) => isTextTab(tab, complete));
  assert(textIndex >= 0, 'complete.zdl text tab not found');
  const inPlace = await vscode.commands.executeCommand<PreviewOpenOutcome>('zenwave.preview.open', completeUri);
  assert(inPlace.kind === 'opened', `open in place: ${JSON.stringify(inPlace)}`);
  await renderedPreview(preview, complete);
  await waitFor(() => groupOne().tabs.findIndex((tab) => isPreviewTab(tab, complete)) === textIndex && !groupOne().tabs.some((tab) => isTextTab(tab, complete)),
    `The in-place preview did not take the text tab's position ${textIndex}: ${groupOne().tabs.map((tab) => tab.label).join()}`, 10000);
  if ((await vscode.commands.getCommands(true)).includes('workbench.action.reopenTextEditor')) {
    await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
    await waitFor(() => isTextTab(vscode.window.tabGroups.activeTabGroup.activeTab, complete) && groupOne().tabs.findIndex((tab) => isTextTab(tab, complete)) === textIndex,
      `Reopen with the text editor did not give the text back in place: ${groupOne().tabs.map((tab) => tab.label).join()}`, 10000);
    await vscode.commands.executeCommand('zenwave.preview.open', completeUri);
    await renderedPreview(preview, complete);
    console.log('PASS: VS Code\'s reopen-with-text returns to the text in place, and the preview opens in place again');
  }
  const back = await vscode.commands.executeCommand<PreviewOpenOutcome>('zenwave.preview.showText', completeUri);
  assert(back.kind === 'opened', `showText: ${JSON.stringify(back)}`);
  await waitFor(() => groupOne().tabs.findIndex((tab) => isTextTab(tab, complete)) === textIndex && !groupOne().tabs.some((tab) => isPreviewTab(tab, complete)),
    `Going back to the text did not keep the position: ${groupOne().tabs.map((tab) => tab.label).join()}`, 10000);
  await waitFor(() => preview.editorsFor(complete).length === 0, 'The replaced preview editor was not disposed');
  console.log('PASS: the in-place preview takes the text tab\'s position, and Show Model Text gives the text back at the same position');

  // An untitled buffer is not offered a preview; the command says to save it first (MP-Q4).
  const untitled = await vscode.workspace.openTextDocument({ language: 'zdl', content: 'entity Draft {\n  name String\n}\n' });
  await vscode.window.showTextDocument(untitled, { viewColumn: vscode.ViewColumn.One, preview: false });
  const refused = await vscode.commands.executeCommand<PreviewOpenOutcome>('zenwave.preview.openToSide');
  assert(refused.kind === 'untitled' && editorCount(preview) === 2, `An untitled buffer: ${JSON.stringify(refused)}`);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  console.log('PASS: an untitled model is not previewed, and the command says to save it first');

  await editsAndChoices(api, flow, alt);
  await rendersWhateverItIsGiven(flow);
  if (desktop) await previewTheme(flow, model);
  await previewStates(api, preview);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => editorCount(preview) === 0, 'Closing all editors left previews registered');
}

/** 005/7.9, 7.10, MP-R5, MP-R11, MP-R12: the preview follows edits without blanking, and keeps what the user chose. */
async function editsAndChoices(api: LanguageServerApi, flow: PreviewEditorApi, alt: Preview): Promise<void> {
  const checkout = flow.documentUri;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(checkout));
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  const endLine = document.getText().split('\n').findIndex((line) => line.trim() === 'end {');
  assert(endLine > 0, 'checkout.zfl has no end block');
  const column = (): string => allTabs().filter((tab) => isPreviewTab(tab, checkout)).map((tab) => tab.group.viewColumn).join();
  assert(column() === String(vscode.ViewColumn.Two), `Unexpected column before editing: ${column()}`);

  // Typing: the preview follows without an empty state, in few requests, keeping the diagram the user chose.
  await vscode.commands.executeCommand('zenwave.preview.selectDiagram', { documentUri: checkout, representationId: 'flowchart' });
  const before = await drawing(flow, 'flowchart', contentHash(alt.representations[0]!.content), 'The flowchart was not drawn');
  const states: string[] = [];
  const watch = setInterval(() => { states.push(flow.session.state?.mode ?? 'none'); }, 20);
  const text = '    when OrderCreated do smokeAuditOrder {\n        service Orders.OrderService\n        emits OrderAudited\n    }\n\n';
  try {
    let offset = document.offsetAt(new vscode.Position(endLine, 0));
    const requestsBefore = flow.session.requests;
    for (const character of text) {
      await editor.edit((edit) => edit.insert(document.positionAt(offset), character));
      offset += character.length;
    }
    await waitFor(() => flow.session.representations[0]?.content.includes('smokeAuditOrder') ? true : undefined, 'The typed command did not reach the preview', 30000);
    const typedRequests = flow.session.requests - requestsBefore;
    assert(typedRequests < text.length / 4, `${text.length} keystrokes caused ${typedRequests} zenwave/preview requests`);
    const latest = await serverPreview(api, checkout);
    const drawn = await drawing(flow, 'flowchart', contentHash(latest.representations[0]!.content), 'The page did not draw the latest flowchart');
    assert(drawn.renderedHash !== before.renderedHash && drawn.renderedId === 'flowchart', 'The preview did not change with the text');
    console.log(`PASS: ${text.length} keystrokes caused ${typedRequests} zenwave/preview request(s), and the flowchart drawn is the last text typed`);

    // A declaration briefly incomplete: the last good drawing stays, under a banner, never an overlay.
    await editor.edit((edit) => edit.insert(new vscode.Position(endLine, 0), '    when {{ do\n'));
    await waitFor(() => flow.session.data.kind !== 'rendered' ? true : undefined, `A broken flow was not reported: ${JSON.stringify(flow.session.data)}`, 30000);
    const kept = await flow.probe();
    assert(flow.session.data.kind === 'unreadable' && kept.stateKind === 'unreadable' && kept.stateMode === 'banner' && kept.svgCount === 1 && kept.renderedHash === drawn.renderedHash,
      `The last good preview was not kept under a banner: ${flow.session.data.kind} ${kept.stateKind} ${kept.stateMode} ${kept.svgCount}`);
    await editor.edit((edit) => edit.delete(new vscode.Range(endLine, 0, endLine + 1, 0)));
    await waitFor(() => flow.session.state === null && flow.session.data.kind === 'rendered', 'The preview did not recover when the flow was fixed', 30000);
  } finally {
    clearInterval(watch);
  }
  assert(!states.includes('overlay'), `An empty state flashed while editing: ${[...new Set(states)].join()}`);
  assert(column() === String(vscode.ViewColumn.Two) && isTextTab(vscode.window.tabGroups.activeTabGroup.activeTab, checkout), 'Re-rendering moved the preview or took the focus');
  console.log('PASS: a broken flow keeps the last drawing under a banner and the preview recovers; it never moved or took focus while following the edits');

  // 005/7.10: choose a sequence, keep editing: the choice holds, and the page redraws only what changed.
  const server = await serverPreview(api, checkout);
  const rejected = server.representations.find((item) => outcomeOf(item.id) === 'rejected');
  assert(rejected, `No rejected outcome offered: ${server.representations.map((item) => item.id).join()}`);
  await vscode.commands.executeCommand('zenwave.preview.selectDiagram', { documentUri: checkout, representationId: rejected.id });
  await drawing(flow, rejected.id, contentHash(rejected.content), 'The rejected sequence was not drawn');
  const requests = flow.session.requests;
  await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '\n'));
  await waitFor(() => flow.session.requests > requests ? true : undefined, 'A blank line did not reach the preview', 30000);
  await flow.settled();
  assert(flow.session.selectedId === rejected.id && (await flow.probe()).renderedId === rejected.id, `The choice did not hold while editing: ${flow.session.selectedId}`);
  console.log('PASS: the chosen sequence holds while editing');

  // MP-R11, MP-R12: another render mode asks the server again, and the same outcome stays selected under the id the new mode gave it.
  const asked = flow.session.requests;
  const mode = await vscode.commands.executeCommand<PreviewSelectOutcome>('zenwave.preview.selectRenderMode', { documentUri: checkout, renderMode: 'SEPARATE_VARIANTS' });
  assert(mode.kind === 'selected', `selectRenderMode: ${JSON.stringify(mode)}`);
  await waitFor(() => flow.session.requests > asked && flow.session.data.kind === 'rendered' ? true : undefined, 'Changing the render mode did not ask the server again', 30000);
  const separate = await serverPreview(api, checkout, 'SEPARATE_VARIANTS');
  const kept = flow.session.selectedId;
  assert(kept !== undefined && separate.representations.some((item) => item.id === kept) && outcomeOf(kept) === 'rejected', `The outcome did not survive the mode change: ${kept} in ${separate.representations.map((item) => item.id).join()}`);
  const separateProbe = await waitFor(async () => {
    const answer = await flow.probe();
    return answer.renderModeSelector.value === 'SEPARATE_VARIANTS' && answer.diagramSelector.options.map((option) => option.label).join('|') === separate.representations.map((item) => item.title).join('|') ? answer : undefined;
  }, 'The selectors do not show the server answer for the separate variants', 30000);
  assert(separateProbe.diagramSelector.value === kept, `The diagram selector does not show ${kept}: ${separateProbe.diagramSelector.value}`);
  await vscode.commands.executeCommand('zenwave.preview.selectRenderMode', { documentUri: checkout, renderMode: 'ALT_BLOCKS' });
  await waitFor(() => flow.session.renderMode === 'ALT_BLOCKS' && flow.session.data.kind === 'rendered' && flow.session.representations.length === server.representations.length ? true : undefined, 'Going back to alt blocks did not ask again', 30000);
  assert(flow.session.selectedId !== undefined && outcomeOf(flow.session.selectedId) === 'rejected', `The outcome did not survive the way back: ${flow.session.selectedId}`);
  console.log(`PASS: changing the render mode asks the server again with the new mode, and the rejected outcome stays selected (${rejected.id} → ${kept})`);

  await vscode.commands.executeCommand('workbench.action.files.revert');
  await waitFor(() => !document.isDirty, 'Could not revert checkout.zfl');
  await waitFor(() => flow.session.data.kind === 'rendered' ? true : undefined, 'The preview did not follow the revert');
}

/** 005/5.1, 5.3, 5.5: Markdown and HTML are sanitised; a diagram that cannot be drawn reports itself and leaves the rest readable; other formats are named, not shown. */
async function rendersWhateverItIsGiven(flow: PreviewEditorApi): Promise<void> {
  await flow.settled();
  const good = flow.session.representations.find((item) => item.id === flow.session.selectedId)!;
  const filler = Array.from({ length: 120 }, (_, index) => `Paragraph ${index} of filler text, so the page can scroll.`).join('\n\n');
  const markdownText = [
    '# Orders', '',
    '[Last section](#last-section) and [out](https://remote.invalid/page) and [again](#orders-1)', '',
    '![remote](https://remote.invalid/pic.png)', '',
    '<script>window.__pwned = 1</script>', '',
    '<img src="https://remote.invalid/raw.png" onerror="window.__pwned = 1">', '',
    '```mermaid', '---', 'config:', '  theme: forest', '---', 'flowchart LR', '  a --> b', '```', '',
    '```mermaid', 'this is not a diagram', '  ???', '```', '',
    '```mermaid', 'flowchart LR', '  c --> d', '```', '',
    '| a | b |', '|---|---|', '| 1 | `2` |', '',
    filler, '', '## Last section', '', 'The end.', '',
    filler, '', '## Orders', '', 'Again.', '',
  ].join('\n');
  const hostileHtml = '<p onclick="window.__pwned = 1" style="color:red">zzmarker</p><script>window.__pwned = 1</script><iframe src="https://remote.invalid/f"></iframe>' +
    '<form action="https://remote.invalid/p"><input name="x"></form><img src="https://remote.invalid/p.png" srcset="https://remote.invalid/p2.png">' +
    '<a href="https://remote.invalid/x">out</a><a href="#zzmarker">in</a><h2 id="zzmarker">Marked</h2><table><tr><td>cell</td></tr></table>';
  const items = [
    { id: 'broken', title: 'Broken', format: 'MERMAID', content: 'this is not a diagram\n  ???' },
    { id: 'doc', title: 'Markdown page', format: 'MARKDOWN', content: markdownText },
    { id: 'page', title: 'HTML page', format: 'HTML', content: hostileHtml },
    { id: 'other', title: 'Other', format: 'ASCIIDOC', content: '= Title' },
    good,
  ];
  const send = (selectedId: string, list: readonly unknown[] = items): Thenable<boolean> =>
    flow.panel.webview.postMessage({ type: 'zenwave.preview.render', payload: { representations: list, selectedId, renderMode: 'ALT_BLOCKS', showRenderMode: true } });
  const show = async (selectedId: string): Promise<PreviewProbe> => {
    await send(selectedId);
    let last: PreviewProbe | undefined;
    try {
      return await waitFor(async () => {
        const probe = last = await flow.probe();
        const shown = selectedId === 'broken' || selectedId === 'other' ? probe.notice !== undefined : probe.renderedId === selectedId;
        return probe.diagramSelector.value === selectedId && shown ? probe : undefined;
      }, `${selectedId} was not shown`, 30000);
    } catch (error) {
      throw new Error(`${String(error)}: ${JSON.stringify(last && { ...last, text: last.text.slice(0, 300) })}`);
    }
  };
  const broken = await show('broken');
  assert(/could not be drawn/.test(broken.notice ?? '') && broken.text.includes('this is not a diagram') && broken.svgCount === 0, `A malformed diagram: ${broken.notice}`);
  assert(broken.diagramSelector.options.length === items.length && broken.diagramSelector.visible, 'The rest is not readable: the selector is gone');
  assert(broken.strayElements === 0, `A malformed diagram left ${broken.strayElements} elements in the page`);

  // Markdown: rendered, three fenced diagrams each on its own (frontmatter included, one malformed), nothing hostile, no request.
  const markdown = await show('doc');
  assert(markdown.content.diagrams.drawn === 2 && markdown.content.diagrams.failed === 1 && markdown.svgCount === 2, `Fenced diagrams: ${JSON.stringify(markdown.content.diagrams)} svg=${markdown.svgCount}`);
  assert(markdown.text.includes('This diagram could not be drawn') && markdown.text.includes('this is not a diagram') && markdown.text.includes('The end.') && markdown.content.tables === 1,
    `A malformed block did not report itself in place, or the rest is unreadable: ${markdown.text.slice(0, 300)}`);
  assert(markdown.notice === undefined && markdown.strayElements === 0, `Markdown: ${markdown.notice} strays=${markdown.strayElements}`);
  assert(markdown.content.hostile === 0 && markdown.content.remoteImages === 0 && markdown.text.includes('<script>window.__pwned = 1</script>'), `Markdown content is not safe: ${JSON.stringify(markdown.content)}`);
  assert(!markdown.content.resources.some((url) => url.includes('remote.invalid')) && markdown.cspViolations.length === 0, `A request left the page: ${markdown.content.resources.join()} ${markdown.cspViolations.join()}`);
  assert(markdown.content.otherLinks === 0 && markdown.content.fragments.join() === '#last-section,#orders-1' && markdown.content.unresolved.length === 0, `Links: ${JSON.stringify(markdown.content)}`);
  assert(markdown.diagramSelector.visible, 'The selector is not usable on a Markdown page');
  const followed = await flow.probe('#last-section');
  assert(followed.scrollTop > 0, `An anchor link did not scroll within the page: ${followed.scrollTop}`);
  const again = await flow.probe('#orders-1');
  assert(again.scrollTop > 0 && again.scrollTop !== followed.scrollTop, `The repeated heading's anchor did not resolve to the second heading: ${followed.scrollTop} then ${again.scrollTop}`);
  // An edit with the page left where it was: same representation, one more line, scroll kept (MP-R5).
  await send('doc', items.map((item) => item.id === 'doc' ? { ...item, content: `${markdownText}\nAnd one more line.\n` } : item));
  const kept = await waitFor(async () => { const probe = await flow.probe(); return probe.text.includes('And one more line.') ? probe : undefined; }, 'The edited Markdown was not shown', 30000);
  assert(kept.scrollTop === again.scrollTop && kept.content.diagrams.drawn === 2, `The edit moved the page: ${again.scrollTop} to ${kept.scrollTop}`);

  const html = await show('page');
  assert(html.text.includes('zzmarker') && html.text.includes('cell') && html.content.tables === 1, `HTML: ${html.text}`);
  assert(html.content.hostile === 0 && html.content.remoteImages === 0 && html.content.otherLinks === 0 && html.content.unresolved.length === 0, `HTML content is not safe: ${JSON.stringify(html.content)}`);
  assert(!html.content.resources.some((url) => url.includes('remote.invalid')) && html.cspViolations.length === 0, `A request left the page: ${html.content.resources.join()} ${html.cspViolations.join()}`);
  assert(html.svgCount === 0 && html.notice === undefined, `HTML: ${html.notice}`);
  const other = await show('other');
  assert(/ASCIIDOC format/.test(other.notice ?? '') && other.svgCount === 0 && !other.text.includes('Title'), `Another format: ${other.notice}`);
  const recovered = await show(good.id);
  await waitFor(async () => (await flow.probe()).svgCount === 1, 'The good diagram was not drawn after the others', 30000);
  assert(recovered.cspViolations.length === 0, `Policy violations: ${recovered.cspViolations.join('; ')}`);
  await flow.session.refresh();
  await waitFor(async () => (await flow.probe()).diagramSelector.options.length === flow.session.representations.length ? true : undefined, 'The page did not return to the server answer', 30000);
  console.log('PASS: Markdown and HTML are sanitised (nothing hostile, no request, no navigation) and anchors scroll; a malformed fenced diagram reports itself in place and the rest stays readable; an edit kept the scroll');
}

/** 005/7.11, 5.6: the preview follows a colour theme change while open. */
async function previewTheme(flow: PreviewEditorApi, model: PreviewEditorApi): Promise<void> {
  const workbench = vscode.workspace.getConfiguration('workbench');
  const saved = workbench.inspect<string>('colorTheme')?.globalValue;
  const pages: Partial<Record<'light' | 'dark', PreviewProbe>> = {};
  const flows: Partial<Record<'light' | 'dark', PreviewProbe>> = {};
  try {
    for (const [name, theme] of [['Default Light Modern', 'light'], ['Default Dark Modern', 'dark']] as const) {
      const renders = (await flow.probe()).renders;
      const modelRenders = (await model.probe()).renders;
      await workbench.update('colorTheme', name, vscode.ConfigurationTarget.Global);
      const probe = await waitFor(async () => {
        const answer = await flow.probe();
        return answer.theme === theme && answer.renderedTheme === theme && answer.svgCount === 1 && answer.renders > renders ? answer : undefined;
      }, `The preview did not follow the ${name} theme`, 30000);
      assert(probe.cspViolations.length === 0, `Policy violations after the theme change: ${probe.cspViolations.join('; ')}`);
      flows[theme] = probe;
      // The diagrams inside a Markdown page follow the theme too, each redrawn.
      const page = await waitFor(async () => {
        const answer = await model.probe();
        return answer.theme === theme && answer.renderedTheme === theme && answer.content.diagrams.drawn > 0 && answer.content.diagrams.failed === 0 && answer.renders > modelRenders ? answer : undefined;
      }, `The Markdown page did not follow the ${name} theme`, 30000);
      assert(page.cspViolations.length === 0 && page.content.unresolved.length === 0, `Markdown page after the theme change: ${page.cspViolations.join('; ')} ${page.content.unresolved.join()}`);
      pages[theme] = page;
    }
    // What the diagrams look like, not which theme was asked for. A fenced diagram that carries its own
    // theme (the server's class and state diagrams carry a light one so they stay readable) keeps it;
    // one without follows the editor.
    const content = model.session.representations.find((item) => item.id === model.session.selectedId)?.content ?? '';
    const fences = [...content.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((match) => /^---\r?\n[\s\S]*?\btheme:\s*\S+[\s\S]*?---/.test(match[1]!));
    const luminance = (colour: string): number => {
      const [r, g, b] = (colour.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number) as [number, number, number];
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const [light, dark] = [pages.light?.content.diagramColours ?? [], pages.dark?.content.diagramColours ?? []];
    assert(fences.length > 0 && light.length === fences.length && dark.length === fences.length, `Diagrams drawn: ${light.length} light, ${dark.length} dark, ${fences.length} fenced`);
    assert(fences.every(Boolean), `A diagram of the domain page has no theme of its own, so this check does not describe it: ${fences.join()}`);
    light.forEach((before, index) => {
      const after = dark[index]!;
      assert(before.inks.length > 0 && after.inks.length > 0, `Diagram ${index} has no text to measure`);
      assert(after.inks.every((ink) => luminance(ink) < 0.4), `Diagram ${index} with its own theme lost dark text on the dark page: ${after.inks.join()}`);
      assert(after.fills.length === 0 || after.fills.some((fill) => luminance(fill) > 0.6), `Diagram ${index} with its own theme lost its light fill on the dark page: ${after.fills.join()}`);
    });
    // A diagram with no theme of its own (the ZFL flowchart) follows the editor: its text changes colour and is light on the dark page.
    const flowSource = flow.session.representations.find((item) => item.id === flow.session.selectedId)?.content ?? '';
    assert(flowSource !== '' && !/\btheme:/.test(flowSource), 'The ZFL diagram carries a theme of its own, so it is not the diagram without one');
    const [flowLight, flowDark] = [flows.light?.content.diagramColours[0], flows.dark?.content.diagramColours[0]];
    assert(flowLight && flowDark && flowLight.inks.length > 0 && flowDark.inks.length > 0, 'The flowchart has no text to measure');
    assert(flowLight.inks.join() !== flowDark.inks.join(), `A diagram without a theme kept its text colour across the switch: ${flowLight.inks.join()}`);
    assert(flowLight.inks.some((ink) => luminance(ink) < 0.4) && flowDark.inks.some((ink) => luminance(ink) > 0.6), `Text of a diagram without a theme: light ${flowLight.inks.join()} dark ${flowDark.inks.join()}`);
    // The page the server wrote for a real module, recorded: a flowchart with a subgraph (front matter, no theme), class
    // diagrams, a state diagram. A relation with a multiplicity is added, as the server writes it for an embedded entity.
    const recorded = recordedDomainPage.result.representations[0]!.content;
    const multiplicity = ['', '```mermaid', '---', 'config:', '  theme: default', '  themeVariables:', '    lineColor: "#888888"', '    edgeLabelBackground: "#ffffff"', '---', 'classDiagram', '    class Order', '    class OrderItem', '    Order *-- "*" OrderItem : items', '```', ''].join('\n');
    const sampleSource = recorded + multiplicity;
    const sampleThemed = [...sampleSource.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((match) => /^---\r?\n[\s\S]*?\btheme:\s*default[\s\S]*?---/.test(match[1]!));
    const sample: Partial<Record<'light' | 'dark', PreviewProbe>> = {};
    for (const [name, theme] of [['Default Light Modern', 'light'], ['Default Dark Modern', 'dark']] as const) {
      await workbench.update('colorTheme', name, vscode.ConfigurationTarget.Global);
      await model.panel.webview.postMessage({ type: 'zenwave.preview.render', payload: { representations: [{ id: 'recorded', title: 'Recorded', format: 'MARKDOWN', content: sampleSource }], selectedId: 'recorded', renderMode: 'ALT_BLOCKS', showRenderMode: false } });
      sample[theme] = await waitFor(async () => {
        const answer = await model.probe();
        return answer.renderedId === 'recorded' && answer.theme === theme && answer.renderedTheme === theme && answer.content.diagrams.drawn === sampleThemed.length && answer.content.diagrams.failed === 0 ? answer : undefined;
      }, `The recorded page was not drawn in the ${name} theme`, 30000);
    }
    const [sampleLight, sampleDark] = [sample.light!.content.diagramColours, sample.dark!.content.diagramColours];
    assert(sampleThemed.includes(false) && sampleThemed.includes(true), `The recorded page does not mix diagrams with and without a theme: ${sampleThemed.join()}`);
    sampleThemed.forEach((themed, index) => {
      const [before, after] = [sampleLight[index]!, sampleDark[index]!];
      if (themed) {
        // `theme: default`: dark text on a light fill whatever the editor.
        assert(after.inks.length > 0 && after.inks.every((ink) => luminance(ink) < 0.4), `Diagram ${index} (${after.kind}) with theme: default lost its dark text on the dark page: ${after.inks.join()}`);
        assert(after.fills.length === 0 || after.fills.some((fill) => luminance(fill) > 0.6), `Diagram ${index} (${after.kind}) with theme: default lost its light fill on the dark page: ${after.fills.join()}`);
      } else {
        // No theme: the lines follow the editor, and a subgraph title keeps dark text on its light fill in both.
        assert(before.lines.length > 0 && before.lines.join() !== after.lines.join(), `Diagram ${index} (${after.kind}) without a theme kept its lines across the switch: ${before.lines.join()}`);
        assert(before.lines.some((line) => luminance(line) < 0.4) && after.lines.some((line) => luminance(line) > 0.6), `Lines of a diagram without a theme: light ${before.lines.join()} dark ${after.lines.join()}`);
        for (const probe of [before, after]) {
          assert(probe.clusterInks.length > 0 && probe.clusterInks.every((ink) => luminance(ink) < 0.4), `A subgraph title is not dark text: ${probe.clusterInks.join()}`);
          assert(probe.clusterFills.length > 0 && probe.clusterFills.every((fill) => luminance(fill) > 0.6), `A subgraph is not on a light fill: ${probe.clusterFills.join()}`);
        }
      }
    });
    // State diagram transitions are not Mermaid's #333 on the dark page.
    const states = sampleDark.filter((diagram) => diagram.kind === 'stateDiagram');
    assert(states.length > 0 && states.every((diagram) => diagram.lines.length > 0 && !diagram.lines.includes('rgb(51, 51, 51)') && diagram.lines.every((line) => luminance(line) > 0.4)),
      `State diagram transitions on the dark page: ${states.map((diagram) => diagram.lines.join()).join(' | ')}`);
    // Multiplicity labels sit on the page itself: the editor's text colour in both themes.
    const terminalsLight = sampleLight.flatMap((diagram) => diagram.terminals);
    const terminalsDark = sampleDark.flatMap((diagram) => diagram.terminals);
    assert(terminalsLight.length > 0 && terminalsLight.every((ink) => luminance(ink) < 0.4), `Multiplicity labels on the light page: ${terminalsLight.join()}`);
    assert(terminalsDark.length > 0 && terminalsDark.every((ink) => luminance(ink) > 0.6), `Multiplicity labels on the dark page: ${terminalsDark.join()}`);
    console.log('PASS: switching the colour theme with a preview open redraws the diagram and those of a Markdown page; a diagram without a theme of its own changes its text colour, one with its own keeps dark text on a light fill; on a recorded page state transitions and multiplicity labels read on the dark page and a subgraph title stays dark on its light fill');
  } finally {
    await workbench.update('colorTheme', saved, vscode.ConfigurationTarget.Global);
  }
}

/** 005/7.14, MP-R8, 005/5.4: with the server stopped, or a document it cannot read, the preview explains; Mermaid is not loaded for it. */
async function previewStates(api: LanguageServerApi, preview: PreviewApi): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const settings = vscode.workspace.getConfiguration('zenwave');
  const checkoutUri = await fixture('lsp/checkout.zfl');
  const checkout = checkoutUri.toString();
  const ordersUri = await fixture('lsp/orders.zdl');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(checkoutUri), { viewColumn: vscode.ViewColumn.One, preview: false });
  await vscode.commands.executeCommand('zenwave.preview.openToSide', checkoutUri);
  const open = await renderedPreview(preview, checkout);
  try {
    await settings.update('lsp.enabled', false, vscode.ConfigurationTarget.Workspace);
    await waitFor(() => open.session.state?.kind === 'no-server', `The open preview did not say it needs the server: ${JSON.stringify(open.session.state)}`, 30000);
    const banner = await waitFor(async () => { const probe = await open.probe(); return probe.stateKind === 'no-server' ? probe : undefined; }, 'The page does not show the no-server banner', 15000);
    assert(banner.stateMode === 'banner' && banner.svgCount === 1, `No-server with a preview on screen: ${banner.stateKind} ${banner.stateMode} ${banner.svgCount}`);
    await vscode.commands.executeCommand('zenwave.preview.openToSide', ordersUri);
    const fresh = await waitFor(() => preview.editorsFor(ordersUri.toString())[0], 'No preview for orders.zdl', 30000);
    await waitFor(() => fresh.session.page.kind === 'ready' && fresh.session.state?.kind === 'no-server', `A new preview without a server: ${JSON.stringify(fresh.session.state)}`, 60000);
    const overlay = await waitFor(async () => { const probe = await fresh.probe(); return probe.stateKind === 'no-server' ? probe : undefined; }, 'The page does not show the no-server state', 15000);
    assert(overlay.stateMode === 'overlay' && overlay.svgCount === 0 && fresh.session.state?.actions.some((action) => action.command === 'zenwave.lsp.showStatus'), `No-server without a diagram: ${JSON.stringify(fresh.session.state)}`);
    assert(!overlay.mermaidLoaded && overlay.scripts.every((src) => baseName(src) === 'preview.js'), `Mermaid was loaded for a preview with nothing to draw: ${overlay.scripts.join()}`);
    console.log('PASS: with the server stopped an open preview keeps its drawing under a banner, a new one says it needs the language server, and Mermaid stays unloaded until a diagram is drawn');
  } finally {
    await settings.update('lsp.enabled', undefined, vscode.ConfigurationTarget.Workspace);
  }
  await connected(api, 'Re-enabled after the preview check');
  await waitFor(() => open.session.state === null && open.session.data.kind === 'rendered' && preview.editorsFor(ordersUri.toString())[0]?.session.state === null, 'The previews did not recover when the server returned', 60000);
  await renderedPreview(preview, ordersUri.toString());
  console.log('PASS: when the server returns the previews draw again');

  // A document the server cannot read is its own message, with the problems in the output channel.
  const folder = vscode.workspace.workspaceFolders![0]!.uri;
  const brokenUri = vscode.Uri.joinPath(folder, 'smoke-unreadable.zfl');
  await vscode.workspace.fs.writeFile(brokenUri, new TextEncoder().encode('flow Broken {\n    when {{ do\n'));
  try {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(brokenUri), { viewColumn: vscode.ViewColumn.One, preview: false });
    await vscode.commands.executeCommand('zenwave.preview.openToSide', brokenUri);
    const broken = await waitFor(() => preview.editorsFor(brokenUri.toString())[0], 'No preview for the unreadable flow', 30000);
    await waitFor(() => broken.session.page.kind === 'ready' && broken.session.data.kind !== 'loading' ? true : undefined, `The unreadable flow got no answer: ${JSON.stringify(broken.session.data)}`, 60000);
    const unreadable = await waitFor(async () => { const probe = await broken.probe(); return probe.stateKind !== undefined ? probe : undefined; }, 'The page shows nothing for the unreadable flow', 15000);
    assert(broken.session.data.kind === 'unreadable' && unreadable.stateKind === 'unreadable' && unreadable.stateMode === 'overlay' && !unreadable.mermaidLoaded,
      `An unreadable flow: ${JSON.stringify(broken.session.data)} ${unreadable.stateKind} ${unreadable.stateMode}`);
    assert(broken.session.state?.title !== open.session.state?.title && broken.session.state?.kind !== 'no-server', 'Unreadable reads like a missing server');
    console.log('PASS: a flow the server cannot read says so, as a different message from a missing server');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(brokenUri);
  }
}


/** Desktop only: rewrites the copied fixture on disk with a preview open. */
async function previewOnDisk(api: LanguageServerApi, preview: PreviewApi): Promise<void> {
  await connected(api, 'Preview on disk');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const placeOrderUri = await fixture('place-order-flow.zfl');
  const placeOrder = placeOrderUri.toString();
  const original = await vscode.workspace.fs.readFile(placeOrderUri);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(placeOrderUri), vscode.ViewColumn.One);
  await vscode.commands.executeCommand('zenwave.preview.openToSide', placeOrderUri);
  const flow = await renderedPreview(preview, placeOrder);
  await vscode.commands.executeCommand('zenwave.preview.selectDiagram', { documentUri: placeOrder, representationId: 'flowchart' });
  try {
    const onDisk = new TextDecoder().decode(original).replace('    end {', '    when OrderCancelled do diskAuditOrder {\n        service OrdersCheckout.OrdersCheckoutService\n    }\n\n    end {');
    await vscode.workspace.fs.writeFile(placeOrderUri, new TextEncoder().encode(onDisk));
    await waitFor(() => flow.session.representations.find((item) => item.id === 'flowchart')?.content.includes('diskAuditOrder') ? true : undefined, 'A change on disk did not reach the preview', 30000);
    const changed = flow.session.representations.find((item) => item.id === 'flowchart')!;
    await drawing(flow, 'flowchart', contentHash(changed.content), 'The page did not draw the flowchart changed on disk');
    console.log('PASS: a change to the file on disk re-renders the preview');
  } finally {
    await vscode.workspace.fs.writeFile(placeOrderUri, original);
  }
  await waitFor(() => !flow.session.representations.find((item) => item.id === 'flowchart')?.content.includes('diskAuditOrder'), 'Restoring the file did not re-render the preview', 30000);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Runs in both the desktop extension host and the browser Web Worker host. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert(extension, `${EXTENSION_ID} was not installed in the test host`);

  await extension.activate();
  assert(extension.isActive, `${EXTENSION_ID} did not activate`);
  await sharedLspFoundation();
  const { languageServer: api, explorer, eventflow, preview } = extension.exports as ZenwaveExtensionApi;
  const desktop = vscode.env.uiKind === vscode.UIKind.Desktop;
  await explorerBeforeAnyDocument(api, explorer, desktop);
  await realLanguageServer(api, desktop);
  await modelActions(api);
  await explorerTrees(api, explorer, eventflow);
  await eventflowDiagrams(api, explorer, eventflow);
  if (desktop) await eventflowOnDisk(api, eventflow);
  await previewModels(api, preview, desktop);
  await previewZw(api, preview);
  if (desktop) await previewOnDisk(api, preview);
  if (desktop) await modelActionsOnDisk(api);
  if (desktop) await explorerOnDisk(api, explorer);
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
  assert(sdkLenses.length === (desktop ? 3 : 0), `Expected ${desktop ? 3 : 0} SDK lenses, got ${sdkLenses.length}`);
  if (desktop) {
    const requests = sdkLenses.map((lens) => lens.command?.arguments?.[0] as { plugin: string; offset: number });
    assert(requests.map((request) => request.plugin).sort().join(',') === 'FirstPlugin,FirstPlugin,SecondPlugin',
      'Lenses must cover every enabled plugin declaration, including duplicates');
    assert(new Set(requests.map((request) => request.offset)).size === 3,
      'Each same-type plugin lens must identify its own declaration');
  }
  console.log(`PASS: ${desktop ? 'desktop enabled-plugin' : 'browser absent'} CodeLens`);
  await authoring();
  if (desktop) await desktopRuns(plugins);
}

/** 005/3.4, 3.6, MP-R14, MP-R16: a `.zw` file previews its plugin configuration, described from the catalogue this client sent the server. */
async function previewZw(api: LanguageServerApi, preview: PreviewApi): Promise<void> {
  await connected(api, 'The .zw preview');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const uri = await fixture('lsp/scripts.zw');
  const name = uri.toString();
  const shipped = SHIPPED_CATALOGUE.plugins.find((plugin) => plugin.name === 'ZDLToOpenAPIPlugin');
  const shippedSummary = shipped?.summary;
  assert(shippedSummary, 'The shipped catalogue has no summary for ZDLToOpenAPIPlugin');

  // Opening it the ordinary way is still the text editor.
  await vscode.commands.executeCommand('vscode.open', uri);
  await waitFor(() => isTextTab(vscode.window.tabGroups.activeTabGroup.activeTab, name), 'Opening a .zw did not give the text editor', 10000);
  assert(editorCount(preview) === 0, 'Opening a .zw opened a preview');
  const document = await vscode.workspace.openTextDocument(uri);
  assert(document.languageId === 'zw', `scripts.zw has language ${document.languageId}`);

  // The preview is offered and renders the server's Markdown page, with the catalogue's description of each plugin it knows.
  const outcome = await vscode.commands.executeCommand<PreviewOpenOutcome>('zenwave.preview.openToSide');
  assert(outcome.kind === 'opened' && outcome.documentUri === name, `Preview of a .zw: ${JSON.stringify(outcome)}`);
  let editor = await renderedZwPreview(preview, name);
  const answer = await serverPreview(api, name);
  const page = answer.representations[0];
  assert(answer.representations.length === 1 && page?.id === 'configuration' && page.format === 'MARKDOWN' && page.title === 'Plugin configuration',
    `The .zw answer: ${answer.representations.map((item) => `${item.id}:${item.format}:${item.title}`).join()}`);
  let probe = await editor.probe();
  assert(!probe.diagramSelector.visible && !probe.renderModeSelector.visible && probe.svgCount === 0 && probe.notice === undefined,
    `A .zw page with a selector or a diagram: ${JSON.stringify(probe.diagramSelector)}`);
  assert(probe.text.includes('Resolved configuration') && probe.text.includes('Own configuration') && probe.text.includes('io.example.orders'),
    `The .zw page does not show the resolved configuration: ${probe.text.slice(0, 300)}`);
  assert(probe.text.includes(shippedSummary) && probe.text.includes(`Plugin descriptions come from the plugin catalogue: ${SHIPPED_CATALOGUE.source}`),
    'The .zw page does not describe the plugin from the catalogue');
  assert(probe.content.unresolved.length === 0 && probe.content.hostile === 0 && probe.cspViolations.length === 0,
    `The .zw page: ${JSON.stringify(probe.content)} ${probe.cspViolations.join()}`);
  console.log('PASS: a .zw file opens as text, and its preview renders the plugin configuration, resolved, described from the catalogue');

  // An edit re-renders it, unsaved (MP-R5).
  const text = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  const at = document.getText().indexOf('maxDepth 3');
  assert(at > 0, 'scripts.zw has no maxDepth option');
  const requests = editor.session.requests;
  try {
    await text.edit((edit) => edit.replace(new vscode.Range(document.positionAt(at), document.positionAt(at + 'maxDepth 3'.length)), 'maxDepth 7'));
    probe = await zwShowing(editor, (content) => content.includes('| maxDepth | 7 | plugin |') && !content.includes('| maxDepth | 3 |'), 'The edited .zw was not shown');
    assert(editor.session.requests > requests, 'The .zw preview did not follow the edit');
    console.log('PASS: an edit to the .zw text re-renders its preview');
  } finally {
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  await waitFor(() => !document.isDirty, 'Could not revert scripts.zw');
  await zwShowing(editor, (content) => content.includes('| maxDepth | 3 | plugin |'), 'The .zw preview did not follow the revert');

  // A title equal to a section name must not move the contents links: the link goes to the section (an H2 after the contents), not to the title (the H1).
  const titleAt = document.getText().indexOf('"Arcadia Editions - Orders Checkout scripts"');
  assert(titleAt > 0, 'scripts.zw has no title');
  try {
    await text.edit((edit) => edit.replace(new vscode.Range(document.positionAt(titleAt), document.positionAt(titleAt + '"Arcadia Editions - Orders Checkout scripts"'.length)), '"Configuration"'));
    await zwShowing(editor, (content) => content.startsWith('# Configuration') && content.includes('(#configuration-1)'), 'The .zw page did not show the title "Configuration"');
    const followedConfiguration = (await editor.probe('#configuration-1')).followed;
    assert(followedConfiguration?.tag === 'H2' && followedConfiguration.text.trim() === 'Configuration' && followedConfiguration.headingIndex > 1,
      `The contents link to Configuration went to ${JSON.stringify(followedConfiguration)}, not to the Configuration section`);
    console.log('PASS: with a .zw title equal to the Configuration section, the contents link leads to the section heading (H2), not the title');
  } finally {
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  await waitFor(() => !document.isDirty, 'Could not revert scripts.zw after the title edit');
  await zwShowing(editor, (content) => content.includes('# Arcadia Editions - Orders Checkout scripts'), 'The .zw preview did not follow the second revert');

  // The same for a ZDL whose title is a section of the domain page.
  const titledUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'lsp/titled.zdl');
  await vscode.workspace.fs.writeFile(titledUri, new TextEncoder().encode('config {\n    title "Aggregates"\n}\n\nentity Customer {\n    name String\n}\n\naggregate CustomerAggregate(Customer) {\n}\n'));
  try {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(titledUri), { viewColumn: vscode.ViewColumn.One, preview: false });
    const opened = await vscode.commands.executeCommand<PreviewOpenOutcome>('zenwave.preview.openToSide');
    assert(opened.kind === 'opened', `Preview of titled.zdl: ${JSON.stringify(opened)}`);
    const titled = await renderedZwPreview(preview, titledUri.toString());
    const domain = await zwShowing(titled, (content) => content.startsWith('# Aggregates') && content.includes('(#aggregates-1)'), 'The ZDL page did not show the title "Aggregates"');
    assert(domain.content.unresolved.length === 0, `Unresolved links: ${domain.content.unresolved.join()}`);
    const followedAggregates = (await titled.probe('#aggregates-1')).followed;
    assert(followedAggregates?.tag === 'H2' && followedAggregates.text.trim() === 'Aggregates' && followedAggregates.headingIndex > 1,
      `The contents link to Aggregates went to ${JSON.stringify(followedAggregates)}, not to the Aggregates section`);
    console.log('PASS: with a ZDL title equal to the Aggregates section, the contents link leads to the section heading (H2), not the title');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(titledUri, { useTrash: false });
  }
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  await vscode.commands.executeCommand('zenwave.preview.openToSide', uri);
  editor = await renderedZwPreview(preview, name);

  // The catalogue is the client's copy: another one, sent at initialisation, is the one the page describes (and its source is named).
  const marker = 'Smoke marker: this description came from the client catalogue';
  const sent = {
    ...SHIPPED_CATALOGUE_RAW,
    source: 'Smoke catalogue sent by the client',
    plugins: SHIPPED_CATALOGUE_RAW.plugins.map((plugin) => (plugin as { name?: string }).name === 'ZDLToOpenAPIPlugin' ? { ...(plugin as object), summary: marker } : plugin),
  };
  api.overridePluginCatalogue(() => sent);
  try {
    await api.restart();
    await connected(api, 'Restarted with another catalogue');
    probe = await waitFor(async () => {
      const answered = await editor.probe().catch(() => undefined);
      return answered && answered.text.includes(marker) ? answered : undefined;
    }, `The .zw page does not describe the plugin from the catalogue the client sent: ${editor.session.data.kind}`, 60000);
    assert(probe.text.includes('Plugin descriptions come from the plugin catalogue: Smoke catalogue sent by the client') && !probe.text.includes(shippedSummary), 'The page mixes catalogues');
    console.log("PASS: the .zw page describes the plugin from the catalogue the client sent at initialisation, not the server's own");

    // A catalogue that cannot be read must not stop the server: it starts, and uses its own copy.
    api.overridePluginCatalogue(() => { throw new Error('smoke: the catalogue is unreadable'); });
    await api.restart();
    await connected(api, 'Restarted with an unreadable catalogue');
    probe = await waitFor(async () => {
      const answered = await editor.probe().catch(() => undefined);
      return answered && answered.text.includes(shippedSummary) && !answered.text.includes(marker) ? answered : undefined;
    }, "The .zw page did not fall back to the server's own catalogue", 60000);
    assert(probe.text.includes('Resolved configuration'), 'The .zw page lost its content');
    console.log("PASS: an unreadable catalogue is left out, the server still starts and describes plugins from its own copy");
  } finally {
    api.overridePluginCatalogue(undefined);
  }
  await api.restart();
  await connected(api, 'Restarted with the shipped catalogue');
  await waitFor(async () => (await editor.probe().catch(() => undefined))?.text.includes(shippedSummary) ? true : undefined, 'The .zw page did not return to the shipped catalogue', 60000);
  console.log('PASS: with the shipped catalogue sent again, the .zw page describes plugins as before');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => editorCount(preview) === 0, 'Closing all editors left previews registered');
}

/** A preview of a Markdown page once its page said it loaded and drew it (no diagram to wait for). */
async function renderedZwPreview(preview: PreviewApi, uri: string): Promise<PreviewEditorApi> {
  const editor = await waitFor(() => preview.editorsFor(uri)[0], `No preview editor for ${uri}`, 30000);
  await waitFor(() => editor.session.page.kind === 'ready' ? true : editor.session.page.kind === 'failed' ? (() => { throw new Error(`Preview page failed: ${JSON.stringify(editor.session.page)}`); })() : undefined,
    `The preview page never said it loaded for ${uri}`, 60000);
  await waitFor(async () => {
    const answer = await editor.probe().catch(() => undefined);
    return answer && answer.renderedId === editor.session.selectedId && answer.content.headings > 0 ? answer : undefined;
  }, `The preview rendered nothing for ${uri}: ${JSON.stringify(editor.session.state)} ${JSON.stringify(editor.session.data)}`, 90000);
  return editor;
}

/** Waits until the Markdown the session holds satisfies the predicate and the page has drawn exactly that. */
async function zwShowing(editor: PreviewEditorApi, wanted: (content: string) => boolean, message: string): Promise<PreviewProbe> {
  return waitFor(async () => {
    const content = editor.session.representations[0]?.content;
    if (content === undefined || !wanted(content)) return undefined;
    const answered = await editor.probe().catch(() => undefined);
    return answered && answered.renderedHash === contentHash(content) ? answered : undefined;
  }, message, 30000);
}
