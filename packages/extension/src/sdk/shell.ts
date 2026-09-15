export function resolveLoginShell(
  configuredShell: string | undefined,
  preferredTerminalShell: string,
): string {
  return configuredShell?.trim() || preferredTerminalShell.trim();
}

export function loginShellArguments(shellPath: string): readonly string[] {
  const normalized = shellPath.replaceAll('\\', '/');
  const executable = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  switch (executable) {
    case 'pwsh':
    case 'pwsh.exe':
      return ['-Login', '-Command'];
    case 'powershell':
    case 'powershell.exe':
      return ['-NoLogo', '-Command'];
    case 'cmd':
    case 'cmd.exe':
      return ['/s', '/c'];
    case 'nu':
    case 'nu.exe':
      return ['--login', '--commands'];
    case 'wsl':
    case 'wsl.exe':
      return ['--exec', 'sh', '-lc'];
    default:
      return ['-l', '-c'];
  }
}
