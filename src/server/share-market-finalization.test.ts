import test from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import { finalizeShareMarket, type WorkflowDeployment } from './share-workflows.ts';
import { LocalStore } from './store.ts';

const owner = '0x1111111111111111111111111111111111111111';
const provisioner = '0x2222222222222222222222222222222222222222';
const hash = `0x${'aa'.repeat(32)}` as const;
const escrowHash = `0x${'bb'.repeat(32)}` as const;
const proposal: WorkflowDeployment = {
  status: 'ready', owner, provisioner, oracle: owner, desk: owner, pool: owner, stock: owner,
  basePriceAtomic: '200000000', transactions: [],
};

test('slow market-finalization replay preserves an already accepted escrow and never discards contract history', async () => {
  const store = new LocalStore(':memory:');
  try {
    const key = 'share-workflows:owned-wallet';
    const starting = { status: 'starting' as const, owner: owner as Address, provisioner: provisioner as Address, addresses: {}, steps: {}, transactions: [hash as Hex] };
    await store.create(key, starting);
    const initial = await store.update<typeof starting | WorkflowDeployment>(key, (value) => finalizeShareMarket(value, proposal));
    assert.deepEqual(initial.transactions, [hash]);
    await store.update<WorkflowDeployment>(key, (value) => ({ ...value, escrow: provisioner, depositAtomic: '10000000', transactions: [...value.transactions, escrowHash] }));
    const resumed = await store.update<WorkflowDeployment>(key, (value) => finalizeShareMarket(value, proposal));
    assert.equal(resumed.escrow, provisioner);
    assert.equal(resumed.depositAtomic, '10000000');
    assert.deepEqual(resumed.transactions, [hash, escrowHash]);
  } finally { await store.close(); }
});
