import type { ShareDepositAction, ShareDepositView, ShareDepositPlan } from '../domain/share-deposit.ts';
import { parseUnits } from 'viem';

/** Never invent permission from a local clock; the server's readable actions are authoritative. */
export function nextShareDepositAction(view: Pick<ShareDepositView, 'deployment' | 'actions' | 'needsTopUp' | 'state' | 'role'>): ShareDepositAction | null {
  if (view.deployment !== 'deployed') return null;
  const priority: ShareDepositAction[] = view.state === 'Active'
    ? view.role === 'tenant' ? view.needsTopUp ? ['approve', 'pledge', 'requestReturn', 'withdraw'] : ['closeUnclaimed', 'closeUnresolved'] : ['proposeClaim']
    : ['closeUnresolved', 'closeUnclaimed', 'acceptClaim', 'contestClaim', 'resolveClaim', 'escalateClaim', 'create', 'approve', 'pledge', 'activate', 'payout', 'lowerClaim'];
  return priority.find(action => view.actions.includes(action)) ?? null;
}

export function shareRefreshIsCurrent(started: number, current: number) {
  return started === current;
}

export function showShareClaim(view: Pick<ShareDepositView, 'state' | 'claim' | 'landlordOwed'>) {
  return !!view.claim && (view.state === 'ClaimPending' || view.state === 'ClaimContested' ||
    view.state === 'Closed' && BigInt(view.landlordOwed) > 0n);
}

export function showTenantFunding(view: Pick<ShareDepositView, 'role'>) {
  return view.role === 'tenant';
}

export function shareFeeBalance(assets: { robinhood: { value?: { ethBalance?: string } } | null }) {
  // A stale valuation still carries authoritative wallet balances.
  return assets.robinhood?.value?.ethBalance;
}

export function shareReceiptPollDelay(errors: number) {
  return Math.min(5_000 * 2 ** Math.min(errors, 4), 60_000);
}

/** Only the current wallet's genuinely pending receipt may block its next signature. */
export function pendingShareDepositReceipt(receipts: ShareDepositView['receipts'], walletIds: readonly string[]) {
  return receipts.find(receipt => receipt.status === 'pending' && walletIds.includes(receipt.walletId)) ?? null;
}

export function requireBoundShareReview(plan: ShareDepositPlan, view: ShareDepositView) {
  if (plan.rentalId !== view.rentalId || plan.review.factory.toLowerCase() !== view.form.factory?.toLowerCase() ||
      plan.review.stock.toLowerCase() !== view.form.stock.toLowerCase() ||
      (plan.action !== 'create' && plan.review.escrow?.toLowerCase() !== view.escrow?.toLowerCase()))
    throw new Error('Review does not match this accepted deposit.');
  if (plan.action === 'create') {
    const terms = plan.review.args[0] as Record<string, unknown> | undefined;
    if (!terms || terms.agreementHash !== view.agreementHash || String(terms.depositValue) !== view.form.securityUsd6 ||
        Number(terms.responseWindow) !== view.form.responseWindow || Number(terms.returnWindow) !== view.form.returnWindow ||
        Number(terms.arbitrationWindow) !== view.form.arbitrationWindow)
      throw new Error('Creation review differs from the accepted security, digest or windows.');
  }
}
export function shareDepositAmount(value: string, decimals: 6 | 18): string {
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text) || (text.split('.')[1]?.length ?? 0) > decimals)
    throw new Error(`Enter a nonnegative decimal with at most ${decimals} decimal places; no rounding is applied.`);
  const amount = parseUnits(text, decimals);
  if (amount >= 1n << 256n) throw new Error('The amount exceeds the contract range.');
  return amount.toString();
}

