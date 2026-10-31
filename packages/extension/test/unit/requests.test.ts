import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { documentFailure, ZENWAVE_REQUESTS, ZenwaveRequests } from '../../src/lsp/requests.js';
import type { RequestResult } from '../../src/lsp/supervisor.js';

/** Wire samples recorded from @zenwave360/lsp-js 0.1.0-SNAPSHOT (zenwave-lsp d7156e7). */
const samples = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/lsp-samples');
const json = (name: string): unknown => JSON.parse(readFileSync(join(samples, name), 'utf8'));
const result = (name: string): unknown => (json(name) as { result: unknown }).result;
const error = (name: string) => (json(name) as { error: { code: number; message: string; data?: unknown } }).error;

function issuer(answer: (method: string) => RequestResult) {
  const sent: { method: string; params: unknown }[] = [];
  const requests = new ZenwaveRequests({
    request: async (method, params) => { sent.push({ method, params }); return answer(method); },
  });
  return { sent, requests };
}

test('every request the server advertises today has a wrapper sending the wire params', async () => {
  const { sent, requests } = issuer(() => ({ kind: 'ok', value: null }));
  await requests.hierarchy('file:///w/a.zfl');
  await requests.forwardReferences('file:///w/a.zfl', 'file:///w/a.zfl#x');
  await requests.reverseReferences('file:///w/a.zfl', 'file:///w/a.zfl#x');
  await requests.organizeZflServices('file:///w/a.zfl');
  await requests.eventFlowViews('file:///w/a.zfl');
  await requests.preview('file:///w/a.zfl');
  await requests.preview('file:///w/a.zfl', 'SEPARATE_VARIANTS');
  await requests.symbolAt('file:///w/a.zfl', { line: 14, character: 30 });
  assert.deepEqual(sent, [
    { method: 'zenwave/hierarchy', params: { uri: 'file:///w/a.zfl' } },
    { method: 'zenwave/forwardReferences', params: { uri: 'file:///w/a.zfl', semanticId: 'file:///w/a.zfl#x' } },
    { method: 'zenwave/reverseReferences', params: { uri: 'file:///w/a.zfl', semanticId: 'file:///w/a.zfl#x' } },
    { method: 'zenwave/organizeZflServices', params: { uri: 'file:///w/a.zfl' } },
    { method: 'zenwave/eventFlowViews', params: { textDocument: { uri: 'file:///w/a.zfl' } } },
    { method: 'zenwave/preview', params: { textDocument: { uri: 'file:///w/a.zfl' } } },
    { method: 'zenwave/preview', params: { textDocument: { uri: 'file:///w/a.zfl' }, sequenceRenderMode: 'SEPARATE_VARIANTS' } },
    { method: 'zenwave/symbolAt', params: { textDocument: { uri: 'file:///w/a.zfl' }, position: { line: 14, character: 30 } } },
  ]);
  assert.deepEqual(Object.values(ZENWAVE_REQUESTS), json('customRequests.json'));
});

test('recorded server answers pass through unchanged and unexpected shapes fail', async () => {
  const answers: Record<string, unknown> = {
    'zenwave/hierarchy': result('hierarchy-unopened-manifest.json'),
    'zenwave/eventFlowViews': result('eventFlowViews.json'),
    'zenwave/preview': result('preview-zdl.json'),
    'zenwave/symbolAt': result('symbolAt-command.json'),
    'zenwave/forwardReferences': result('forwardReferences-from-symbolAt-command.json'),
  };
  const { requests } = issuer((method) => ({ kind: 'ok', value: answers[method] }));
  const hierarchy = await requests.hierarchy('file:///workspace/zenwave-architecture.yml');
  assert.equal(hierarchy.kind === 'ok' && hierarchy.value[0]?.children[0]?.label, 'orders');
  const views = await requests.eventFlowViews('file:///workspace/checkout.zfl');
  assert.equal(views.kind === 'ok' && views.value.flowGraph.schema, 'zfl.eventflow.view@1');
  assert.equal(views.kind === 'ok' && views.value, answers['zenwave/eventFlowViews'], 'forwarded unchanged');
  const preview = await requests.preview('file:///workspace/model.zdl');
  assert.equal(preview.kind === 'ok' && preview.value.defaultRepresentationId, 'domain');
  const symbol = await requests.symbolAt('file:///workspace/checkout.zfl', { line: 14, character: 30 });
  assert.equal(symbol.kind === 'ok' && symbol.value?.semanticId, 'file:///workspace/checkout.zfl#flows.CheckoutFlow.commands.createOrder');
  const references = await requests.forwardReferences('file:///workspace/checkout.zfl', 'x');
  assert.equal(references.kind === 'ok' && references.value[0]?.relationType, 'uses');
  assert.deepEqual(await issuer(() => ({ kind: 'ok', value: null })).requests.symbolAt('file:///w', { line: 8, character: 0 }),
    { kind: 'ok', value: null });
  assert.equal((await issuer(() => ({ kind: 'ok', value: { nodes: [] } })).requests.eventFlowViews('file:///w')).kind, 'failed');
  assert.deepEqual(await issuer(() => ({ kind: 'unsupported', method: 'zenwave/preview' })).requests.preview('file:///w'),
    { kind: 'unsupported', method: 'zenwave/preview' });
});

test('document failures are read from the -32803 error data', () => {
  const unreadable = error('error-unreadable.json');
  const failure = documentFailure({ kind: 'failed', reason: unreadable.message, code: unreadable.code, data: unreadable.data });
  assert.equal(failure?.kind, 'documentUnreadable');
  assert.equal(failure?.diagnostics.length, 2);
  const notFound = error('error-hierarchy-notFound.json');
  assert.deepEqual(documentFailure({ kind: 'failed', reason: notFound.message, code: notFound.code, data: notFound.data }),
    { kind: 'documentNotFound', diagnostics: [] });
  const invalid = error('error-hierarchy-invalidParams.json');
  assert.equal(documentFailure({ kind: 'failed', reason: invalid.message, code: invalid.code }), undefined);
  assert.equal(documentFailure({ kind: 'failed', reason: 'timeout' }), undefined);
  assert.equal(documentFailure({ kind: 'no-server', reason: 'x' }), undefined);
});
