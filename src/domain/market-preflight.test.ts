import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketShortfall, type MarketFacts } from './market-preflight.ts';

const TSLA = 10n ** 18n;
const USD = 10n ** 6n;
const none: MarketFacts = { walletTsla: 0n, walletUsd: 0n, collateral: 0n, debt: 0n, available: 0n, withdrawable: 0n };

for (const [name, operation, amount, facts, expected] of [
  ['collateral the wallet does not hold (the owner’s live case)', 'deposit_collateral', TSLA, none, /You hold 0 official test TSLA, less than 1\. Get test TSLA from Robinhood’s faucet first\./],
  ['exactly the TSLA the wallet holds', 'deposit_collateral', TSLA, { ...none, walletTsla: TSLA }, null],
  ['borrowing without collateral', 'borrow', USD, { ...none, available: 100n * USD }, /Add official test TSLA as collateral/],
  ['borrowing above the limit', 'borrow', 176n * USD, { ...none, collateral: TSLA, available: 175n * USD }, /up to 175 tUSDG/],
  ['borrowing exactly the limit', 'borrow', 175n * USD, { ...none, collateral: TSLA, available: 175n * USD }, null],
  ['repaying without debt', 'repay', USD, { ...none, walletUsd: USD }, /no debt/],
  // Repay takes only what is owed, so closing a loan with interest needs just the debt in the wallet.
  ['repaying more than the debt with only the debt in the wallet', 'repay', USD, { ...none, walletUsd: 2n, debt: 2n }, null],
  ['repaying with too few dollars', 'repay', 50n * USD, { ...none, walletUsd: 10n * USD, debt: 50n * USD }, /You hold 10 tUSDG; this repayment needs 50\./],
  ['lending more than the wallet holds', 'lend', 1_001n * USD, { ...none, walletUsd: 1_000n * USD }, /You hold 1,000 tUSDG, less than 1,001\. Get test dollars first\./],
  ['withdrawing more lent dollars than available', 'unlend', 11n * USD, { ...none, withdrawable: 10n * USD }, /up to 10 tUSDG/],
  ['withdrawing more collateral than deposited', 'withdraw_collateral', 2n * TSLA, { ...none, collateral: TSLA }, /Your collateral is 1 test TSLA, less than 2\./],
] as const) {
  test(`preflight: ${name}`, () => {
    const result = marketShortfall(operation, amount, facts);
    if (expected === null) assert.equal(result, null);
    else assert.match(result ?? '', expected);
  });
}
