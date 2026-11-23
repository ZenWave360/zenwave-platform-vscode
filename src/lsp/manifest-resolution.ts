/**
 * Choosing the one architecture manifest for a workspace.
 *
 * Pure: the VS Code layer (`manifest.ts`) reads settings and files and hands the
 * candidates in, so the choice — and what is said about it — is testable
 * without an editor. URIs are opaque strings here; nothing is joined or split.
 */
import { DEFAULT_REMOTE_MANIFEST_NAME, remoteManifestAddress, remoteManifestPath, ZENWAVE_SCHEME } from './resources.js';

/** `zenwave.architecture.remoteManifestName`. A plain file name. The client and the server fall back when it is not one. */
export const REMOTE_MANIFEST_NAME_SETTING = 'zenwave.architecture.remoteManifestName';
/** `zenwave.architecture.allowedDomains`. Hosts an absolute http(s) manifest entry may be fetched from. */
export const ALLOWED_DOMAINS_SETTING = 'zenwave.architecture.allowedDomains';

export type ManifestRoute = 'setting' | 'override' | 'none';

export interface FolderCandidates {
  readonly folderName: string;
  readonly folderUri: string;
  /** `zenwave.workspace.manifest` as it applies to this folder, already resolved to a URI. */
  readonly setting?: { readonly value: string; readonly manifestUri: string };
}

export interface ResolvedManifest {
  readonly route: ManifestRoute;
  readonly manifestUri?: string;
  /** The workspace folder that supplied it. */
  readonly folderName?: string;
  /** What was found and not used, and anything wrong with what was found. */
  readonly notes: readonly string[];
}

/** Whether a manifest is an `http(s)` address: the server serves it under `zenwave:` and it is read-only (LC-R3, AR-R11). */
export function isRemoteManifest(manifestUri: string): boolean {
  return /^https?:\/\//i.test(manifestUri);
}

/**
 * The document the editor holds for a manifest: the manifest itself, or `zenwave:/<name>` for a remote one (AR-Q1).
 * `remoteManifestName` is a plain file name. A name that is not one becomes the default, the same name the
 * server would use, so the document and the selector never point at a different file.
 */
export function manifestDocumentUri(manifestUri: string, remoteManifestName: string = DEFAULT_REMOTE_MANIFEST_NAME): string {
  return isRemoteManifest(manifestUri) ? remoteManifestAddress(normalizeRemoteManifestName(remoteManifestName)) : manifestUri;
}

/** What *URL…* accepts: an `http` or `https` address with a host. Returns the trimmed address, or why it is refused. */
export function parseManifestUrl(text: string): { readonly url: string } | { readonly problem: string } {
  const value = text.trim();
  if (!/^https?:\/\/[^\s/?#]+/i.test(value)) return { problem: 'Enter an http or https address, such as https://example.org/zenwave-architecture.yml' };
  if (/\s/.test(value)) return { problem: 'The address cannot contain spaces' };
  return { url: value };
}

/**
 * The document filters the language client serves besides the model languages (LC-R3, AR-R8): the remote manifest
 * by exact scheme and path, and nothing for `.yml`, `.yaml` or `.md` under the scheme. `local` is the filter for a
 * manifest that is a file, supplied by the VS Code layer because it needs the URI's `fsPath`.
 */
export function manifestFilters(
  manifestUri: string | undefined,
  local: (manifestUri: string) => { scheme: string; pattern: string },
  remoteManifestName: string = DEFAULT_REMOTE_MANIFEST_NAME,
): { scheme: string; pattern: string }[] {
  if (!manifestUri) return [];
  return [isRemoteManifest(manifestUri)
    ? { scheme: ZENWAVE_SCHEME, pattern: remoteManifestPath(normalizeRemoteManifestName(remoteManifestName)) }
    : local(manifestUri)];
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
 * The session choice, then the setting, then nothing — and one manifest for the
 * whole workspace. When more than one folder offers one, the first folder in
 * workspace order wins and every other offer is named in `notes`, so a
 * multi-root workspace never picks silently.
 */
export function chooseManifest(folders: readonly FolderCandidates[], override?: string): ResolvedManifest {
  const notes: string[] = [];
  if (override) {
    // A session choice (no folder is open to hold a setting): it takes the setting's place and is never written to a file.
    for (const folder of folders) {
      if (folder.setting) notes.push(`zenwave.workspace.manifest in folder "${folder.folderName}" names ${folder.setting.manifestUri}; ignored, the session choice comes first`);
    }
    return { route: 'override', manifestUri: override, notes };
  }
  const settings = folders.filter((folder) => folder.setting);
  if (settings.length > 0) {
    const chosen = settings[0]!;
    for (const other of settings.slice(1)) {
      if (other.setting!.manifestUri !== chosen.setting!.manifestUri) {
        notes.push(`zenwave.workspace.manifest in folder "${other.folderName}" names ${other.setting!.manifestUri}; ignored, folder "${chosen.folderName}" comes first`);
      }
    }
    return { route: 'setting', manifestUri: chosen.setting!.manifestUri, folderName: chosen.folderName, notes };
  }

  return { route: 'none', notes };
}

export function describeManifest(resolved: ResolvedManifest): string {
  const how = {
    setting: `from the zenwave.workspace.manifest setting (folder "${resolved.folderName}")`,
    override: 'chosen with Choose Architecture Manifest… for this session (not saved)',
    none: 'none found: no zenwave.workspace.manifest setting; starting without a manifest',
  }[resolved.route];
  const lines = [resolved.manifestUri ? `Architecture manifest: ${resolved.manifestUri}, ${how}` : `Architecture manifest: ${how}`];
  for (const note of resolved.notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

/** Whether two resolutions would initialise the server differently. */
export function sameInitialization(left: ResolvedManifest, right: ResolvedManifest): boolean {
  return left.manifestUri === right.manifestUri;
}

/** The remote-manifest name and the allowed domains the server is initialised with (AN/4.5). */
export interface ArchitectureSettings {
  readonly remoteManifestName: string;
  readonly allowedDomains: readonly string[];
  /** Set when the configured name was rejected. The extension logs it. Absent when the value was missing or already a plain file name. */
  readonly remoteManifestNameWarning?: string;
}

/** A remote manifest name is at most this many characters. The server rejects a longer one. */
const MAX_REMOTE_MANIFEST_NAME_LENGTH = 255;

/**
 * `/`, `\`, `%`, `#`, `?`, and the glob characters `* [ ] { }` a document selector would widen.
 * `?` is both. The server rejects the same set except the glob characters; rejecting those here
 * means the client never sends a name the selector could match against another file.
 */
const REMOTE_MANIFEST_NAME_FORBIDDEN = /[/\\%#?*[\]{}]/;

/** ISO control characters, the range Kotlin's `Char.isISOControl` uses. */
function isIsoControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * A plain file name, the server's rule plus glob characters: not empty, not `.` or a name containing `..`,
 * at most 255 characters, and containing none of `/`, `\`, `%`, `#`, `?`, `*`, `[`, `]`, `{`, `}`, or an
 * ISO control character.
 */
export function isPlainRemoteManifestName(name: string): boolean {
  return name.length > 0
    && name.length <= MAX_REMOTE_MANIFEST_NAME_LENGTH
    && name !== '.'
    && !name.includes('..')
    && !REMOTE_MANIFEST_NAME_FORBIDDEN.test(name)
    && !isIsoControl(name);
}

/**
 * The name the server is given. A non-string becomes the default with no warning. Anything that is not a
 * plain file name becomes the default, and `warning` is what the extension logs. Surrounding whitespace
 * is removed first, so a padded plain name is that name.
 */
export function resolveRemoteManifestName(value: unknown): { readonly name: string; readonly warning?: string } {
  if (typeof value !== 'string') return { name: DEFAULT_REMOTE_MANIFEST_NAME };
  const trimmed = value.trim();
  if (isPlainRemoteManifestName(trimmed)) return { name: trimmed };
  return {
    name: DEFAULT_REMOTE_MANIFEST_NAME,
    warning: `remoteManifestName '${value}' is not a plain file name; using '${DEFAULT_REMOTE_MANIFEST_NAME}'`,
  };
}

function normalizeRemoteManifestName(value: unknown): string {
  return resolveRemoteManifestName(value).name;
}

/**
 * Host list as the server receives it. Entries are lowercased, then trimmed; empty entries, non-strings and
 * duplicates are dropped. Matching on the server is case-insensitive, so `GitHub.com` and `github.com`
 * initialise it the same way. Nothing else is checked: `github.com` and `*.githubusercontent.com` mean
 * what the server says they mean.
 */
function normalizeAllowedDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.toLowerCase().trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    domains.push(normalized);
  }
  return domains;
}

/** Reads both settings into the shape that is sent. Missing values are the defaults. A rejected name carries its warning. */
export function architectureSettings(remoteManifestName: unknown, allowedDomains: unknown): ArchitectureSettings {
  const name = resolveRemoteManifestName(remoteManifestName);
  return {
    remoteManifestName: name.name,
    allowedDomains: normalizeAllowedDomains(allowedDomains),
    ...(name.warning ? { remoteManifestNameWarning: name.warning } : {}),
  };
}

/** Whether two readings would initialise the server the same way. Trim, case, duplicates and a rejected name do not count as a change. */
export function sameArchitectureSettings(left: ArchitectureSettings, right: ArchitectureSettings): boolean {
  return left.remoteManifestName === right.remoteManifestName
    && left.allowedDomains.length === right.allowedDomains.length
    && left.allowedDomains.every((domain, index) => domain === right.allowedDomains[index]);
}

/**
 * What the server is initialised with. `projectManifestUri` is omitted when absent.
 * `remoteManifestName` and `allowedDomains` are always sent (AN/4.5). The catalogue sits at the top level
 * beside `zenwave`, where the server reads it.
 */
export function initializationOptions(
  resolved: ResolvedManifest,
  credentialRequest: boolean,
  pluginCatalogue?: object,
  architecture?: { readonly remoteManifestName?: unknown; readonly allowedDomains?: unknown },
): {
  zenwave: {
    projectManifestUri?: string;
    clientCapabilities: { credentialRequest: boolean };
    remoteManifestName: string;
    allowedDomains: string[];
  };
  pluginCatalogue?: object;
} {
  const resources = architectureSettings(architecture?.remoteManifestName, architecture?.allowedDomains);
  return {
    zenwave: {
      ...(resolved.manifestUri ? { projectManifestUri: resolved.manifestUri } : {}),
      clientCapabilities: { credentialRequest },
      remoteManifestName: resources.remoteManifestName,
      allowedDomains: [...resources.allowedDomains],
    },
    ...(pluginCatalogue ? { pluginCatalogue } : {}),
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
