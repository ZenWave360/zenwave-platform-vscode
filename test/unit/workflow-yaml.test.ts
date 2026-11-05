import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error The installed YAML parser has no type declarations.
import { load } from 'js-yaml';

const workflows = join(import.meta.dirname, '../../.github/workflows');

test('every GitHub workflow parses as YAML, including run commands containing colons', () => {
  const files = readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file));
  assert.ok(files.length > 0, 'the workflow directory must not be empty');
  for (const file of files) {
    assert.doesNotThrow(
      () => load(readFileSync(join(workflows, file), 'utf8')),
      `${file} must be valid YAML before its jobs can run`,
    );
  }
});
