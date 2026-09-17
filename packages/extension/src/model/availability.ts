import type { LanguageServerStatus } from '../lsp/status.js';

/**
 * Whether a server-backed command can run now, and if not, which of the two
 * reasons applies: no server, or a server that does not offer the request.
 * Pure, so the distinction and its wording are testable without an editor.
 */
export type CommandAvailability =
  | { readonly kind: 'available' }
  | { readonly kind: 'no-server'; readonly message: string }
  | { readonly kind: 'unsupported'; readonly message: string; readonly missing: readonly string[] };

export interface AvailabilityInputs {
  readonly status: LanguageServerStatus;
  readonly advertisedRequests: readonly string[];
  readonly serverVersion?: string;
}

export function commandAvailability(
  feature: string,
  requiredRequests: readonly string[],
  inputs: AvailabilityInputs,
): CommandAvailability {
  const { status } = inputs;
  if (status.kind === 'starting') {
    return { kind: 'no-server', message: `${feature} needs the ZenWave language server, which is still starting. Try again in a moment.` };
  }
  if (status.kind !== 'connected') {
    return { kind: 'no-server', message: `${feature} needs the ZenWave language server, which is not available here: ${status.reason}.` };
  }
  const missing = requiredRequests.filter((method) => !inputs.advertisedRequests.includes(method));
  if (missing.length > 0) {
    const server = inputs.serverVersion ? `ZenWave language server (${inputs.serverVersion})` : 'ZenWave language server';
    return {
      kind: 'unsupported',
      missing,
      message: `${feature} is not supported by the connected ${server}: it does not offer ${missing.join(', ')}.`,
    };
  }
  return { kind: 'available' };
}
