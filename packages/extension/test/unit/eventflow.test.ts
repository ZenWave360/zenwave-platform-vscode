import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DIAGRAM_STATE_KINDS, presentState, type DataState } from '../../src/eventflow/diagram-state.js';
import { buildFallbackHtml, buildPageHtml, contentSecurityPolicy, createNonce, HOST_SCRIPT } from '../../src/eventflow/page.js';
import { EVENTFLOW_PROTOCOL, EVENTFLOW_PROTOCOL_VERSION, EVENTFLOW_VIEW_TYPE, inboundMessage, readiness, type OutboundMessage } from '../../src/eventflow/protocol.js';
import { parsePositionsFile, positionsFileName, serializePositions, validatePositions, type PositionsFile } from '../../src/eventflow/positions.js';
import { DiagramSession } from '../../src/eventflow/session.js';
import { ZenwaveRequests, type EventFlowViews } from '../../src/lsp/requests.js';
import type { RequestResult } from '../../src/lsp/supervisor.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, '../fixtures/lsp-samples');
const json = (name: string): unknown => JSON.parse(readFileSync(join(samples, name), 'utf8'));
const manifest = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8'));

const URI = 'file:///workspace/place-order-flow.zfl';
const READY = { type: 'webviewReady', payload: { protocol: EVENTFLOW_PROTOCOL, protocolVersion: 1 } };
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(answer: () => RequestResult | Promise<RequestResult>, initial = { viewMode: 'flow' as const, displaySettings: { humanizeLabels: true } }, documentUri = URI, flowVariants = false, savedPositions = false) {
  const positionsFile = { file: { exists: false } as PositionsFile, written: [] as string[], removed: 0, readOnly: false };
  const posted: OutboundMessage[] = [];
  const logs: string[] = [];
  const commands: string[] = [];
  const asked: unknown[] = [];
  const requests = new ZenwaveRequests({ request: async (_method, params) => { asked.push(params); return answer(); } });
  const session = new DiagramSession({
    documentUri,
    fileName: 'place-order-flow.zfl',
    eventFlowViews: (uri, variant, positions) => requests.eventFlowViews(uri, variant, positions),
    flowVariants: () => flowVariants,
    savedPositions: () => savedPositions,
    positionsFile: {
      read: async () => positionsFile.file,
      write: async (positions) => {
        if (positionsFile.readOnly) return 'read-only';
        positionsFile.written.push(serializePositions(positions));
        positionsFile.file = { exists: true, positions };
        return 'written';
      },
      remove: async () => { positionsFile.removed++; positionsFile.file = { exists: false }; },
    },
    post: async (message) => { posted.push(message); return true; },
    runCommand: (command) => { commands.push(command); },
    log: { info: (line) => logs.push(line), warn: (line) => logs.push(line), debug: (line) => logs.push(line) },
  }, initial);
  const ofType = <T extends OutboundMessage['type']>(type: T) => posted.filter((message): message is Extract<OutboundMessage, { type: T }> => message.type === type);
  return { session, posted, logs, commands, ofType, asked, positionsFile };
}

const failure = (kind: string, extra: Record<string, unknown> = {}): RequestResult =>
  ({ kind: 'failed', reason: `server says ${kind}`, code: -32803, data: { kind, ...extra } });

/**
 * A view model that fails the test if anything reads it: every trap throws. Only
 * passing the reference along is allowed. Structured cloning by the real webview
 * happens outside the extension, after `postMessage`.
 */
function untouchable(name: string, touched: string[]): object {
  const record = (trap: string) => (): never => {
    touched.push(`${name}.${trap}`);
    throw new Error(`the extension inspected ${name} (${trap})`);
  };
  return new Proxy({}, {
    get: record('get'), has: record('has'), ownKeys: record('ownKeys'), getOwnPropertyDescriptor: record('getOwnPropertyDescriptor'),
    set: record('set'), defineProperty: record('defineProperty'), deleteProperty: record('deleteProperty'),
    getPrototypeOf: record('getPrototypeOf'), setPrototypeOf: record('setPrototypeOf'), isExtensible: record('isExtensible'),
    preventExtensions: record('preventExtensions'),
  });
}

test('the view model reaches the page as the same objects the server answered, and nothing reads them on the way', async () => {
  const touched: string[] = [];
  const flowGraph = untouchable('flowGraph', touched);
  const serviceGraph = untouchable('serviceGraph', touched);
  const { session, ofType, logs } = harness(() => ({ kind: 'ok', value: { flowGraph, serviceGraph } }));
  session.receive(READY);
  await session.refresh();
  const [render] = ofType('renderBundle');
  assert.ok(render, 'renderBundle was not posted');
  assert.equal(render.payload.flowGraph, flowGraph, 'flowGraph was replaced or copied');
  assert.equal(render.payload.serviceGraph, serviceGraph, 'serviceGraph was replaced or copied');
  assert.equal(render.payload.diagramId, URI);
  assert.deepEqual(Object.keys(render.payload).sort(), ['diagramId', 'displaySettings', 'flowGraph', 'serviceGraph', 'viewMode']);
  assert.deepEqual(touched, [], `the view model was inspected: ${touched.join(', ')}`);
  assert.ok(logs.some((line) => line.endsWith(': rendered')));
});

test('a recorded server answer is forwarded field for field, and the log never carries the model', async () => {
  const value = (json('eventFlowViews.json') as { result: EventFlowViews }).result;
  const expected = structuredClone(value);
  const { session, ofType, logs } = harness(() => ({ kind: 'ok', value }));
  await session.refresh();
  assert.equal(ofType('renderBundle').length, 0, 'renderBundle must wait for webviewReady');
  session.receive(READY);
  const [render] = ofType('renderBundle');
  assert.deepEqual(structuredClone({ flowGraph: render?.payload.flowGraph, serviceGraph: render?.payload.serviceGraph }), expected);
  assert.deepEqual(value, expected, 'the answer was modified');
  assert.deepEqual(render?.payload.viewMode, 'flow');
  assert.deepEqual(render?.payload.displaySettings, { humanizeLabels: true });
  for (const line of logs) {
    assert.ok(!line.includes('CheckoutStarted') && !line.includes('zfl.eventflow.view'), `the log carries model content: ${line}`);
  }
});

test('webviewReady is checked against the protocol version, and a mismatch is a named load failure', () => {
  assert.deepEqual(readiness(READY.payload), { kind: 'ready', protocolVersion: 1 });
  const missing = readiness(undefined);
  assert.equal(missing.kind, 'mismatch');
  assert.match(missing.kind === 'mismatch' ? missing.message : '', /states no protocol version/);
  const newer = readiness({ protocol: EVENTFLOW_PROTOCOL, protocolVersion: 2 });
  assert.match(newer.kind === 'mismatch' ? newer.message : '', /version 2; this extension needs zenwave\.eventflow\.webview version 1/);

  const { session, ofType } = harness(() => ({ kind: 'ok', value: { flowGraph: {}, serviceGraph: {} } }));
  session.receive({ type: 'webviewReady' });
  assert.equal(session.page.kind, 'failed');
  assert.equal(session.state?.kind, 'page-failed');
  assert.equal(session.state?.mode, 'overlay');
  assert.match(session.state?.detail ?? '', /states no protocol version/);
  assert.equal(ofType('zenwave.host.state').at(-1)?.payload?.kind, 'page-failed');
});

test('an asset that fails to load before the page is ready, or a page that never says it loaded, is a load failure', () => {
  const broken = harness(() => ({ kind: 'ok', value: { flowGraph: {}, serviceGraph: {} } }));
  broken.session.receive({ type: 'zenwave.host.loadError', payload: { message: 'Could not load https://x/assets/index.js' } });
  assert.equal(broken.session.state?.kind, 'page-failed');
  const silent = harness(() => ({ kind: 'ok', value: { flowGraph: {}, serviceGraph: {} } }));
  silent.session.pageTimedOut(30);
  assert.match(silent.session.state?.detail ?? '', /did not report that it loaded within 30 seconds/);
  const late = harness(() => ({ kind: 'ok', value: { flowGraph: {}, serviceGraph: {} } }));
  late.session.receive(READY);
  late.session.receive({ type: 'zenwave.host.loadError', payload: { message: 'a runtime error' } });
  late.session.pageTimedOut(30);
  assert.equal(late.session.page.kind, 'ready', 'errors after the page loaded are logged, not a load failure');
});

test('the last good diagram stays on screen while the document cannot be read, and the next good one replaces it', async () => {
  let answer: RequestResult = { kind: 'ok', value: { flowGraph: { n: 1 }, serviceGraph: { n: 1 } } };
  const { session, ofType } = harness(() => answer);
  session.receive(READY);
  await session.refresh();
  assert.equal(ofType('renderBundle').length, 1);
  answer = failure('documentUnreadable', { diagnostics: [{ message: 'mismatched input' }] });
  await session.refresh();
  assert.equal(ofType('renderBundle').length, 1, 'a failure must not re-render');
  assert.equal(session.state?.kind, 'unreadable');
  assert.equal(session.state?.mode, 'banner', 'with a diagram on screen the failure is a banner, not an empty state');
  answer = { kind: 'ok', value: { flowGraph: { n: 2 }, serviceGraph: { n: 2 } } };
  await session.refresh();
  assert.equal(ofType('renderBundle').length, 2);
  assert.deepEqual(ofType('renderBundle')[1]?.payload.flowGraph, { n: 2 });
  assert.equal(session.state, null);
});

test('an answer overtaken by a newer request is dropped, so the last document typed is the one shown', async () => {
  const resolvers: ((value: RequestResult) => void)[] = [];
  const { session, ofType } = harness(() => new Promise<RequestResult>((resolve) => resolvers.push(resolve)));
  session.receive(READY);
  const first = session.refresh();
  const second = session.refresh();
  await settle();
  resolvers[1]?.({ kind: 'ok', value: { flowGraph: { v: 'new' }, serviceGraph: {} } });
  await second;
  resolvers[0]?.({ kind: 'ok', value: { flowGraph: { v: 'old' }, serviceGraph: {} } });
  await first;
  assert.deepEqual(ofType('renderBundle').map((message) => message.payload.flowGraph), [{ v: 'new' }]);
});

test('each reason for having nothing to show is its own state, explained, with something to do about it', async () => {
  const cases: [RequestResult, string][] = [
    [{ kind: 'no-server', reason: 'ZenWave language server is turned off' }, 'no-server'],
    [{ kind: 'unsupported', method: 'zenwave/eventFlowViews' }, 'unsupported'],
    [failure('documentUnreadable', { diagnostics: [] }), 'unreadable'],
    [failure('documentNotFound'), 'not-found'],
    [failure('unsupportedDocument'), 'unsupported-document'],
    [{ kind: 'failed', reason: 'timed out' }, 'failed'],
  ];
  const titles = new Set<string>();
  for (const [result, kind] of cases) {
    const { session } = harness(() => result);
    session.receive(READY);
    await session.refresh();
    assert.equal(session.state?.kind, kind);
    assert.equal(session.state?.mode, 'overlay');
    assert.ok((session.state?.actions.length ?? 0) > 0, `${kind} offers nothing to do`);
    titles.add(session.state?.title ?? '');
  }
  assert.equal(titles.size, cases.length, 'two states read the same');
  const loading = harness(() => ({ kind: 'no-server', reason: 'x' }));
  assert.equal(loading.session.state?.kind, 'loading', 'before an answer the editor says it is working');
  assert.match(presentState('a.zfl', { kind: 'ready', protocolVersion: 1 }, { kind: 'no-server', reason: 'off' }, false)?.title ?? '', /needs the ZenWave language server/);
  const everyKind: DataState['kind'][] = ['loading', 'rendered', 'no-server', 'unsupported', 'unreadable', 'not-found', 'unsupported-document', 'failed'];
  assert.deepEqual([...DIAGRAM_STATE_KINDS].sort(), [...everyKind, 'page-failed'].sort());
});

test('every renderBundle names the diagram by its document, and a later update of the same diagram keeps that id', async () => {
  const first = harness(() => ({ kind: 'ok', value: { flowGraph: { n: 1 }, serviceGraph: {} } }));
  const second = harness(() => ({ kind: 'ok', value: { flowGraph: {}, serviceGraph: {} } }), undefined, 'file:///workspace/checkout.zfl');
  for (const { session } of [first, second]) session.receive(READY);
  await first.session.refresh();
  await first.session.refresh();
  await second.session.refresh();
  assert.deepEqual(first.ofType('renderBundle').map((message) => message.payload.diagramId), [URI, URI]);
  assert.equal(second.ofType('renderBundle')[0]?.payload.diagramId, 'file:///workspace/checkout.zfl');
});

test('view and label choices are kept per diagram and survive a re-render', async () => {
  const value = { flowGraph: {}, serviceGraph: {} };
  const one = harness(() => ({ kind: 'ok', value }), { viewMode: 'flow', displaySettings: { humanizeLabels: true } });
  const two = harness(() => ({ kind: 'ok', value }), { viewMode: 'flow', displaySettings: { humanizeLabels: true } });
  for (const { session } of [one, two]) { session.receive(READY); await session.refresh(); }
  one.session.setViewMode('services');
  one.session.setDisplaySettings({ humanizeLabels: false });
  assert.deepEqual(one.ofType('setViewMode').map((message) => message.payload), [{ viewMode: 'services' }]);
  assert.deepEqual(one.ofType('setDisplaySettings').map((message) => message.payload), [{ displaySettings: { humanizeLabels: false } }]);
  await one.session.refresh();
  const last = one.ofType('renderBundle').at(-1);
  assert.equal(last?.payload.viewMode, 'services');
  assert.deepEqual(last?.payload.displaySettings, { humanizeLabels: false });
  assert.equal(two.session.viewMode, 'flow');
  assert.equal(two.ofType('setViewMode').length, 0);
  const services = harness(() => ({ kind: 'ok', value }), { viewMode: 'services', displaySettings: { humanizeLabels: false } });
  services.session.receive(READY);
  await services.session.refresh();
  assert.equal(services.ofType('renderBundle')[0]?.payload.viewMode, 'services', 'the configured default view is the initial one');
});

test('a view chosen in the page selector is recorded without telling the page, and the next render carries it', async () => {
  const value = { flowGraph: {}, serviceGraph: {} };
  const { session, ofType, posted } = harness(() => ({ kind: 'ok', value }));
  session.receive(READY);
  await session.refresh();
  const before = posted.length;
  session.receive({ type: 'viewModeChanged', payload: { viewMode: 'services' } });
  assert.equal(session.viewMode, 'services');
  assert.equal(posted.length, before, 'nothing is posted back to the page');
  assert.equal(ofType('setViewMode').length, 0);
  await session.refresh();
  assert.equal(ofType('renderBundle').at(-1)?.payload.viewMode, 'services', 're-render after a selector change');
  // The title commands end in the same state: the same view as a command is not posted twice, the other one is.
  session.setViewMode('services');
  assert.equal(ofType('setViewMode').length, 0);
  session.setViewMode('flow');
  assert.deepEqual(ofType('setViewMode').map((message) => message.payload), [{ viewMode: 'flow' }]);
  // Then the page flips back.
  session.receive({ type: 'viewModeChanged', payload: { viewMode: 'flow' } });
  session.receive({ type: 'viewModeChanged', payload: { viewMode: 'services' } });
  assert.equal(session.viewMode, 'services');
});

test('viewModeChanged with another view than flow or services is ignored', () => {
  const { session } = harness(() => ({ kind: 'no-server', reason: 'off' }));
  for (const payload of [{ viewMode: 'timeline' }, { viewMode: 3 }, {}, null, 'services']) {
    session.receive({ type: 'viewModeChanged', payload });
    assert.equal(session.viewMode, 'flow', JSON.stringify(payload));
    assert.equal(inboundMessage({ type: 'viewModeChanged', payload }), undefined);
  }
  assert.deepEqual(inboundMessage({ type: 'viewModeChanged', payload: { viewMode: 'services', extra: 1 } }), { type: 'viewModeChanged', payload: { viewMode: 'services' } });
});

test('a highlight asked for before the diagram is on the page is applied once it is', async () => {
  const { session, ofType } = harness(() => ({ kind: 'ok', value: { flowGraph: {}, serviceGraph: {} } }));
  session.highlightNode('command:createOrder');
  assert.equal(ofType('highlightNode').length, 0);
  session.receive(READY);
  await session.refresh();
  session.highlightNode(null);
  assert.deepEqual(ofType('highlightNode').map((message) => message.payload.nodeId), ['command:createOrder', null]);
});

test('the page can run only the actions the editor is offering', async () => {
  const { session, commands } = harness(() => ({ kind: 'no-server', reason: 'off' }));
  session.receive(READY);
  await session.refresh();
  session.receive({ type: 'zenwave.host.action', payload: { command: 'zenwave.lsp.showStatus' } });
  session.receive({ type: 'zenwave.host.action', payload: { command: 'workbench.action.terminal.new' } });
  assert.deepEqual(commands, ['zenwave.lsp.showStatus']);
});

test('the page gets webview URIs for its assets, a CSP without remote or inline allowances, and the host script first', () => {
  const index = readFileSync(join(here, '../fixtures/eventflow/index.html'), 'utf8');
  const html = buildPageHtml(index, { assetUri: (path) => `https://file+.vscode-resource.vscode-cdn.net/ext/dist/eventflow-webview/${path}`, cspSource: 'https://*.vscode-cdn.net', nonce: 'abc123' });
  assert.ok(html.includes('src="https://file+.vscode-resource.vscode-cdn.net/ext/dist/eventflow-webview/assets/index-DquKNvpo.js"'));
  assert.ok(html.includes('href="https://file+.vscode-resource.vscode-cdn.net/ext/dist/eventflow-webview/assets/index-B5q_aPuf.css"'));
  assert.ok(!html.includes('"./assets/'));
  const csp = contentSecurityPolicy('https://*.vscode-cdn.net', 'abc123');
  assert.ok(html.includes(`content="${csp}"`));
  assert.match(csp, /^default-src 'none'; /);
  assert.ok(!/unsafe-inline|unsafe-eval|http:|\*;|connect-src/.test(csp.replaceAll('https://*.vscode-cdn.net', '')), csp);
  assert.ok(html.indexOf('acquireVsCodeApi()') < html.indexOf('<script type="module"'), 'the host script must run before the page acquires the API');
  assert.equal((HOST_SCRIPT.match(/acquireVsCodeApi\(\)/g) ?? []).length, 1);
  assert.ok(HOST_SCRIPT.includes('window.__zenwaveVsCodeApi = api'));
  assert.throws(() => buildPageHtml(index.replace('./assets/index-B5q_aPuf.css', 'https://fonts.example/x.css'), { assetUri: (path) => path, cspSource: 's', nonce: 'n' }), /references https:\/\/fonts\.example/);
  assert.throws(() => buildPageHtml('<html><head></head></html>', { assetUri: (path) => path, cspSource: 's', nonce: 'n' }), /no \.\/assets/);
  assert.ok(buildFallbackHtml({ cspSource: 's', nonce: 'n' }).includes("nonce-n"));
  assert.match(createNonce(), /^[0-9a-f]{36}$/);
  assert.notEqual(createNonce(), createNonce());
});

test('the manifest registers an optional diagram editor for .zfl and offers it from one submenu', () => {
  const contributes = manifest.contributes;
  assert.deepEqual(contributes.customEditors.filter((editor: { viewType: string }) => editor.viewType === EVENTFLOW_VIEW_TYPE), [{ viewType: EVENTFLOW_VIEW_TYPE, displayName: 'ZenWave EventFlow Diagram', selector: [{ filenamePattern: '*.zfl' }], priority: 'option' }]);
  assert.deepEqual(manifest.zenwaveEventFlowWebview, { package: '@zenwave360/vistas-eventflow-webview', version: manifest.devDependencies['@zenwave360/vistas-eventflow-webview'], protocol: EVENTFLOW_PROTOCOL, protocolVersion: EVENTFLOW_PROTOCOL_VERSION });
  const title = contributes.menus['editor/title'] as { command?: string; submenu?: string; when: string }[];
  assert.deepEqual(title.filter((item) => item.submenu).map((item) => [item.submenu, item.when]), [
    ['zenwave.zflViews', 'resourceExtname == .zfl && !isInDiffEditor'],
    ['zenwave.zdlViews', 'resourceExtname == .zdl && !isInDiffEditor'],
    ['zenwave.zwViews', 'resourceExtname == .zw && !isInDiffEditor'],
  ]);
  assert.ok(!title.some((item) => item.command === 'zenwave.eventflow.open' || item.command === 'zenwave.eventflow.openToSide'), 'no title-bar icon of its own');
  const submenu = contributes.menus['zenwave.zflViews'] as { command: string; when: string }[];
  assert.deepEqual(submenu.map((item) => item.command).filter((command) => command.startsWith('zenwave.eventflow.')).sort(), ['zenwave.eventflow.open', 'zenwave.eventflow.openToSide', 'zenwave.eventflow.showText']);
  for (const item of submenu.filter((entry) => entry.command === 'zenwave.eventflow.open' || entry.command === 'zenwave.eventflow.openToSide')) assert.match(item.when, /^resourceExtname == .zfl /, `${item.command} stays on ZFL only`);
  for (const item of title.filter((entry) => entry.command?.startsWith('zenwave.eventflow.'))) {
    assert.match(item.when, /^activeCustomEditorId == zenwave\.eventflow && /, `${item.command} is not scoped to the diagram editor`);
  }
  const toggles = Object.fromEntries(title.filter((entry) => entry.command).map((entry) => [entry.command, entry.when]));
  assert.ok(toggles['zenwave.eventflow.showServiceView']?.endsWith('zenwave.eventflowViewMode == flow'));
  assert.ok(toggles['zenwave.eventflow.showFlowView']?.endsWith('zenwave.eventflowViewMode == services'));
  assert.ok(toggles['zenwave.eventflow.showLabelsAsWritten']?.endsWith('&& zenwave.eventflowHumanizeLabels'));
  assert.ok(toggles['zenwave.eventflow.showHumanizedLabels']?.endsWith('&& !zenwave.eventflowHumanizeLabels'));
  const palette = Object.fromEntries((contributes.menus.commandPalette as { command: string; when?: string }[]).map((entry) => [entry.command, entry.when]));
  assert.match(palette['zenwave.eventflow.open'] ?? '', /resourceExtname == \.zfl/);
  assert.match(palette['zenwave.eventflow.openToSide'] ?? '', /resourceExtname == \.zfl/);
  assert.deepEqual(contributes.configuration.properties['zenwave.eventflow.defaultView'].enum, ['flow', 'services']);
  assert.equal(contributes.configuration.properties['zenwave.eventflow.humanizeLabels'].default, true);
});

const VARIANTS = [{ id: 'happy', title: 'Happy path' }, { id: 'out-of-stock', title: 'Out of stock' }];
const withVariants = (flowGraph: object = { schema: 'full' }): RequestResult =>
  ({ kind: 'ok', value: { flowGraph: { schema: 'g', ...flowGraph }, serviceGraph: { schema: 's' }, variants: VARIANTS } });
const invalidVariant: RequestResult = { kind: 'failed', reason: 'unknown variant', code: -32602 };

test('renderBundle carries variants and the full diagram as variant null only when the server advertised flowVariants', async () => {
  const on = harness(() => withVariants(), undefined, URI, true);
  on.session.receive(READY);
  await on.session.refresh();
  assert.deepEqual(on.session.lastRenderBundle?.variants, VARIANTS);
  assert.equal(on.session.lastRenderBundle?.variant, null);

  const off = harness(() => withVariants());
  off.session.receive(READY);
  await off.session.refresh();
  assert.equal('variants' in (off.session.lastRenderBundle ?? {}), false);
  assert.equal('variant' in (off.session.lastRenderBundle ?? {}), false);
  off.session.receive({ type: 'variantChanged', payload: { variant: 'happy' } });
  await settle();
  assert.equal(off.asked.length, 1, 'a server without the capability is never asked for a variant');
});

test('variantChanged requests that variant, omits it for null, and the choice survives a document change', async () => {
  const h = harness(() => withVariants(), undefined, URI, true);
  h.session.receive(READY);
  await h.session.refresh();
  h.session.receive({ type: 'variantChanged', payload: { variant: 'happy' } });
  await settle();
  assert.deepEqual(h.asked.at(-1), { textDocument: { uri: URI }, variant: 'happy' });
  assert.equal(h.session.lastRenderBundle?.variant, 'happy');
  assert.equal(h.session.lastRenderBundle?.diagramId, URI);
  await h.session.refresh();
  assert.deepEqual(h.asked.at(-1), { textDocument: { uri: URI }, variant: 'happy' });
  h.session.receive({ type: 'variantChanged', payload: { variant: null } });
  await settle();
  assert.deepEqual(h.asked.at(-1), { textDocument: { uri: URI } });
  assert.equal(h.session.lastRenderBundle?.variant, null);
});

test('a variant the server no longer knows (-32602) falls back to the full diagram and renders it', async () => {
  let gone = false;
  const h = harness(() => gone && (h.asked.at(-1) as { variant?: string }).variant ? invalidVariant : withVariants(), undefined, URI, true);
  h.session.receive(READY);
  await h.session.refresh();
  h.session.receive({ type: 'variantChanged', payload: { variant: 'happy' } });
  await settle();
  assert.equal(h.session.lastRenderBundle?.variant, 'happy');
  gone = true;
  const before = h.asked.length;
  await h.session.refresh();
  assert.equal(h.asked.length - before, 2);
  assert.deepEqual(h.asked.at(-1), { textDocument: { uri: URI } });
  assert.equal(h.session.lastRenderBundle?.variant, null);
  assert.equal(h.session.data.kind, 'rendered');
});

test('variantChanged with an unknown payload is ignored', () => {
  assert.equal(inboundMessage({ type: 'variantChanged', payload: { variant: 3 } }), undefined);
  assert.deepEqual(inboundMessage({ type: 'variantChanged', payload: { variant: null } }), { type: 'variantChanged', payload: { variant: null } });
});

const SAVED = { 'command:A': { x: 120, y: 40 }, 'event:B': { x: 300, y: 40 } };
const answerWith = (savedPositions?: object): RequestResult =>
  ({ kind: 'ok', value: { flowGraph: { schema: 'g' }, serviceGraph: { schema: 's' }, variants: VARIANTS, ...(savedPositions ? { savedPositions } : {}) } });
const positionsHarness = (answer: () => RequestResult = () => answerWith({ applied: true })) => harness(answer, undefined, URI, true, true);

test('with the capability and a file, the full diagram request carries positions and renderBundle says they applied', async () => {
  const h = positionsHarness();
  h.positionsFile.file = { exists: true, positions: SAVED };
  h.session.receive(READY);
  await h.session.refresh();
  assert.deepEqual(h.asked.at(-1), { textDocument: { uri: URI }, positions: SAVED });
  assert.deepEqual(h.session.lastRenderBundle?.savedPositions, { exists: true, applied: true });
  assert.equal(h.session.savedPositionsExist, true);
});

test('a file the server cannot apply is reported with the nodes it lacks', async () => {
  const h = positionsHarness(() => answerWith({ applied: false, reason: 'missing-nodes', missing: ['command:C'] }));
  h.positionsFile.file = { exists: true, positions: SAVED };
  h.session.receive(READY);
  await h.session.refresh();
  assert.deepEqual(h.session.lastRenderBundle?.savedPositions, { exists: true, applied: false, missing: ['command:C'] });
});

test('no file: renderBundle says exists false and the request carries no positions', async () => {
  const h = positionsHarness(() => answerWith());
  h.session.receive(READY);
  await h.session.refresh();
  assert.deepEqual(h.asked.at(-1), { textDocument: { uri: URI } });
  assert.deepEqual(h.session.lastRenderBundle?.savedPositions, { exists: false, applied: false });
  assert.equal(h.session.savedPositionsExist, false);
});

test('a file that does not parse or has an unknown schema exists but is not sent, and the log says why', async () => {
  for (const text of ['{ nope', '{"schema":"other@9","flow":{}}']) {
    const h = positionsHarness(() => answerWith());
    h.positionsFile.file = parsePositionsFile(text);
    h.session.receive(READY);
    await h.session.refresh();
    assert.deepEqual(h.asked.at(-1), { textDocument: { uri: URI } });
    assert.deepEqual(h.session.lastRenderBundle?.savedPositions, { exists: true, applied: false });
    assert.ok(h.logs.some((line) => line.includes('saved positions file is ignored')), h.logs.join('\n'));
  }
});

test('a variant request never carries positions, and renderBundle has no savedPositions for it', async () => {
  const h = positionsHarness();
  h.positionsFile.file = { exists: true, positions: SAVED };
  h.session.receive(READY);
  await h.session.refresh();
  h.session.receive({ type: 'variantChanged', payload: { variant: 'happy' } });
  await settle();
  assert.deepEqual(h.asked.at(-1), { textDocument: { uri: URI }, variant: 'happy' });
  assert.equal('savedPositions' in (h.session.lastRenderBundle ?? {}), false);
  h.session.receive({ type: 'savePositions', payload: { positions: SAVED } });
  await settle();
  assert.deepEqual(h.positionsFile.written, [], 'positions are saved only from the full diagram');
});

test('without the capability nothing about positions is read, sent or reported', async () => {
  const h = harness(() => answerWith(), undefined, URI, true, false);
  h.positionsFile.file = { exists: true, positions: SAVED };
  h.session.receive(READY);
  await h.session.refresh();
  assert.deepEqual(h.asked.at(-1), { textDocument: { uri: URI } });
  assert.equal('savedPositions' in (h.session.lastRenderBundle ?? {}), false);
  h.session.receive({ type: 'savePositions', payload: { positions: SAVED } });
  await settle();
  assert.deepEqual(h.positionsFile.written, []);
});

test('savePositions writes sorted keys, whole numbers and the schema, then asks again with them', async () => {
  const h = positionsHarness();
  h.session.receive(READY);
  await h.session.refresh();
  const before = h.asked.length;
  h.session.receive({ type: 'savePositions', payload: { positions: { 'b:2': { x: 10.6, y: -3.2 }, '10': { x: 1, y: 2 }, '2': { x: 0, y: 0.4 }, 'a:1': { x: 120, y: 40 } } } });
  await settle();
  assert.deepEqual(h.positionsFile.written, [
    '{\n  "schema": "zfl.eventflow.positions@1",\n  "flow": {\n' +
    '    "10": { "x": 1, "y": 2 },\n    "2": { "x": 0, "y": 0 },\n    "a:1": { "x": 120, "y": 40 },\n    "b:2": { "x": 11, "y": -3 }\n  }\n}\n',
  ]);
  assert.equal(h.asked.length, before + 1, 're-requested after saving');
  assert.deepEqual((h.asked.at(-1) as { positions: object }).positions, { 'b:2': { x: 11, y: -3 }, '10': { x: 1, y: 2 }, '2': { x: 0, y: 0 }, 'a:1': { x: 120, y: 40 } });
  assert.equal(h.session.savedPositionsExist, true);
});

test('a read-only workspace writes nothing and does not re-request', async () => {
  const h = positionsHarness();
  h.positionsFile.readOnly = true;
  h.session.receive(READY);
  await h.session.refresh();
  const before = h.asked.length;
  h.session.receive({ type: 'savePositions', payload: { positions: SAVED } });
  await settle();
  assert.deepEqual(h.positionsFile.written, []);
  assert.equal(h.asked.length, before);
});

test('savePositions with values that are not finite numbers is ignored', () => {
  for (const positions of [null, [], { a: { x: 'ten', y: 1 } }, { a: { x: 1 } }, { a: null }, { a: { x: Number.POSITIVE_INFINITY, y: 1 } }]) {
    assert.equal(inboundMessage({ type: 'savePositions', payload: { positions } }), undefined);
  }
  assert.deepEqual(validatePositions({ a: { x: 1.5, y: -0.4 } }), { a: { x: 2, y: 0 } });
});

test('discardSavedPositions deletes the file and asks again without positions', async () => {
  const h = positionsHarness(() => answerWith());
  h.positionsFile.file = { exists: true, positions: SAVED };
  h.session.receive(READY);
  await h.session.refresh();
  assert.equal(h.session.savedPositionsExist, true);
  await h.session.discardSavedPositions();
  assert.equal(h.positionsFile.removed, 1);
  assert.deepEqual(h.asked.at(-1), { textDocument: { uri: URI } });
  assert.deepEqual(h.session.lastRenderBundle?.savedPositions, { exists: false, applied: false });
  assert.equal(h.session.savedPositionsExist, false);
});

test('the positions file sits beside the model and the discard command is contributed for the diagram only when the file exists', () => {
  assert.equal(positionsFileName('checkout.zfl'), 'checkout.zfl.positions.json');
  const { contributes } = manifest;
  const command = contributes.commands.find((entry: { command: string }) => entry.command === 'zenwave.eventflow.discardSavedPositions');
  assert.equal(command.title, 'Discard Saved Positions');
  assert.equal(command.category, 'ZenWave');
  const when = 'activeCustomEditorId == zenwave.eventflow && zenwave.eventflowPositionsExist';
  assert.equal(contributes.menus.commandPalette.find((entry: { command: string }) => entry.command === command.command).when, when);
  const title = contributes.menus['editor/title'].find((entry: { command: string }) => entry.command === command.command);
  assert.equal(title.when, when);
  assert.ok(!String(title.group).startsWith('navigation'), 'it belongs to the ... menu');
});
