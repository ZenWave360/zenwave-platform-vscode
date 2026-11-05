/** The shells whose quoting rules the command line is written for. */
export type ShellFamily = 'posix' | 'powershell';

export function resolveLoginShell(
  configuredShell: string | undefined,
  preferredTerminalShell: string,
): string {
  return configuredShell?.trim() || preferredTerminalShell.trim();
}

function executableName(shellPath: string): string {
  const normalized = shellPath.trim().replaceAll('\\', '/');
  return normalized
    .slice(normalized.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/\.exe$/, '');
}

/**
 * The quoting family of a shell, or `undefined` for a shell the command line
 * cannot be quoted safely for — `cmd.exe` above all, which has no quoting that
 * reliably keeps a value from being interpreted.
 */
export function shellFamily(shellPath: string): ShellFamily | undefined {
  switch (executableName(shellPath)) {
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'dash':
    case 'ksh':
    case 'fish':
      return 'posix';
    case 'pwsh':
    case 'powershell':
      return 'powershell';
    default:
      return undefined;
  }
}

export function loginShellArguments(shellPath: string): readonly string[] | undefined {
  switch (executableName(shellPath)) {
    case 'pwsh':
      return ['-Login', '-Command'];
    case 'powershell':
      return ['-NoLogo', '-Command'];
    default:
      return shellFamily(shellPath) === 'posix' ? ['-l', '-c'] : undefined;
  }
}
