import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error A build script without type declarations.
import { DEFAULT_SMOKE_TIMEOUT_MS, SmokeTimeoutError, smokeTimeoutMs, withDeadline } from '../../scripts/smoke-deadline.mjs';

test('the smoke deadline is five minutes unless ZENWAVE_SMOKE_TIMEOUT_MS sets it', () => {
  assert.equal(DEFAULT_SMOKE_TIMEOUT_MS, 5 * 60 * 1000);
  assert.equal(smokeTimeoutMs({}), DEFAULT_SMOKE_TIMEOUT_MS);
  assert.equal(smokeTimeoutMs({ ZENWAVE_SMOKE_TIMEOUT_MS: '' }), DEFAULT_SMOKE_TIMEOUT_MS);
  assert.equal(smokeTimeoutMs({ ZENWAVE_SMOKE_TIMEOUT_MS: '1500' }), 1500);
  assert.throws(() => smokeTimeoutMs({ ZENWAVE_SMOKE_TIMEOUT_MS: '0' }), /ZENWAVE_SMOKE_TIMEOUT_MS/);
  assert.throws(() => smokeTimeoutMs({ ZENWAVE_SMOKE_TIMEOUT_MS: 'nope' }), /ZENWAVE_SMOKE_TIMEOUT_MS/);
  assert.throws(() => smokeTimeoutMs({ ZENWAVE_SMOKE_TIMEOUT_MS: '2147483648' }), /ZENWAVE_SMOKE_TIMEOUT_MS/);
});

test('a smoke run that finishes does not wait out the deadline', async () => {
  const started = Date.now();
  assert.equal(await withDeadline(Promise.resolve('done'), 30_000, 'should not time out'), 'done');
  assert.ok(Date.now() - started < 1000);
});

test('a smoke run that does not finish rejects, and a late failure is not unhandled', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    let failLate: (error: Error) => void = () => {};
    const hanging = new Promise<never>((_resolve, reject) => {
      failLate = reject;
    });
    await assert.rejects(withDeadline(hanging, 20, 'timed out'), (error: unknown) => {
      assert.ok(error instanceof SmokeTimeoutError);
      assert.match(error.message, /timed out/);
      return true;
    });
    failLate(new Error('late failure'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});
