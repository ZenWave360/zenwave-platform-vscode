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
