import assert from 'node:assert/strict';
import test from 'node:test';
import { sameEconomicReview, settlementPayouts } from './solana-review.ts';

const previous = {
  id: 'old',
  state: 'prepared' as const,
  agreementId: 'agreement',
  walletId: 'wallet',
  actor: 'tenant',
  role: 'tenant' as const,
  nonce: '1',
  deployment: { genesisHash: 'genesis', escrowProgram: 'escrow-program', programSha256: 'a'.repeat(64) },
  action: { kind: 'supply' as const, amountAtomic: '10000000' },
  expectedDeltas: [{
    account: 'escrow', mint: 'USDC', owner: 'tenancy', direction: 'debit' as const,
    minimumAtomic: '9999999', maximumAtomic: '10000000',
  }],
  simulation: {
    slot: '1', sponsorDebitCeilingLamports: '20000', networkFeeLamports: '10000',
  },
  expiresAt: new Date(1000).toISOString(),
};

test('a renewed blockhash can be signed only for the same bounded financial review', () => {
  const fresh = { ...previous, id: 'new', expiresAt: new Date(2000).toISOString() };
  assert.equal(sameEconomicReview(previous, fresh, 1500), true);
  assert.equal(sameEconomicReview(previous, { ...fresh, actor: 'other' }, 1500), false);
  assert.equal(sameEconomicReview(previous, { ...fresh, deployment: { ...fresh.deployment, genesisHash: 'other' } }, 1500), false);
  assert.equal(sameEconomicReview(previous, { ...fresh, deployment: { ...fresh.deployment, escrowProgram: 'other' } }, 1500), false);
  assert.equal(sameEconomicReview(previous, { ...fresh, deployment: { ...fresh.deployment, programSha256: 'b'.repeat(64) } }, 1500), false);
  const unboundPrevious = { ...previous }, unboundFresh = { ...fresh };
  Reflect.deleteProperty(unboundPrevious, 'deployment');
  Reflect.deleteProperty(unboundFresh, 'deployment');
  assert.equal(sameEconomicReview(unboundPrevious, unboundFresh, 1500), false);
  assert.equal(sameEconomicReview(previous, { ...fresh, nonce: '2' }, 1500), false);
  assert.equal(sameEconomicReview(previous, {
    ...fresh, action: { kind: 'supply', amountAtomic: '20000000' },
  }, 1500), false);
  assert.equal(sameEconomicReview(previous, {
    ...fresh, expectedDeltas: [{ ...fresh.expectedDeltas[0], account: 'other' }],
  }, 1500), false);
  assert.equal(sameEconomicReview(previous, {
    ...fresh, simulation: { ...fresh.simulation, sponsorDebitCeilingLamports: '20001' },
  }, 1500), false);
  assert.equal(sameEconomicReview(previous, { ...fresh, state: 'broadcast' }, 1500), false);
  assert.equal(sameEconomicReview(previous, fresh, 2000), false);
});

test('settlement review shows exact fixed-recipient payouts and rejects mismatches', () => {
  const tenancy = {
    address: 'escrow', phase: 'settling' as const,
    depositMint: 'USDC', tenant: 'tenant', landlord: 'landlord',
    tenantDestination: 'tenant-ata', landlordDestination: 'landlord-ata',
    accountedIdleAtomic: '10000000',
  };
  const operation = {
    action: { kind: 'settle' as const },
    expectedDeltas: [
      { account: 'cash', mint: 'USDC', owner: 'escrow', direction: 'debit' as const,
        minimumAtomic: '10000000', maximumAtomic: '10000000' },
      { account: 'landlord-ata', mint: 'USDC', owner: 'landlord', direction: 'credit' as const,
        minimumAtomic: '0', maximumAtomic: '0' },
      { account: 'tenant-ata', mint: 'USDC', owner: 'tenant', direction: 'credit' as const,
        minimumAtomic: '10000000', maximumAtomic: '10000000' },
    ],
  };
  assert.deepEqual(settlementPayouts(operation, tenancy), {
    tenantAtomic: '10000000', landlordAtomic: '0',
  });
  assert.equal(settlementPayouts({ ...operation, expectedDeltas: [
    operation.expectedDeltas[0], operation.expectedDeltas[1],
    { ...operation.expectedDeltas[2], owner: 'someone-else' },
  ] }, tenancy), null);
  assert.equal(settlementPayouts({ ...operation, expectedDeltas: [
    operation.expectedDeltas[0], operation.expectedDeltas[1],
    { ...operation.expectedDeltas[2], minimumAtomic: '9000000', maximumAtomic: '9000000' },
  ] }, tenancy), null);
  assert.deepEqual(settlementPayouts(operation, {
    ...tenancy, phase: 'closed', accountedIdleAtomic: '0',
  }), { tenantAtomic: '10000000', landlordAtomic: '0' });
});
