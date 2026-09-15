import { exec, execFile } from 'node:child_process';
import process from 'node:process';
import type { CommandProbe, ProcessResult, SdkInvocation, SdkProcessService } from '../sdk/host.js';
import { loginShellArguments } from '../sdk/shell.js';

const MAX_CATALOGUE_BYTES = 20 * 1024 * 1024;

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
          [...loginShellArguments(invocation.loginShell), catalogueCommand],
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
    const trimmedCommand = command.trim();
    const searchPath = process.env.PATH ?? '';
    if (!trimmedCommand) {
      return { found: false, diagnosis: 'The configured SDK command is empty.' };
    }
    const attempted = `${trimmedCommand} -h json`;
    const check = await this.catalogue(trimmedCommand, cwd, invocation);
    if (check.exitCode === 0) {
      return { found: true, diagnosis: `Started "${attempted}" in "${cwd}".` };
    }
    const environment =
      invocation.environment === 'loginShell'
        ? invocation.loginShell
          ? `login shell "${invocation.loginShell}"`
          : 'an empty zenwave.sdk.loginShell setting'
        : 'the environment inherited by VS Code';
    return {
      found: false,
      diagnosis: [
        `Could not start the configured SDK command by running "${attempted}" in "${cwd}" through ${environment}.`,
        `Searched PATH=${searchPath}`,
        check.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
}
