import * as vscode from 'vscode';
import type { DocumentSelector } from 'vscode-languageclient';
import {
  chooseManifest,
  hasScheme,
  isAbsolutePath,
  literalGlob,
  projectManifestOf,
  relativeSegments,
  type FolderCandidates,
  type ResolvedManifest,
} from './manifest-resolution.js';

export const MANIFEST_SETTING = 'zenwave.workspace.manifest';
const CONFIG_SEGMENTS = ['.zenwave', 'config.yml'] as const;

/** A reference relative to a folder, joined as a URI — never as a file-system path. */
function referenceUri(folder: vscode.Uri, reference: string): vscode.Uri {
  if (hasScheme(reference)) return vscode.Uri.parse(reference, true);
  if (isAbsolutePath(reference)) return vscode.Uri.file(reference);
  return vscode.Uri.joinPath(folder, ...relativeSegments(reference));
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function candidatesFor(folder: vscode.WorkspaceFolder): Promise<FolderCandidates> {
  const inspected = vscode.workspace.getConfiguration('zenwave.workspace', folder.uri).inspect<string>('manifest');
  // Only values the user set: a default would make every workspace "configured".
  const value = [inspected?.workspaceFolderValue, inspected?.workspaceValue, inspected?.globalValue]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)?.trim();
  const configUri = vscode.Uri.joinPath(folder.uri, ...CONFIG_SEGMENTS);
  const text = await readText(configUri);
  let config: FolderCandidates['config'];
  if (text !== undefined) {
    const manifest = projectManifestOf(text);
    config = manifest
      ? { configUri: configUri.toString(), manifestUri: referenceUri(folder.uri, manifest).toString() }
      : { configUri: configUri.toString(), problem: "has no 'project-manifest'; ignored" };
  }
  return {
    folderName: folder.name,
    folderUri: folder.uri.toString(),
    ...(value ? { setting: { value, manifestUri: referenceUri(folder.uri, value).toString() } } : {}),
    ...(config ? { config } : {}),
  };
}

/**
 * Resolves the workspace's one manifest: setting, then `.zenwave/config.yml` at
 * a folder root, then none. Everything is read through `vscode.workspace.fs`,
 * so the web host resolves the same way; nothing is fetched and no content is
 * read beyond the configuration file itself.
 */
export async function resolveWorkspaceManifest(): Promise<ResolvedManifest> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const resolved = chooseManifest(await Promise.all(folders.map(candidatesFor)));
  if (!resolved.manifestUri) return resolved;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.parse(resolved.manifestUri, true));
    return resolved;
  } catch {
    return { ...resolved, notes: [...resolved.notes, `${resolved.manifestUri} does not exist (yet); it is still the manifest the server is given`] };
  }
}

/**
 * What the language client serves: ZDL, ZW and ZFL by language, and the manifest
 * by its resolved location. Never a `.yml` glob — a workspace is full of YAML
 * that is not ZenWave's.
 *
 * The manifest filter is its scheme plus its `fsPath` as the pattern: VS Code
 * scores a pattern equal to a document's `fsPath` as a match before treating it
 * as a glob, so the file matches exactly whatever characters its name holds.
 */
export function documentSelector(resolved: ResolvedManifest): DocumentSelector {
  const selector: DocumentSelector = [{ language: 'zdl' }, { language: 'zw' }, { language: 'zfl' }];
  if (resolved.manifestUri) {
    const uri = vscode.Uri.parse(resolved.manifestUri, true);
    selector.push({ scheme: uri.scheme, pattern: uri.fsPath });
  }
  return selector;
}

function manifestPattern(resolved: ResolvedManifest): vscode.RelativePattern | undefined {
  if (!resolved.manifestUri) return undefined;
  const uri = vscode.Uri.parse(resolved.manifestUri, true);
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  return name ? new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), literalGlob(name)) : undefined;
}

/** Whether a document is the resolved manifest. */
export function isManifest(resolved: ResolvedManifest, document: vscode.TextDocument): boolean {
  return resolved.manifestUri !== undefined && document.uri.toString() === vscode.Uri.parse(resolved.manifestUri, true).toString();
}

/**
 * Watchers for everything that decides or is the manifest: each folder's
 * `.zenwave/config.yml`, and the resolved manifest file.
 */
export function manifestWatchers(resolved: ResolvedManifest): vscode.FileSystemWatcher[] {
  const watchers = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, CONFIG_SEGMENTS.join('/'))));
  const manifest = manifestPattern(resolved);
  if (manifest) watchers.push(vscode.workspace.createFileSystemWatcher(manifest));
  return watchers;
}
