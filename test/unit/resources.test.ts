import assert from 'node:assert/strict';
import test from 'node:test';
import { ZenwaveRequests } from '../../src/lsp/requests.js';
import { contentBytes, openTarget, resourceFailure } from '../../src/lsp/resources.js';
import type { RequestResult } from '../../src/lsp/supervisor.js';

const address = 'zenwave:/orders/0.1.0/openapi.yml';

test('a server too old is told apart from a file that is missing', () => {
  const old = resourceFailure(address, { kind: 'unsupported', method: 'zenwave/readResource' });
  assert.equal(old?.reason, 'too-old');
  assert.match(old!.message, /too old/);
  assert.doesNotMatch(old!.message, /not found|missing|not declared/i);
  const refused = resourceFailure(address, { kind: 'failed', reason: 'x', code: -32803, data: { kind: 'resourceNotDeclared' } });
  assert.equal(refused?.reason, 'not-declared');
  assert.doesNotMatch(refused!.message, /too old/);
});

test('an unresolved address lists the candidates in the order the server tried them', () => {
  const failure = resourceFailure(address, {
    kind: 'failed', reason: 'x', code: -32803,
    data: { kind: 'resourceUnresolved', candidates: [
      { source: 'workspace', url: 'file:///w/openapi.yml', message: 'not found' },
      { source: 'git', url: 'https://example.org/raw/openapi.yml', message: '404' },
    ] },
  });
  assert.equal(failure?.reason, 'unresolved');
  const lines = failure!.message.split('\n');
  assert.match(lines[1]!, /workspace file:\/\/\/w\/openapi\.yml: not found/);
  assert.match(lines[2]!, /git https:\/\/example\.org\/raw\/openapi\.yml: 404/);
});

test('other outcomes: no server, a plain failure, and an answer', () => {
  assert.equal(resourceFailure(address, { kind: 'no-server', reason: 'stopped' })?.reason, 'no-server');
  assert.equal(resourceFailure(address, { kind: 'failed', reason: 'boom' })?.reason, 'failed');
  assert.equal(resourceFailure(address, { kind: 'ok', value: {} }), undefined);
});

test('only a workspace answer with a file: URI opens as the plain file', () => {
  const stat = (source: { kind: string; fileUri?: string }) => ({ uri: address, type: 'file' as const, size: 1, readonly: true as const, source });
  assert.deepEqual(openTarget(stat({ kind: 'workspace', fileUri: 'file:///w/openapi.yml' }), address), { via: 'file', uri: 'file:///w/openapi.yml' });
  assert.deepEqual(openTarget(stat({ kind: 'git' }), address), { via: 'zenwave', uri: address });
  assert.deepEqual(openTarget(stat({ kind: 'workspace' }), address), { via: 'zenwave', uri: address });
});

test('content is text or base64', () => {
  assert.deepEqual([...contentBytes({ uri: address, encoding: 'utf8', content: 'héllo' })], [...new TextEncoder().encode('héllo')]);
  assert.deepEqual([...contentBytes({ uri: address, encoding: 'base64', content: 'AAEC/w==' })], [0, 1, 2, 255]);
});

test('the wrappers ask the server by the wire names and check the shape', async () => {
  const sent: Array<{ method: string; params: unknown }> = [];
  const answers = new Map<string, RequestResult>([
    ['zenwave/statResource', { kind: 'ok', value: { uri: address, type: 'file', size: 3, readonly: true, source: { kind: 'git' } } }],
    ['zenwave/readResource', { kind: 'ok', value: { uri: address, encoding: 'utf8', content: 'abc' } }],
  ]);
  const requests = new ZenwaveRequests({ request: async (method, params) => { sent.push({ method, params }); return answers.get(method) ?? { kind: 'unsupported', method }; } });
  const stat = await requests.statResource(address);
  assert.equal(stat.kind === 'ok' && stat.value.size, 3);
  const read = await requests.readResource(address);
  assert.equal(read.kind === 'ok' && read.value.content, 'abc');
  assert.deepEqual(sent, [
    { method: 'zenwave/statResource', params: { uri: address } },
    { method: 'zenwave/readResource', params: { uri: address } },
  ]);
  answers.set('zenwave/readResource', { kind: 'ok', value: { content: 1 } });
  assert.equal((await requests.readResource(address)).kind, 'failed');
  answers.clear();
  assert.equal((await requests.readResource(address)).kind, 'unsupported', 'a server without the request is too old, not an error');
});
