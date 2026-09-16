import assert from 'node:assert/strict';
import test from 'node:test';
import { advertisedRequests, LspSupervisor, type LspTransport } from '../../src/lsp/supervisor.js';

const INITIALIZE = { capabilities: { experimental: { customRequests: ['zenwave/workspaceStatus'] } } };

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function harness() {
  const log: string[] = [];
  const logger = { info: (value: string) => log.push(value), warn: (value: string) => log.push(value), error: (value: string) => log.push(value) };
  const requests: { method: string; params: unknown }[] = [];
  let starts = 0;
  let stops = 0;
  let disposed = 0;
  let exit: ((reason: string) => void) | undefined;
  const transport: LspTransport = {
    start: async () => { starts++; return INITIALIZE; },
    stop: async () => { stops++; },
    sendRequest: async (method, params) => { requests.push({ method, params }); return { status: 'ready' }; },
    onDidExit: (listener) => { exit = listener; return { dispose: () => { disposed++; } }; },
  };
  return { logger, log, transport, requests, get starts() { return starts; }, get stops() { return stops; }, get disposed() { return disposed; }, crash: () => exit?.('server exited') };
}

test('missing LSP transport returns no-server promptly without throwing', async () => {
  const h = harness();
  const supervisor = new LspSupervisor(undefined, h.logger);
  await supervisor.start();
  assert.equal(supervisor.state.kind, 'unavailable');
  assert.equal((await supervisor.request('zenwave/workspaceStatus', undefined)).kind, 'no-server');
  assert.equal(h.starts, 0);
});

test('initialize capability discovery ignores malformed and non-ZenWave entries', () => {
  for (const invalid of [undefined, null, [], {}, { capabilities: { experimental: { customRequests: 'zenwave/workspaceStatus' } } }]) {
    assert.equal(advertisedRequests(invalid).size, 0);
  }
  assert.deepEqual([...advertisedRequests({ capabilities: { experimental: {
    customRequests: ['zenwave/workspaceStatus', 42, null, 'textDocument/hover', 'zenwave/workspaceStatus'],
  } } })], ['zenwave/workspaceStatus']);
});

test('concurrent starts share one session and unsupported requests never reach the wire', async () => {
  const h = harness();
  const supervisor = new LspSupervisor(() => h.transport, h.logger);
  const states: string[] = [];
  const subscription = supervisor.onDidChangeState((state) => states.push(state.kind));
  await Promise.all([supervisor.start(), supervisor.start()]);
  assert.equal(h.starts, 1);
  assert.deepEqual(states, ['starting', 'connected']);
  assert.equal(supervisor.supports('zenwave/workspaceStatus'), true);
  assert.deepEqual(await supervisor.request('zenwave/preview', {}), { kind: 'unsupported', method: 'zenwave/preview' });
  assert.deepEqual(h.requests, []);
  assert.ok(h.log.some((line) => line.includes('does not advertise zenwave/preview')));
  subscription.dispose();
  await supervisor.stop();
  assert.deepEqual(states, ['starting', 'connected']);
});

test('successful LSP request keeps the payload unchanged and failures remain distinguishable', async () => {
  const h = harness();
  const payload = { unknownFutureField: ['preserve', { nested: true }] };
  h.transport.sendRequest = async (method, params) => { h.requests.push({ method, params }); return payload; };
  const supervisor = new LspSupervisor(() => h.transport, h.logger);
  await supervisor.start();
  const params = { uri: 'file:///order.zdl', privateModel: 'must not be logged' };
  const result = await supervisor.request('zenwave/workspaceStatus', params);
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') assert.equal(result.value, payload);
  assert.equal(h.requests[0]?.params, params);
  h.transport.sendRequest = async () => { throw new Error('wire failed'); };
  assert.deepEqual(await supervisor.request('zenwave/workspaceStatus', undefined), { kind: 'failed', reason: 'wire failed' });
  assert.equal(supervisor.state.kind, 'connected');
  assert.equal(h.log.some((line) => line.includes(params.privateModel)), false);
  await supervisor.stop();
});

test('startup failure cleans up once and restart can connect a new transport', async () => {
  const first = harness();
  const second = harness();
  first.transport.start = async () => { throw new Error('cannot launch'); };
  let attempt = 0;
  const supervisor = new LspSupervisor(() => attempt++ === 0 ? first.transport : second.transport, first.logger);
  await supervisor.start();
  assert.deepEqual(supervisor.state, { kind: 'failed', reason: 'cannot launch' });
  assert.equal(first.stops, 1);
  assert.equal(first.disposed, 1);
  assert.equal(first.log.filter((line) => line.startsWith('Language server failed to start:')).length, 1);
  await supervisor.restart();
  assert.equal(supervisor.state.kind, 'connected');
  assert.equal(second.starts, 1);
  await supervisor.stop();
});

test('stop cancels a queued startup before creating a transport', async () => {
  const h = harness();
  let factories = 0;
  const supervisor = new LspSupervisor(() => { factories++; return h.transport; }, h.logger);
  await Promise.all([supervisor.start(), supervisor.stop()]);
  assert.equal(factories, 0);
  assert.equal(supervisor.state.kind, 'unavailable');
});

test('stop interrupts pending startup and ignores its late completion', async () => {
  const h = harness();
  const ready = deferred<void>();
  const initialize = deferred<unknown>();
  h.transport.start = async () => { ready.resolve(); return initialize.promise; };
  const supervisor = new LspSupervisor(() => h.transport, h.logger);
  const start = supervisor.start();
  await ready.promise;
  assert.equal((await supervisor.request('zenwave/workspaceStatus', undefined)).kind, 'no-server');
  await supervisor.stop();
  await start;
  initialize.resolve(INITIALIZE);
  await Promise.resolve();
  assert.equal(supervisor.state.kind, 'unavailable');
  assert.equal(h.stops, 1);
  assert.equal(supervisor.supports('zenwave/workspaceStatus'), false);
});

test('crash settles a pending request promptly and ignores old-session exit callbacks after restart', async () => {
  const first = harness();
  const second = harness();
  const sent = deferred<void>();
  const response = deferred<unknown>();
  first.transport.sendRequest = async () => { sent.resolve(); return response.promise; };
  let attempt = 0;
  const supervisor = new LspSupervisor(() => attempt++ === 0 ? first.transport : second.transport, first.logger);
  await supervisor.start();
  const request = supervisor.request('zenwave/workspaceStatus', undefined);
  await sent.promise;
  first.crash();
  assert.equal((await request).kind, 'no-server');
  assert.deepEqual(supervisor.state, { kind: 'failed', reason: 'server exited' });
  assert.equal(first.disposed, 1);
  await supervisor.restart();
  first.crash();
  response.resolve({ stale: true });
  assert.equal(supervisor.state.kind, 'connected');
  assert.equal((await supervisor.request('zenwave/workspaceStatus', undefined)).kind, 'ok');
  await supervisor.stop();
});

test('stop promptly settles an in-flight request and discards its late payload', async () => {
  const h = harness();
  const sent = deferred<void>();
  const response = deferred<unknown>();
  h.transport.sendRequest = async () => { sent.resolve(); return response.promise; };
  const supervisor = new LspSupervisor(() => h.transport, h.logger);
  await supervisor.start();
  const request = supervisor.request('zenwave/workspaceStatus', undefined);
  await sent.promise;
  await supervisor.stop();
  assert.equal((await request).kind, 'no-server');
  response.resolve({ stale: true });
  assert.equal(supervisor.state.kind, 'unavailable');
});

test('stalled startup and requests return explicit failures by their deadline', async () => {
  const h = harness();
  h.transport.start = () => new Promise(() => {});
  const supervisor = new LspSupervisor(() => h.transport, h.logger, 5);
  await supervisor.start();
  assert.deepEqual(supervisor.state, { kind: 'failed', reason: 'Language server startup timed out' });
  assert.equal(h.stops, 1);
  h.transport.start = async () => INITIALIZE;
  await supervisor.restart();
  h.transport.sendRequest = () => new Promise(() => {});
  assert.deepEqual(await supervisor.request('zenwave/workspaceStatus', undefined), {
    kind: 'failed', reason: 'Language server request zenwave/workspaceStatus timed out',
  });
  await supervisor.stop();
});
