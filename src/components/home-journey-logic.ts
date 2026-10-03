import type { JourneyStage } from '../server/journey.ts';
import type { PublicListing } from '../server/listings.ts';

export const HOME_STAGES = ['Find', 'Apply', 'Agree', 'Secure', 'Live', 'Move out', 'Paid out'] as const;

const PASSIVE_TENANCY_STEPS: Record<string, true> = {
  wait: true, confirming: true, paying_out: true, done: true, cancelled: true, propose_claim: true,
};
const VOLUNTARY_SHARE_ACTIONS: Record<string, true> = {
  approve: true, pledge: true, withdraw: true, requestReturn: true, lowerClaim: true,
};

/** Only funding-stage actions, top-ups and mandatory settlement steps need this person. */
export function tenancyNeedsPerson(journey: {
  stage: string; next: { kind: string }; depositForm?: { kind: string };
  shareDeposit?: { needsTopUp: boolean; actions: readonly string[] };
}) {
  if (journey.depositForm?.kind === 'shares' && journey.stage === 'living') {
    return journey.next.kind !== 'propose_claim' && Boolean(journey.shareDeposit?.needsTopUp);
  }
  const requiredShareAction = journey.shareDeposit?.actions.some(action =>
    journey.stage === 'deposit' || !VOLUNTARY_SHARE_ACTIONS[action]);
  return Boolean(journey.shareDeposit?.needsTopUp || requiredShareAction)
    || !PASSIVE_TENANCY_STEPS[journey.next.kind];
}

/** Expiry rejected before persistence: discard local approval before obtaining a fresh review. */
export async function recoverExpiredRentReview(
  reason: unknown, clearApproval: () => void, prepare: () => Promise<void>,
): Promise<boolean> {
  if (!(reason instanceof Error) || !('status' in reason) || reason.status !== 409 || !/rent review expired/i.test(reason.message)) return false;
  clearApproval();
  await prepare();
  return true;
}

/** Cancelled records stay available in Home, but never drive the active path. */
export function currentHomeTenancy<T extends { stage: string; next: { kind: string } }>(tenancies: readonly T[]): T | undefined {
  const live = tenancies.filter((tenancy) => tenancy.next.kind !== 'cancelled' && tenancy.next.kind !== 'done');
  return live.find((tenancy) => tenancy.next.kind === 'respond_claim' || tenancy.next.kind === 'decide_claim')
    ?? live.find((tenancy) => !['confirming', 'paying_out', 'wait', 'propose_claim'].includes(tenancy.next.kind))
    ?? live.find((tenancy) => tenancy.stage !== 'living')
    ?? live[0];
}

/** A failed home read is unknown, never evidence that someone needs to find a home. */
export function homeSituation<L extends Pick<PublicListing, 'relation' | 'status' | 'agreementId' | 'applications'>>({
  listings, tenancyIds, hasCurrent, homeKnown,
}: { listings: readonly L[]; tenancyIds: readonly string[]; hasCurrent: boolean; homeKnown: boolean }) {
  return {
    reviewListings: listings.filter(l => l.relation === 'landlord' && l.status === 'open' && (l.applications?.length ?? 0) > 0),
    applicationListings: listings.filter(l => (l.relation === 'chosen' || l.relation === 'applicant') && !(l.agreementId && tenancyIds.includes(l.agreementId))),
    showBrowser: homeKnown && !hasCurrent && !listings.some(l => l.relation === 'landlord'),
  };
}

export function applicationStatusLabel(listing: Pick<PublicListing, 'relation' | 'status'>): string {
  if (listing.status === 'closed') return 'Listing closed';
  if (listing.relation === 'chosen') return 'Chosen · agreement next';
  if (listing.status === 'let') return 'Not chosen';
  return 'Application sent · the landlord decides. The app sends no notification; tell them yourself.';
}

/** Person-facing progress only; never advances a pending chain operation. */
export function homeStage(stage?: JourneyStage, listing?: Pick<PublicListing, 'relation' | 'status'>): number {
  if (stage) return { agreement: 2, space: 3, deposit: 3, living: 4, 'move-out': 5, paid: 6 }[stage];
  if (listing?.relation === 'chosen') return 2;
  if (listing?.status === 'open' && (listing.relation === 'applicant' || listing.relation === 'landlord')) return 1;
  return 0;
}

export function claimAmount(value: string, maximumAtomic: string): string {
  const normalized = value.replace(',', '.');
  if (!/^(0|[1-9]\d{0,18})(\.\d{1,6})?$/.test(normalized)) throw new Error('Enter a test USDC amount with up to six decimal places.');
  const [whole, fraction = ''] = normalized.split('.');
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
  if (atomic > BigInt(maximumAtomic)) throw new Error('The deduction cannot exceed the allowed maximum.');
  return atomic.toString();
}

export function settlementSplit(totalAtomic: string, landlordAtomic: string) {
  const total = BigInt(totalAtomic);
  const landlord = BigInt(landlordAtomic);
  if (landlord < 0n || landlord > total) throw new Error('The deduction cannot exceed the deposit at stake.');
  return { tenantAtomic: (total - landlord).toString(), landlordAtomic: landlord.toString() };
}

export const invitationKey = (accountId: string, agreementId: string) =>
  `ledger-of-life:invite:v1:${accountId}:${agreementId}`;

export function invitationStatus(createdAt: number, now: number) {
  return now >= createdAt + 86_400_000 ? 'expired' : 'valid';
}

export function invitationPayload(value: string): { id: string; role: 'arbitrator' | 'tenant'; token: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const invitation = parsed as Record<string, unknown>;
    if (typeof invitation.id !== 'string' || !invitation.id || !['arbitrator', 'tenant'].includes(String(invitation.role)) ||
      typeof invitation.token !== 'string' || !/^[a-f0-9]{64}$/.test(invitation.token)) return null;
    return invitation as { id: string; role: 'arbitrator' | 'tenant'; token: string };
  } catch { return null; }
}

export const confirmationStalled = (startedAt: number, now: number) => now - startedAt >= 90_000;
export const pollingPaused = (failures: number) => failures >= 3;
