import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const command = process.env.ZENWAVE_SDK_CATALOGUE_COMMAND?.trim() || 'jbang snapshots@zenwave360/zenwave-sdk';
const { stdout, stderr } = await execAsync(`${command} -h json`, {
  cwd: projectDir,
  maxBuffer: 20 * 1024 * 1024,
});

if (stderr.trim()) {
  process.stderr.write(stderr);
}

const firstBrace = stdout.indexOf('{');
const lastBrace = stdout.lastIndexOf('}');
if (firstBrace < 0 || lastBrace <= firstBrace) {
  throw new Error(`The SDK command did not return a JSON object: ${command} -h json`);
}

const raw = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
if (!Array.isArray(raw.plugins)) {
  throw new Error('The SDK catalogue has no plugins array');
}

const optionalString = (value) => (typeof value === 'string' && value ? value : undefined);
const documentation = (value) =>
  optionalString(value?.documentation) ??
  optionalString(value?.documentationUrl) ??
  optionalString(value?.docLink);

const plugins = raw.plugins.flatMap((plugin) => {
  if (!plugin || typeof plugin.configClassName !== 'string' || !plugin.options) {
    return [];
  }
  const options = Object.fromEntries(
    Object.entries(plugin.options).map(([name, option]) => [
      name,
      {
        name,
        ...(optionalString(option?.description) ? { description: option.description } : {}),
        ...(optionalString(option?.type) ? { type: option.type } : {}),
        ...('defaultValue' in (option ?? {}) ? { defaultValue: option.defaultValue } : {}),
        ...(Array.isArray(option?.values) ? { values: option.values.map(String) } : {}),
        ...(documentation(option) ? { documentation: documentation(option) } : {}),
      },
    ]),
  );
  const pluginDocumentation = documentation(plugin) ?? documentation(plugin.plugin);
  return [
    {
      name:
        optionalString(plugin.configClassSimpleName) ??
        plugin.configClassName.slice(plugin.configClassName.lastIndexOf('.') + 1),
      configClassName: plugin.configClassName,
      ...(optionalString(plugin.plugin?.title) ? { title: plugin.plugin.title } : {}),
      ...(optionalString(plugin.plugin?.summary) ? { summary: plugin.plugin.summary } : {}),
      ...(optionalString(plugin.plugin?.description)
        ? { description: plugin.plugin.description }
        : {}),
      ...(pluginDocumentation ? { documentation: pluginDocumentation } : {}),
      options,
    },
  ];
}).sort((left, right) => left.name.localeCompare(right.name));

const version = optionalString(raw.version) ?? 'unknown';
const catalogue = {
  source: `ZenWave SDK ${version}`,
  version,
  plugins,
};
const output = path.join(projectDir, 'resources/sdk-plugin-catalogue.json');
fs.writeFileSync(output, `${JSON.stringify(catalogue, null, 2)}\n`);
console.log(`Wrote ${plugins.length} plugins from ZenWave SDK ${version} to ${output}`);
