import * as vscode from 'vscode';

export type SdkEnvironment = 'inherited' | 'loginShell';

export interface SdkInvocation {
  readonly environment: SdkEnvironment;
  readonly loginShell: string;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandProbe {
  readonly found: boolean;
  readonly diagnosis: string;
}

export interface SdkProcessService {
  catalogue(
    command: string,
    cwd: string | undefined,
    invocation: SdkInvocation,
  ): Promise<ProcessResult>;
  probe(command: string, cwd: string, invocation: SdkInvocation): Promise<CommandProbe>;
}

export interface SdkSettings {
  readonly cliCommand: string;
  readonly extraArgs: readonly string[];
  readonly invocation: SdkInvocation;
}

export function readSdkSettings(uri?: vscode.Uri): SdkSettings {
  const configuration = vscode.workspace.getConfiguration('zenwave.sdk', uri);
  return {
    cliCommand: configuration.get<string>('cliCommand', 'jbang zw'),
    extraArgs: configuration.get<readonly string[]>('extraArgs', []),
    invocation: {
      environment: configuration.get<SdkEnvironment>('environment', 'inherited'),
      loginShell: configuration.get<string>('loginShell', ''),
    },
  };
}
