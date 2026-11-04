import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Preview, PreviewMode, SequenceRenderMode } from '../../src/lsp/requests.js';
import type { RequestResult } from '../../src/lsp/supervisor.js';
import { buildFailedHtml, buildPreviewHtml, previewContentSecurityPolicy } from '../../src/preview/page.js';
import { decidePreviewLink } from '../../src/preview/links.js';
import { inboundMessage, PREVIEW_VIEW_TYPE, RENDER_MODES, type OutboundMessage } from '../../src/preview/protocol.js';
import { outcomeOf, reselect } from '../../src/preview/selection.js';
import { PREVIEW_MARKDOWN_CONTEXT_KEY, PreviewSession, markdownContextValue } from '../../src/preview/session.js';
import { PREVIEW_STATE_KINDS, presentPreviewState, type PreviewDataState } from '../../src/preview/state.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8'));
const runtimeFiles = JSON.parse(readFileSync(join(here, '../../runtime-files.json'), 'utf8')) as { files: string[] };
const zdlAnswer = (JSON.parse(readFileSync(join(here, '../fixtures/lsp-samples/preview-zdl.json'), 'utf8')) as { result: Preview }).result;

const ZFL = 'file:///workspace/checkout.zfl';
const READY = { type: 'zenwave.preview.ready' };
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const mermaid = (id: string, title = id): Preview['representations'][number] => ({ id, title, format: 'MERMAID', content: `sequenceDiagram\n  Note over A: ${id}` });

/** What `zenwave/preview` answers for a ZFL flow in each render mode (zenwave-lsp ModelVisualizations). */
const ALT: Preview = {
  representations: [mermaid('flowchart', 'Flowchart'), mermaid('sequence:completed:0', 'Sequence: completed'), mermaid('sequence:rejected:1', 'Sequence: rejected')],
  defaultRepresentationId: 'sequence:completed:0',
};
const SEPARATE: Preview = {
  representations: [mermaid('flowchart', 'Flowchart'), mermaid('sequence:completed:0', 'Sequence: completed'), mermaid('sequence:completed:1', 'Sequence: completed (variant)'), mermaid('sequence:rejected:2', 'Sequence: rejected')],
  defaultRepresentationId: 'sequence:completed:0',
};

function harness(answer: (mode: SequenceRenderMode | undefined) => RequestResult<Preview> | Promise<RequestResult<Preview>>, options: { hasRenderMode?: boolean; uri?: string; fileName?: string } = {}) {
  const posted: OutboundMessage[] = [];
  const asked: (SequenceRenderMode | undefined)[] = [];
  const logs: string[] = [];
  const commands: string[] = [];
  const markdownContext: boolean[] = [];
  const session = new PreviewSession({
    documentUri: options.uri ?? ZFL,
    fileName: options.fileName ?? 'checkout.zfl',
    hasRenderMode: options.hasRenderMode ?? true,
    preview: async (_uri, mode) => { asked.push(mode); return answer(mode); },
    post: async (message) => { posted.push(message); return true; },
    runCommand: (command) => { commands.push(command); },
    setContext: (key, value) => { assert.equal(key, PREVIEW_MARKDOWN_CONTEXT_KEY); markdownContext.push(value); },
    log: { info: (line) => logs.push(line), warn: (line) => logs.push(line), debug: (line) => logs.push(line) },
  });
  const renders = () => posted.flatMap((message) => message.type === 'zenwave.preview.render' ? [message.payload] : []);
  return { session, posted, asked, logs, commands, renders, markdownContext };
}

const ok = (value: Preview): RequestResult<Preview> => ({ kind: 'ok', value });
const failure = (kind: string, extra: Record<string, unknown> = {}): RequestResult<Preview> =>
  ({ kind: 'failed', reason: `server says ${kind}`, code: -32803, data: { kind, ...extra } });

test('the representations reach the page in the server order, under its titles, starting on its default (MP-R4)', async () => {
  const { session, renders, posted } = harness(() => ok(ALT));
  await session.refresh();
  assert.equal(renders().length, 0, 'nothing is posted before the page says it is ready');
  session.receive(READY);
  const [render] = renders();
  assert.deepEqual(render?.representations.map((item) => [item.id, item.title]), ALT.representations.map((item) => [item.id, item.title]));
  assert.equal(render?.selectedId, 'sequence:completed:0', 'the first happy-path sequence, not the flowchart');
  assert.equal(render?.showRenderMode, true);
  assert.equal(render?.renderMode, 'ALT_BLOCKS');
  assert.ok(posted.some((message) => message.type === 'zenwave.host.state'));
});

test('a ZDL page has no render mode to offer, and the request carries none', async () => {
  const { session, renders, asked } = harness(() => ok(zdlAnswer), { hasRenderMode: false, uri: 'file:///workspace/orders.zdl', fileName: 'orders.zdl' });
  session.receive(READY);
  await session.refresh();
  assert.deepEqual(asked, [undefined]);
  assert.equal(renders().at(-1)?.showRenderMode, false);
  assert.equal(renders().at(-1)?.representations.length, 1);
  await session.setRenderMode('SEPARATE_VARIANTS');
  assert.equal(asked.length, 1, 'a document without sequence variants does not ask again for a mode');
});

test('a ZFL request names the render mode, and changing it asks the server again with the new one (MP-R11)', async () => {
  const { session, asked, renders } = harness((mode) => ok(mode === 'SEPARATE_VARIANTS' ? SEPARATE : ALT));
  session.receive(READY);
  await session.refresh();
  assert.deepEqual(asked, ['ALT_BLOCKS']);
  await session.setRenderMode('SEPARATE_VARIANTS');
  assert.deepEqual(asked, ['ALT_BLOCKS', 'SEPARATE_VARIANTS']);
  assert.equal(renders().at(-1)?.renderMode, 'SEPARATE_VARIANTS');
  assert.equal(renders().at(-1)?.representations.length, 4);
  await session.setRenderMode('SEPARATE_VARIANTS');
  assert.equal(asked.length, 2, 'choosing the mode already chosen asks nothing');
});

test('the selection survives a new answer by exact id, then by outcome, then falls back to the default (MP-R12)', async () => {
  assert.equal(outcomeOf('sequence:completed:0'), 'completed');
  assert.equal(outcomeOf('sequence:payment:failed:3'), 'payment:failed');
  assert.equal(outcomeOf('flowchart'), undefined);
  assert.deepEqual(reselect('sequence:rejected:1', ALT.representations, ALT.defaultRepresentationId), { id: 'sequence:rejected:1', reason: 'kept' });
  assert.deepEqual(reselect('sequence:rejected:1', SEPARATE.representations, SEPARATE.defaultRepresentationId), { id: 'sequence:rejected:2', reason: 'same-outcome' });
  assert.deepEqual(reselect('sequence:cancelled:1', ALT.representations, ALT.defaultRepresentationId), { id: 'sequence:completed:0', reason: 'default' });
  assert.deepEqual(reselect('flowchart', [mermaid('sequence:completed:0')], 'sequence:completed:0'), { id: 'sequence:completed:0', reason: 'default' });
  assert.deepEqual(reselect(undefined, ALT.representations, ALT.defaultRepresentationId), { id: 'sequence:completed:0', reason: 'default' });
  assert.deepEqual(reselect('x', [mermaid('a'), mermaid('b')], 'missing'), { id: 'a', reason: 'first' });
  assert.equal(reselect('x', [], 'y'), undefined);

  // The flow of it: choose the rejected outcome, switch the mode, and the same outcome stays; edit it away and the default returns.
  let answer: Preview = ALT;
  const { session, renders } = harness(() => ok(answer));
  session.receive(READY);
  await session.refresh();
  assert.equal(session.selectRepresentation('sequence:rejected:1'), true);
  assert.equal(renders().at(-1)?.selectedId, 'sequence:rejected:1');
  answer = SEPARATE;
  await session.setRenderMode('SEPARATE_VARIANTS');
  assert.equal(session.selectedId, 'sequence:rejected:2', 'the same outcome, under the id the new mode gave it');
  assert.equal(renders().at(-1)?.selectedId, 'sequence:rejected:2');
  answer = { representations: [mermaid('flowchart'), mermaid('sequence:completed:0')], defaultRepresentationId: 'sequence:completed:0' };
  await session.refresh();
  assert.equal(session.selectedId, 'sequence:completed:0', 'an edit that removes the outcome falls back to the server default');
  assert.equal(session.selectRepresentation('sequence:rejected:2'), false, 'an id outside the current set cannot be selected');
});

test('a new session starts on the server default whatever another preview chose (selection lasts as long as the editor)', async () => {
  const first = harness(() => ok(ALT));
  first.session.receive(READY);
  await first.session.refresh();
  first.session.selectRepresentation('flowchart');
  const second = harness(() => ok(ALT));
  second.session.receive(READY);
  await second.session.refresh();
  assert.equal(second.session.selectedId, 'sequence:completed:0');
});

test('the last good set stays on screen while the document cannot be read, and the next good one replaces it (MP-R5)', async () => {
  let next: RequestResult<Preview> = ok(ALT);
  const { session, renders, posted } = harness(() => next);
  session.receive(READY);
  await session.refresh();
  const good = renders().length;
  next = failure('documentUnreadable', { diagnostics: [{ message: 'unexpected token' }] });
  await session.refresh();
  assert.equal(session.hasPreview, true);
  assert.equal(renders().length, good, 'a failure posts no new render, so the page keeps what it has');
  assert.equal(session.state?.kind, 'unreadable');
  assert.equal(session.state?.mode, 'banner', 'never an overlay over a preview that is on screen');
  assert.match(session.state?.title ?? '', /Showing the last preview produced/);
  const state = posted.filter((message) => message.type === 'zenwave.host.state').at(-1);
  assert.equal(state?.type === 'zenwave.host.state' && state.payload?.mode, 'banner');
  next = ok({ representations: [mermaid('flowchart', 'Flowchart')], defaultRepresentationId: 'flowchart' });
  await session.refresh();
  assert.equal(session.state, null);
  assert.equal(renders().at(-1)?.representations.length, 1);
});

test('a refresh asked while one is running waits for it: the stale answer is dropped and one request for the latest follows', async () => {
  const gates: ((result: RequestResult<Preview>) => void)[] = [];
  const { session, renders, asked } = harness(() => new Promise((resolve) => { gates.push(resolve); }));
  session.receive(READY);
  const first = session.refresh();
  const second = session.refresh();
  const third = session.refresh();
  assert.equal(gates.length, 1, 'the server is asked once while a request runs');
  assert.equal(session.requests, 1);
  gates[0]!(ok({ representations: [mermaid('flowchart', 'older')], defaultRepresentationId: 'flowchart' }));
  await settle();
  assert.equal(gates.length, 2, 'one follow-up for everything asked meanwhile');
  assert.equal(renders().length, 0, 'the answer overtaken by a newer edit is not shown');
  gates[1]!(ok({ representations: [mermaid('flowchart', 'newer')], defaultRepresentationId: 'flowchart' }));
  await Promise.all([first, second, third]);
  assert.deepEqual(renders().map((render) => render.representations[0]?.title), ['newer']);
  assert.equal(session.requests, 2);
  assert.equal(asked.length, 2);
  void session.refresh();
  assert.equal(session.requests, 3, 'an idle session asks again');
  session.dispose();
});

test('changing the render mode while a request runs asks once more, with the new mode', async () => {
  const gates: ((result: RequestResult<Preview>) => void)[] = [];
  const { session, asked } = harness(() => new Promise((resolve) => { gates.push(resolve); }));
  const running = session.refresh();
  const changed = session.setRenderMode('SEPARATE_VARIANTS');
  assert.equal(gates.length, 1);
  gates[0]!(ok(ALT));
  await settle();
  gates[1]!(ok(SEPARATE));
  await Promise.all([running, changed]);
  assert.deepEqual(asked, ['ALT_BLOCKS', 'SEPARATE_VARIANTS']);
});

test('each reason for having nothing to show is its own message, explained, with something to do about it (MP-R8)', async () => {
  const cases: [RequestResult<Preview>, string][] = [
    [{ kind: 'no-server', reason: 'ZenWave language server is turned off' }, 'no-server'],
    [{ kind: 'unsupported', method: 'zenwave/preview' }, 'unsupported'],
    [failure('documentUnreadable', { diagnostics: [] }), 'unreadable'],
    [failure('documentNotFound'), 'not-found'],
    [failure('unsupportedDocument'), 'unsupported-document'],
    [{ kind: 'failed', reason: 'timed out' }, 'failed'],
    [ok({ representations: [], defaultRepresentationId: '' }), 'empty'],
  ];
  const titles = new Set<string>();
  for (const [result, kind] of cases) {
    const { session, logs } = harness(() => result);
    session.receive(READY);
    await session.refresh();
    assert.equal(session.state?.kind, kind);
    assert.equal(session.state?.mode, 'overlay');
    assert.ok((session.state?.actions.length ?? 0) > 0, `${kind} offers nothing to do`);
    assert.ok(logs.some((line) => line.startsWith('Preview of checkout.zfl: ')), `${kind} is not in the output channel`);
    titles.add(session.state?.title ?? '');
  }
  assert.equal(titles.size, cases.length, 'two states read the same');
  const none = harness(() => ({ kind: 'no-server', reason: 'off' }));
  assert.equal(none.session.state?.kind, 'loading', 'before an answer the editor says it is working');
  const detail = harness(() => failure('documentUnreadable', { diagnostics: [{ message: 'unexpected token' }] }));
  await detail.session.refresh();
  assert.ok(detail.logs.some((line) => line.includes('unexpected token')), 'the problems go to the output channel');
  assert.match(presentPreviewState('a.zfl', { kind: 'ready' }, { kind: 'no-server', reason: 'off' }, false)?.title ?? '', /needs the ZenWave language server/);
  const every: PreviewDataState['kind'][] = ['loading', 'rendered', 'no-server', 'unsupported', 'unreadable', 'not-found', 'unsupported-document', 'failed', 'empty'];
  assert.deepEqual([...PREVIEW_STATE_KINDS].sort(), [...every, 'page-failed'].sort());
});

test('a representation in a format the page cannot show yet is passed on as it came, for the page to say so', async () => {
  const markdown = { id: 'domain', title: 'Domain', format: 'MARKDOWN', content: '# Orders\n\n```mermaid\nclassDiagram\n```' };
  const html = { id: 'page', title: 'Page', format: 'HTML', content: '<p onclick="x()">hi</p><script>x()</script>' };
  const { session, renders } = harness(() => ok({ representations: [markdown, mermaid('flowchart'), html] as Preview['representations'], defaultRepresentationId: 'domain' }));
  session.receive(READY);
  await session.refresh();
  assert.deepEqual(renders().at(-1)?.representations.map((item) => [item.id, item.format, item.content]),
    [[markdown.id, markdown.format, markdown.content], ['flowchart', 'MERMAID', mermaid('flowchart').content], [html.id, html.format, html.content]]);
  assert.equal(renders().at(-1)?.selectedId, 'domain', 'selection never depends on the format');
});

test('the page can run only the actions the editor is offering, and a failed diagram is reported to the output channel', async () => {
  const { session, commands, logs } = harness(() => ({ kind: 'no-server', reason: 'off' }));
  session.receive(READY);
  await session.refresh();
  session.receive({ type: 'zenwave.host.action', payload: { command: 'zenwave.lsp.showStatus' } });
  session.receive({ type: 'zenwave.host.action', payload: { command: 'workbench.action.quit' } });
  assert.deepEqual(commands, ['zenwave.lsp.showStatus']);
  session.receive({ type: 'zenwave.preview.diagramFailed', payload: { id: 'flowchart', message: 'Parse error on line 3' } });
  assert.ok(logs.some((line) => line.includes('flowchart could not be drawn: Parse error on line 3')));
  assert.equal(session.page.kind, 'ready', 'one malformed diagram is not a failed page');
});

test('an asset that fails to load before the page is ready, or a page that never says it loaded, is a load failure', () => {
  const broken = harness(() => ok(ALT));
  broken.session.receive({ type: 'zenwave.host.loadError', payload: { message: 'Could not load preview.js' } });
  assert.equal(broken.session.state?.kind, 'page-failed');
  const silent = harness(() => ok(ALT));
  silent.session.pageTimedOut(30);
  assert.match(silent.session.state?.detail ?? '', /did not report that it loaded within 30 seconds/);
  const late = harness(() => ok(ALT));
  late.session.receive(READY);
  late.session.receive({ type: 'zenwave.host.loadError', payload: { message: 'a runtime error' } });
  late.session.pageTimedOut(30);
  assert.equal(late.session.page.kind, 'ready', 'a runtime error after the page loaded is logged, not a load failure');
});

test('a probe is relayed to the page and answered', async () => {
  const { session, posted } = harness(() => ok(ALT));
  const answer = session.probe(undefined, undefined, 1000);
  const asked = posted.find((message) => message.type === 'zenwave.host.probe');
  assert.ok(asked && asked.type === 'zenwave.host.probe');
  session.receive({ type: 'zenwave.host.probeResult', payload: { requestId: asked.payload.requestId, svgCount: 1 } });
  assert.equal((await answer).svgCount, 1);
  await settle();
});

test('copy as markdown writes the page the server sent, and a diagram page writes nothing (MP-R26)', async () => {
  const page = '# Orders\n\nA <tag> & *stars*\n\n```mermaid\nclassDiagram\n  class Order\n```\n';
  const markdown = { id: 'docs', title: 'Model Docs', format: 'MARKDOWN' as const, content: page };
  const chart = mermaid('classes', 'Classes');
  const written: string[] = [];
  const write = async (text: string): Promise<void> => { written.push(text); };

  const docs = harness(() => ok({ representations: [markdown], defaultRepresentationId: 'docs' }), { hasRenderMode: false, uri: 'file:///workspace/orders.zdl', fileName: 'orders.zdl' });
  assert.equal(await docs.session.copyMarkdown(write), false, 'before a page arrives there is nothing to copy');
  assert.deepEqual(written, []);
  docs.session.receive(READY);
  await docs.session.refresh();
  assert.deepEqual(docs.markdownContext, [true]);
  assert.equal(await docs.session.copyMarkdown(write), true);
  assert.deepEqual(written, [page]);
  docs.session.dispose();
  assert.deepEqual(docs.markdownContext, [true], 'closing the preview does not reach the host: its panel is already disposed and the host throws; the host clears the key');

  const diagram = harness(() => ok(ALT));
  diagram.session.receive(READY);
  await diagram.session.refresh();
  assert.deepEqual(diagram.markdownContext, []);
  assert.equal(await diagram.session.copyMarkdown(write), false);
  assert.deepEqual(written, [page], 'a diagram page writes nothing');
  assert.equal(diagram.session.showsMarkdown, false);

  let answer: Preview = { representations: [markdown, chart], defaultRepresentationId: 'docs' };
  const mixed = harness(() => ok(answer), { hasRenderMode: false, uri: 'file:///workspace/orders.zdl', fileName: 'orders.zdl' });
  mixed.session.receive(READY);
  await mixed.session.refresh();
  assert.equal(await mixed.session.copyMarkdown(write), true);
  assert.equal(written[written.length - 1], page);
  const renamed = '# Orders renamed\n\n```mermaid\nclassDiagram\n  class Order\n```\n';
  answer = { representations: [{ ...markdown, content: renamed }, chart], defaultRepresentationId: 'docs' };
  await mixed.session.refresh();
  assert.deepEqual(mixed.markdownContext, [true], 'editing the markdown page does not republish the context');
  assert.equal(await mixed.session.copyMarkdown(write), true);
  assert.equal(written[written.length - 1], renamed);
  assert.equal(mixed.session.selectRepresentation('classes'), true);
  assert.deepEqual(mixed.markdownContext, [true, false]);
  assert.equal(await mixed.session.copyMarkdown(write), false);
  assert.equal(written[written.length - 1], renamed, 'the diagram that replaced the page is not copied');
  assert.equal(mixed.session.selectRepresentation('docs'), true);
  assert.deepEqual(mixed.markdownContext, [true, false, true]);
  assert.equal(await mixed.session.copyMarkdown(write), true);
  assert.equal(written[written.length - 1], renamed);
});

test('messages from the page are read by shape, and anything else is ignored', () => {
  assert.deepEqual(inboundMessage({ type: 'zenwave.preview.selectRenderMode', payload: { mode: 'SEPARATE_VARIANTS' } }), { type: 'zenwave.preview.selectRenderMode', payload: { mode: 'SEPARATE_VARIANTS' } });
  assert.deepEqual(inboundMessage({ type: 'zenwave.preview.copyMermaid', payload: { content: 'sequenceDiagram\nA->>B: hi\n' } }), { type: 'zenwave.preview.copyMermaid', payload: { content: 'sequenceDiagram\nA->>B: hi\n' } });
  assert.deepEqual(inboundMessage({ type: 'zenwave.preview.followLink', payload: { href: '../apis/asyncapi.yml#L8' } }), { type: 'zenwave.preview.followLink', payload: { href: '../apis/asyncapi.yml#L8' } });
  assert.equal(inboundMessage({ type: 'zenwave.preview.followLink', payload: {} }), undefined);
  assert.equal(inboundMessage({ type: 'zenwave.preview.copyMermaid', payload: {} }), undefined);
  assert.equal(inboundMessage({ type: 'zenwave.preview.selectRenderMode', payload: { mode: 'AUTO' } }), undefined, 'AUTO is not offered');
  assert.equal(inboundMessage({ type: 'zenwave.preview.selectRepresentation', payload: {} }), undefined);
  assert.equal(inboundMessage({ type: 'something.else' }), undefined);
  assert.equal(inboundMessage(null), undefined);
  assert.deepEqual(RENDER_MODES.map((mode) => mode.label), ['Alt blocks', 'Separate variants']);
});

test('preview links open only workspace documents or http(s) through the host', () => {
  const source = 'vscode-vfs://github.example/org/repo/models/orders.zdl';
  const folders = ['vscode-vfs://github.example/org/repo'];
  assert.deepEqual(decidePreviewLink(source, '../apis/asyncapi.yml#L8', folders),
    { kind: 'workspace', href: 'vscode-vfs://github.example/org/repo/apis/asyncapi.yml#L8', line: 8 });
  assert.deepEqual(decidePreviewLink(source, 'notes.md#overview', folders),
    { kind: 'workspace', href: 'vscode-vfs://github.example/org/repo/models/notes.md#overview' });
  assert.deepEqual(decidePreviewLink('file:///workspace/models/orders.zdl', 'file:///workspace/apis/asyncapi.yml', ['file:///workspace']),
    { kind: 'workspace', href: 'file:///workspace/apis/asyncapi.yml' });
  assert.deepEqual(decidePreviewLink(source, 'https://example.test/docs?q=1#part', folders),
    { kind: 'external', href: 'https://example.test/docs?q=1#part' });
  for (const href of ['../../outside.yml', 'file:///outside.yml', 'command:workbench.action.quit', 'javascript:alert(1)', 'classpath:api.yml', 'http://[']) {
    assert.deepEqual(decidePreviewLink(source, href, folders), { kind: 'refused' }, href);
  }
});

test('preview links reject encoded path separators and dot segments before containment', () => {
  const workspaces = [
    { source: 'file:///workspace/models/orders.zdl', folder: 'file:///workspace', encodedFile: 'file:///workspace/%2f../outside.yml' },
    { source: 'file:///c%3A/workspace/models/orders.zdl', folder: 'file:///c%3A/workspace', encodedFile: 'file:///c%3A/workspace/%2f../outside.yml' },
    { source: 'file://server/share/workspace/models/orders.zdl', folder: 'file://server/share/workspace', encodedFile: 'file://server/share/workspace/%2f../outside.yml' },
    { source: 'vscode-vfs://github.example/org/repo/models/orders.zdl', folder: 'vscode-vfs://github.example/org/repo', encodedFile: 'vscode-vfs://github.example/org/repo/%2f../outside.yml' },
  ];

  for (const { source, folder, encodedFile } of workspaces) {
    for (const href of ['..%2f..%2foutside.yml', '..%2F..%2Foutside.yml', '..%5c..%5Coutside.yml', '%2e/outside.yml', '%2e%2e/outside.yml', encodedFile]) {
      assert.deepEqual(decidePreviewLink(source, href, [folder]), { kind: 'refused' }, `${source}: ${href}`);
    }
  }
});

test('the page has a CSP with no remote, inline-script or eval allowance, only inline styles, and only its own assets', () => {
  const resources = {
    cspSource: 'https://*.vscode-cdn.net', nonce: 'abc123',
    scriptUri: 'https://x.vscode-cdn.net/ext/dist/preview-webview/preview.js',
    styleUri: 'https://x.vscode-cdn.net/ext/dist/preview-webview/preview.css',
    mermaidUri: 'https://x.vscode-cdn.net/ext/dist/preview-webview/mermaid.min.js',
    contentUri: 'https://x.vscode-cdn.net/ext/dist/preview-webview/content.js',
  };
  const html = buildPreviewHtml(resources);
  const csp = previewContentSecurityPolicy(resources.cspSource, resources.nonce);
  assert.ok(html.includes(`content="${csp}"`));
  assert.match(csp, /^default-src 'none'; /);
  const [script, style] = ['script-src', 'style-src'].map((directive) => csp.split('; ').find((part) => part.startsWith(directive + ' ')) ?? '');
  assert.ok(!/unsafe-inline|unsafe-eval|http:/.test(script), script);
  assert.ok(script.includes("'nonce-abc123'"), 'scripts run under the nonce');
  assert.ok(style.includes("'unsafe-inline'"), 'styles: the one allowance, for Mermaid to measure with (see page.ts)');
  assert.ok(!/unsafe-eval|http:|connect-src|\*;/.test(csp.replaceAll('https://*.vscode-cdn.net', '')), csp);
  assert.ok(html.includes(`<script nonce="abc123" src="${resources.scriptUri}"></script>`));
  assert.ok(html.includes(`data-mermaid-src="${resources.mermaidUri}"`), 'Mermaid is named, not loaded, by the page');
  assert.ok(html.includes(`data-content-src="${resources.contentUri}"`), 'the content bundle is named, not loaded, by the page');
  assert.ok(!/<script[^>]*src="[^"]*(mermaid|content)/.test(html), 'Mermaid and the content bundle are loaded when first needed, not when the panel opens');
  assert.ok(!/img-src[^;]*https?:/.test(csp.replaceAll('https://*.vscode-cdn.net', '')), 'no remote image source');
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style="/.test(html), 'the page carries no inline style');
  const failed = buildFailedHtml(resources, 'Could not load <b>preview.js</b>');
  assert.ok(failed.includes('Could not load &lt;b&gt;preview.js&lt;/b&gt;'));
  assert.ok(!failed.includes('<script'), 'the static failure page runs nothing');
  assert.ok(html.includes('id="render-mode"') && html.includes('id="diagram"'));
});

test('the manifest registers an optional preview editor and names each supported file mode', () => {
  const contributes = manifest.contributes;
  assert.deepEqual(contributes.customEditors.find((editor: { viewType: string }) => editor.viewType === PREVIEW_VIEW_TYPE),
    { viewType: 'zenwave.preview', displayName: 'ZenWave Preview', selector: [{ filenamePattern: '*.zdl' }, { filenamePattern: '*.zw' }, { filenamePattern: '*.zfl' }], priority: 'option' });
  const commands = (contributes.commands as { command: string; title: string }[]).map((entry) => entry.command);
  for (const command of ['zenwave.preview.open', 'zenwave.preview.openToSide', 'zenwave.preview.openSequenceDiagrams', 'zenwave.preview.openModelDocs', 'zenwave.preview.openZdlDiagrams', 'zenwave.preview.openScriptsDocs', 'zenwave.preview.openSequenceDiagramsToSide', 'zenwave.preview.openModelDocsToSide', 'zenwave.preview.openScriptsDocsToSide', 'zenwave.preview.showText', 'zenwave.preview.selectDiagram', 'zenwave.preview.selectRenderMode', 'zenwave.preview.copyMarkdown']) {
    assert.ok(commands.includes(command), `${command} is not contributed`);
  }
  const title = contributes.menus['editor/title'] as { command?: string; submenu?: string; when: string }[];
  const submenus = title.filter((item) => item.submenu);
  assert.deepEqual(submenus.map((item) => item.submenu).sort(), ['zenwave.zdlViews', 'zenwave.zflViews', 'zenwave.zwViews']);
  for (const submenu of submenus) assert.match(submenu.when, /!isInDiffEditor/, 'no preview is offered in a diff (MP-Q4)');
  assert.ok(!title.some((item) => item.command?.startsWith('zenwave.preview.') && item.command !== 'zenwave.preview.copyMarkdown'), 'the preview has no title-bar icon of its own besides Copy as Markdown');
  const menus = contributes.menus as Record<string, { command: string; when: string }[]>;
  const opens = (submenu: string) => menus[submenu]!.map((entry) => entry.command).filter((command) => !command.endsWith('.showText'));
  assert.deepEqual(opens('zenwave.zflViews'), ['zenwave.eventflow.open', 'zenwave.eventflow.openToSide', 'zenwave.preview.openSequenceDiagrams', 'zenwave.preview.openSequenceDiagramsToSide']);
  assert.deepEqual(opens('zenwave.zdlViews'), ['zenwave.preview.openModelDocs', 'zenwave.preview.openZdlDiagrams', 'zenwave.preview.openModelDocsToSide']);
  const zdlMenu = Object.fromEntries((menus['zenwave.zdlViews'] as { command: string; when?: string }[]).map((entry) => [entry.command, entry.when]));
  assert.equal(zdlMenu['zenwave.preview.openZdlDiagrams'], 'zenwave.previewModesAvailable', 'ZDL Diagrams is offered only to a server that advertises previewModes (MP-R25)');
  assert.equal(zdlMenu['zenwave.preview.openModelDocs'], undefined, 'Model Docs is reachable from inside a preview too (MP-R17)');
  assert.deepEqual(opens('zenwave.zwViews'), ['zenwave.preview.openScriptsDocs', 'zenwave.preview.openScriptsDocsToSide']);
  const titles = Object.fromEntries((contributes.commands as { command: string; title: string }[]).map((entry) => [entry.command, entry.title]));
  assert.deepEqual([titles['zenwave.preview.openSequenceDiagramsToSide'], titles['zenwave.preview.openModelDocsToSide'], titles['zenwave.preview.openScriptsDocsToSide']],
    ['Open Sequence Diagrams to the Side', 'Open Model Docs to the Side', 'Open Scripts Docs to the Side'], 'each "to the side" entry names its view (MP-R27)');
  for (const command of ['openSequenceDiagramsToSide', 'openModelDocsToSide', 'openScriptsDocsToSide']) {
    assert.equal((contributes.menus.commandPalette as { command: string; when?: string }[]).find((entry) => entry.command === `zenwave.preview.${command}`)?.when, 'false', `${command} is a menu entry; Open Preview to the Side keeps the palette`);
  }
  for (const submenu of ['zenwave.zflViews', 'zenwave.zdlViews', 'zenwave.zwViews']) {
    assert.ok(menus[submenu]!.some((entry) => entry.command === 'zenwave.preview.showText' && entry.when === 'activeCustomEditorId == zenwave.preview'), `${submenu} keeps the way back to text (MP-Q9)`);
  }
  const palette = Object.fromEntries((contributes.menus.commandPalette as { command: string; when?: string }[]).map((entry) => [entry.command, entry.when]));
  assert.match(palette['zenwave.preview.openSequenceDiagrams'] ?? '', /zfl/);
  assert.match(palette['zenwave.preview.openModelDocs'] ?? '', /zdl/);
  assert.match(palette['zenwave.preview.openZdlDiagrams'] ?? '', /zdl/);
  assert.match(palette['zenwave.preview.openZdlDiagrams'] ?? '', /zenwave\.previewModesAvailable/);
  for (const command of ['zenwave.preview.openModelDocs', 'zenwave.preview.openZdlDiagrams']) {
    assert.doesNotMatch(palette[command] ?? '', /activeCustomEditorId/, `${command} switches mode from inside the preview`);
  }
  assert.match(palette['zenwave.preview.openScriptsDocs'] ?? '', /zw/);
  assert.match(palette['zenwave.preview.openToSide'] ?? '', /!isInDiffEditor/);
  assert.match(palette['zenwave.preview.selectRenderMode'] ?? '', /resourceExtname == \.zfl/);
});

test('copy as markdown is on the title bar and in the palette only while that preview shows Markdown (MP-R26)', () => {
  const commands = manifest.contributes.commands as { command: string; title: string; category?: string; icon?: string }[];
  const copy = commands.find((entry) => entry.command === 'zenwave.preview.copyMarkdown');
  assert.equal(copy?.title, 'Copy as Markdown');
  assert.equal(copy?.category, 'ZenWave');
  assert.equal(copy?.icon, '$(copy)');
  const when = `activeCustomEditorId == ${PREVIEW_VIEW_TYPE} && ${PREVIEW_MARKDOWN_CONTEXT_KEY}`;
  const title = manifest.contributes.menus['editor/title'] as { command?: string; when: string; group?: string }[];
  const button = title.filter((item) => item.command === 'zenwave.preview.copyMarkdown');
  assert.deepEqual(button.map((item) => [item.when, item.group]), [[when, 'navigation@100']]);
  const palette = manifest.contributes.menus.commandPalette as { command: string; when?: string }[];
  assert.deepEqual(palette.filter((item) => item.command === 'zenwave.preview.copyMarkdown').map((item) => item.when), [when]);
  const menus = manifest.contributes.menus as Record<string, { command?: string }[]>;
  for (const submenu of ['zenwave.zflViews', 'zenwave.zdlViews', 'zenwave.zwViews']) {
    assert.ok(!menus[submenu]!.some((entry) => entry.command === 'zenwave.preview.copyMarkdown'), `${submenu} does not carry Copy as Markdown`);
  }
});

test('every table of a Markdown page is as wide as the page, whatever its content (MP-R28)', () => {
  const css = readFileSync(join(here, '../../webview/preview/preview.css'), 'utf8');
  const rule = css.split(/\r?\n/).find((line) => /^\.document table\s*\{/.test(line));
  assert.ok(rule, 'a rule for .document table');
  assert.match(rule, /width:\s*100%\s*!important;/);
  assert.match(rule, /display:\s*table;/, 'the table itself, not a block around it, is stretched');
});

test('the Copy as Markdown button follows the editor that is active, whatever order the events came in (MP-R26)', async () => {
  const docs = { id: 'docs', title: 'Model Docs', format: 'MARKDOWN' as const, content: '# Orders\n' };
  const side = harness(() => ok({ representations: [docs], defaultRepresentationId: 'docs' }), { hasRenderMode: false, uri: 'file:///workspace/orders.zdl', fileName: 'orders.zdl' });
  const diagram = harness(() => ok(ALT));
  // Opened to the side without focus: its page arrives while it is not the active editor.
  side.session.receive(READY);
  await side.session.refresh();
  diagram.session.receive(READY);
  await diagram.session.refresh();
  const previews = [
    { documentUri: 'file:///workspace/orders.zdl', get showsMarkdown() { return side.session.showsMarkdown; } },
    { documentUri: ZFL, get showsMarkdown() { return diagram.session.showsMarkdown; } },
  ];
  assert.equal(markdownContextValue(undefined, previews), false, 'a text editor is active');
  assert.equal(markdownContextValue('file:///workspace/other.zdl', previews), false, 'an editor that is no preview of ours');
  assert.equal(markdownContextValue(ZFL, previews), false, 'a diagram preview has no button');
  assert.equal(markdownContextValue('file:///workspace/orders.zdl', previews), true, 'clicking the side preview shows the button, though its page arrived earlier');
  // The page changes to a diagram while the preview stays active, and back.
  const withChart = harness(() => ok({ representations: [docs, mermaid('classes', 'Classes')], defaultRepresentationId: 'docs' }), { hasRenderMode: false, uri: 'file:///workspace/orders.zdl', fileName: 'orders.zdl' });
  withChart.session.receive(READY);
  await withChart.session.refresh();
  const one = [{ documentUri: 'file:///workspace/orders.zdl', get showsMarkdown() { return withChart.session.showsMarkdown; } }];
  assert.equal(markdownContextValue('file:///workspace/orders.zdl', one), true);
  withChart.session.selectRepresentation('classes');
  assert.equal(markdownContextValue('file:///workspace/orders.zdl', one), false);
  withChart.session.selectRepresentation('docs');
  assert.equal(markdownContextValue('file:///workspace/orders.zdl', one), true);
  await withChart.session.setPreviewMode('docs');
  assert.deepEqual(withChart.markdownContext, [true, false, true]);
  assert.equal(markdownContextValue('file:///workspace/gone.zdl', []), false, 'a closed preview leaves nothing to show');
});

test('the preview keybindings are scoped to model editors and cannot reach the built-in Markdown preview', () => {
  const bindings = manifest.contributes.keybindings as { command: string; key: string; mac?: string; when: string }[];
  assert.deepEqual(bindings.map((binding) => [binding.command, binding.key, binding.mac]), [
    ['zenwave.preview.open', 'ctrl+shift+v', 'cmd+shift+v'],
    ['zenwave.preview.openToSide', 'ctrl+k v', 'cmd+k v'],
  ]);
  for (const binding of bindings) {
    assert.match(binding.when, /editorTextFocus/);
    assert.ok(binding.when.includes('resourceExtname =~ /^\\.(zdl|zw|zfl)$/'), binding.when);
    assert.ok(!/markdown/i.test(binding.when), 'Markdown files are not matched');
  }
});

test('the preview page and the Mermaid bundle are runtime files, and Mermaid is pinned exactly', () => {
  for (const file of ['dist/preview-webview/preview.js', 'dist/preview-webview/preview.css', 'dist/preview-webview/mermaid.min.js']) {
    assert.ok(runtimeFiles.files.includes(file), `${file} is not listed in runtime-files.json`);
  }
  assert.match(manifest.dependencies.mermaid, /^\d+\.\d+\.\d+$/, 'Mermaid is pinned to an exact version');
});

const ZDL = 'file:///workspace/orders.zdl';
const diagram = (id: string, title: string, group: string): Preview['representations'][number] =>
  ({ id, title, format: 'MERMAID', content: `classDiagram\n  class ${title.replace(/\W/g, '_')}`, group });

/** What `zenwave/preview` answers with `mode: "diagrams"` (LVR-R17): groups in the server's order, an empty kind absent. */
const DIAGRAMS: Preview = {
  representations: [
    diagram('service:Orders', 'Orders', 'Services'),
    diagram('aggregate:Order', 'Order', 'Aggregates'),
    diagram('aggregate:Invoice', 'Invoice', 'Aggregates'),
    diagram('command:Orders:placeOrder', 'Orders.placeOrder', 'Commands'),
    diagram('command:Orders:cancelOrder', 'Orders.cancelOrder', 'Commands'),
  ],
  defaultRepresentationId: 'service:Orders',
};

function diagramsHarness(answer: (mode: PreviewMode | undefined) => Preview, options: { available?: boolean } = {}) {
  const posted: OutboundMessage[] = [];
  const asked: (PreviewMode | undefined)[] = [];
  const session = new PreviewSession({
    documentUri: ZDL,
    fileName: 'orders.zdl',
    hasRenderMode: false,
    preview: async (_uri, _renderMode, mode) => { asked.push(mode); return ok(answer(mode)); },
    diagramsAvailable: () => options.available ?? true,
    post: async (message) => { posted.push(message); return true; },
    runCommand: () => undefined,
    setContext: () => undefined,
    log: { info: () => undefined, warn: () => undefined, debug: () => undefined },
  });
  const renders = () => posted.flatMap((message) => message.type === 'zenwave.preview.render' ? [message.payload] : []);
  return { session, asked, renders };
}

const elementsOf = (render: { representations: Preview['representations']; selectedGroup?: string } | undefined) =>
  (render?.representations ?? []).filter((item) => item.group === render?.selectedGroup);

test('ZDL Diagrams groups the set in the server order: Show lists the kinds, Element the kind chosen (MP-R25)', async () => {
  const { session, renders, asked } = diagramsHarness(() => DIAGRAMS);
  session.receive(READY);
  assert.equal(await session.setPreviewMode('diagrams'), true);
  assert.deepEqual(asked, ['diagrams']);
  const first = renders().at(-1);
  assert.deepEqual(first?.groups, ['Services', 'Aggregates', 'Commands'], 'a kind with no element is not offered');
  assert.equal(first?.selectedGroup, 'Services');
  assert.equal(first?.selectedId, 'service:Orders');

  session.receive({ type: 'zenwave.preview.selectGroup', payload: { group: 'Commands' } });
  const commands = renders().at(-1);
  assert.equal(commands?.selectedGroup, 'Commands');
  assert.equal(commands?.selectedId, 'command:Orders:placeOrder', 'changing Show picks the first element of that kind');
  assert.deepEqual(elementsOf(commands).map((item) => item.title), ['Orders.placeOrder', 'Orders.cancelOrder']);

  session.receive({ type: 'zenwave.preview.selectGroup', payload: { group: 'Events' } });
  assert.equal(renders().at(-1)?.selectedId, 'command:Orders:placeOrder', 'a kind the set does not hold changes nothing');
  assert.equal(inboundMessage({ type: 'zenwave.preview.selectGroup', payload: {} }), undefined);
});

test('one kind hides Show, and one element hides Element: the page decides from these counts (MP-R25, MP-R10)', async () => {
  const single: Preview = { representations: [diagram('other:entities', 'Other entities', 'Other entities')], defaultRepresentationId: 'other:entities' };
  const one = diagramsHarness(() => single);
  one.session.receive(READY);
  await one.session.setPreviewMode('diagrams');
  assert.deepEqual(one.renders().at(-1)?.groups, ['Other entities'], 'one kind: Show is hidden');
  assert.equal(elementsOf(one.renders().at(-1)).length, 1, 'one element: Element is hidden');

  const many = diagramsHarness(() => DIAGRAMS);
  many.session.receive(READY);
  await many.session.setPreviewMode('diagrams');
  assert.equal(many.renders().at(-1)?.groups.length, 3);
  assert.equal(elementsOf(many.renders().at(-1)).length, 1, 'Services holds one element: Element is hidden while Show has three kinds');
});

test('the choice survives a refresh of the same document while the element exists, and falls to the default when it does not (MP-R25, MP-R12)', async () => {
  let answer = DIAGRAMS;
  const { session, renders } = diagramsHarness(() => answer);
  session.receive(READY);
  await session.setPreviewMode('diagrams');
  session.selectRepresentation('command:Orders:cancelOrder');
  await session.refresh();
  assert.equal(renders().at(-1)?.selectedId, 'command:Orders:cancelOrder');
  assert.equal(renders().at(-1)?.selectedGroup, 'Commands');

  // Another command of the same service must not be taken for the same element.
  answer = { ...DIAGRAMS, representations: DIAGRAMS.representations.filter((item) => item.id !== 'command:Orders:cancelOrder') };
  await session.refresh();
  assert.equal(session.selectedId, 'service:Orders');
});

test('without the capability the preview asks as before and offers no groups (MP-R25)', async () => {
  const { session, renders, asked } = diagramsHarness(() => ({ representations: [mermaid('classes', 'Classes')], defaultRepresentationId: 'classes' }), { available: false });
  session.receive(READY);
  assert.equal(await session.setPreviewMode('diagrams'), false);
  await session.refresh();
  assert.deepEqual(asked, [undefined], 'the request carries no mode');
  assert.equal(session.mode, 'docs');
  assert.deepEqual(renders().at(-1)?.groups, []);
  assert.equal(renders().at(-1)?.selectedGroup, undefined);
});

test('going back to Model Docs asks without a mode and drops the groups', async () => {
  const { session, renders, asked } = diagramsHarness((mode) => mode === 'diagrams' ? DIAGRAMS : zdlAnswer);
  session.receive(READY);
  await session.setPreviewMode('diagrams');
  await session.setPreviewMode('docs');
  assert.deepEqual(asked, ['diagrams', undefined]);
  assert.deepEqual(renders().at(-1)?.groups, []);
  assert.equal(renders().at(-1)?.selectedId, zdlAnswer.defaultRepresentationId);
});
