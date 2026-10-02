import type { TenancyJourney } from '../server/journey.ts';
import { depositHoldings } from './deposit-holdings.ts';

export type CashDepositStatus = 'unfunded' | 'paid_out' | 'no_entitlement' | 'secured' | 'claim_owed' | 'held_for_tenant' | 'not_owner';
/** A zero tenant balance is not evidence that the deposit belongs to another role. */
export function cashDepositStatus(tenancy: Pick<TenancyJourney, 'role' | 'chain'>): CashDepositStatus {
  const chain = tenancy.chain;
  if (!chain || tenancy.role === 'arbitrator') return 'not_owner';
  const { cashLocked } = depositHoldings([tenancy]);
  if (tenancy.role === 'landlord') return cashLocked > 0 ? 'claim_owed' : 'held_for_tenant';
  if (cashLocked > 0) return 'secured';
  if (chain.phase === 'settling' || chain.phase === 'closed') return 'paid_out';
  if (BigInt(chain.lendingValueAtomic) + BigInt(chain.escrowAtomic) === 0n) return 'unfunded';
  return 'no_entitlement';
}

export const TEST_EXIT_NOTICE = 'Fictional test units, no value, no rights. Local tHOME and tWORK units can be sold back for tUSDG at the fixed test price only when the desk has enough test cash. Other test units have no app sell lane. Test cash and shared-pool withdrawals have no monetary value.';

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
