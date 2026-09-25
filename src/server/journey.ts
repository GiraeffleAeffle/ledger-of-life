import type { TenancyAccount } from '../finance/solana/program.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { agreementDigest, agreementRole, type Agreement } from './agreements.ts';
import { RecoveryError } from './recovery.ts';
import { SolanaServiceError, type SolanaOperation } from './solana-service.ts';
import { solanaServicesFor } from './solana-tenancies.ts';
import type { Store } from './store.ts';

export type JourneyRole = 'tenant' | 'landlord' | 'arbitrator';
export type JourneyStage = 'agreement' | 'space' | 'deposit' | 'living' | 'move-out' | 'paid';
export const JOURNEY_STAGES: { id: JourneyStage; label: string }[] = [
  { id: 'agreement', label: 'Agreement' },
  { id: 'space', label: 'Deposit space' },
  { id: 'deposit', label: 'Deposit secured' },
  { id: 'living', label: 'Living here' },
  { id: 'move-out', label: 'Move-out' },
  { id: 'paid', label: 'Paid out' },
];

/** Exactly one thing this person can do now, or what they are waiting for. */
export type NextAction =
  | { kind: 'invite_arbitrator' | 'create_space' | 'secure_deposit' | 'settle' | 'finish_setup'; label: string; detail: string }
  | { kind: 'accept_agreement'; label: string; detail: string; digest: string }
  | { kind: 'propose_claim'; label: string; detail: string; maximumAtomic: string }
  | { kind: 'respond_claim'; label: string; detail: string; claimAtomic: string }
  | { kind: 'decide_claim'; label: string; detail: string; claimAtomic: string }
  | { kind: 'confirming'; label: string; detail: string; operationId: string | null }
  | { kind: 'paying_out' | 'wait' | 'done'; label: string; detail: string };

export interface TenancyJourney {
  agreementId: string;
  property: string;
  role: JourneyRole;
  requiredSecurity: string;
  stage: JourneyStage;
  next: NextAction;
  chain: null | {
    phase: TenancyAccount['phase'];
    escrowAtomic: string;
    lendingValueAtomic: string;
    claimAtomic: string;
    approvedClaimAtomic: string;
    tenantOwedAtomic: string;
    landlordOwedAtomic: string;
    tenantPaidAtomic: string;
    landlordPaidAtomic: string;
    walletId: string;
    feePayer: string;
    walletChain: 'solana:devnet' | null;
  };
}

const usd = (atomic: string) => (Number(atomic) / 1e6).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const waiting = (label: string, detail: string): NextAction => ({ kind: 'wait', label, detail });

/** Pure: agreement-level next step before any chain state exists. */
export function agreementStep(agreement: Agreement, role: JourneyRole): NextAction | null {
  if (!agreement.parties.arbitrator)
    return role === 'landlord'
      ? { kind: 'invite_arbitrator', label: 'Invite a neutral arbitrator', detail: 'They only decide if you and the tenant disagree at move-out.' }
      : waiting('Waiting for the arbitrator', 'The landlord is inviting a neutral person for disputes.');
  const digest = agreementDigest(agreement)!;
  const accepted = (side: 'tenant' | 'landlord') => agreement.accepted[side]?.digest === digest;
  if (role !== 'arbitrator' && !accepted(role))
    return {
      kind: 'accept_agreement',
      label: 'Review and accept the agreement',
      detail: `${agreement.property} · ${usd(agreement.requiredSecurity)} deposit${agreement.releaseAllowed ? ' · earnings above the deposit go to the tenant' : ''}`,
      digest,
    };
  if (!accepted('tenant') || !accepted('landlord'))
    return waiting('Waiting for the other side to accept', 'Nothing moves until tenant and landlord accept the same terms.');
  return null;
}

/** Pure: next step from finalized chain state and this person's role. */
export function chainStep(
  role: JourneyRole,
  t: Pick<TenancyAccount, 'phase' | 'requiredSecurityAtomic' | 'claimAtomic' | 'tenantOwedAtomic' | 'landlordOwedAtomic'>,
  pull: boolean,
): { stage: JourneyStage; next: NextAction } {
  switch (t.phase) {
    case 'awaiting-funding':
      return {
        stage: 'deposit',
        next: role === 'tenant'
          ? { kind: 'secure_deposit', label: `Secure your ${usd(t.requiredSecurityAtomic)} deposit`, detail: 'One approval: the deposit is locked for this home and starts earning in lending.' }
          : waiting('Waiting for the tenant’s deposit', 'The deposit space is ready; the tenant approves the deposit.'),
      };
    case 'active':
      return {
        stage: 'living',
        next: role === 'landlord'
          ? { kind: 'propose_claim', label: 'Tenancy ended? Start the move-out', detail: 'Enter any deduction (0 if none) with a reason. The tenant must agree or the arbitrator decides.', maximumAtomic: t.requiredSecurityAtomic }
          : role === 'tenant'
            ? waiting('Your deposit is secured and earning', 'At move-out the landlord proposes a deduction (or none); you then agree or dispute.')
            : waiting('Nothing to decide', 'You are only needed if tenant and landlord disagree.'),
      };
    case 'claim-proposed':
      return {
        stage: 'move-out',
        next: role === 'tenant'
          ? { kind: 'respond_claim', label: `Landlord asks for ${usd(t.claimAtomic)}`, detail: pull ? 'Agree to settle now in one approval, or dispute it for the arbitrator.' : 'Agree or dispute.', claimAtomic: t.claimAtomic }
          : waiting('Waiting for the tenant’s answer', `Proposed deduction: ${usd(t.claimAtomic)}.`),
      };
    case 'disputed':
      return {
        stage: 'move-out',
        next: role === 'arbitrator'
          ? { kind: 'decide_claim', label: 'Decide the disputed deduction', detail: `The landlord asked for ${usd(t.claimAtomic)}. Choose an amount up to that, with a reason.`, claimAtomic: t.claimAtomic }
          : waiting('Waiting for the arbitrator', 'The disputed deduction is with the neutral arbitrator.'),
      };
    case 'settling':
      return {
        stage: 'move-out',
        next: role === 'arbitrator'
          ? waiting('Settlement pending', 'Tenant or landlord completes the settlement.')
          : { kind: 'settle', label: 'Complete the settlement', detail: 'One approval returns the deposit from lending and fixes each side’s payout.' },
      };
    case 'closed': {
      const owed = BigInt(t.tenantOwedAtomic) + BigInt(t.landlordOwedAtomic);
      return {
        stage: 'paid',
        next: owed > 0n
          ? { kind: 'paying_out', label: 'Paying out', detail: 'Payouts are sent automatically to each side’s own account.' }
          : { kind: 'done', label: 'All paid out', detail: 'This tenancy is closed.' },
      };
    }
  }
}

function pendingFor(operations: Omit<SolanaOperation, 'signedTxBase64' | 'subject' | 'fingerprint'>[], walletId: string) {
  return operations.find((op) => op.walletId === walletId && op.signature && ['signed', 'broadcast', 'unknown'].includes(op.state));
}

export async function tenancyJourney(
  store: Store,
  identity: VerifiedIdentity,
  agreement: Agreement,
  resolveServices: typeof solanaServicesFor = solanaServicesFor,
): Promise<TenancyJourney> {
  const role = agreementRole(agreement, identity);
  const base = { agreementId: agreement.id, property: agreement.property, role, requiredSecurity: agreement.requiredSecurity, chain: null };
  const early = agreementStep(agreement, role);
  if (early) return { ...base, stage: 'agreement', next: early };
  const services = await resolveServices(store, agreement.id);
  if (!services)
    return { ...base, stage: 'space', next: waiting('Deposit service not configured', 'The operator must configure the reviewed devnet deployment and fee sponsor.') };
  const setup = (await services.initialization.status(identity)).initialization;
  if (setup?.state !== 'finalized') {
    const pending = setup && setup.signature && ['signed', 'broadcast', 'unknown'].includes(setup.state);
    return {
      ...base,
      stage: 'space',
      next: pending
        ? { kind: 'confirming', label: 'Creating the deposit space…', detail: 'Waiting for final confirmation on the network.', operationId: null }
        : role === 'landlord'
          ? { kind: 'create_space', label: 'Create the deposit space', detail: 'One approval. It holds no money until the tenant deposits.' }
          : waiting('Waiting for the landlord', 'The landlord creates the deposit space for these terms.'),
    };
  }
  let snapshot;
  try {
    snapshot = await services.service.snapshot(identity);
  } catch (error) {
    if (error instanceof RecoveryError || (error instanceof SolanaServiceError && error.code === 'identity_expired'))
      return { ...base, stage: 'space', next: { kind: 'finish_setup', label: 'Confirm your account recovery', detail: 'A one-time check that your backup login controls the same wallet. Open Connections to finish it.' } };
    throw error;
  }
  const t = snapshot.tenancy;
  const { stage, next } = chainStep(role, t, services.config.escrowVersion === 'pull-v2');
  const pending = pendingFor(snapshot.operations, snapshot.walletId);
  const paid = (landlord: boolean) =>
    snapshot.operations
      .filter((op) => op.state === 'finalized' && op.action.kind === 'payout' && op.action.landlord === landlord)
      .reduce((sum, op) => sum + BigInt(op.expectedDeltas.find((delta) => delta.direction === 'credit')?.minimumAtomic ?? '0'), 0n)
      .toString();
  return {
    ...base,
    stage,
    next: pending ? { kind: 'confirming', label: 'Confirming on the network…', detail: 'Your approval was sent. This usually takes a few seconds.', operationId: pending.id } : next,
    chain: {
      phase: t.phase,
      escrowAtomic: t.accountedIdleAtomic,
      lendingValueAtomic: snapshot.receiptValueAtomic,
      claimAtomic: t.claimAtomic,
      approvedClaimAtomic: t.approvedClaimAtomic,
      tenantOwedAtomic: t.tenantOwedAtomic,
      landlordOwedAtomic: t.landlordOwedAtomic,
      tenantPaidAtomic: paid(false),
      landlordPaidAtomic: paid(true),
      walletId: snapshot.walletId,
      feePayer: snapshot.feePayer,
      walletChain: snapshot.walletChain === 'solana:devnet' ? 'solana:devnet' : null,
    },
  };
}

export async function myTenancies(store: Store, identity: VerifiedIdentity) {
  const rows = await store.scan<Agreement>('agreement:', '', 200);
  return rows
    .map((row) => row.value)
    .filter((agreement) => agreement.network === 'solana' && Object.values(agreement.parties).some((party) => party?.subject === identity.subject))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
