import { formatUnits } from 'viem';

/** What a wallet holds and owes in the shared market, in atomic units (test TSLA 18 decimals, tUSDG 6). */
export type MarketFacts = {
  walletTsla: bigint;
  walletUsd: bigint;
  collateral: bigint;
  debt: bigint;
  /** tUSDG the wallet could borrow now. */
  available: bigint;
  /** Lent tUSDG the wallet could withdraw now. */
  withdrawable: bigint;
};

const tsla = (value: bigint) => Number(formatUnits(value, 18)).toLocaleString('en-US', { maximumFractionDigits: 6 });
const usd = (value: bigint) => Number(formatUnits(value, 6)).toLocaleString('en-US', { maximumFractionDigits: 6 });

/**
 * Why this action cannot succeed for the wallet, in one sentence, or null when it can go ahead.
 * Checked before anything is signed, so nobody approves tokens for an action the pool will refuse.
 * The pool still enforces every rule itself; this covers the shortfalls a person can fix.
 */
export function marketShortfall(operation: string, amount: bigint, facts: MarketFacts): string | null {
  switch (operation) {
    case 'deposit_collateral':
      return amount > facts.walletTsla ? `You hold ${tsla(facts.walletTsla)} official test TSLA, less than ${tsla(amount)}. Get test TSLA from Robinhood’s faucet first.` : null;
    case 'withdraw_collateral':
      return amount > facts.collateral ? `Your collateral is ${tsla(facts.collateral)} test TSLA, less than ${tsla(amount)}.` : null;
    case 'borrow':
      if (facts.collateral === 0n) return 'Add official test TSLA as collateral before borrowing.';
      return amount > facts.available ? `You can borrow up to ${usd(facts.available)} tUSDG now.` : null;
    case 'repay': {
      if (facts.debt === 0n) return 'You have no debt to repay.';
      const needed = amount < facts.debt ? amount : facts.debt;
      return needed > facts.walletUsd ? `You hold ${usd(facts.walletUsd)} tUSDG; this repayment needs ${usd(needed)}.` : null;
    }
    case 'lend':
      return amount > facts.walletUsd ? `You hold ${usd(facts.walletUsd)} tUSDG, less than ${usd(amount)}. Get test dollars first.` : null;
    case 'unlend':
      return amount > facts.withdrawable ? `You can withdraw up to ${usd(facts.withdrawable)} tUSDG of your lent dollars now.` : null;
    case 'liquidate':
      return amount > facts.walletUsd ? `You hold ${usd(facts.walletUsd)} tUSDG, less than ${usd(amount)}.` : null;
    default:
      return null;
  }
}
