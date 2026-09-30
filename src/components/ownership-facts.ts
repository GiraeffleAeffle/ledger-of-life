import type { LocalInvestmentView } from '../server/local-investments.ts';

export type SharePosition = {
  enabled: boolean; deployment: unknown | null;
  sharesRaw: string | null; testUsdAtomic: string | null;
  loan: { sharesRaw: string; debtAtomic: string; availableAtomic: string } | null;
};
export type OwnershipFacts = {
  walletShares: boolean; lockedShares: boolean; borrowed: boolean; cashAtomic: bigint | null;
  housing: boolean; company: boolean; enabled: boolean; availableAtomic: bigint;
};
/** Live positions, not navigational clicks: an existing unit or wallet cash is never proof of a loan. */
export function ownershipFacts(share: SharePosition, market: LocalInvestmentView): OwnershipFacts {
  const holding = (id: string) => market.state === 'ready' && market.assets.some((asset) =>
    asset.projectId === id && asset.holdingRaw !== null && BigInt(asset.holdingRaw) > 0n && !asset.error);
  const cash = market.cashAtomic ?? share.testUsdAtomic;
  return {
    walletShares: share.sharesRaw !== null && BigInt(share.sharesRaw) > 0n,
    lockedShares: BigInt(share.loan?.sharesRaw ?? '0') > 0n,
    borrowed: BigInt(share.loan?.debtAtomic ?? '0') > 0n,
    cashAtomic: cash === null ? null : BigInt(cash),
    housing: holding('demo-neighbourhood-homes'), company: holding('demo-retrofit-workshop'),
    enabled: share.enabled,
    availableAtomic: BigInt(share.loan?.availableAtomic ?? '0'),
  };
}
