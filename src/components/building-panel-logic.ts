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
  if (!input.connected) return 'Connect your Robinhood wallet in Me';
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
