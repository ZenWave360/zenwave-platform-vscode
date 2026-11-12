import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { HierarchyNode } from '../../src/lsp/requests.js';
import { CoalescedRefresh, type Scheduler } from '../../src/explorer/coalesce.js';
import { documentSymbolsToHierarchy, loadDocumentOutline, type DocumentSymbolLike, type SymbolInformationLike } from '../../src/explorer/document-symbols.js';
import { DiagramPanels, reflectSelection } from '../../src/explorer/diagram-selection.js';
import { focusedTreeTarget, followDecision, isApiDescription, isModelDocument, outlineRetarget, tabDocumentUri, targetForTextDocument } from '../../src/explorer/follow.js';
import { buildTree, findNode, NEUTRAL_ICON, nodeAt, presentNode, walk } from '../../src/explorer/hierarchy-model.js';
import { describeState, serverUnavailable, stateFromResult, TREE_STATE_KINDS } from '../../src/explorer/tree-state.js';
import { LatestLoad, resumeAbandoned } from '../../src/explorer/latest-load.js';
import { untilSettledOrStale, waitForOutline } from '../../src/explorer/outline-wait.js';

/** Wire samples recorded from @zenwave360/lsp-js 0.1.0-SNAPSHOT (zenwave-lsp d7156e7). */
const samples = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/lsp-samples');
const sample = (name: string): HierarchyNode[] =>
  (JSON.parse(readFileSync(join(samples, name), 'utf8')) as { result: HierarchyNode[] }).result;

const FLOW = 'file:///workspace/checkout.zfl';
const ZDL = 'file:///workspace/orders/model.zdl';
const MANIFEST = 'file:///workspace/zenwave-architecture.yml';

const byLabel = (label: string, kind?: string) => (node: { node: HierarchyNode }) =>
  node.node.label === label && (kind === undefined || node.node.kind === kind);

test('a flow hierarchy keeps nodes declared in other documents, and knows every document it spans', () => {
  const tree = buildTree(FLOW, sample('hierarchy-unopened-zfl.json'));
  assert.deepEqual([...tree.sourceUris].sort(), [FLOW, ZDL]);
  const orders = findNode(tree, byLabel('Orders', 'system'));
  assert.equal(orders?.node.sourceUri, ZDL);
  const service = orders?.children.find(byLabel('OrderService', 'service'));
  assert.deepEqual(service?.children.map((child) => child.node.label), ['createOrder', 'notifyCustomer'],
    'commands appear under the service that handles them, including one derived from a when block');
  assert.equal(service?.children[0]?.parent, service, 'getParent is answerable for reveal()');
  const keys = [...walk(tree.roots)].map((node) => node.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('a server that repeats an id still yields unique tree keys', () => {
  const node = (id: string, label: string): HierarchyNode => ({ id, label, kind: 'event', sourceUri: FLOW,
    sourceRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, children: [], relatedResources: [], uiHints: {}, viewNodeIds: [] });
  const tree = buildTree(FLOW, [node('x', 'a'), node('x', 'b'), node('', 'c')]);
  assert.deepEqual(tree.roots.map((root) => root.key), ['x', 'x~1', `${FLOW}/event:c`]);
});

test('a nested document-symbol response becomes a navigable nested tree', () => {
  const range = { start: { line: 1, character: 0 }, end: { line: 8, character: 0 } };
  const symbols: DocumentSymbolLike[] = [{
    name: 'Orders', detail: 'namespace', kind: 3, range,
    selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } },
    children: [{ name: 'create', kind: 5, range: { start: { line: 3, character: 2 }, end: { line: 5, character: 3 } } }],
  }];
  const tree = buildTree('file:///workspace/openapi.yaml', documentSymbolsToHierarchy('file:///workspace/openapi.yaml', symbols));
  const root = tree.roots[0]!;
  assert.deepEqual([root.node.label, root.node.sourceUri, root.node.sourceRange, root.revealRange],
    ['Orders', 'file:///workspace/openapi.yaml', symbols[0]!.range, symbols[0]!.selectionRange]);
  assert.deepEqual(root.children.map((child) => child.node.label), ['create']);
  assert.equal(presentNode(root, tree.documentUri).description, 'namespace');
});

test('a flat SymbolInformation response keeps every entry as a navigable root', () => {
  const symbols: SymbolInformationLike[] = [
    { name: 'GET /orders', kind: 12, containerName: 'paths', location: { uri: { toString: () => 'file:///workspace/openapi.yaml' }, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 11 } } } },
    { name: 'Order', kind: 5, location: { uri: { toString: () => 'file:///workspace/schemas.yaml' }, range: { start: { line: 1, character: 0 }, end: { line: 6, character: 0 } } } },
  ];
  const nodes = documentSymbolsToHierarchy('file:///workspace/openapi.yaml', symbols);
  assert.deepEqual(nodes.map((node) => [node.label, node.children.length, node.sourceUri]), [
    ['GET /orders', 0, 'file:///workspace/openapi.yaml'], ['Order', 0, 'file:///workspace/schemas.yaml'],
  ]);
  assert.equal(nodes[0]!.uiHints.detail, 'paths');
});

test('a document symbol uses its full range for cursor containment and its selection range for navigation', () => {
  const uri = 'file:///workspace/README.md';
  const fullRange = { start: { line: 10, character: 0 }, end: { line: 40, character: 0 } };
  const selectionRange = { start: { line: 10, character: 2 }, end: { line: 10, character: 9 } };
  const tree = buildTree(uri, documentSymbolsToHierarchy(uri, [{ name: 'Heading', kind: 15, range: fullRange, selectionRange }]));
  assert.equal(nodeAt(tree, uri, { line: 25, character: 0 })?.node.label, 'Heading');
  assert.deepEqual(tree.roots[0]?.revealRange, selectionRange);
});

test('an empty symbol response has no nodes, and only Markdown and API descriptions select the host outline', () => {
  assert.deepEqual(documentSymbolsToHierarchy('file:///workspace/README.md', undefined), []);
  const markdown = { path: '/workspace/README.md', toString: () => 'file:///workspace/README.md' };
  const yaml = { path: '/workspace/openapi.yaml', toString: () => 'file:///workspace/openapi.yaml' };
  const json = { path: '/workspace/openapi.json', toString: () => 'file:///workspace/openapi.json' };
  assert.deepEqual(targetForTextDocument(markdown, 'markdown'), { uri: 'file:///workspace/README.md', source: 'outline', outlineKind: 'markdown' });
  assert.deepEqual(targetForTextDocument(yaml, 'yaml', 'openapi: 3.1.0'), { uri: 'file:///workspace/openapi.yaml', source: 'outline', outlineKind: 'api-description' });
  assert.deepEqual(targetForTextDocument(json, 'json', '{ "asyncapi": "3.0.0" }'), { uri: 'file:///workspace/openapi.json', source: 'outline', outlineKind: 'api-description' });
  assert.deepEqual(targetForTextDocument(json, 'jsonc', '// generated\n{ "swagger": "2.0" }'), { uri: 'file:///workspace/openapi.json', source: 'outline', outlineKind: 'api-description' });
  assert.equal(targetForTextDocument(yaml, 'yaml', 'config:\n  openapi: ignored'), undefined);
  assert.equal(targetForTextDocument(json, 'json', '{ "config": { "openapi": "3.1.0" } }'), undefined);
  assert.equal(targetForTextDocument(json, 'jsonc', '{ "title": "an openapi: mention" }'), undefined);
  assert.equal(targetForTextDocument({ path: '/workspace/model.zdl', toString: () => FLOW }, 'zdl').source, 'server');
  assert.equal(targetForTextDocument({ path: '/workspace/App.java', toString: () => 'file:///workspace/App.java' }, 'java'), undefined);
  assert.equal(targetForTextDocument({ path: '/workspace/notes.txt', toString: () => 'file:///workspace/notes.txt' }, 'plaintext'), undefined);
});

test('the API discriminator looks only at top-level keys in the first fifty lines and four kilobytes', () => {
  assert.ok(isApiDescription('---\n# a description\nasyncapi: 3.0.0', 'yaml'));
  assert.ok(isApiDescription('{ /* a comment */ "openapi": "3.1.0" }', 'jsonc'));
  assert.equal(isApiDescription(`${'ignored: value\n'.repeat(50)}openapi: 3.1.0`, 'yaml'), false);
  assert.equal(isApiDescription(`${' '.repeat(4096)}\nopenapi: 3.1.0`, 'yaml'), false);
});

test('a document-symbol provider failure becomes a failed tree state with a provider-specific log', async () => {
  const result = await loadDocumentOutline('file:///workspace/openapi.yaml', async () => { throw new Error('provider exploded'); });
  assert.deepEqual(result.state, { kind: 'failed', reason: 'provider exploded' });
  assert.match(result.log ?? '', /^document symbol provider failed for .*openapi\.yaml: provider exploded$/);
  assert.doesNotMatch(result.log ?? '', /zenwave\/hierarchy/);
});

test('an empty outline load carries no banner of its own', async () => {
  const result = await loadDocumentOutline('file:///workspace/README.md', async () => []);
  assert.deepEqual(result.state, { kind: 'outline-empty' });
  assert.equal(result.message, undefined);
  assert.deepEqual(result.nodes, []);
});

test('a load result is discarded when its target becomes stale', async () => {
  let target = { uri: 'file:///workspace/first.md', source: 'outline' };
  let release: (() => void) | undefined;
  const latest = new LatestLoad<typeof target, string>();
  const pending = latest.run(() => target, async () => new Promise<string>((resolve) => { release = () => resolve('first'); }),
    (left, right) => left.uri === right.uri && left.source === right.source);
  target = { uri: 'file:///workspace/second.md', source: 'outline' };
  release!();
  assert.equal(await pending, undefined);
});

test('a dropped load is asked again, and a finished one is published', () => {
  let resumes = 0;
  const resume = (): void => { resumes++; };
  assert.equal(resumeAbandoned(undefined, resume), undefined);
  assert.equal(resumeAbandoned({ result: { superseded: true } }, resume), undefined);
  assert.equal(resumes, 2);
  assert.deepEqual(resumeAbandoned({ result: { superseded: false, nodes: 3 } }, resume), { result: { superseded: false, nodes: 3 } });
  assert.equal(resumes, 2);
});

test('an outline that answers immediately is not held for a poll, and a late rejection is ignored', async () => {
  let slept = 0;
  const answered = await untilSettledOrStale(Promise.resolve(['Intro']), () => false, 50, async () => { slept++; });
  assert.deepEqual(answered, { kind: 'value', value: ['Intro'] });
  assert.equal(slept, 0);

  const rejections: unknown[] = [];
  const onRejection = (error: unknown): void => { rejections.push(error); };
  process.on('unhandledRejection', onRejection);
  let rejectLate: (error: Error) => void = () => undefined;
  const hung = new Promise<string[]>((_, reject) => { rejectLate = reject; });
  const abandoned = await untilSettledOrStale(hung, () => true, 50, async () => { slept++; });
  assert.deepEqual(abandoned, { kind: 'stale' });
  assert.equal(slept, 0);
  rejectLate(new Error('late'));
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', onRejection);
  assert.deepEqual(rejections, []);
});

test('markdown keeps asking after an empty answer and activates once, without an isActive gate', async () => {
  let time = 0;
  const answers: (readonly string[] | undefined)[] = [undefined, [], ['Intro', 'Fixtures']];
  let activations = 0;
  const outcome = await waitForOutline({
    ask: async () => answers.shift(),
    activate: async () => { activations++; },
    deadlineMs: 15_000,
    pollMs: 50,
    now: () => time,
    sleep: async (ms) => { time += ms; },
  });
  assert.deepEqual(outcome, { kind: 'symbols', symbols: ['Intro', 'Fixtures'] });
  assert.equal(activations, 1);
  assert.ok(time < 15_000, `waited ${time}ms`);
});

test('an outline that stays empty ends at the deadline, and one that never answers does too', async () => {
  let time = 0;
  let asks = 0;
  const empty = await waitForOutline({
    ask: async () => { asks++; return []; },
    deadlineMs: 100,
    pollMs: 40,
    now: () => time,
    sleep: async (ms) => { time += ms; },
  });
  assert.deepEqual(empty, { kind: 'empty' });
  assert.ok(asks >= 2);
  assert.ok(time >= 100);

  time = 0;
  const silent = await waitForOutline<string>({
    ask: () => new Promise(() => undefined),
    deadlineMs: 100,
    pollMs: 40,
    now: () => time,
    sleep: async (ms) => { time += ms; },
  });
  assert.deepEqual(silent, { kind: 'unanswered' });
  assert.ok(time >= 100 && time < 180, `silent wait ran for ${time}ms`);
});

test('an always-empty outline is asked with backoff, not every fifty milliseconds, and ends empty', async () => {
  let time = 0;
  let asks = 0;
  const empty = await waitForOutline({
    ask: async () => { asks++; return []; },
    deadlineMs: 15_000,
    pollMs: 50,
    initialIntervalMs: 100,
    maxIntervalMs: 2_000,
    now: () => time,
    sleep: async (ms) => { time += ms; },
  });
  assert.deepEqual(empty, { kind: 'empty' });
  assert.ok(asks <= 12, `always-empty outline asked ${asks} times`);
  assert.ok(asks >= 8, `always-empty outline asked only ${asks} times`);
  assert.ok(time >= 15_000);
});

test('a hung outline is abandoned when the target changes, well before the deadline', async () => {
  let time = 0;
  let stale = false;
  let asks = 0;
  const outcome = await waitForOutline({
    ask: () => { asks++; return new Promise(() => undefined); },
    activate: async () => { throw new Error('should not activate after the target moved'); },
    deadlineMs: 5_000,
    pollMs: 30,
    stale: () => stale,
    now: () => time,
    sleep: async (ms) => { time += ms; stale = true; },
  });
  assert.deepEqual(outcome, { kind: 'stale' });
  assert.equal(asks, 1);
  assert.equal(time, 30);
});

test('disposing the tree cancels an in-flight outline wait: no further polling, no further asks', async () => {
  let cancelled = false;
  let sleeps = 0;
  let pollsAfterCancel = 0;
  let releaseSleep: (() => void) | undefined;
  const hung = untilSettledOrStale(
    new Promise<string[]>(() => undefined),
    () => cancelled,
    50,
    () => {
      sleeps++;
      if (cancelled) pollsAfterCancel++;
      return new Promise<void>((resolve) => { releaseSleep = resolve; });
    },
  );
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(sleeps, 1, 'the hung ask is polled once while it is live');
  cancelled = true;
  releaseSleep!();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(await hung, { kind: 'stale' });
  assert.equal(pollsAfterCancel, 0);
  assert.equal(sleeps, 1);

  let time = 0;
  let disposed = false;
  let asks = 0;
  const empty = await waitForOutline({
    ask: async () => { asks++; return []; },
    deadlineMs: 15_000,
    pollMs: 50,
    initialIntervalMs: 100,
    maxIntervalMs: 2_000,
    stale: () => disposed,
    now: () => time,
    sleep: async (ms) => { time += ms; disposed = true; },
  });
  assert.deepEqual(empty, { kind: 'stale' });
  assert.equal(asks, 1);
  assert.ok(time < 15_000, `disposed wait ran for ${time}ms`);
});

test('an abandoned refresh schedules one follow-up and the next run does not overlap it', async () => {
  const clock = fakeClock();
  let runs = 0;
  let overlap = 0;
  let inFlight = 0;
  const refresh = new CoalescedRefresh(() => {
    inFlight++;
    if (inFlight > 1) overlap++;
    runs++;
    const run = runs;
    return Promise.resolve().then(() => {
      inFlight--;
      if (run === 1) resumeAbandoned(undefined, () => refresh.request(0));
    });
  }, 50, clock);

  refresh.request(0);
  await clock.advance(0);
  assert.equal(runs, 2);
  assert.equal(overlap, 0);
  assert.equal(refresh.pending, false);
  refresh.dispose();
});

test('nodes present in this client vocabulary, and a kind released later still renders under its name', () => {
  const tree = buildTree(FLOW, sample('hierarchy-unopened-zfl.json'));
  const systems = presentNode(tree.roots[0]!, FLOW);
  assert.equal(systems.label, 'Systems', 'a structural section reads like a VS Code tree');
  const orders = presentNode(findNode(tree, byLabel('Orders', 'system'))!, FLOW);
  assert.equal(orders.label, 'Orders');
  assert.equal(orders.description, 'model.zdl', 'a node declared elsewhere names that document');
  assert.equal(orders.contextValue, 'zenwave.hierarchy.system.related.declaration.references');
  assert.match(orders.contextValue, /\.declaration(\.|$)/, 'a declaration can offer navigation actions');
  assert.match(orders.contextValue, /\.references(\.|$)/, 'a system name resolves, so Go to References is offered');
  assert.ok(!/\.declaration(\.|$)/.test(presentNode(tree.roots[0]!, FLOW).contextValue), 'a structural section does not offer declaration actions');
  const policy = presentNode(findNode(tree, byLabel('OrderCreated', 'policy'))!, FLOW);
  assert.equal(policy.description, 'do notifyCustomer');
  const kinds = new Set([...walk(tree.roots)].map((node) => presentNode(node, FLOW).icon));
  assert.ok(kinds.size >= 7 && !kinds.has(NEUTRAL_ICON), 'systems, services, commands, events … are distinguishable');

  const future = buildTree(FLOW, [{ id: `${FLOW}#x`, label: 'Saga Payments', kind: 'saga-step', sourceUri: FLOW,
    sourceRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, children: [], relatedResources: [], uiHints: {}, viewNodeIds: [] }]);
  const shown = presentNode(future.roots[0]!, FLOW);
  assert.deepEqual([shown.label, shown.icon, shown.contextValue], ['Saga Payments', NEUTRAL_ICON, 'zenwave.hierarchy.saga-step']);

  const manifest = buildTree(MANIFEST, sample('hierarchy-unopened-manifest.json'));
  assert.equal(presentNode(manifest.roots[0]!, MANIFEST).label, 'zenwave-architecture.yml');
  assert.equal(presentNode(manifest.roots[0]!.children[0]!, MANIFEST).label, 'orders');
});

test('an Arcadia architecture hierarchy keeps resources lazy, typed and visibly pending where the server says so', () => {
  const tree = buildTree(MANIFEST, sample('hierarchy-arcadia-manifest.json'));
  const domain = findNode(tree, byLabel('architecture', 'domain'))!;
  const subdomain = findNode(tree, byLabel('catalogue', 'subdomain'))!;
  const emptyDomain = findNode(tree, byLabel('empty-domain', 'domain'))!;
  assert.ok(domain.children.some(byLabel('Docs', 'docs')), 'a domain with docs is kept even without a version');
  assert.ok(subdomain.children.some(byLabel('Docs', 'docs')), 'a subdomain with docs remains a node');
  assert.equal(emptyDomain.children.length, 0, 'a domain without services is not dropped');

  const artifacts = presentNode(findNode(tree, byLabel('Artifacts', 'artifacts'))!, MANIFEST);
  const docs = presentNode(findNode(tree, byLabel('Docs', 'docs'))!, MANIFEST);
  const consumers = presentNode(findNode(tree, byLabel('Consumers', 'consumers'))!, MANIFEST);
  assert.deepEqual([artifacts.icon, docs.icon, consumers.icon], ['package', 'book', 'organization']);

  const openapi = presentNode(findNode(tree, byLabel('apis/catalog.yml', 'artifact'))!, MANIFEST);
  assert.deepEqual([openapi.icon, openapi.description, openapi.address, openapi.disabled], [
    'symbol-interface',
    'apis/catalog.yml · 1.2.3',
    'zenwave:/architecture/catalogue/1.2.3/apis/catalog.yml',
    false,
  ]);
  const absolute = presentNode(findNode(tree, byLabel('https://schemas.arcadia.example/catalog/openapi.yml', 'artifact'))!, MANIFEST);
  assert.equal(absolute.label, 'https://schemas.arcadia.example/catalog/openapi.yml', 'an absolute URI is shown as the server labelled it');
  assert.equal(absolute.description, 'https://schemas.arcadia.example/catalog/openapi.yml · 2026.11');

  const unversionedDoc = presentNode(findNode(tree, byLabel('README.md', 'doc'))!, MANIFEST);
  assert.deepEqual([unversionedDoc.description, unversionedDoc.address], ['README.md', 'zenwave:/architecture/-/README.md']);
  assert.ok(!unversionedDoc.description?.includes('undefined'), 'an unversioned document does not acquire a synthetic version');

  const glob = presentNode(findNode(tree, byLabel('contracts/**/*.yaml', 'artifact'))!, MANIFEST);
  assert.equal(glob.description, 'contracts/**/*.yaml · 2.0.0 · pending (phase 2)');
  assert.equal(glob.disabled, true);
  assert.equal(glob.address, undefined, 'folder and glob resources cannot be opened before phase 2');
  assert.match(glob.tooltip, /Pending \(phase 2\): Folder and glob entries are not supported/);

  const consumer = presentNode(findNode(tree, byLabel('Arcadia storefront', 'consumer'))!, MANIFEST);
  assert.deepEqual([consumer.label, consumer.address, consumer.disabled], ['Arcadia storefront', undefined, false], 'consumers are plain text');
  const unknown = presentNode(findNode(tree, byLabel('Release notes', 'future-resource'))!, MANIFEST);
  assert.deepEqual([unknown.label, unknown.icon], ['Release notes', NEUTRAL_ICON], 'a future kind remains visible');
});

test('the node at a cursor is the narrowest declaration containing it, in the document the cursor is in', () => {
  const tree = buildTree(FLOW, sample('hierarchy-unopened-zfl.json'));
  assert.equal(nodeAt(tree, FLOW, { line: 21, character: 8 })?.node.kind, 'policy', 'the when block, not a part repeated under it');
  assert.equal(nodeAt(tree, FLOW, { line: 11, character: 0 })?.node.label, 'CheckoutStarted');
  assert.equal(nodeAt(tree, ZDL, { line: 5, character: 10 })?.node.label, 'createOrder');
  assert.equal(nodeAt(tree, ZDL, { line: 4, character: 2 })?.node.label, 'OrderService');
  assert.equal(nodeAt(tree, FLOW, { line: 8, character: 0 }), undefined);
  assert.equal(nodeAt(tree, ZDL, { line: 0, character: 0 })?.node.label, 'Orders', 'a zero-width server range matches its point');
  assert.equal(nodeAt(tree, ZDL, { line: 0, character: 1 }), undefined, 'a zero-width range matches only its point');
});

test('a boundary shared by adjacent outline symbols belongs to the following symbol', () => {
  const uri = 'file:///workspace/README.md';
  const heading = (label: string, startCharacter: number, endCharacter: number): HierarchyNode => ({
    id: label, label, kind: 'heading', sourceUri: uri,
    sourceRange: { start: { line: 3, character: startCharacter }, end: { line: 3, character: endCharacter } },
    children: [], relatedResources: [], uiHints: {}, viewNodeIds: [],
  });
  const tree = buildTree(uri, [heading('First', 0, 4), heading('Second', 4, 10)]);
  assert.equal(nodeAt(tree, uri, { line: 3, character: 3 })?.node.label, 'First');
  assert.equal(nodeAt(tree, uri, { line: 3, character: 4 })?.node.label, 'Second', 'the shared end is outside the previous symbol');
  assert.equal(nodeAt(tree, uri, { line: 3, character: 10 }), undefined, 'a non-zero range excludes its end');

  const point = buildTree(uri, [heading('Point', 4, 4), heading('After', 4, 10)]);
  assert.equal(nodeAt(point, uri, { line: 3, character: 4 })?.node.label, 'Point', 'a zero-width range is narrower than the symbol that starts there');
  assert.equal(nodeAt(point, uri, { line: 3, character: 5 })?.node.label, 'After');
});

test('the model tree follows the focused model, but not into a document its hierarchy already spans', () => {
  const tree = buildTree(FLOW, sample('hierarchy-unopened-zfl.json'));
  const shown = { uri: FLOW, tree };
  assert.equal(followDecision(undefined, FLOW), 'retarget', 'opening a flow');
  assert.equal(followDecision(shown, ZDL), 'keep', 'drilling into the ZDL a system is declared in');
  assert.equal(followDecision(shown, 'file:///workspace/cancel-order.zfl'), 'retarget', 'moving to another model');
  assert.equal(followDecision(shown, undefined), 'keep', 'a Java file, a webview or no tab keeps the last model');
  assert.equal(followDecision({ uri: FLOW }, ZDL), 'retarget', 'before its hierarchy arrives the tree spans only its document');
});

test('the active document comes from text and custom editor tabs alike', () => {
  const uri = { path: '/w/checkout.zfl', toString: () => 'file:///w/checkout.zfl' };
  assert.equal(tabDocumentUri({ uri })?.toString(), 'file:///w/checkout.zfl', 'TabInputText');
  assert.equal(tabDocumentUri({ uri, viewType: 'zenwave.eventflow' })?.toString(), 'file:///w/checkout.zfl', 'TabInputCustom');
  assert.equal(tabDocumentUri({ original: uri, modified: uri }), undefined, 'a diff');
  assert.equal(tabDocumentUri({ viewType: 'markdown.preview' }), undefined, 'a webview');
  assert.equal(tabDocumentUri(undefined), undefined);
  assert.equal(isModelDocument(uri, undefined), true, 'a diagram of a flow not open as text');
  assert.equal(isModelDocument({ path: 'Untitled-1', toString: () => 'untitled:Untitled-1' }, 'zfl'), true);
  assert.equal(isModelDocument({ path: '/w/App.java', toString: () => '' }, 'java'), false);
  assert.equal(isModelDocument({ path: '/w/zenwave-architecture.yml', toString: () => '' }, undefined), false);
});

test('a focused diagram is the model on screen even when a text editor in another group is still active', () => {
  const checkout = { path: '/w/lsp/checkout.zfl', toString: () => 'file:///w/lsp/checkout.zfl' };
  const placeOrder = { path: '/w/place-order-flow.zfl', toString: () => 'file:///w/place-order-flow.zfl' };
  const readme = { path: '/w/README.md', toString: () => 'file:///w/README.md' };
  const checkoutText = targetForTextDocument(checkout, 'zfl');
  assert.deepEqual(focusedTreeTarget(checkoutText, { uri: placeOrder, customEditor: true, languageId: undefined }),
    { uri: placeOrder.toString(), source: 'server' });
  assert.deepEqual(focusedTreeTarget(undefined, { uri: placeOrder, customEditor: true, languageId: 'zfl' }),
    { uri: placeOrder.toString(), source: 'server' });
  assert.deepEqual(focusedTreeTarget(undefined, { uri: checkout, customEditor: false, languageId: 'zfl' }),
    { uri: checkout.toString(), source: 'server' }, 'a text tab still follows the server when no text editor is active');
  const markdown = targetForTextDocument(readme, 'markdown');
  assert.deepEqual(focusedTreeTarget(markdown, { uri: readme, customEditor: false, languageId: 'markdown' }), markdown);
  assert.equal(focusedTreeTarget(undefined, undefined), undefined, 'no focused document keeps the current model');
  assert.equal(focusedTreeTarget(undefined, { uri: { path: '/w/App.java', toString: () => 'file:///w/App.java' }, customEditor: false, languageId: 'java' }), undefined);
  assert.equal(focusedTreeTarget(markdown, { uri: { path: '/w/pic.png', toString: () => 'file:///w/pic.png' }, customEditor: true }), undefined,
    'an image is not a model or an outline, so the tree stays where it is');
  assert.equal(focusedTreeTarget(markdown, { customEditor: true }), undefined, 'a webview keeps the current tree');
  assert.deepEqual(focusedTreeTarget(markdown, undefined), markdown, 'with no active tab the text editor is the fallback');
});

test('focusing an image keeps diagram B when Markdown A is still the active text editor', () => {
  const markdownA = targetForTextDocument({ path: '/w/README.md', toString: () => 'file:///w/README.md' }, 'markdown');
  const diagramB = { path: '/w/place-order-flow.zfl', toString: () => 'file:///w/place-order-flow.zfl' };
  const image = { path: '/w/pic.png', toString: () => 'file:///w/pic.png' };
  const onDiagram = focusedTreeTarget(markdownA, { uri: diagramB, customEditor: true });
  assert.deepEqual(onDiagram, { uri: diagramB.toString(), source: 'server' }, 'the diagram is the model on screen');
  assert.equal(focusedTreeTarget(markdownA, { uri: image, customEditor: true }), undefined,
    'the image keeps diagram B; Markdown A is a text editor in another group');
  assert.equal(focusedTreeTarget(markdownA, { customEditor: true }), undefined, 'a webview keeps diagram B too');
});

test('editing the active document onto an API description switches to its outline, and back does not', () => {
  const yaml = { path: '/w/service.yaml', toString: () => 'file:///w/service.yaml' };
  const shown = { uri: 'file:///w/place-order-flow.zfl', source: 'server' as const };
  assert.equal(outlineRetarget(shown, { active: true, uri: yaml, languageId: 'yaml', text: 'info:\n  title: Orders\n' }), undefined,
    'ordinary YAML leaves the current model');
  const qualified = outlineRetarget(shown, { active: true, uri: yaml, languageId: 'yaml', text: 'openapi: 3.1.0\ninfo:\n  title: Orders\n' });
  assert.deepEqual(qualified, { uri: 'file:///w/service.yaml', source: 'outline', outlineKind: 'api-description' });
  assert.equal(outlineRetarget(
    { uri: 'file:///w/service.yaml', source: 'outline' },
    { active: true, uri: yaml, languageId: 'yaml', text: 'openapi: 3.1.0\npaths: {}\n' },
  ), undefined, 'further edits of the outline already on screen do not retarget');
  assert.equal(outlineRetarget(
    { uri: 'file:///w/service.yaml', source: 'outline' },
    { active: true, uri: yaml, languageId: 'yaml', text: 'info:\n  title: Orders\n' },
  ), undefined, 'removing the key keeps the outline');
  const json = { path: '/w/service.json', toString: () => 'file:///w/service.json' };
  assert.deepEqual(outlineRetarget(shown, { active: true, uri: json, languageId: 'json', text: '{ "openapi": "3.1.0" }' }),
    { uri: 'file:///w/service.json', source: 'outline', outlineKind: 'api-description' });
  assert.equal(outlineRetarget(shown, { active: false, uri: yaml, languageId: 'yaml', text: 'openapi: 3.1.0\n' }), undefined,
    'a document that is not the active one does not move the tree');
  assert.equal(outlineRetarget(shown, { active: true, uri: { path: '/w/model.zdl', toString: () => 'file:///w/model.zdl' }, languageId: 'zdl', text: 'openapi: 3.1.0\n' }), undefined,
    'a ZenWave model stays with the server');
});

test('an empty tree says why: no server, no hierarchy request, not found, unreadable, empty', () => {
  assert.deepEqual(serverUnavailable({ kind: 'no-server', reason: 'no transport' }, []), { kind: 'no-server', reason: 'no transport' });
  assert.deepEqual(serverUnavailable({ kind: 'starting' }, []), { kind: 'loading' });
  assert.deepEqual(serverUnavailable({ kind: 'connected' }, ['zenwave/preview']), { kind: 'unsupported' });
  assert.equal(serverUnavailable({ kind: 'connected' }, ['zenwave/hierarchy']), undefined);

  assert.deepEqual(stateFromResult({ kind: 'ok', value: [] }, 0), { kind: 'empty' });
  assert.deepEqual(stateFromResult({ kind: 'ok', value: [] }, 3), { kind: 'ready', nodes: 3 });
  const notFound = stateFromResult({ kind: 'failed', reason: 'vscode-test-web://mount/zenwave-architecture.yml is not open and cannot be read', code: -32803, data: { kind: 'documentNotFound' } }, 0);
  assert.equal(notFound.kind, 'not-found');
  assert.match(describeState('Architecture', 'zenwave-architecture.yml', notFound), /could not read zenwave-architecture\.yml .*browser/);
  assert.deepEqual(stateFromResult({ kind: 'failed', reason: 'x', code: -32803, data: { kind: 'documentUnreadable', diagnostics: [{}, {}] } }, 0),
    { kind: 'unreadable', problems: 2 });
  assert.deepEqual(stateFromResult({ kind: 'failed', reason: 'timed out' }, 0), { kind: 'failed', reason: 'timed out' });
  assert.match(describeState('Architecture', undefined, { kind: 'no-manifest' }), /no architecture manifest was resolved.*zenwave\.workspace\.manifest/);
});

function fakeClock(): Scheduler & { now: number; advance(ms: number): Promise<void> } {
  let timers: { at: number; callback: () => void; id: number }[] = [];
  let next = 0;
  const clock = {
    now: 0,
    set(callback: () => void, ms: number) { const id = next++; timers.push({ at: clock.now + ms, callback, id }); return id; },
    clear(handle: unknown) { timers = timers.filter((timer) => timer.id !== handle); },
    async advance(ms: number) {
      const until = clock.now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        clock.now = due.at;
        due.callback();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      clock.now = until;
    },
  };
  return clock;
}

test('typing does not make a tree thrash: a burst of edits is one request, edits during a request one more', async () => {
  const clock = fakeClock();
  let requests = 0;
  let release: (() => void) | undefined;
  const refresh = new CoalescedRefresh(() => { requests++; return new Promise<void>((resolve) => { release = resolve; }); }, 400, clock);

  // 200 keystrokes, 50 ms apart: the quiet period never elapses while typing.
  for (let key = 0; key < 200; key++) { refresh.request(); await clock.advance(50); }
  assert.equal(requests, 0);
  await clock.advance(400);
  assert.equal(requests, 1, 'one request once typing pauses');

  // More typing while the (slow, large-model) request runs: coalesced into one follow-up, never concurrent.
  for (let key = 0; key < 50; key++) { refresh.request(); await clock.advance(450); }
  assert.equal(requests, 1, 'nothing runs concurrently');
  const idle = refresh.idle();
  release!();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(requests, 2, 'exactly one follow-up for everything typed meanwhile');
  release!();
  await idle;
  assert.equal(refresh.pending, false);
  refresh.dispose();
});

test('a tree selection reaches the diagram open for the same document, and only that one', async () => {
  const panels = new DiagramPanels();
  const received: (string | null)[] = [];
  const other: (string | null)[] = [];
  const registration = panels.register(FLOW, { highlightNode: (id) => { received.push(id); } });
  panels.register('file:///workspace/other.zfl', { highlightNode: (id) => { other.push(id); } });

  const tree = buildTree(FLOW, sample('hierarchy-unopened-zfl.json'));
  const command = findNode(tree, byLabel('createOrder', 'command'))!;
  const flow = findNode(tree, byLabel('CheckoutFlow', 'flow'))!;
  assert.equal(await reflectSelection(panels, FLOW, command.node.viewNodeIds), 'highlighted');
  assert.equal(await reflectSelection(panels, FLOW, flow.node.viewNodeIds), 'no-counterpart', 'no counterpart clears rather than matching the wrong node');
  assert.equal(await reflectSelection(panels, FLOW, undefined), 'cleared');
  assert.deepEqual(received, ['command:createOrder', null, null]);
  assert.deepEqual(other, []);

  registration.dispose();
  assert.equal(await reflectSelection(panels, FLOW, command.node.viewNodeIds), 'no-diagram', 'no diagram open: nothing happens, nothing is reported');
  assert.equal(await reflectSelection(panels, undefined, command.node.viewNodeIds), 'no-diagram');
});

test('the container, both views, activation and an explanation for every empty state are contributed', () => {
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')) as {
    activationEvents: string[];
    contributes: {
      viewsContainers: { activitybar: { id: string; icon: string }[] };
      views: Record<string, { id: string; name: string }[]>;
      viewsWelcome: { view: string; contents: string; when: string }[];
      menus: Record<string, { command: string; when?: string; group?: string }[]>;
    };
  };
  const { contributes } = manifest;
  assert.ok(contributes.viewsContainers.activitybar.some((container) => container.id === 'zenwave' && container.icon.length > 0));
  assert.deepEqual(contributes.views.zenwave?.map((view) => [view.id, view.name]), [['zenwave.architecture', 'Architecture'], ['zenwave.model', 'Model']]);
  for (const view of ['zenwave.architecture', 'zenwave.model']) assert.ok(manifest.activationEvents.includes(`onView:${view}`));

  const keys = { 'zenwave.architecture': 'zenwave.architectureTreeState', 'zenwave.model': 'zenwave.modelTreeState' } as const;
  for (const [view, key] of Object.entries(keys)) {
    const relevant = TREE_STATE_KINDS.filter((kind) => kind !== 'ready' && (kind !== 'no-manifest' || view === 'zenwave.architecture') &&
      (kind !== 'no-model' || view === 'zenwave.model') && (kind !== 'outline-empty' || view === 'zenwave.model'));
    for (const kind of relevant) {
      const entries = contributes.viewsWelcome.filter((entry) => entry.view === view && entry.when === `${key} == ${kind}`);
      assert.equal(entries.length, 1, `${view} explains ${kind}`);
    }
  }
  const noManifest = contributes.viewsWelcome.find((entry) => entry.when === 'zenwave.architectureTreeState == no-manifest');
  assert.match(noManifest?.contents ?? '', /command:workbench\.action\.openSettings\?%5B%22zenwave\.workspace\.manifest%22%5D/, 'no manifest links to the setting');
  const definition = contributes.menus['view/item/context']?.find((entry) => entry.command === 'zenwave.explorer.goToDefinition');
  assert.equal(definition?.group, 'inline@1');
  const references = contributes.menus['view/item/context']?.find((entry) => entry.command === 'zenwave.explorer.goToReferences');
  assert.ok((references?.when ?? '').includes("'zenwave/symbolAt' in zenwave.languageServerRequests"));
  assert.ok((references?.when ?? '').includes("'zenwave/reverseReferences' in zenwave.languageServerRequests"));
  assert.equal(references?.group, 'inline@2');
  const refresh = contributes.menus['view/title']?.find((entry) => entry.command === 'zenwave.explorer.refresh');
  assert.deepEqual([refresh?.when, refresh?.group], ['view == zenwave.architecture || view == zenwave.model', 'navigation']);
  const palette = Object.fromEntries((contributes.menus.commandPalette ?? []).map((entry) => [entry.command, entry.when]));
  for (const command of ['zenwave.explorer.openNode', 'zenwave.explorer.openResource', 'zenwave.explorer.openRelated', 'zenwave.explorer.goToDefinition', 'zenwave.explorer.goToReferences']) {
    assert.equal(palette[command], 'false', `${command} is reachable from the Command Palette`);
  }
  assertMenuMarkers(contributes.menus);
});

/** A context value the presenter builds, plus every order of its markers. An end-anchored regex fails one of them. */
function contextValues(): string[] {
  const range = { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } };
  const related = [{ targetKind: 'document', label: 'model.zdl', uri: ZDL }];
  const leaf = (kind: string, label: string, options: { source?: boolean; related?: boolean; parentKind?: string } = {}): ExplorerNode => {
    const node: HierarchyNode = {
      id: `${options.parentKind ?? 'root'}/${kind}:${label}`, label, kind,
      sourceUri: options.source === false ? '' : FLOW,
      sourceRange: range,
      children: [], relatedResources: options.related ? related : [], uiHints: {}, viewNodeIds: [],
    };
    const parent = options.parentKind ? leaf(options.parentKind, 'parent') : undefined;
    return { key: node.id, node, parent, children: [], depth: parent ? 1 : 0 };
  };
  const produced = [
    presentNode(leaf('section', 'systems'), FLOW).contextValue,
    presentNode(leaf('entity', 'Order', { source: false, related: true }), FLOW).contextValue,
    presentNode(leaf('entity', 'Order'), FLOW).contextValue,
    presentNode(leaf('field', 'status'), FLOW).contextValue,
    presentNode(leaf('method', 'createOrder'), FLOW).contextValue,
    presentNode(leaf('service', 'OrderService'), FLOW).contextValue,
    presentNode(leaf('event', 'OrderEvent'), FLOW).contextValue,
    presentNode(leaf('relationship', 'ManyToOne'), FLOW).contextValue,
    presentNode(leaf('event', 'PaymentAuthorized', { parentKind: 'policy' }), FLOW).contextValue,
    presentNode(leaf('service', 'Orders.OrderService', { parentKind: 'policy' }), FLOW).contextValue,
    presentNode(leaf('event', 'OrderConfirmationSent', { parentKind: 'outcome' }), FLOW).contextValue,
    presentNode(leaf('flow', 'CheckoutFlow'), FLOW).contextValue,
    presentNode(leaf('api', 'RestaurantsAsyncAPI'), FLOW).contextValue,
    presentNode(leaf('system', 'Orders', { related: true }), FLOW).contextValue,
    presentNode(leaf('saga-step', 'Saga'), FLOW).contextValue,
  ];
  const values = new Set<string>();
  for (const value of produced) {
    const body = value.slice('zenwave.hierarchy.'.length);
    const [kind, ...markers] = body.split('.');
    for (const order of permutations(markers)) values.add(['zenwave.hierarchy.' + kind, ...order].filter((part) => part.length > 0).join('.'));
  }
  return [...values];
}

function permutations(items: string[]): string[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations(items.filter((_, candidate) => candidate !== index)).map((rest) => [item, ...rest]));
}

function marker(value: string, name: string): boolean {
  return new RegExp(`\\.${name}(?:\\.|$)`).test(value);
}

/** Every `viewItem` regex in the manifest, evaluated against the context values the presenter produces. */
function assertMenuMarkers(menus: Record<string, { command: string; when?: string }[]>): void {
  const pattern = /viewItem =~ \/((?:\\\/|[^/])*)\//g;
  const values = contextValues();
  let checked = 0;
  for (const entries of Object.values(menus)) {
    for (const entry of entries) {
      for (const match of (entry.when ?? '').matchAll(pattern)) {
        const expression = new RegExp(match[1]!.replace(/\\\//g, '/'));
        for (const value of values) {
          let expected = true;
          if (expression.source.includes('related')) expected = expected && marker(value, 'related');
          if (expression.source.includes('declaration')) expected = expected && marker(value, 'declaration');
          if (expression.source.includes('references')) expected = expected && marker(value, 'references');
          assert.equal(expression.test(value), expected, `${entry.command} ${expression} against ${value}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 0, 'no viewItem clause was evaluated');
  const orders = values.find((value) => value.startsWith('zenwave.hierarchy.system'));
  assert.equal(orders, 'zenwave.hierarchy.system.related.declaration.references');
  assert.ok(values.includes('zenwave.hierarchy.event'), 'a policy event is not a declaration');
  assert.ok(values.includes('zenwave.hierarchy.relationship'), 'a relationship bucket is not a declaration');
  assert.ok(values.includes('zenwave.hierarchy.field.declaration') && !values.some((value) => value.startsWith('zenwave.hierarchy.field') && marker(value, 'references')));
  assert.ok(values.includes('zenwave.hierarchy.method.declaration') && !values.some((value) => value.startsWith('zenwave.hierarchy.method') && marker(value, 'references')));
  assert.ok(values.includes('zenwave.hierarchy.entity.declaration') && !values.some((value) => value.startsWith('zenwave.hierarchy.entity') && marker(value, 'references')));
}
