import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore } from './store.ts';
import { PRICE_JOB_OVERDUE_SECONDS, readPriceJob, recordPriceJob, shapePriceJob } from './price-job-health.ts';

const now = 1_800_000_000;

test('a job that never reported needs attention', () => {
  const status = shapePriceJob(null, now);
  assert.equal(status.health, 'attention');
  assert.equal(status.lastRun, null);
});

for (const [reason, health] of [['same_or_older_round', 'waiting'], ['push_interval', 'waiting'], ['stale_source_round', 'attention'], ['reference_unavailable', 'attention'], ['source_paused', 'attention'], ['rpc_chain_unavailable', 'attention']] as const) {
  test(`a run skipped for ${reason} is ${health}, never ok`, async () => {
    const store = new LocalStore(':memory:');
    try {
      await recordPriceJob(store, { status: 'skipped', reason, sourceRoundId: '7', sourceUpdatedAt: now - 500 }, now - 60);
      const status = shapePriceJob(await readPriceJob(store), now);
      assert.equal(status.health, health);
      assert.notEqual(status.health, 'ok');
      assert.equal(status.lastRun?.reason, reason);
      assert.equal(status.lastRun?.sourceUpdatedAt, now - 500);
    } finally { await store.close(); }
  });
}

test('a push is ok, and a later skip keeps the last copy time and round', async () => {
  const store = new LocalStore(':memory:');
  try {
    await recordPriceJob(store, { status: 'pushed', sourceRoundId: '8', sourceUpdatedAt: now - 7200, transactionHash: '0xabc' }, now - 3600);
    assert.equal(shapePriceJob(await readPriceJob(store), now - 3500).health, 'ok');
    await recordPriceJob(store, { status: 'skipped', reason: 'stale_source_round', sourceRoundId: '9', sourceUpdatedAt: now - 99_999 }, now - 10);
    const status = shapePriceJob(await readPriceJob(store), now);
    assert.equal(status.health, 'attention');
    assert.deepEqual(status.lastPush, { at: now - 3600, sourceRoundId: '8', sourceUpdatedAt: now - 7200, transactionHash: '0xabc' });
    assert.equal(status.lastRun?.sourceUpdatedAt, now - 99_999, 'the skipped round is reported separately from the copied one');
  } finally { await store.close(); }
});

test('a run older than three hours is attention even if it pushed; unknown statuses count as failed', async () => {
  const store = new LocalStore(':memory:');
  try {
    await recordPriceJob(store, { status: 'pushed', sourceRoundId: '8' }, now - PRICE_JOB_OVERDUE_SECONDS - 1);
    const status = shapePriceJob(await readPriceJob(store), now);
    assert.equal(status.overdue, true);
    assert.equal(status.health, 'attention');
    await recordPriceJob(store, { status: 'surprise', reason: 'boom' }, now);
    const failed = shapePriceJob(await readPriceJob(store), now);
    assert.equal(failed.lastRun?.status, 'failed');
    assert.equal(failed.health, 'attention');
  } finally { await store.close(); }
});
