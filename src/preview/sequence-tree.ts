/**
 * The Sequence Diagrams selector as a tree grouped by end outcome (MP-R36, EF-R25). Pure: no DOM, so the page script
 * and the unit tests share it. It reads the server's structured steps and outcomes, never a title.
 *
 * The EventFlow dropdown draws the same tree in the vistas page (`variantOptionGroups`), which this extension does not
 * bundle, so the few lines that draw `├─ │ └─` are written here too.
 */
import type { VariantTreeGroup, VariantTreeNode } from '../lsp/requests.js';
import type { PageRepresentation } from './protocol.js';

/** One option of the selector. `title` is the tooltip: the full title of what choosing it shows. */
export interface SelectorOption {
  readonly value: string;
  readonly label: string;
  readonly title: string;
}

export interface SelectorGroup {
  readonly label: string;
  readonly options: readonly SelectorOption[];
}

/** Options outside any group (the flowchart) come first, then one group per outcome. */
export interface SelectorLayout {
  readonly loose: readonly SelectorOption[];
  readonly groups: readonly SelectorGroup[];
}

const NBSP = ' ';
/** A run of more steps than this keeps its first and last step around an ellipsis. */
const MAX_STEPS = 3;

export function runLabel(steps: readonly string[]): string {
  const shown = steps.length > MAX_STEPS ? [steps[0], '…', steps[steps.length - 1]] : steps;
  return shown.join(' → ');
}

function lineTitle(node: VariantTreeNode): string {
  return node.count > 1 ? `${node.title} (${node.count} variants)` : node.title;
}

function treeOptions(group: VariantTreeGroup): SelectorOption[] {
  const options: SelectorOption[] = [];
  const visit = (nodes: readonly VariantTreeNode[], guide: string, nested: boolean): void => {
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      const connector = nested ? (last ? '└─ ' : '├─ ') : '';
      const text = runLabel(node.steps) + (node.children.length > 0 ? ` (${node.count})` : '');
      options.push({ value: node.id, label: `${guide}${connector}${text}`.replace(/ /g, NBSP), title: lineTitle(node) });
      visit(node.children, nested ? guide + (last ? '   ' : '│  ') : guide, true);
    });
  };
  visit(group.nodes, '', false);
  return options;
}

/**
 * Separate variants with a tree: a prefix tree of steps in each outcome. Alt blocks, with no tree but with outcomes on
 * the representations: one line per diagram under its outcome. Otherwise `undefined`, and the selector stays flat.
 */
export function sequenceSelector(representations: readonly PageRepresentation[], tree: readonly VariantTreeGroup[] | undefined): SelectorLayout | undefined {
  const whole = (item: PageRepresentation): SelectorOption => ({ value: item.id, label: item.title, title: item.title });
  if (tree !== undefined && tree.length > 0) {
    const inTree = new Set<string>();
    const note = (nodes: readonly VariantTreeNode[]): void => nodes.forEach((node) => { inTree.add(node.id); note(node.children); });
    tree.forEach((group) => note(group.nodes));
    return {
      loose: representations.filter((item) => !inTree.has(item.id)).map(whole),
      groups: tree.map((group) => ({ label: group.outcome, options: treeOptions(group) })),
    };
  }
  if (!representations.some((item) => item.outcome !== undefined)) return undefined;
  const outcomes: string[] = [];
  for (const item of representations) if (item.outcome !== undefined && !outcomes.includes(item.outcome)) outcomes.push(item.outcome);
  return {
    loose: representations.filter((item) => item.outcome === undefined).map(whole),
    groups: outcomes.map((outcome) => ({ label: outcome, options: representations.filter((item) => item.outcome === outcome).map(whole) })),
  };
}

/** What the toolbar shows for the chosen option when the selector has groups: its full title. */
export function chosenTitle(layout: SelectorLayout, value: string): string | undefined {
  for (const option of [...layout.loose, ...layout.groups.flatMap((group) => group.options)]) {
    if (option.value === value) return option.title;
  }
  return undefined;
}
