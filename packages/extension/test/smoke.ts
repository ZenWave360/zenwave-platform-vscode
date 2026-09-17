import * as vscode from 'vscode';
import { SHIPPED_CATALOGUE } from '../src/sdk/catalogue.js';
import { LspSupervisor } from '../src/lsp/supervisor.js';
import type { ZenwaveExtensionApi } from '../src/activate.js';
import type { LanguageServerApi } from '../src/lsp/feature.js';
import { documentFailure } from '../src/lsp/requests.js';
import type { OrganizeOutcome, ReferencesOutcome } from '../src/model/actions.js';
import type { HierarchyTreeApi, ModelExplorerApi, OpenRelatedOutcome } from '../src/explorer/feature.js';
import { findNode, type ExplorerNode } from '../src/explorer/hierarchy-model.js';
import type { EventFlowApi, EventFlowEditorApi, EventFlowOpenOutcome } from '../src/eventflow/feature.js';

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
  const { languageServer: api, explorer, eventflow } = extension.exports as ZenwaveExtensionApi;
  const desktop = vscode.env.uiKind === vscode.UIKind.Desktop;
  await explorerBeforeAnyDocument(api, explorer, desktop);
  await realLanguageServer(api, desktop);
  await modelActions(api);
  await explorerTrees(api, explorer, eventflow);
  await eventflowDiagrams(api, explorer, eventflow);
  if (desktop) await eventflowOnDisk(api, eventflow);
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
  assert(sdkLenses.length === (desktop ? 2 : 0), `Expected ${desktop ? 2 : 0} SDK lenses, got ${sdkLenses.length}`);
  if (desktop) {
    assert(sdkLenses.map((lens) => (lens.command?.arguments?.[0] as { plugin: string }).plugin)
      .sort().join(',') === 'FirstPlugin,SecondPlugin', 'Lenses must only cover enabled plugins');
  }
  console.log(`PASS: ${desktop ? 'desktop enabled-plugin' : 'browser absent'} CodeLens`);
  await authoring();
  if (desktop) await desktopRuns(plugins);
}
