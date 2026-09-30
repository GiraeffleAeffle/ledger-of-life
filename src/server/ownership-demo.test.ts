import test from 'node:test';
import assert from 'node:assert/strict';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { LocalStore } from './store.ts';
import { assertEmptySharePosition, readOwnershipPreparation } from './ownership-demo.ts';

const empty = () => ({ sharesRaw: '0', loan: { sharesRaw: '0', debtAtomic: '0' }, deposit: null });

test('preparation accepts only genuinely empty share positions, not wallet cash or a spent loan', () => {
  assert.doesNotThrow(() => assertEmptySharePosition(empty()));
  for (const position of [
    { ...empty(), sharesRaw: '1' },
    { ...empty(), loan: { sharesRaw: '1000000000000000000', debtAtomic: '0' } },
    { ...empty(), loan: { sharesRaw: '0', debtAtomic: '12000000' } },
    { ...empty(), deposit: { state: 1 } },
    { ...empty(), deposit: { state: 4 } },
  ]) assert.throws(() => assertEmptySharePosition(position), /already has shares, locked collateral, a loan or a deposit/);
  assert.doesNotThrow(() => assertEmptySharePosition({ ...empty(), deposit: { state: 5 } }));
});

test('read-only preparation status remains reserved after shares arrive, until its signed journal is ready', async () => {
  const store = new LocalStore(':memory:');
  const owner = '0x1111111111111111111111111111111111111111';
  const identity: VerifiedIdentity = {
    subject: 'alice', sessionId: 'session', expiresAt: Date.now() + 60_000,
    wallets: [{ id: 'wallet', chainType: 'ethereum', address: owner }], passkeyCount: 1, backupLoginLinked: true,
  };
  try {
    assert.equal((await readOwnershipPreparation(store, identity)).state, 'none');
    const key = `ownership-example:${owner.toLowerCase()}`;
    const reservation = { owner, provisioner: owner, state: 'reserved', mint: { signed: '0x02aa', hash: '0xaaaa' } };
    await store.create(key, reservation);
    assert.equal((await readOwnershipPreparation(store, identity)).state, 'reserved');
    await store.update<typeof reservation>(key, (value) => ({ ...value, state: 'ready' }));
    assert.equal((await readOwnershipPreparation(store, identity)).state, 'ready');
  } finally { await store.close(); }
});
