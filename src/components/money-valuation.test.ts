import assert from 'node:assert/strict';
import test from 'node:test';
import { netPositionParts, netPositionTotal, shareValuationAvailable, type SharePositionAmounts } from './money-valuation.ts';
const position: SharePositionAmounts = { deployment: { pool: 'pool' }, price: { stale: false }, suspended: false, priceAtomic: '350000000', sharesRaw: '2000000000000000000', walletValueAtomic: '700000000', loan: null, lender: null };
const parts = (positions: SharePositionAmounts, cash = 0) => {
  const result = netPositionParts({ positions, lockedUsd: 0, walletCashUsd: cash, walletSharesUsd: 0 });
  assert.ok(result);
  return result;
};
test('wallet and collateral at one mirrored price conserve value through collateral and borrowing', () => {
  const collateral = { ...position, sharesRaw: '1000000000000000000', walletValueAtomic: '350000000', loan: { sharesRaw: '1000000000000000000', valueAtomic: '350000000', debtAtomic: '100000000' } };
  assert.deepEqual(parts(collateral, 100), { free: 450, locked: 0, pledged: 350, lent: 0, owed: 100 });
  assert.equal(netPositionTotal(parts(collateral, 100)), netPositionTotal(parts(position)));
});
test('lending moves cash into a claim once; borrower interest and losses change that claim', () => {
  const lent = { ...position, lender: { valueAtomic: '100000000' } };
  assert.equal(netPositionTotal(parts(lent)), netPositionTotal(parts(position, 100)));
  assert.equal(netPositionTotal(parts({ ...lent, lender: { valueAtomic: '101000000' } })), 801);
  assert.equal(netPositionTotal(parts({ ...lent, lender: { valueAtomic: '90000000' } })), 790);
});
test('nonzero wallet or collateral TSLA cannot be valued with stale, absent or undeployed mirror', () => {
  assert.equal(shareValuationAvailable(position), true);
  for (const unavailable of [{ ...position, price: { stale: true } }, { ...position, price: null }, { ...position, deployment: null }, { ...position, suspended: true }, { ...position, priceAtomic: null }, { ...position, priceAtomic: '0' }]) {
    assert.equal(shareValuationAvailable(unavailable), false);
    assert.equal(shareValuationAvailable({ ...unavailable, sharesRaw: '0', loan: { sharesRaw: '1', valueAtomic: '1', debtAtomic: '0' } }), false);
  }
  assert.equal(shareValuationAvailable({ ...position, deployment: null, price: null, sharesRaw: '0', walletValueAtomic: '0' }), true);
  assert.equal(shareValuationAvailable(null), false);
});
test('unknown stock balances and nullable held-stock values keep the subtotal incomplete', () => {
  const collateral = { sharesRaw: '1000000000000000000', valueAtomic: null, debtAtomic: '100000000' };
  for (const unavailable of [
    { ...position, sharesRaw: null },
    { ...position, walletValueAtomic: null },
    { ...position, sharesRaw: '0', walletValueAtomic: '0', loan: collateral },
    { ...position, suspended: true, priceAtomic: null, walletValueAtomic: null, loan: collateral },
    { ...position, deployment: null, price: null, priceAtomic: null, walletValueAtomic: null },
  ]) {
    assert.equal(shareValuationAvailable(unavailable), false);
    assert.equal(netPositionParts({ positions: unavailable, lockedUsd: 50, walletCashUsd: 100, walletSharesUsd: 0 }), null);
  }
});

test('cash, lender claims and debt remain valued without a quote when stock quantities are confirmed zero', () => {
  const noStock = { ...position, deployment: null, price: null, suspended: true, sharesRaw: '0', priceAtomic: null, walletValueAtomic: null,
    loan: { sharesRaw: '0', valueAtomic: null, debtAtomic: '10000000' }, lender: { valueAtomic: '25000000' } };
  assert.equal(shareValuationAvailable(noStock), true);
  assert.deepEqual(parts(noStock, 100), { free: 100, locked: 0, pledged: 0, lent: 25, owed: 10 });
  assert.equal(netPositionTotal(parts(noStock, 100)), 115);
});
