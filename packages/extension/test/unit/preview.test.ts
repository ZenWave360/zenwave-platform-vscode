import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Preview, SequenceRenderMode } from '../../src/lsp/requests.js';
import type { RequestResult } from '../../src/lsp/supervisor.js';
import { buildFailedHtml, buildPreviewHtml, previewContentSecurityPolicy } from '../../src/preview/page.js';
import { inboundMessage, PREVIEW_VIEW_TYPE, RENDER_MODES, type OutboundMessage } from '../../src/preview/protocol.js';
import { outcomeOf, reselect } from '../../src/preview/selection.js';
import { PreviewSession } from '../../src/preview/session.js';
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
  const session = new PreviewSession({
    documentUri: options.uri ?? ZFL,
    fileName: options.fileName ?? 'checkout.zfl',
    hasRenderMode: options.hasRenderMode ?? true,
    preview: async (_uri, mode) => { asked.push(mode); return answer(mode); },
    post: async (message) => { posted.push(message); return true; },
    runCommand: (command) => { commands.push(command); },
    log: { info: (line) => logs.push(line), warn: (line) => logs.push(line), debug: (line) => logs.push(line) },
  });
  const renders = () => posted.flatMap((message) => message.type === 'zenwave.preview.render' ? [message.payload] : []);
  return { session, posted, asked, logs, commands, renders };
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

test('a ZDL class diagram has no render mode to offer, and the request carries none', async () => {
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

test('an answer overtaken by a newer request is dropped, so the last document typed is the one shown', async () => {
  const gates: ((result: RequestResult<Preview>) => void)[] = [];
  const { session, renders } = harness(() => new Promise((resolve) => { gates.push(resolve); }));
  session.receive(READY);
  const slow = session.refresh();
  const fast = session.refresh();
  gates[1]!(ok({ representations: [mermaid('flowchart', 'newer')], defaultRepresentationId: 'flowchart' }));
  await fast;
  gates[0]!(ok({ representations: [mermaid('flowchart', 'older')], defaultRepresentationId: 'flowchart' }));
  await slow;
  assert.deepEqual(renders().map((render) => render.representations[0]?.title), ['newer']);
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
  const answer = session.probe(1000);
  const asked = posted.find((message) => message.type === 'zenwave.host.probe');
  assert.ok(asked && asked.type === 'zenwave.host.probe');
  session.receive({ type: 'zenwave.host.probeResult', payload: { requestId: asked.payload.requestId, svgCount: 1 } });
  assert.equal((await answer).svgCount, 1);
  await settle();
});

test('messages from the page are read by shape, and anything else is ignored', () => {
  assert.deepEqual(inboundMessage({ type: 'zenwave.preview.selectRenderMode', payload: { mode: 'SEPARATE_VARIANTS' } }), { type: 'zenwave.preview.selectRenderMode', payload: { mode: 'SEPARATE_VARIANTS' } });
  assert.equal(inboundMessage({ type: 'zenwave.preview.selectRenderMode', payload: { mode: 'AUTO' } }), undefined, 'AUTO is not offered');
  assert.equal(inboundMessage({ type: 'zenwave.preview.selectRepresentation', payload: {} }), undefined);
  assert.equal(inboundMessage({ type: 'something.else' }), undefined);
  assert.equal(inboundMessage(null), undefined);
  assert.deepEqual(RENDER_MODES.map((mode) => mode.label), ['Alt blocks', 'Separate variants']);
});

test('the page has a CSP with no remote, inline-script or eval allowance, only inline styles, and only its own assets', () => {
  const resources = {
    cspSource: 'https://*.vscode-cdn.net', nonce: 'abc123',
    scriptUri: 'https://x.vscode-cdn.net/ext/dist/preview-webview/preview.js',
    styleUri: 'https://x.vscode-cdn.net/ext/dist/preview-webview/preview.css',
    mermaidUri: 'https://x.vscode-cdn.net/ext/dist/preview-webview/mermaid.min.js',
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
  assert.ok(!/<script[^>]*src="[^"]*mermaid/.test(html), 'Mermaid is loaded on the first diagram, not when the panel opens');
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style="/.test(html), 'the page carries no inline style');
  const failed = buildFailedHtml(resources, 'Could not load <b>preview.js</b>');
  assert.ok(failed.includes('Could not load &lt;b&gt;preview.js&lt;/b&gt;'));
  assert.ok(!failed.includes('<script'), 'the static failure page runs nothing');
  assert.ok(html.includes('id="render-mode"') && html.includes('id="diagram"'));
});

test('the manifest registers an optional preview editor for .zdl and .zfl, offered from the one submenu', () => {
  const contributes = manifest.contributes;
  assert.deepEqual(contributes.customEditors.find((editor: { viewType: string }) => editor.viewType === PREVIEW_VIEW_TYPE),
    { viewType: 'zenwave.preview', displayName: 'ZenWave Preview', selector: [{ filenamePattern: '*.zdl' }, { filenamePattern: '*.zfl' }], priority: 'option' });
  const commands = (contributes.commands as { command: string; title: string }[]).map((entry) => entry.command);
  for (const command of ['zenwave.preview.open', 'zenwave.preview.openToSide', 'zenwave.preview.showText', 'zenwave.preview.selectDiagram', 'zenwave.preview.selectRenderMode']) {
    assert.ok(commands.includes(command), `${command} is not contributed`);
  }
  const title = contributes.menus['editor/title'] as { command?: string; submenu?: string; when: string }[];
  const [submenu] = title.filter((item) => item.submenu);
  assert.equal(submenu?.submenu, 'zenwave.modelViews');
  assert.match(submenu?.when ?? '', /resourceExtname == \.zdl/);
  assert.match(submenu?.when ?? '', /resourceExtname == \.zfl/);
  assert.match(submenu?.when ?? '', /!isInDiffEditor/, 'no preview is offered in a diff (MP-Q4)');
  assert.ok(!title.some((item) => item.command?.startsWith('zenwave.preview.')), 'the preview has no title-bar icon of its own');
  const entries = contributes.menus['zenwave.modelViews'] as { command: string; when: string }[];
  const eventflow = entries.filter((entry) => entry.command.startsWith('zenwave.eventflow.'));
  const preview = entries.filter((entry) => entry.command.startsWith('zenwave.preview.'));
  assert.deepEqual(preview.map((entry) => entry.command).sort(), ['zenwave.preview.open', 'zenwave.preview.openToSide', 'zenwave.preview.showText']);
  for (const entry of eventflow.filter((item) => item.command !== 'zenwave.eventflow.showText')) {
    assert.match(entry.when, /^resourceExtname == \.zfl /, `${entry.command} stays on ZFL`);
  }
  for (const entry of preview.filter((item) => item.command !== 'zenwave.preview.showText')) {
    assert.ok(entry.when.includes('resourceExtname =~ /^\\.(zdl|zfl)$/'), `${entry.command} covers ZDL and ZFL, and not .zw yet`);
  }
  const palette = Object.fromEntries((contributes.menus.commandPalette as { command: string; when?: string }[]).map((entry) => [entry.command, entry.when]));
  assert.match(palette['zenwave.preview.open'] ?? '', /editorLangId =~ \/\^\(zdl\|zfl\)\$\//, 'an untitled model sees the command, which tells it to save first');
  assert.match(palette['zenwave.preview.openToSide'] ?? '', /!isInDiffEditor/);
  assert.match(palette['zenwave.preview.selectRenderMode'] ?? '', /resourceExtname == \.zfl/);
});

test('the preview keybindings are scoped to model editors and cannot reach the built-in Markdown preview', () => {
  const bindings = manifest.contributes.keybindings as { command: string; key: string; mac?: string; when: string }[];
  assert.deepEqual(bindings.map((binding) => [binding.command, binding.key, binding.mac]), [
    ['zenwave.preview.open', 'ctrl+shift+v', 'cmd+shift+v'],
    ['zenwave.preview.openToSide', 'ctrl+k v', 'cmd+k v'],
  ]);
  for (const binding of bindings) {
    assert.match(binding.when, /editorTextFocus/);
    assert.ok(binding.when.includes('resourceExtname =~ /^\\.(zdl|zfl)$/'), binding.when);
    assert.ok(!/markdown/i.test(binding.when), 'Markdown files are not matched');
  }
});

test('the preview page and the Mermaid bundle are runtime files, and Mermaid is pinned exactly', () => {
  for (const file of ['dist/preview-webview/preview.js', 'dist/preview-webview/preview.css', 'dist/preview-webview/mermaid.min.js']) {
    assert.ok(runtimeFiles.files.includes(file), `${file} is not listed in runtime-files.json`);
  }
  assert.match(manifest.dependencies.mermaid, /^\d+\.\d+\.\d+$/, 'Mermaid is pinned to an exact version');
});
