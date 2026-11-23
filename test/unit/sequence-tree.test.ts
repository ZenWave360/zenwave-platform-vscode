import assert from 'node:assert/strict';
import test from 'node:test';
import type { VariantTreeGroup } from '../../src/lsp/requests.js';
import type { PageRepresentation } from '../../src/preview/protocol.js';
import { chosenTitle, runLabel, sequenceSelector } from '../../src/preview/sequence-tree.js';

const rep = (id: string, title: string, outcome?: string): PageRepresentation => ({ id, title, format: 'MERMAID', content: '', ...(outcome === undefined ? {} : { outcome }) });
const leaf = (id: string, steps: string[], title: string) => ({ id, steps, title, count: 1, children: [] });
const nbsp = (text: string) => text.replace(/ /g, ' ');

const tree: VariantTreeGroup[] = [
  {
    outcome: 'completed',
    nodes: [{
      id: 'branch:completed:0', steps: ['Start', 'reserved'], title: 'from Start → reserved to completed', count: 3,
      children: [
        {
          id: 'branch:completed:0.0', steps: ['authorized'], title: 'from Start → reserved → authorized to completed', count: 2,
          children: [
            leaf('sequence:completed:0', ['shipped'], 'from Start → reserved → authorized → shipped to completed'),
            leaf('sequence:completed:1', ['pickup'], 'from Start → reserved → authorized → pickup to completed'),
          ],
        },
        leaf('sequence:completed:2', ['retried'], 'from Start → reserved → retried to completed'),
      ],
    }],
  },
  { outcome: 'failed', nodes: [leaf('sequence:failed:3', ['Start', 'declined'], 'from Start → declined to failed')] },
];
const representations = [
  rep('flowchart', 'Flowchart'),
  ...['sequence:completed:0', 'sequence:completed:1', 'sequence:completed:2', 'sequence:failed:3', 'branch:completed:0', 'branch:completed:0.0']
    .map((id) => rep(id, `Sequence: ${id}`, id.split(':')[1])),
];

test('with a tree the flowchart stays first and each outcome is a group of lines that show only the steps they add (MP-R36)', () => {
  const layout = sequenceSelector(representations, tree)!;
  assert.deepEqual(layout.loose.map((option) => option.value), ['flowchart']);
  assert.deepEqual(layout.groups.map((group) => group.label), ['completed', 'failed']);
  assert.deepEqual(layout.groups[0]!.options.map((option) => option.label), [
    nbsp('Start → reserved (3)'), nbsp('├─ authorized (2)'), nbsp('│  ├─ shipped'), nbsp('│  └─ pickup'), nbsp('└─ retried'),
  ]);
  assert.ok(layout.groups.flatMap((group) => group.options).every((option) => !option.label.includes(' ')), 'only non-breaking spaces, so the select keeps the indentation');
  assert.deepEqual(layout.groups[1]!.options.map((option) => option.label), [nbsp('Start → declined')]);
});

test('every line is a representation of the set, so choosing it needs nothing else from the server (MP-R36)', () => {
  const layout = sequenceSelector(representations, tree)!;
  const ids = new Set(representations.map((item) => item.id));
  assert.ok([...layout.loose, ...layout.groups.flatMap((group) => group.options)].every((option) => ids.has(option.value)));
});

test('the tooltip and the toolbar show the full title, and a line with several variants says how many', () => {
  const layout = sequenceSelector(representations, tree)!;
  assert.equal(chosenTitle(layout, 'sequence:failed:3'), 'from Start → declined to failed');
  assert.equal(chosenTitle(layout, 'branch:completed:0.0'), 'from Start → reserved → authorized to completed (2 variants)');
  assert.equal(layout.groups[0]!.options[2]!.title, 'from Start → reserved → authorized → shipped to completed');
  assert.equal(chosenTitle(layout, 'flowchart'), 'Flowchart');
  assert.equal(chosenTitle(layout, 'nope'), undefined);
});

test('a variant that ends at a line with others under it is a leaf that adds no steps (EF-R25)', () => {
  const ends: VariantTreeGroup[] = [{ outcome: 'x', nodes: [{ id: 'branch:x:1', steps: ['A', 'x'], title: 't', count: 2, children: [leaf('v0', [], 'from A → x to x'), leaf('v1', ['y'], 'from A → x → y to x')] }] }];
  const layout = sequenceSelector([rep('v0', 'V0', 'x'), rep('v1', 'V1', 'x')], ends)!;
  assert.deepEqual(layout.groups[0]!.options.map((option) => [option.value, option.label]), [['branch:x:1', nbsp('A → x (2)')], ['v0', nbsp('├─ (ends here)')], ['v1', nbsp('└─ y')]]);
});

test('long runs are shortened with an ellipsis', () => {
  assert.equal(runLabel(['a', 'b', 'c']), 'a → b → c');
  assert.equal(runLabel(['StartOrderCheckout', 'StockReservedResult', 'authorizePayment', 'authorized']), 'StartOrderCheckout → … → authorized');
});

test('Alt blocks has no tree: one line per diagram under its outcome, the flowchart first (MP-R36)', () => {
  const alt = [rep('flowchart', 'Flowchart'), rep('sequence:completed:0', 'Sequence: from S to completed', 'completed'), rep('sequence:cancelled:1', 'Sequence: from S to cancelled', 'cancelled')];
  const layout = sequenceSelector(alt, undefined)!;
  assert.deepEqual(layout.loose.map((option) => option.value), ['flowchart']);
  assert.deepEqual(layout.groups.map((group) => [group.label, group.options.map((option) => option.label)]), [
    ['completed', ['Sequence: from S to completed']],
    ['cancelled', ['Sequence: from S to cancelled']],
  ]);
});

test('a server that names no outcome gets the flat selector it always had', () => {
  assert.equal(sequenceSelector([rep('flowchart', 'Flowchart'), rep('sequence:a:0', 'A')], undefined), undefined);
  assert.equal(sequenceSelector([rep('flowchart', 'Flowchart'), rep('sequence:a:0', 'A')], []), undefined);
});
