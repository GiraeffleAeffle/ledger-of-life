import type { LocalInvestmentView } from '../server/local-investments.ts';

export type SharePosition = {
  enabled: boolean; fakeStock: unknown | null; deployment: unknown | null;
  sharesRaw: string; testUsdAtomic: string;
  deposit: { state: number; sharesRaw: string } | null;
  loan: { sharesRaw: string; debtAtomic: string; availableAtomic: string } | null;
};
export type OwnershipFacts = {
  walletShares: boolean; lockedShares: boolean; depositLocked: boolean; borrowed: boolean; cashAtomic: bigint;
  housing: boolean; company: boolean; legacy: boolean; enabled: boolean; availableAtomic: bigint;
};
/** Live positions, not navigational clicks: an existing unit or wallet cash is never proof of a loan. */
export function ownershipFacts(share: SharePosition, market: LocalInvestmentView): OwnershipFacts {
  const holding = (id: string) => market.state === 'ready' && market.assets.some((asset) =>
    asset.projectId === id && asset.holdingRaw !== null && BigInt(asset.holdingRaw) > 0n && !asset.error);
  return {
    walletShares: BigInt(share.sharesRaw) > 0n,
    lockedShares: BigInt(share.loan?.sharesRaw ?? '0') > 0n,
    depositLocked: Boolean(share.deposit && share.deposit.state > 0 && share.deposit.state < 5),
    borrowed: BigInt(share.loan?.debtAtomic ?? '0') > 0n,
    cashAtomic: BigInt(market.cashAtomic ?? share.testUsdAtomic),
    housing: holding('demo-neighbourhood-homes'), company: holding('demo-retrofit-workshop'),
    legacy: Boolean(share.deployment && !share.fakeStock), enabled: share.enabled,
    availableAtomic: BigInt(share.loan?.availableAtomic ?? '0'),
  };
}
