import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { HierarchyNode } from '../../src/lsp/requests.js';
import { CoalescedRefresh, type Scheduler } from '../../src/explorer/coalesce.js';
import { DiagramPanels, reflectSelection } from '../../src/explorer/diagram-selection.js';
import { followDecision, isModelDocument, tabDocumentUri } from '../../src/explorer/follow.js';
import { buildTree, findNode, NEUTRAL_ICON, nodeAt, presentNode, walk } from '../../src/explorer/hierarchy-model.js';
import { describeState, serverUnavailable, stateFromResult, TREE_STATE_KINDS } from '../../src/explorer/tree-state.js';

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

test('nodes present in this client vocabulary, and a kind released later still renders under its name', () => {
  const tree = buildTree(FLOW, sample('hierarchy-unopened-zfl.json'));
  const systems = presentNode(tree.roots[0]!, FLOW);
  assert.equal(systems.label, 'Systems', 'a structural section reads like a VS Code tree');
  const orders = presentNode(findNode(tree, byLabel('Orders', 'system'))!, FLOW);
  assert.equal(orders.label, 'Orders');
  assert.equal(orders.description, 'model.zdl', 'a node declared elsewhere names that document');
  assert.equal(orders.contextValue, 'zenwave.hierarchy.system.related');
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

test('the node at a cursor is the narrowest declaration containing it, in the document the cursor is in', () => {
  const tree = buildTree(FLOW, sample('hierarchy-unopened-zfl.json'));
  assert.equal(nodeAt(tree, FLOW, { line: 21, character: 8 })?.node.kind, 'policy', 'the when block, not a part repeated under it');
  assert.equal(nodeAt(tree, FLOW, { line: 11, character: 0 })?.node.label, 'CheckoutStarted');
  assert.equal(nodeAt(tree, ZDL, { line: 5, character: 10 })?.node.label, 'createOrder');
  assert.equal(nodeAt(tree, ZDL, { line: 4, character: 2 })?.node.label, 'OrderService');
  assert.equal(nodeAt(tree, FLOW, { line: 8, character: 0 }), undefined);
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
      menus: Record<string, { command: string; when?: string }[]>;
    };
  };
  const { contributes } = manifest;
  assert.ok(contributes.viewsContainers.activitybar.some((container) => container.id === 'zenwave' && container.icon.length > 0));
  assert.deepEqual(contributes.views.zenwave?.map((view) => [view.id, view.name]), [['zenwave.architecture', 'Architecture'], ['zenwave.model', 'Model']]);
  for (const view of ['zenwave.architecture', 'zenwave.model']) assert.ok(manifest.activationEvents.includes(`onView:${view}`));

  const keys = { 'zenwave.architecture': 'zenwave.architectureTreeState', 'zenwave.model': 'zenwave.modelTreeState' } as const;
  for (const [view, key] of Object.entries(keys)) {
    const relevant = TREE_STATE_KINDS.filter((kind) => kind !== 'ready' && (kind !== 'no-manifest' || view === 'zenwave.architecture') && (kind !== 'no-model' || view === 'zenwave.model'));
    for (const kind of relevant) {
      const entries = contributes.viewsWelcome.filter((entry) => entry.view === view && entry.when === `${key} == ${kind}`);
      assert.equal(entries.length, 1, `${view} explains ${kind}`);
    }
  }
  const noManifest = contributes.viewsWelcome.find((entry) => entry.when === 'zenwave.architectureTreeState == no-manifest');
  assert.match(noManifest?.contents ?? '', /command:workbench\.action\.openSettings\?%5B%22zenwave\.workspace\.manifest%22%5D/, 'no manifest links to the setting');
  const related = contributes.menus['view/item/context']?.find((entry) => entry.command === 'zenwave.explorer.openRelated');
  assert.ok((related?.when ?? '').includes('viewItem =~ /\\.related$/'), `related resources menu: ${related?.when}`);
});
