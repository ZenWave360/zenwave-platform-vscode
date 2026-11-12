/**
 * Lets an asynchronous view discard an answer which no longer belongs to the
 * target it was asked for. Kept editor-API-free so the race is unit-testable.
 */
export class LatestLoad<Target, Result> {
  private generation = 0;

  async run(
    resolveTarget: () => Target,
    load: (target: Target) => Promise<Result>,
    sameTarget: (left: Target, right: Target) => boolean,
  ): Promise<{ readonly target: Target; readonly result: Result } | undefined> {
    const generation = ++this.generation;
    const target = resolveTarget();
    const result = await load(target);
    return generation === this.generation && sameTarget(target, resolveTarget()) ? { target, result } : undefined;
  }
}

/**
 * Publishes a load only when that attempt finished for the target it captured.
 * A dropped attempt, or one that stopped because the target moved, has to run
 * again: returning without a follow-up leaves the previous tree on screen.
 */
export function resumeAbandoned<T extends { readonly result: { readonly superseded?: boolean } }>(
  current: T | undefined,
  resume: () => void,
): T | undefined {
  if (current && current.result.superseded !== true) return current;
  resume();
  return undefined;
}
