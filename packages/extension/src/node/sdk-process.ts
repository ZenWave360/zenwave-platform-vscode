import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { SdkProcessService } from '../sdk/host.js';

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      accessSync(file, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export class NodeSdkProcessService implements SdkProcessService {
  readonly platform = process.platform;

  searchPath(): string {
    return process.env.PATH ?? '';
  }

  findExecutable(executable: string, cwd: string): string | undefined {
    const windows = process.platform === 'win32';
    const extensions = windows
      ? // PowerShell, the usual task shell on Windows, also runs .ps1 scripts.
        ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '.PS1']
      : [''];
    const hasDirectory = executable.includes('/') || (windows && executable.includes('\\'));
    const candidates = hasDirectory
      ? [path.resolve(cwd, executable)]
      : this.searchPath()
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) => path.join(directory, executable));

    for (const candidate of candidates) {
      for (const extension of extensions) {
        if (isExecutableFile(candidate + extension)) {
          return candidate + extension;
        }
      }
    }
    return undefined;
  }
}
