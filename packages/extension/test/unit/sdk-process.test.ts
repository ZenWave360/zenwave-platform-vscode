import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { NodeSdkProcessService } from '../../src/node/sdk-process.js';

const service = new NodeSdkProcessService();
const invocation = { environment: 'inherited', loginShell: '' } as const;
const quotedNode = `"${process.execPath}"`;

test('probe starts the complete configured SDK prefix with its catalogue arguments', async () => {
  const result = await service.probe(
    `${quotedNode} -e "process.exit(0)" --`,
    process.cwd(),
    invocation,
  );
  assert.equal(result.found, true);
  assert.match(result.diagnosis, /-h json/);
});

test('probe diagnoses a configured prefix that resolves but cannot start successfully', async () => {
  const command = `${quotedNode} -e "process.exit(17)" --`;
  const result = await service.probe(command, process.cwd(), invocation);
  assert.equal(result.found, false);
  assert.match(result.diagnosis, /Could not start the configured SDK command/);
  assert.match(result.diagnosis, /-h json/);
  assert.match(result.diagnosis, /Searched PATH=/);
  assert.match(result.diagnosis, new RegExp(process.cwd().replaceAll('\\', '\\\\')));
});

test('probe diagnoses a missing command with the attempted command and PATH', async () => {
  const result = await service.probe(
    'definitely-not-a-zenwave-command',
    process.cwd(),
    invocation,
  );
  assert.equal(result.found, false);
  assert.match(result.diagnosis, /definitely-not-a-zenwave-command -h json/);
  assert.match(result.diagnosis, /Searched PATH=/);
});
