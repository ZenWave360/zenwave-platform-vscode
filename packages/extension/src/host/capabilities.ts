/**
 * What the extension host we are running in is actually able to do.
 *
 * These are established by *construction* — the Node entry point knows it is
 * Node, the browser entry point knows it is a Web Worker — rather than by
 * inspecting `vscode.env` from shared code. That keeps the browser bundle free
 * of branches claiming process support it can never have, and it means adding a
 * new host means adding a new entry point, not another special case here.
 */
export interface HostCapabilities {
  /** Human-readable host name, for diagnostics. */
  readonly hostKind: 'desktop' | 'web';

  /**
   * Whether an external command line tool can be spawned.
   *
   * This is what gates ZenWave SDK code generation. `zenwave-sdk` is JVM-only
   * and launched through JBang, so in the browser this is permanently false —
   * not "false until something is installed".
   */
  readonly canRunProcesses: boolean;

  /** Whether terminal-backed tasks (`ShellExecution`) can run. */
  readonly canUseTerminal: boolean;

  /** Whether workspace files live on a local disk the host can reach directly. */
  readonly hasLocalFileSystem: boolean;

  /**
   * Which language server transport is usable here: `ipc` for a Node child
   * process (desktop), `worker` for a Web Worker (web), `none` when this host or
   * build has no server to run. The same `@zenwave360/lsp-js` server in both.
   */
  readonly languageServer: 'ipc' | 'worker' | 'none';
}

export const DESKTOP_CAPABILITIES: HostCapabilities = {
  hostKind: 'desktop',
  canRunProcesses: true,
  canUseTerminal: true,
  hasLocalFileSystem: true,
  languageServer: 'ipc',
};

export const WEB_CAPABILITIES: HostCapabilities = {
  hostKind: 'web',
  canRunProcesses: false,
  canUseTerminal: false,
  hasLocalFileSystem: false,
  languageServer: 'worker',
};

/**
 * Context keys published for `when` clauses in `package.json`.
 *
 * A context key hides a control; it does not secure it. Commands must also
 * check capabilities when they execute, because the palette is not the only way
 * to invoke one.
 */
export const CONTEXT_KEYS = {
  canRunSdk: 'zenwave.canRunSdk',
  canUseTerminal: 'zenwave.canUseTerminal',
} as const;

export function describeCapabilities(capabilities: HostCapabilities): string {
  return [
    `host:            ${capabilities.hostKind}`,
    `processes:       ${capabilities.canRunProcesses}`,
    `terminal tasks:  ${capabilities.canUseTerminal}`,
    `local files:     ${capabilities.hasLocalFileSystem}`,
    `language server: ${capabilities.languageServer}${{
      ipc: ' (Node child process)',
      worker: ' (Web Worker)',
      none: ' (no server in this host or build: highlighting and editing only)',
    }[capabilities.languageServer]}`,
  ].join('\n  ');
}
