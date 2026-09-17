/**
 * Choosing the one architecture manifest for a workspace.
 *
 * Pure: the VS Code layer (`manifest.ts`) reads settings and files and hands the
 * candidates in, so the choice — and what is said about it — is testable
 * without an editor. URIs are opaque strings here; nothing is joined or split.
 */

export type ManifestRoute = 'setting' | 'config' | 'none';

export interface FolderCandidates {
  readonly folderName: string;
  readonly folderUri: string;
  /** `zenwave.workspace.manifest` as it applies to this folder, already resolved to a URI. */
  readonly setting?: { readonly value: string; readonly manifestUri: string };
  /** A `.zenwave/config.yml` at this folder's root. */
  readonly config?: { readonly configUri: string; readonly manifestUri?: string; readonly problem?: string };
}

export interface ResolvedManifest {
  readonly route: ManifestRoute;
  readonly manifestUri?: string;
  readonly configUri?: string;
  /** The workspace folder that supplied it. */
  readonly folderName?: string;
  /** What was found and not used, and anything wrong with what was found. */
  readonly notes: readonly string[];
}

/**
 * The value of `project-manifest` in a `.zenwave/config.yml`.
 *
 * Mirrors zenwave-lsp `ZenwaveWorkspaceConfig.parseScalar` exactly — first
 * line starting with the key, inline ` #` comment removed, trimmed — so the
 * client and the server never disagree about which manifest a configuration
 * names.
 */
export function projectManifestOf(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const comment = raw.indexOf(' #');
    const line = (comment >= 0 ? raw.slice(0, comment) : raw).trimEnd();
    if (line.trimStart().startsWith('project-manifest:')) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/** Whether a manifest reference names a URI rather than a path (`scheme:` with a scheme longer than a drive letter). */
export function hasScheme(reference: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(reference);
}

/** Whether a setting value is an absolute file-system path (POSIX, UNC or a drive letter). */
export function isAbsolutePath(reference: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(reference);
}

/** Path segments of a relative reference, for URI joining. Either separator is accepted. */
export function relativeSegments(reference: string): string[] {
  return reference.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.');
}

/**
 * Setting first, then configuration, then nothing — and one manifest for the
 * whole workspace. When more than one folder offers one, the first folder in
 * workspace order wins and every other offer is named in `notes`, so a
 * multi-root workspace never picks silently.
 */
export function chooseManifest(folders: readonly FolderCandidates[]): ResolvedManifest {
  const notes: string[] = [];
  for (const folder of folders) {
    if (folder.config?.problem) notes.push(`${folder.config.configUri}: ${folder.config.problem}`);
  }

  const settings = folders.filter((folder) => folder.setting);
  if (settings.length > 0) {
    const chosen = settings[0]!;
    for (const other of settings.slice(1)) {
      if (other.setting!.manifestUri !== chosen.setting!.manifestUri) {
        notes.push(`zenwave.workspace.manifest in folder "${other.folderName}" names ${other.setting!.manifestUri}; ignored, folder "${chosen.folderName}" comes first`);
      }
    }
    for (const other of folders.filter((folder) => folder.config?.manifestUri)) {
      notes.push(`${other.config!.configUri} not consulted: zenwave.workspace.manifest is set`);
    }
    return { route: 'setting', manifestUri: chosen.setting!.manifestUri, folderName: chosen.folderName, notes };
  }

  const configs = folders.filter((folder) => folder.config?.manifestUri);
  if (configs.length > 0) {
    const chosen = configs[0]!;
    for (const other of configs.slice(1)) {
      notes.push(`${other.config!.configUri} names ${other.config!.manifestUri}; ignored, folder "${chosen.folderName}" comes first`);
    }
    return {
      route: 'config',
      manifestUri: chosen.config!.manifestUri!,
      configUri: chosen.config!.configUri,
      folderName: chosen.folderName,
      notes,
    };
  }
  return { route: 'none', notes };
}

export function describeManifest(resolved: ResolvedManifest): string {
  const how = {
    setting: `from the zenwave.workspace.manifest setting (folder "${resolved.folderName}")`,
    config: `from ${resolved.configUri}`,
    none: 'none found: no zenwave.workspace.manifest setting and no .zenwave/config.yml at a workspace folder root; starting without a manifest',
  }[resolved.route];
  const lines = [resolved.manifestUri ? `Architecture manifest: ${resolved.manifestUri}, ${how}` : `Architecture manifest: ${how}`];
  for (const note of resolved.notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

/** Whether two resolutions would initialise the server differently. */
export function sameInitialization(left: ResolvedManifest, right: ResolvedManifest): boolean {
  return left.manifestUri === right.manifestUri && left.configUri === right.configUri;
}

/** What the server is initialised with: `{ zenwave: { configUri, projectManifestUri } }`, absent keys omitted. */
export function initializationOptions(resolved: ResolvedManifest, credentialRequest: boolean): {
  zenwave: { configUri?: string; projectManifestUri?: string; clientCapabilities: { credentialRequest: boolean } };
} {
  return {
    zenwave: {
      ...(resolved.configUri ? { configUri: resolved.configUri } : {}),
      ...(resolved.manifestUri ? { projectManifestUri: resolved.manifestUri } : {}),
      clientCapabilities: { credentialRequest },
    },
  };
}

/**
 * A glob for one file name. Glob metacharacters become `?` (any one character)
 * rather than escapes, which VS Code's glob dialect does not reliably support;
 * the match stays a single name in a single directory.
 */
export function literalGlob(name: string): string {
  return name.replace(/[\\*?[\]{},]/g, '?');
}
