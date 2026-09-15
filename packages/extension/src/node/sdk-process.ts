import { exec, execFile } from 'node:child_process';
import process from 'node:process';
import type { CommandProbe, ProcessResult, SdkInvocation, SdkProcessService } from '../sdk/host.js';

const MAX_CATALOGUE_BYTES = 20 * 1024 * 1024;

function firstCommandToken(command: string): string | undefined {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function result(
  stdout: string,
  stderr: string,
  error: unknown,
): ProcessResult {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return {
    stdout,
    stderr,
    exitCode: typeof code === 'number' ? code : error ? 1 : 0,
  };
}

function catalogueResult(
  command: string,
  invocation: SdkInvocation,
  stdout: string,
  stderr: string,
  error: unknown,
): ProcessResult {
  const processResult = result(stdout, stderr, error);
  if (processResult.exitCode === 0) {
    return processResult;
  }
  const environment =
    invocation.environment === 'loginShell'
      ? `login shell "${invocation.loginShell}"`
      : 'the environment inherited by VS Code';
  return {
    ...processResult,
    stderr: `${stderr.trim()}\nCould not run "${command}" through ${environment}. PATH=${process.env.PATH ?? ''}`.trim(),
  };
}

export class NodeSdkProcessService implements SdkProcessService {
  catalogue(
    command: string,
    cwd: string | undefined,
    invocation: SdkInvocation,
  ): Promise<ProcessResult> {
    const catalogueCommand = `${command} -h json`;
    return new Promise((resolve) => {
      const callback = (
        error: unknown,
        stdout: string,
        stderr: string,
      ): void => resolve(catalogueResult(catalogueCommand, invocation, stdout, stderr, error));

      if (invocation.environment === 'loginShell') {
        if (!invocation.loginShell) {
          resolve({
            stdout: '',
            stderr: 'zenwave.sdk.loginShell is empty',
            exitCode: 1,
          });
          return;
        }
        execFile(
          invocation.loginShell,
          ['-l', '-c', catalogueCommand],
          { cwd, maxBuffer: MAX_CATALOGUE_BYTES, encoding: 'utf8' },
          callback,
        );
        return;
      }

      exec(
        catalogueCommand,
        { cwd, maxBuffer: MAX_CATALOGUE_BYTES, encoding: 'utf8' },
        callback,
      );
    });
  }

  async probe(
    command: string,
    cwd: string,
    invocation: SdkInvocation,
  ): Promise<CommandProbe> {
    const executable = firstCommandToken(command);
    const searchPath = process.env.PATH ?? '';
    if (!executable) {
      return { found: false, diagnosis: 'The configured SDK command is empty.' };
    }

    if (invocation.environment === 'loginShell') {
      if (!invocation.loginShell) {
        return {
          found: false,
          diagnosis:
            'The SDK is configured to use a login shell, but zenwave.sdk.loginShell is empty.',
        };
      }
      const check = await new Promise<ProcessResult>((resolve) => {
        execFile(
          invocation.loginShell,
          ['-l', '-c', `command -v -- ${shellQuote(executable)}`],
          { cwd },
          (error, stdout, stderr) => resolve(result(stdout, stderr, error)),
        );
      });
      return check.exitCode === 0
        ? { found: true, diagnosis: check.stdout.trim() }
        : {
            found: false,
            diagnosis: `Could not find "${executable}" from "${command}" through login shell "${invocation.loginShell}". The editor inherited PATH=${searchPath}`,
          };
    }

    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const check = await new Promise<ProcessResult>((resolve) => {
      execFile(locator, [executable], { cwd }, (error, stdout, stderr) =>
        resolve(result(stdout, stderr, error)),
      );
    });
    return check.exitCode === 0
      ? { found: true, diagnosis: check.stdout.trim() }
      : {
          found: false,
          diagnosis: `Could not find "${executable}" from "${command}" in the environment inherited by VS Code. Searched PATH=${searchPath}`,
        };
  }
}
