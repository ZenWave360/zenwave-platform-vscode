import * as vscode from 'vscode';
import { SHIPPED_CATALOGUE } from '../src/sdk/catalogue.js';
import { LspSupervisor } from '../src/lsp/supervisor.js';
import type { ZenwaveExtensionApi } from '../src/activate.js';
import type { LanguageServerApi } from '../src/lsp/feature.js';
import { documentFailure } from '../src/lsp/requests.js';
import type { OrganizeOutcome, ReferencesOutcome } from '../src/model/actions.js';
import type { HierarchyTreeApi, ModelExplorerApi, OpenRelatedOutcome } from '../src/explorer/feature.js';
import { findNode, type ExplorerNode } from '../src/explorer/hierarchy-model.js';

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
async function explorerTrees(api: LanguageServerApi, explorer: ModelExplorerApi): Promise<void> {
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

  // Cursor to tree, and tree selection to an open diagram through the registry 004 fills (a fake panel here).
  const highlighted: (string | null)[] = [];
  const registration = explorer.diagramPanels.register(checkout, { highlightNode: (id) => { highlighted.push(id); } });
  try {
    await vscode.commands.executeCommand('zenwave.model.focus');
    const editor = await vscode.window.showTextDocument(checkoutDocument);
    await waitFor(() => model.view.visible && model.documentUri === checkout, 'Model view not visible');
    await model.settled();
    editor.selection = new vscode.Selection(21, 8, 21, 8);
    await waitFor(() => model.view.selection[0]?.node.kind === 'policy' && model.view.selection[0].node.label === 'OrderCreated',
      `The cursor in a when block did not reveal it: ${model.view.selection[0]?.node.label}`, 15000);
    await waitFor(() => highlighted.includes('policy:OrderCreated:notifyCustomer'), `Tree selection did not reach the diagram panel: ${highlighted}`, 10000);
    editor.selection = new vscode.Selection(11, 2, 11, 2);
    await waitFor(() => model.view.selection[0]?.node.kind === 'start', `The cursor in a start did not reveal it: ${model.view.selection[0]?.node.label}`, 15000);
    await waitFor(() => highlighted.includes('event:CheckoutStarted'), `Second selection did not reach the diagram panel: ${highlighted}`, 10000);
    assert(model.lastReflection === 'highlighted', `Reflection: ${model.lastReflection}`);
  } finally {
    registration.dispose();
  }
  console.log('PASS: moving the cursor reveals the declaration in the tree, and the selection is sent to a diagram registered for the document');

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
  const { languageServer: api, explorer } = extension.exports as ZenwaveExtensionApi;
  const desktop = vscode.env.uiKind === vscode.UIKind.Desktop;
  await explorerBeforeAnyDocument(api, explorer, desktop);
  await realLanguageServer(api, desktop);
  await modelActions(api);
  await explorerTrees(api, explorer);
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
