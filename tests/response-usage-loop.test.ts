import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startResponseUsageLoop, USAGE_REFRESH_INTERVAL_MS } from '../src/lib/response-usage-loop';

test('refreshes immediately and hourly without a browser, and stops cleanly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const stop = startResponseUsageLoop(async () => { calls++; return { errors: [] }; });
  await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(USAGE_REFRESH_INTERVAL_MS - 1);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(calls, 2);
  stop();
  t.mock.timers.tick(USAGE_REFRESH_INTERVAL_MS);
  assert.equal(calls, 2);
});
test('an API failure does not stop future hourly updates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const errors: unknown[] = [];
  const stop = startResponseUsageLoop(async () => {
    calls++;
    if (calls === 1) throw new Error('offline');
    return { errors: [] };
  }, error => errors.push(error));
  await Promise.resolve();
  assert.equal(errors.length, 1);
  t.mock.timers.tick(USAGE_REFRESH_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(calls, 2);
  stop();
});
