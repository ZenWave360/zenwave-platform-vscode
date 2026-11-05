import * as vscode from 'vscode';

export type TraceLevel = 'off' | 'info' | 'debug';

const ORDER: Record<TraceLevel, number> = { off: 0, info: 1, debug: 2 };

/**
 * The ZenWave output channel.
 *
 * Capability gating hides controls, which means a user who expects a feature
 * sees nothing at all rather than an error. The output channel is how they find
 * out why, so activation always writes the detected capabilities here.
 */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(name = 'ZenWave') {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  /** The channel itself, for the language client's own logging and protocol trace. */
  get outputChannel(): vscode.LogOutputChannel {
    return this.channel;
  }

  private get level(): TraceLevel {
    return vscode.workspace.getConfiguration('zenwave').get<TraceLevel>('trace.level', 'info');
  }

  private enabled(level: Exclude<TraceLevel, 'off'>): boolean {
    return ORDER[this.level] >= ORDER[level];
  }

  info(message: string): void {
    if (this.enabled('info')) {
      this.channel.info(message);
    }
  }

  debug(message: string): void {
    if (this.enabled('debug')) {
      this.channel.debug(message);
    }
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string, error?: unknown): void {
    this.channel.error(error instanceof Error ? `${message}: ${error.message}` : message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
