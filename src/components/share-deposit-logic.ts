import type { ShareDepositAction, ShareDepositView, ShareDepositPlan, SolanaShareDepositPlan } from '../domain/share-deposit.ts';
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

export type ShareReviewParties = { tenant: string; landlord: string; arbitrator: string };

/** Solana addresses are case-sensitive, including the accepted program and mint. */
export function requireBoundSolanaShareReview(plan: SolanaShareDepositPlan, view: ShareDepositView, parties: ShareReviewParties, actor: { id: string; address: string }) {
  const form = view.form;
  const review = plan.review;
  if (view.network !== 'solana-devnet' || form.network !== 'solana-devnet' || plan.network !== 'solana-devnet' ||
      plan.rentalId !== view.rentalId || review.programId !== form.programId || review.mint !== form.mint ||
      !review.escrow || (view.escrow !== null && review.escrow !== view.escrow) ||
      !view.actions.includes(plan.action) || plan.action === 'approve')
    throw new Error('Review does not match this accepted Solana deposit.');
  if (!view.agreementHash || review.agreementHash !== view.agreementHash || review.securityUsd6 !== form.securityUsd6 ||
      review.responseWindow !== form.responseWindow || review.returnWindow !== form.returnWindow ||
      review.arbitrationWindow !== form.arbitrationWindow)
    throw new Error('Review differs from the accepted security, digest or windows.');
  if (plan.walletId !== actor.id || review.actor !== actor.address || review.actor !== parties[view.role] ||
      review.tenant !== parties.tenant || review.landlord !== parties.landlord || review.arbitrator !== parties.arbitrator ||
      !parties.tenant || !parties.landlord || !parties.arbitrator)
    throw new Error('Review differs from the accepted parties or verified Solana wallet.');
  if (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= Date.now())
    throw new Error('This review expired. Prepare and review the transaction again.');
}

export function formatDepositShares(raw: string, decimals: 6 | 18 = 18) {
  const amount = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${(amount / scale).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}

export function shareDepositReceiptUrl(hash: string, network?: 'solana-devnet') {
  return network === 'solana-devnet'
    ? `https://explorer.solana.com/tx/${encodeURIComponent(hash)}?cluster=devnet`
    : `https://explorer.testnet.chain.robinhood.com/tx/${encodeURIComponent(hash)}`;
}

