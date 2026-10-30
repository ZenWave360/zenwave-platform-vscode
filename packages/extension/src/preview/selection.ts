/**
 * Which representation stays selected when a new set arrives (MP-R12). Pure.
 *
 * The exact id wins. Failing that, the same outcome: the ids the server gave for
 * a ZFL sequence read `sequence:<outcome>:<index>`, and it is only these
 * identifiers that are read here, never a title or the content. Otherwise the
 * server's default.
 */

export interface Identified {
  readonly id: string;
}

/** The outcome part of an id of the form `<kind>:<outcome>:<index>`, or `undefined` for any other id. */
export function outcomeOf(id: string): string | undefined {
  const first = id.indexOf(':');
  const last = id.lastIndexOf(':');
  return first > 0 && last > first ? id.slice(first + 1, last) : undefined;
}

export type SelectionReason = 'kept' | 'same-outcome' | 'default' | 'first';

export interface Selection {
  readonly id: string;
  readonly reason: SelectionReason;
}

/** `previous` is the id selected before; `undefined` when nothing was (a first answer). */
export function reselect(previous: string | undefined, representations: readonly Identified[], defaultId: string): Selection | undefined {
  if (representations.length === 0) return undefined;
  if (previous !== undefined) {
    if (representations.some((item) => item.id === previous)) return { id: previous, reason: 'kept' };
    const outcome = outcomeOf(previous);
    if (outcome !== undefined) {
      const same = representations.find((item) => outcomeOf(item.id) === outcome);
      if (same) return { id: same.id, reason: 'same-outcome' };
    }
  }
  if (representations.some((item) => item.id === defaultId)) return { id: defaultId, reason: 'default' };
  return { id: representations[0]!.id, reason: 'first' };
}
