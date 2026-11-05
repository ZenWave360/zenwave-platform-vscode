import type { LanguageServerTransport } from './client.js';
import type { ResolvedManifest } from './manifest-resolution.js';
import type { LspState } from './supervisor.js';

/**
 * What the user is told about ZenWave's language features. Pure, so the words
 * and the choice of indication are testable without an editor.
 */
export type LanguageServerStatus =
  | { readonly kind: 'connected' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'disabled' | 'untrusted' | 'no-server' | 'failed'; readonly reason: string };

export interface StatusInputs {
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly transport: LanguageServerTransport;
  /** Why the host has nothing to run, when that is so. */
  readonly absentReason?: string;
  readonly state: LspState;
}

export function languageServerStatus(inputs: StatusInputs): LanguageServerStatus {
  if (!inputs.enabled) return { kind: 'disabled', reason: 'zenwave.lsp.enabled is off' };
  if (!inputs.trusted) {
    return { kind: 'untrusted', reason: 'this workspace is not trusted; trust it to start the language server, resolve content and use credentials' };
  }
  if (inputs.transport === 'none' || inputs.absentReason) {
    return { kind: 'no-server', reason: inputs.absentReason ?? 'no language server transport is available in this host' };
  }
  switch (inputs.state.kind) {
    case 'connected': return { kind: 'connected' };
    case 'starting': return { kind: 'starting' };
    case 'stopping': return { kind: 'no-server', reason: 'the language server is stopping' };
    case 'failed': return { kind: 'failed', reason: inputs.state.reason };
    case 'unavailable': return { kind: 'no-server', reason: inputs.state.reason };
  }
}

export interface StatusPresentation {
  readonly text: string;
  readonly tooltip: string;
  /** Whether the indication calls for attention (a failure). */
  readonly warning: boolean;
}

export function presentStatus(
  status: LanguageServerStatus,
  hostKind: 'desktop' | 'web',
  manifest: ResolvedManifest,
  serverVersion: string | undefined,
): StatusPresentation {
  const icon = {
    connected: '$(check)', starting: '$(sync~spin)', disabled: '$(circle-slash)',
    untrusted: '$(shield)', 'no-server': '$(circle-slash)', failed: '$(warning)',
  }[status.kind];
  const host = hostKind === 'web' ? ' (web)' : '';
  const headline = {
    connected: `ZenWave language features are available${serverVersion ? ` (server ${serverVersion})` : ''}`,
    starting: 'The ZenWave language server is starting',
    disabled: 'ZenWave language features are turned off',
    untrusted: 'ZenWave language features are held back in Restricted Mode',
    'no-server': 'ZenWave language features are unavailable here',
    failed: 'The ZenWave language server is not running',
  }[status.kind];
  const lines = [headline];
  if ('reason' in status) lines.push(`Why: ${status.reason}`);
  lines.push(manifest.manifestUri
    ? `Architecture manifest: ${manifest.manifestUri}`
    : 'No architecture manifest is configured: set zenwave.workspace.manifest, or add .zenwave/config.yml with project-manifest');
  if (hostKind === 'web') lines.push('This is a browser host: ZenWave SDK code generation is not available here.');
  lines.push('Select for details and actions.');
  return { text: `${icon} ZenWave${host}`, tooltip: lines.join('\n'), warning: status.kind === 'failed' };
}
