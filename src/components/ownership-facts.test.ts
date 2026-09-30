import test from 'node:test';
import assert from 'node:assert/strict';
import { ownershipFacts, type SharePosition } from './ownership-facts.ts';
import type { LocalInvestmentView } from '../server/local-investments.ts';

const share: SharePosition = {
  enabled: true, deployment: { pool: 'test-pool' },
  sharesRaw: '2000000000000000000', testUsdAtomic: '12000000', loan: null,
};
const market = {
  state: 'ready', cashAtomic: '2000000', assets: [
    { projectId: 'demo-neighbourhood-homes', holdingRaw: '5000000000000000000', error: null },
    { projectId: 'demo-retrofit-workshop', holdingRaw: '5000000000000000000', error: null },
  ],
} as LocalInvestmentView;

test('cash-funded housing and company stakes do not imply collateral or a share-backed loan', () => {
  const facts = ownershipFacts(share, market);
  assert.equal(facts.walletShares, true);
  assert.equal(facts.lockedShares, false);
  assert.equal(facts.borrowed, false);
  assert.equal(facts.housing, true);
  assert.equal(facts.company, true);
});

test('investing borrowed cash keeps debt and locked collateral visible even when wallet shares are zero', () => {
  const facts = ownershipFacts({ ...share, sharesRaw: '0', loan: { sharesRaw: '2000000000000000000', debtAtomic: '12001000', availableAtomic: '0' } }, market);
  assert.equal(facts.walletShares, false);
  assert.equal(facts.lockedShares, true);
  assert.equal(facts.borrowed, true);
  assert.equal(facts.cashAtomic, 2000000n);
  assert.equal(facts.housing, true);
  assert.equal(facts.company, true);
});

test('unknown wallet quantities do not prove ownership or become a factual zero cash balance', () => {
  const facts = ownershipFacts({ ...share, sharesRaw: null, testUsdAtomic: null }, { ...market, cashAtomic: null });
  assert.equal(facts.walletShares, false);
  assert.equal(facts.cashAtomic, null);
  assert.equal(facts.borrowed, false);
});
