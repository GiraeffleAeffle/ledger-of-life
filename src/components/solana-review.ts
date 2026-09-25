import type { SolanaOperation } from '@/server/solana-service';
import type { TenancyAccount } from '@/finance/solana/program';

type Review = Pick<
  SolanaOperation,
  | 'id'
  | 'state'
  | 'agreementId'
  | 'walletId'
  | 'actor'
  | 'role'
  | 'nonce'
  | 'action'
  | 'deployment'
  | 'expectedDeltas'
  | 'simulation'
  | 'expiresAt'
>;

/** A fresh blockhash may replace an unsigned review only when its financial intent is unchanged. */
export function sameEconomicReview(previous: Review, refreshed: Review, now: number): boolean {
  return (
    previous.state === 'prepared' &&
    refreshed.state === 'prepared' &&
    refreshed.id !== previous.id &&
    Date.parse(refreshed.expiresAt) > now &&
    refreshed.agreementId === previous.agreementId &&
    refreshed.walletId === previous.walletId &&
    refreshed.actor === previous.actor &&
    refreshed.role === previous.role &&
    refreshed.nonce === previous.nonce &&
    refreshed.deployment?.genesisHash === previous.deployment?.genesisHash &&
    refreshed.deployment?.escrowProgram === previous.deployment?.escrowProgram &&
    refreshed.deployment?.programSha256 === previous.deployment?.programSha256 &&
    typeof previous.deployment?.genesisHash === 'string' &&
    typeof previous.deployment?.escrowProgram === 'string' &&
    typeof previous.deployment?.programSha256 === 'string' &&
    JSON.stringify(refreshed.action) === JSON.stringify(previous.action) &&
    JSON.stringify(refreshed.expectedDeltas) === JSON.stringify(previous.expectedDeltas) &&
    BigInt(refreshed.simulation.sponsorDebitCeilingLamports) <=
      BigInt(previous.simulation.sponsorDebitCeilingLamports)
  );
}

/** Show the exact fixed-recipient credits before a settlement signature. */
export function settlementPayouts(
  operation: Pick<SolanaOperation, 'action' | 'expectedDeltas'>,
  tenancy: Pick<
    TenancyAccount,
    | 'address'
    | 'depositMint'
    | 'phase'
    | 'tenant'
    | 'landlord'
    | 'tenantDestination'
    | 'landlordDestination'
    | 'accountedIdleAtomic'
  >,
): { tenantAtomic: string; landlordAtomic: string } | null {
  if (operation.action.kind !== 'settle') return null;
  const credit = (account: string, owner: string) =>
    operation.expectedDeltas.find(
      (delta) =>
        delta.account === account &&
        delta.owner === owner &&
        delta.mint === tenancy.depositMint &&
        delta.direction === 'credit' &&
        delta.minimumAtomic === delta.maximumAtomic,
    )?.minimumAtomic;
  const tenantAtomic = credit(tenancy.tenantDestination, tenancy.tenant);
  const landlordAtomic = credit(tenancy.landlordDestination, tenancy.landlord);
  const escrowDebit = operation.expectedDeltas.find(
    (delta) =>
      delta.owner === tenancy.address &&
      delta.mint === tenancy.depositMint &&
      delta.direction === 'debit' &&
      delta.minimumAtomic === delta.maximumAtomic,
  )?.minimumAtomic;
  if (tenantAtomic === undefined || landlordAtomic === undefined || escrowDebit === undefined)
    return null;
  if (BigInt(tenantAtomic) + BigInt(landlordAtomic) !== BigInt(escrowDebit))
    return null;
  if (tenancy.phase === 'settling' && escrowDebit !== tenancy.accountedIdleAtomic)
    return null;
  return { tenantAtomic, landlordAtomic };
}
