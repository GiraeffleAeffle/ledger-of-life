import test from 'node:test';
import assert from 'node:assert/strict';
import { failUnsignedShareControl } from './share-workflows.ts';
import { acquireOperatorNonceLane, releaseOperatorNonceLane } from './operator-nonce-lane.ts';
import { LocalStore } from './store.ts';

const signer = '0x1111111111111111111111111111111111111111';

test('reverted pre-sign estimate can fence a control and free the provisioner lane', async () => {
  const store = new LocalStore(':memory:');
  const key = 'share-control:wallet:request';
  try {
    await store.create(key, { state: 'running', owner: signer, pool: signer, action: 'flag_shortfall', calls: [], steps: [{}], hashes: [] });
    await acquireOperatorNonceLane(store, signer, 'control-request');
    assert.equal(await failUnsignedShareControl(store, key, 'NoShortfall'), true);
    const journal = await store.get<{ state: string; error?: string }>(key);
    assert.equal(journal?.state, 'failed_unsigned');
    assert.equal(journal.error, 'NoShortfall');
    await releaseOperatorNonceLane(store, signer, 'control-request');
    await acquireOperatorNonceLane(store, signer, 'price-down-request');
    await releaseOperatorNonceLane(store, signer, 'price-down-request');
  } finally { await store.close(); }
});

test('signed ambiguous control remains reserved instead of releasing its nonce', async () => {
  const store = new LocalStore(':memory:');
  const key = 'share-control:wallet:signed';
  try {
    await store.create(key, { state: 'running', owner: signer, pool: signer, action: 'faucet', calls: [], steps: [{ signed: '0x02aa', hash: '0xaaaa' }], hashes: [] });
    assert.equal(await failUnsignedShareControl(store, key, 'unknown receipt'), false);
    assert.equal((await store.get<{ state: string }>(key))?.state, 'running');
  } finally { await store.close(); }
});
