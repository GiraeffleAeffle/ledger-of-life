import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedRobinhood, defaultBuyAmount, netPositionParts, netPositionTotal, netSharePositionsAtomic, officialWalletUsd, type RobinhoodRead, type SharePositionAmounts } from './money-valuation.ts';

const million = 1_000_000n;

test('purchase prefill keeps cash when possible and formats fractional balances', () => {
  assert.equal(defaultBuyAmount(500_000n), '0.5');
  assert.equal(defaultBuyAmount(12_000_000n), '5');
  assert.equal(defaultBuyAmount(3_250_000n), '3.25');
  assert.equal(defaultBuyAmount(5_000_000n), '5');
});
const netWithCash = (cash: bigint, positions: SharePositionAmounts) => cash + netSharePositionsAtomic(positions);

test('a share transferred from wallet to deposit or loan collateral never vanishes from net worth', () => {
  const wallet: SharePositionAmounts = { fakeStock: { walletValueAtomic: (3600n * million).toString() }, deposit: null, loan: null };
  const pledged: SharePositionAmounts = { fakeStock: { walletValueAtomic: (2400n * million).toString() },
    deposit: { valueAtomic: (1200n * million).toString() }, loan: null };
  const collateralized: SharePositionAmounts = { fakeStock: { walletValueAtomic: (1400n * million).toString() },
    deposit: pledged.deposit, loan: { valueAtomic: (1000n * million).toString(), debtAtomic: '0' } };
  assert.equal(netSharePositionsAtomic(wallet), 3600n * million);
  assert.equal(netSharePositionsAtomic(pledged), netSharePositionsAtomic(wallet));
  assert.equal(netSharePositionsAtomic(collateralized), netSharePositionsAtomic(wallet));
});

test('borrowing and repayment change cash and debt together; old official collateral is still owned', () => {
  const legacy: SharePositionAmounts = { fakeStock: null, deposit: { valueAtomic: (1200n * million).toString() },
    loan: { valueAtomic: (1000n * million).toString(), debtAtomic: '0' } };
  const borrowed = { ...legacy, loan: { ...legacy.loan!, debtAtomic: (300n * million).toString() } };
  assert.equal(netWithCash(10n * million, legacy), 2210n * million);
  assert.equal(netWithCash(310n * million, borrowed), netWithCash(10n * million, legacy));
});

test('actual price-unavailable Robinhood response preserves quantities and only values known cash', () => {
  const response: RobinhoodRead = { ok: false, code: 'price_unavailable', error: 'Reference price unavailable',
    value: { status: 'price_unavailable', address: '0x1111111111111111111111111111111111111111',
      testUsdAtomic: '1250000', tslaRaw: '2000000000000000000', tslaShares: 2, ethBalance: '0' } };
  assert.equal(confirmedRobinhood(response)?.tslaShares, 2);
  assert.equal(confirmedRobinhood(response)?.testUsdAtomic, '1250000');
  assert.equal(officialWalletUsd(response), null, 'a nonzero unpriced holding cannot produce a complete value');

  const cashOnly: RobinhoodRead = { ...response, value: { ...response.value, tslaRaw: '0', tslaShares: 0 } };
  assert.equal(officialWalletUsd(cashOnly), 1.25, 'known zero shares permit the confirmed cash-only value');
  assert.equal(confirmedRobinhood({ ok: false, error: 'RPC unavailable' }), null);
  assert.equal(officialWalletUsd({ ok: false, error: 'RPC unavailable' }), null);
});

const parts = (input: Partial<Parameters<typeof netPositionParts>[0]>) =>
  netPositionParts({ lockedUsd: 0, walletCashUsd: 0, walletSharesUsd: 0, positions: null, ...input });
const dollars = (amount: bigint) => (amount * million).toString();

test('the rental deposit is part of the subtotal but never free to use', () => {
  const result = parts({ lockedUsd: 10, walletCashUsd: 5 });
  assert.deepEqual(result, { free: 5, locked: 10, pledged: 0, owed: 0 });
  assert.equal(netPositionTotal(result), 15);
});

test('pledging shares and borrowing against them moves value between parts without changing the total', () => {
  const inWallet: SharePositionAmounts = { fakeStock: { walletValueAtomic: dollars(3600n) }, deposit: null, loan: null };
  const pledged: SharePositionAmounts = { fakeStock: { walletValueAtomic: dollars(2400n) }, deposit: { valueAtomic: dollars(1200n) }, loan: null };
  const borrowed: SharePositionAmounts = { fakeStock: { walletValueAtomic: dollars(1400n) },
    deposit: pledged.deposit, loan: { valueAtomic: dollars(1000n), debtAtomic: dollars(300n) } };
  const total = (cash: number, positions: SharePositionAmounts) => netPositionTotal(parts({ walletCashUsd: cash, positions }));
  assert.deepEqual(parts({ positions: pledged }), { free: 2400, locked: 0, pledged: 1200, owed: 0 });
  assert.deepEqual(parts({ walletCashUsd: 300, positions: borrowed }), { free: 1700, locked: 0, pledged: 2200, owed: 300 });
  assert.equal(total(0, pledged), total(0, inWallet));
  assert.equal(total(300, borrowed), total(0, inWallet), 'the borrowed cash is free to use, the debt is owed, so borrowing changes nothing');
});

test('the breakdown reconciles with the subtotal it replaces, to the cent', () => {
  const positions: SharePositionAmounts = { fakeStock: { walletValueAtomic: '1234567' },
    deposit: { valueAtomic: '7654321' }, loan: { valueAtomic: '4000001', debtAtomic: '1500003' } };
  const input = { lockedUsd: 10.004, walletCashUsd: 20.333333, walletSharesUsd: 30.666667, positions };
  const before = input.lockedUsd + input.walletCashUsd + input.walletSharesUsd + Number(netSharePositionsAtomic(positions)) / 1e6;
  assert.ok(Math.abs(netPositionTotal(netPositionParts(input)) - before) < 0.02, 'each of four parts may round by half a cent');
});
