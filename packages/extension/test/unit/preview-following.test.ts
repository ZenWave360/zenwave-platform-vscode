import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Preview } from '../../src/lsp/requests.js';
import type { RequestResult } from '../../src/lsp/supervisor.js';
import { FollowingMemory, followTarget, followingTitle, isFollowingViewType } from '../../src/preview/following.js';
import { FOLLOWING_VIEW_TYPE, inboundMessage, type OutboundMessage, type RenderPayload } from '../../src/preview/protocol.js';
import { PreviewSession } from '../../src/preview/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8'));

const ORDERS = 'file:///workspace/orders.zdl';
const CHECKOUT = 'file:///workspace/checkout.zfl';

test('the following preview moves only for the text editor of a model it can preview (MP-R31)', () => {
  const model = (uri: string, extra: { previewable?: boolean; inDiff?: boolean } = {}) => ({ uri, previewable: true, inDiff: false, ...extra });
  assert.equal(followTarget(model(CHECKOUT), ORDERS), CHECKOUT, 'another model takes focus');
  assert.equal(followTarget(model(ORDERS), ORDERS), undefined, 'the same model again changes nothing');
  assert.equal(followTarget(undefined, ORDERS), undefined, 'the preview, a diagram or a view has no text editor');
  assert.equal(followTarget(model('file:///workspace/readme.md', { previewable: false }), ORDERS), undefined, 'another language is ignored');
  assert.equal(followTarget(model('untitled:Untitled-1', { previewable: false }), ORDERS), undefined, 'an untitled buffer is not previewable');
  assert.equal(followTarget(model(CHECKOUT, { inDiff: true }), ORDERS), undefined, 'a model open in a diff is ignored');
  assert.equal(followTarget(model(ORDERS), undefined), ORDERS);
});

test('the title names the file shown, and the panel is recognised by its tab (MP-R31)', () => {
  assert.equal(followingTitle('orders.zdl'), 'Following: orders.zdl');
  assert.equal(followingTitle(undefined), 'Following Preview');
  assert.ok(isFollowingViewType(FOLLOWING_VIEW_TYPE));
  assert.ok(isFollowingViewType(`mainThreadWebview-${FOLLOWING_VIEW_TYPE}`), 'a webview tab carries the host prefix');
  assert.ok(!isFollowingViewType('mainThreadWebview-zenwave.preview'));
  assert.ok(!isFollowingViewType('zenwave.preview'));
});

const mermaid = (id: string): Preview['representations'][number] => ({ id, title: id, format: 'MERMAID', content: `flowchart TD\n  A --> ${id}` });
const ANSWER: Preview = { representations: [mermaid('flowchart'), mermaid('sequence:a:0'), mermaid('sequence:b:1')], defaultRepresentationId: 'flowchart' };

/** One panel, many files: the posts go to the session on screen only, as the editor's `post` port does. */
function panel() {
  const posted: OutboundMessage[] = [];
  const memory = new FollowingMemory<PreviewSession>();
  let shown: PreviewSession | undefined;
  const open = (uri: string, fileName: string): PreviewSession => memory.recall(uri, () => {
    const session: PreviewSession = new PreviewSession({
      documentUri: uri, fileName, hasRenderMode: uri.endsWith('.zfl'),
      preview: async (): Promise<RequestResult<Preview>> => ({ kind: 'ok', value: ANSWER }),
      post: async (message) => { if (shown !== session) return false; posted.push(message); return true; },
      runCommand: () => undefined, setContext: () => undefined,
      log: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    });
    return session;
  });
  const show = (session: PreviewSession): void => {
    const page = shown?.page ?? { kind: 'ready' as const };
    shown = session;
    session.attach(page);
  };
  const renders = (): RenderPayload[] => posted.flatMap((message) => message.type === 'zenwave.preview.render' ? [message.payload] : []);
  return { open, show, posted, renders, memory };
}

test('a file shown again comes back with its diagram, mode and scroll; a new file opens at its default (MP-R31, MP-R4)', async () => {
  const { open, show, renders, memory } = panel();
  const orders = open(ORDERS, 'orders.zdl');
  show(orders);
  await orders.refresh();
  assert.equal(orders.selectedId, 'flowchart');
  orders.selectRepresentation('sequence:b:1');
  orders.receive({ type: 'zenwave.preview.scrolled', payload: { top: 420, key: 1 } });
  assert.equal(orders.scrollTop, 420, 'the report of the page that was attached is kept');
  orders.requestedMode = 'diagrams';

  const checkout = open(CHECKOUT, 'checkout.zfl');
  const before = renders().length;
  show(checkout);
  await checkout.refresh();
  const first = renders().slice(before);
  assert.equal(first.length, 1, 'a new file renders once its answer arrives');
  assert.equal(first[0]!.selectedId, 'flowchart', 'a new file opens at the default');
  assert.equal(first[0]!.restore?.top, 0, 'and at the top');
  assert.equal(checkout.requestedMode, 'docs');
  assert.equal(checkout.renderMode, 'ALT_BLOCKS');

  const again = renders().length;
  show(open(ORDERS, 'orders.zdl'));
  assert.equal(memory.has(CHECKOUT), true);
  const restored = renders().slice(again);
  assert.equal(restored.length, 1, 'the last good drawing is sent at once, before any new answer');
  assert.equal(restored[0]!.selectedId, 'sequence:b:1', 'the selected diagram is back');
  assert.equal(restored[0]!.restore?.top, 420, 'and so is the scroll position');
  assert.equal(orders.requestedMode, 'diagrams', 'and the mode');
});

test('the render mode of a ZFL is remembered per file too (MP-R31)', async () => {
  const { open, show } = panel();
  const checkout = open(CHECKOUT, 'checkout.zfl');
  show(checkout);
  await checkout.setRenderMode('SEPARATE_VARIANTS');
  show(open(ORDERS, 'orders.zdl'));
  show(open(CHECKOUT, 'checkout.zfl'));
  assert.equal(checkout.renderMode, 'SEPARATE_VARIANTS');
  assert.equal(open(ORDERS, 'orders.zdl').renderMode, 'ALT_BLOCKS');
});

test('a scroll report from before the switch does not overwrite what the file remembered (MP-R31)', async () => {
  const { open, show, renders } = panel();
  const orders = open(ORDERS, 'orders.zdl');
  show(orders);
  await orders.refresh();
  const first = renders().at(-1)!.restore!.key;
  orders.receive({ type: 'zenwave.preview.scrolled', payload: { top: 300, key: first } });
  show(open(CHECKOUT, 'checkout.zfl'));
  show(orders);
  const key = renders().at(-1)!.restore!.key;
  assert.notEqual(key, first);
  orders.receive({ type: 'zenwave.preview.scrolled', payload: { top: 5, key: first } });
  assert.equal(orders.scrollTop, 300, 'a report that predates the restore is dropped');
  orders.receive({ type: 'zenwave.preview.scrolled', payload: { top: 310, key } });
  assert.equal(orders.scrollTop, 310, 'a report from the restored page counts');
  await orders.refresh();
  assert.equal(renders().at(-1)!.restore, undefined, 'once the page reports, renders stop asking for a restore');
});

test('the answer of a file that is no longer on screen does not reach the page (MP-R31)', async () => {
  const { open, show, renders } = panel();
  const orders = open(ORDERS, 'orders.zdl');
  show(orders);
  const pending = orders.refresh();
  show(open(CHECKOUT, 'checkout.zfl'));
  await pending;
  assert.equal(renders().filter((render) => render.representations.length > 0 && render.selectedId === 'flowchart').length, 0, 'the old file drew nothing in the panel');
  assert.equal(orders.representations.length, 3, 'but it keeps the answer for when it is shown again');
});

test('the scrolled message is read from the page and nothing else (MP-R31)', () => {
  assert.deepEqual(inboundMessage({ type: 'zenwave.preview.scrolled', payload: { top: 12, key: 3 } }), { type: 'zenwave.preview.scrolled', payload: { top: 12, key: 3 } });
  assert.equal(inboundMessage({ type: 'zenwave.preview.scrolled', payload: { top: '12', key: 3 } }), undefined);
});

test('a lock turns the following preview into an ordinary one: the manifest puts it in the title bar of that panel only (MP-R31)', () => {
  const commands = manifest.contributes.commands as { command: string; title: string; category?: string; icon?: string }[];
  const open = commands.find((entry) => entry.command === 'zenwave.preview.openFollowing');
  assert.deepEqual([open?.title, open?.category], ['Open Following Preview', 'ZenWave']);
  const lock = commands.find((entry) => entry.command === 'zenwave.preview.lockFollowing');
  assert.equal(lock?.icon, '$(lock)');
  const palette = manifest.contributes.menus.commandPalette as { command: string; when?: string }[];
  assert.ok(palette.some((entry) => entry.command === 'zenwave.preview.openFollowing' && /!isInDiffEditor/.test(entry.when ?? '')), 'offered for a model, not in a diff');
  const title = manifest.contributes.menus['editor/title'] as { command?: string; when?: string }[];
  assert.deepEqual(title.filter((entry) => entry.command === 'zenwave.preview.lockFollowing').map((entry) => entry.when), [`activeWebviewPanelId == ${FOLLOWING_VIEW_TYPE}`]);
});
