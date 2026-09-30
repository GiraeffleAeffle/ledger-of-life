export const TEST_EXIT_NOTICE = 'Test units and test cash cannot be sold or withdrawn in this prototype.';

export function needsTestFunds(solanaCash: string | null, robinhoodCash: string | null): boolean {
  return solanaCash !== null && robinhoodCash !== null && BigInt(solanaCash) === 0n && BigInt(robinhoodCash) === 0n;
}

/** Current collateral price drop before debt reaches the 80% liquidation threshold. */
export function priceFallBeforeLiquidation(valueAtomic: string, debtAtomic: string): number | null {
  const value = BigInt(valueAtomic);
  const debt = BigInt(debtAtomic);
  if (value <= 0n || debt <= 0n) return null;
  const room = (value * 80n - debt * 100n) * 100n / (value * 80n);
  return Number(room > 0n ? room : 0n);
}

export function missingRepaymentCash(cashAtomic: string, debtAtomic: string): bigint {
  const shortfall = BigInt(debtAtomic) + 1000n - BigInt(cashAtomic);
  return shortfall > 0n ? shortfall : 0n;
}

export function stakeDisabledReason(input: { amountAtomic: string | null; cashAtomic: string | null; nativeAtomic: string | null; hasWallet: boolean }): string {
  if (!input.hasWallet) return 'Connect your Robinhood Chain wallet in Me first.';
  if (!input.amountAtomic || BigInt(input.amountAtomic) <= 0n) return 'Enter a stake amount greater than zero.';
  if (BigInt(input.amountAtomic) > 100_000_000n) return 'One stake purchase is capped at 100 test USD (tUSDG).';
  if (input.cashAtomic === null || input.nativeAtomic === null) return 'Test cash and network-fee ETH could not be checked.';
  const cashMissing = BigInt(input.amountAtomic) > BigInt(input.cashAtomic);
  const ethMissing = BigInt(input.nativeAtomic) === 0n;
  if (cashMissing && ethMissing) return 'You need both test USD (tUSDG) and network-fee test ETH.';
  if (cashMissing) return 'You need more test USD (tUSDG) for this stake.';
  if (ethMissing) return 'You need network-fee test ETH for this stake.';
  return '';
}
