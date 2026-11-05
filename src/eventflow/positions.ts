/**
 * The saved-positions file of a full EventFlow diagram (EF-R14, decision 0022): pure, so every rule is testable.
 * The host only reads and writes the file; the server applies the positions.
 */

export const POSITIONS_SCHEMA = 'zfl.eventflow.positions@1';

export interface Position { readonly x: number; readonly y: number }
export type Positions = Readonly<Record<string, Position>>;

/** `checkout.zfl` saves to `checkout.zfl.positions.json`, beside it. */
export function positionsFileName(modelFileName: string): string {
  return `${modelFileName}.positions.json`;
}

export interface PositionsFile {
  readonly exists: boolean;
  /** Absent when there is no file, or when it cannot be applied (then it is treated as absent for applying). */
  readonly positions?: Positions;
  /** Why an existing file cannot be applied; goes to the log. */
  readonly why?: string;
}

export function parsePositionsFile(text: string): PositionsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { exists: true, why: `it is not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (typeof parsed !== 'object' || parsed === null) return { exists: true, why: 'it is not a JSON object' };
  const { schema, flow } = parsed as { schema?: unknown; flow?: unknown };
  if (schema !== POSITIONS_SCHEMA) return { exists: true, why: `its schema is ${JSON.stringify(schema)}, not ${POSITIONS_SCHEMA}` };
  if (typeof flow !== 'object' || flow === null || Array.isArray(flow)) return { exists: true, why: 'it has no "flow" object' };
  // Values are passed on as they are: the server judges a value that is not a finite number (reason `invalid`).
  return { exists: true, positions: flow as Positions };
}

/** A page's positions as the host will write them: an object of finite numbers, rounded to whole numbers. Otherwise `undefined`. */
export function validatePositions(value: unknown): Positions | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const positions: Record<string, Position> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { x, y } = entry as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    positions[id] = { x: Math.round(x) + 0, y: Math.round(y) + 0 };
  }
  return positions;
}

/** Keys sorted (ids that look like integers would otherwise be reordered by the object), two-space indent, trailing newline. */
export function serializePositions(positions: Positions): string {
  const ids = Object.keys(positions).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = ids.map((id) => `    ${JSON.stringify(id)}: { "x": ${positions[id]!.x}, "y": ${positions[id]!.y} }`);
  const flow = lines.length === 0 ? '{}' : `{\n${lines.join(',\n')}\n  }`;
  return `{\n  "schema": ${JSON.stringify(POSITIONS_SCHEMA)},\n  "flow": ${flow}\n}\n`;
}
