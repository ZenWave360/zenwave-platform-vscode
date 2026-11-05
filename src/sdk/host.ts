import * as vscode from 'vscode';
import { resolveLoginShell } from './shell.js';

export type SdkEnvironment = 'inherited' | 'loginShell';

export interface SdkInvocation {
  readonly environment: SdkEnvironment;
  readonly loginShell: string;
}

/** What only a host that can spawn processes knows. Implemented under `src/node/`. */
export interface SdkProcessService {
  /** `process.platform` of the extension host. */
  readonly platform: string;
  /** The PATH the editor inherited, for diagnostics. */
  searchPath(): string;
  /** Resolves an executable as the inherited environment would, without running it. */
  findExecutable(executable: string, cwd: string): string | undefined;
}

export interface SdkSettings {
  readonly cliCommand: string;
  readonly extraArgs: readonly string[];
  readonly invocation: SdkInvocation;
}

export function readSdkSettings(uri?: vscode.Uri): SdkSettings {
  const configuration = vscode.workspace.getConfiguration('zenwave.sdk', uri);
  const configuredLoginShell = configuration.get<string>('loginShell');
  return {
    cliCommand: configuration.get<string>('cliCommand', 'jbang zw'),
    extraArgs: configuration.get<readonly string[]>('extraArgs', []),
    invocation: {
      environment: configuration.get<SdkEnvironment>('environment', 'inherited'),
      loginShell: resolveLoginShell(configuredLoginShell, vscode.env.shell),
    },
  };
}

const AUTOMATION_PROFILE_OS: Readonly<Record<string, string>> = {
  win32: 'windows',
  darwin: 'osx',
};

/** The shell a task will run in: the login shell, or VS Code's automation shell. */
export function taskShell(settings: SdkSettings, platform: string): string {
  if (settings.invocation.environment === 'loginShell') {
    return settings.invocation.loginShell;
  }
  const profile = vscode.workspace
    .getConfiguration('terminal.integrated')
    .get<{ readonly path?: unknown }>(
      `automationProfile.${AUTOMATION_PROFILE_OS[platform] ?? 'linux'}`,
    );
  return typeof profile?.path === 'string' && profile.path.trim()
    ? profile.path.trim()
    : vscode.env.shell;
}
