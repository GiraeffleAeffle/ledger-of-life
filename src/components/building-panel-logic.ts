import type { SolanaOperationResult } from '../server/solana-operations.ts';

export function estimateBuildingHeat(input: { tokens: number; measuredWhPerToken?: number | null; runtimeMs?: number | null; nominalWatts?: number | null }) {
  const valid = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (valid(input.tokens) && valid(input.measuredWhPerToken)) return { kwh: input.tokens * input.measuredWhPerToken / 1000, assumption: `${input.tokens} served tokens × ${input.measuredWhPerToken} measured Wh/token`, method: 'tokens' as const };
  if (valid(input.runtimeMs) && valid(input.nominalWatts)) return { kwh: input.runtimeMs / 3_600_000 * input.nominalWatts / 1000, assumption: `${(input.runtimeMs / 3_600_000).toFixed(4)} runtime hours × ${input.nominalWatts} nominal W`, method: 'runtime' as const };
  return null;
}

export function buildingActionState(input: {
  operation: 'stake' | 'unstake' | 'claim' | 'sync'; configured: boolean; connected: boolean; busy: boolean;
  quantityRaw: string | null; walletUnitsRaw: string | null; stakedRaw: string | null; earnedRaw: string | null; pendingRevenueRaw?: string | null;
}) {
  if (!input.connected) return 'Connect your Shares wallet in Me';
  if (!input.configured) return 'Building distributor not configured';
  if (input.busy) return 'Finish the current building action first';
  if (input.operation === 'sync') {
    if (input.pendingRevenueRaw == null) return 'Wait for verified new income';
    return BigInt(input.pendingRevenueRaw) > 0n ? null : 'No new income to start streaming';
  }
  if (input.operation === 'claim') {
    if (input.earnedRaw === null) return 'Wait for verified earnings';
    return BigInt(input.earnedRaw) > 0n ? null : 'No claimable test dollars';
  }
  if (input.quantityRaw === null || BigInt(input.quantityRaw) <= 0n) return 'Enter a positive tHOME amount';
  const balance = input.operation === 'stake' ? input.walletUnitsRaw : input.stakedRaw;
  if (balance === null) return 'Wait for verified unit balances';
  if (BigInt(input.quantityRaw) > BigInt(balance)) return input.operation === 'stake' ? 'Not enough wallet tHOME units' : 'Not enough staked tHOME units';
  return null;
}

/** The tick is a projection between verified reads, never an amount used to prepare a claim. */
export function projectedBuildingEarnings(input: {
  earnedRaw: string; stakedRaw: string; totalStakedRaw: string; rewardRateRaw: string;
  rewardScaleRaw: string; periodFinish: number; observedAt: number; now: number;
}) {
  const total = BigInt(input.totalStakedRaw), scale = BigInt(input.rewardScaleRaw);
  const elapsed = Math.max(0, Math.min(input.now, input.periodFinish) - input.observedAt);
  if (total <= 0n || scale <= 0n || elapsed === 0) return input.earnedRaw;
  return (BigInt(input.earnedRaw) + BigInt(Math.floor(elapsed)) * BigInt(input.rewardRateRaw) * BigInt(input.stakedRaw) / total / scale).toString();
}

/** Solana units and tUSDC both have six decimals; fees and account rent are sponsored. */
export function solanaHouseActionState(input: {
  operation: 'buy' | 'sell' | 'stake' | 'unstake' | 'claim' | 'reinvest';
  configured: boolean; connected: boolean; busy: boolean; quantityRaw: string | null;
  cashAtomic: string | null; walletUnitsRaw: string | null; stakedRaw: string | null; earnedRaw: string | null;
  priceAtomic?: string | null; sellCapUnitsRaw?: string | null; deskCashAtomic?: string | null;
}) {
  if (!input.connected) return 'Connect your Solana wallet in Me';
  if (!input.configured) return 'Wait for the verified Solana house';
  if (input.busy) return 'Finish the current house review or transaction first';
  if (input.operation === 'claim' || input.operation === 'reinvest') {
    if (input.earnedRaw == null) return 'Wait for verified claimable income';
    const earned = BigInt(input.earnedRaw);
    if (earned <= 0n) return 'No claimable test USDC';
    if (input.operation === 'reinvest') {
      if (earned > 100_000_000n) return 'One reinvest is capped at 100 tUSDC';
      if (input.priceAtomic == null) return 'Wait for the verified unit price';
      if (earned * 1_000_000n / BigInt(input.priceAtomic) <= 0n) return 'Income is too small to buy an atomic unit';
    }
    return null;
  }
  if (input.quantityRaw == null || !/^[1-9]\d{0,19}$/.test(input.quantityRaw) || BigInt(input.quantityRaw) > (1n << 64n) - 1n) return 'Enter a positive six-decimal amount';
  const quantity = BigInt(input.quantityRaw);
  if (input.operation === 'buy') {
    if (quantity < 1000n || quantity > 100_000_000n) return 'Buy between 0.001 and 100 tUSDC';
    if (input.cashAtomic == null) return 'Wait for your verified tUSDC balance';
    if (quantity > BigInt(input.cashAtomic)) return 'Get more test USDC in Me';
    if (input.priceAtomic == null) return 'Wait for the verified unit price';
    if (quantity * 1_000_000n / BigInt(input.priceAtomic) <= 0n) return 'This amount buys no atomic unit';
    return null;
  }
  const balance = input.operation === 'unstake' ? input.stakedRaw : input.walletUnitsRaw;
  if (balance == null) return 'Wait for verified unit balances';
  if (quantity > BigInt(balance)) return input.operation === 'unstake' ? 'Not enough of your own staked units' : 'Not enough wallet units; unstake before selling';
  if (input.operation === 'sell') {
    if (input.sellCapUnitsRaw == null || input.deskCashAtomic == null || input.priceAtomic == null) return 'Wait for the verified desk balance and sell cap';
    if (quantity > 100_000_000n || quantity > BigInt(input.sellCapUnitsRaw)) return 'Sell-back exceeds the house unit cap';
    const cash = quantity * BigInt(input.priceAtomic) / 1_000_000n;
    if (cash === 0n) return 'This amount returns no atomic test USDC';
    if (cash > BigInt(input.deskCashAtomic)) return 'The house desk needs more test USDC';
  }
  return null;
}

/** Only canonical prepared state permits a wallet prompt; expiry never implies a payout. */
export function solanaHouseSigningBlocker(operation: Pick<SolanaOperationResult, 'state' | 'signature' | 'blockhashValid'>): string | null {
  if (operation.state === 'prepared') return operation.blockhashValid === true ? null
    : 'Network blockhash validity could not be verified. No wallet prompt was opened; retry checking this same review.';
  if (operation.state === 'expired') return operation.signature
    ? 'Finalized recovery found that this signed transaction did not land before expiry. Prepare a fresh review to try again.'
    : operation.blockhashValid === false
      ? 'This review’s network blockhash expired. No transaction was sent and no payout receipt exists for it. Prepare a fresh review before signing.'
      : 'This unsigned review is closed or its maximum server review-policy deadline ended. No transaction was sent and no payout receipt exists for it. Prepare a fresh review before signing.';
  if (operation.state === 'failed') return 'This transaction failed on chain. It has no successful payout receipt. Prepare a fresh review to try again.';
  if (operation.state === 'broadcast') return 'Your existing signed transaction still awaits a verified finalized receipt. Continue checking it instead of signing a replacement.';
  return 'This transaction already has a verified finalized receipt. See House action receipts; do not sign it again.';
}

/** Displays only observed heights; block time and wall-clock policy deadlines are not estimates. */
export function solanaHouseBlockhashStatus(input: { lastValidBlockHeight: string; blockHeight?: string; blockhashValid?: boolean }): string {
  if (!/^\d+$/.test(input.lastValidBlockHeight) || input.blockHeight === undefined || !/^\d+$/.test(input.blockHeight) || input.blockhashValid === undefined)
    return 'Network blockhash validity has not been verified yet; it will be checked before a wallet prompt.';
  const current = BigInt(input.blockHeight), lastValid = BigInt(input.lastValidBlockHeight);
  if (!input.blockhashValid || current > lastValid)
    return `Network blockhash expired · observed confirmed height ${current} is past last valid height ${lastValid}.`;
  return `Network blockhash valid at confirmed height ${current} · last valid height ${lastValid} · ${lastValid - current + 1n} valid block heights remaining at this check.`;
}
