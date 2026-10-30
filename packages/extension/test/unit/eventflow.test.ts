import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DIAGRAM_STATE_KINDS, presentState, type DataState } from '../../src/eventflow/diagram-state.js';
import { buildFallbackHtml, buildPageHtml, contentSecurityPolicy, createNonce, HOST_SCRIPT } from '../../src/eventflow/page.js';
import { EVENTFLOW_PROTOCOL, EVENTFLOW_PROTOCOL_VERSION, EVENTFLOW_VIEW_TYPE, readiness, type OutboundMessage } from '../../src/eventflow/protocol.js';
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

function harness(answer: () => RequestResult | Promise<RequestResult>, initial = { viewMode: 'flow' as const, displaySettings: { humanizeLabels: true } }) {
  const posted: OutboundMessage[] = [];
  const logs: string[] = [];
  const commands: string[] = [];
  const requests = new ZenwaveRequests({ request: async () => answer() });
  const session = new DiagramSession({
    documentUri: URI,
    fileName: 'place-order-flow.zfl',
    eventFlowViews: (uri) => requests.eventFlowViews(uri),
    post: async (message) => { posted.push(message); return true; },
    runCommand: (command) => { commands.push(command); },
    log: { info: (line) => logs.push(line), warn: (line) => logs.push(line), debug: (line) => logs.push(line) },
  }, initial);
  const ofType = <T extends OutboundMessage['type']>(type: T) => posted.filter((message): message is Extract<OutboundMessage, { type: T }> => message.type === type);
  return { session, posted, logs, commands, ofType };
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
  assert.deepEqual(Object.keys(render.payload).sort(), ['displaySettings', 'flowGraph', 'serviceGraph', 'viewMode']);
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
  assert.deepEqual(manifest.zenwaveEventFlowWebview, { package: '@zenwave360/vistas-eventflow-webview', version: '0.1.0', protocol: EVENTFLOW_PROTOCOL, protocolVersion: EVENTFLOW_PROTOCOL_VERSION });
  const title = contributes.menus['editor/title'] as { command?: string; submenu?: string; when: string }[];
  assert.deepEqual(title.filter((item) => item.submenu).map((item) => [item.submenu, item.when]), [['zenwave.modelViews', '(resourceExtname == .zfl || resourceExtname == .zdl) && !isInDiffEditor']]);
  assert.ok(!title.some((item) => item.command === 'zenwave.eventflow.open' || item.command === 'zenwave.eventflow.openToSide'), 'no title-bar icon of its own');
  const submenu = contributes.menus['zenwave.modelViews'] as { command: string; when: string }[];
  assert.deepEqual(submenu.map((item) => item.command).filter((command) => command.startsWith('zenwave.eventflow.')).sort(), ['zenwave.eventflow.open', 'zenwave.eventflow.openToSide', 'zenwave.eventflow.showText']);
  for (const item of submenu.filter((entry) => entry.command === 'zenwave.eventflow.open' || entry.command === 'zenwave.eventflow.openToSide')) assert.match(item.when, /^resourceExtname == .zfl /, `${item.command} stays on ZFL only`);
  for (const item of title.filter((entry) => entry.command)) {
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
