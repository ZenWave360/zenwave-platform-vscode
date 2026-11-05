import AdmZip from 'adm-zip';
import { pinnedVersions } from './release-rules.mjs';

/** The entries of a VSIX by name, with Windows separators normalised. */
export function readArchive(file) {
  const zip = new AdmZip(file);
  return new Map(
    zip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => [entry.entryName.replaceAll('\\', '/'), entry.getData()]),
  );
}

/**
 * What a VSIX says about itself, read from the file and nothing else: the version and pre-release flag the registries
 * will see, the commit it was built from, and the `@zenwave360/*` versions it ships (spec:release#r-r9).
 */
export function vsixInfo(archive) {
  const manifest = JSON.parse(archive.get('extension/package.json').toString('utf8'));
  const buildInfo = JSON.parse(archive.get('extension/dist/build-info.json').toString('utf8'));
  const vsixManifest = archive.get('extension.vsixmanifest')?.toString('utf8') ?? '';
  const flag = /<Property\s+Id="Microsoft\.VisualStudio\.Code\.PreRelease"\s+Value="([^"]*)"/.exec(vsixManifest);
  return {
    id: `${manifest.publisher}.${manifest.name}`,
    version: manifest.version,
    preRelease: flag?.[1] === 'true',
    buildInfoVersion: buildInfo.version,
    commit: buildInfo.commit,
    packages: pinnedVersions(manifest),
    manifest,
  };
}
