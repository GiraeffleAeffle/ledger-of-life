import type { TenancyJourney } from '../server/journey.ts';
import type { ShareDepositView } from '../domain/share-deposit.ts';

type DepositHolding = Pick<TenancyJourney, 'chain' | 'role' | 'shareDeposit'>;
const atomicUsd = (atomic: string | null | undefined) => Number(atomic ?? '0') / 1e6;
function cashEntitlementUsd(role: TenancyJourney['role'], chain: NonNullable<TenancyJourney['chain']>): number {
  const settled = chain.phase === 'settling' || chain.phase === 'closed';
  if (role === 'tenant') return settled
    ? atomicUsd(chain.tenantOwedAtomic) - atomicUsd(chain.tenantPaidAtomic)
    : Math.max(0, atomicUsd(chain.lendingValueAtomic) + atomicUsd(chain.escrowAtomic) - atomicUsd(chain.approvedClaimAtomic));
  if (role === 'landlord') return settled
    ? atomicUsd(chain.landlordOwedAtomic) - atomicUsd(chain.landlordPaidAtomic)
    : atomicUsd(chain.approvedClaimAtomic);
  return 0;
}
function shareEntitlementUsd(role: TenancyJourney['role'], view: ShareDepositView | undefined): number {
  if (!view?.quote?.fresh) return 0;
  const locked = BigInt(view.lockedShares);
  const award = BigInt(view.landlordOwed) < locked ? BigInt(view.landlordOwed) : locked;
  const own = role === 'tenant' ? locked - award : role === 'landlord' ? award : 0n;
  return Number(own * BigInt(view.quote.priceUsd6) / 10n ** 18n) / 1e6;
}
/** Cash tiles never include share custody; the net subtotal includes each role's outstanding entitlement once. */
export function depositHoldings<T extends DepositHolding>(tenancies: readonly T[]) {
  const entitled = tenancies.map(t => ({ t, value: t.chain ? cashEntitlementUsd(t.role, t.chain) : shareEntitlementUsd(t.role, t.shareDeposit) })).filter(({ value }) => value > 0);
  const cashEntitled = entitled.filter(({ t }) => t.chain);
  return {
    cashEntitled,
    locked: entitled.reduce((sum, { value }) => sum + value, 0),
    cashLocked: cashEntitled.reduce((sum, { value }) => sum + value, 0),
    cashTenantCount: cashEntitled.filter(({ t }) => t.role === 'tenant').length,
  };
}
