import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { NodeSdkProcessService } from '../../src/node/sdk-process.js';

const service = new NodeSdkProcessService();

test('an executable given by path is found without running it', () => {
  assert.equal(service.findExecutable(process.execPath, process.cwd()), process.execPath);
});

test('an executable given by relative path resolves against the model directory', () => {
  const directory = path.dirname(process.execPath);
  const name = path.basename(process.execPath);
  assert.equal(service.findExecutable(`./${name}`, directory), path.join(directory, name));
});

test('a missing command is not found', () => {
  assert.equal(service.findExecutable('definitely-not-a-zenwave-command', process.cwd()), undefined);
});
