import type { TenancyAccount } from '../finance/solana/program.ts';
import { SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { agreementDigest, agreementRole, type Agreement } from './agreements.ts';
import { SolanaServiceError, type SolanaOperation } from './solana-service.ts';
import { ensurePayoutAccounts, solanaServicesFor } from './solana-tenancies.ts';
import type { Store } from './store.ts';
import { cancellationState } from './tenancy-cancellation.ts';
import { readDepositYield, type DepositYieldView } from './deposit-yield.ts';
import { RpcSolanaGateway } from './solana-rpc.ts';
import type { DepositForm } from '../domain/deposit-form.ts';
import type { ShareDepositView } from '../domain/share-deposit.ts';
import { readShareDeposit } from './share-deposit.ts';

export type JourneyRole = 'tenant' | 'landlord' | 'arbitrator';
export type JourneyStage = 'agreement' | 'space' | 'deposit' | 'living' | 'move-out' | 'paid';
export const JOURNEY_STAGES: { id: JourneyStage; label: string }[] = [
  { id: 'agreement', label: 'Agree' },
  { id: 'space', label: 'Secure' },
  { id: 'deposit', label: 'Secure' },
  { id: 'living', label: 'Live' },
  { id: 'move-out', label: 'Move out' },
  { id: 'paid', label: 'Paid out' },
];

/** Exactly one thing this person can do now, or what they are waiting for. */
export type NextAction =
  | { kind: 'invite_arbitrator' | 'create_space' | 'secure_deposit' | 'settle'; label: string; detail: string }
  | { kind: 'accept_agreement'; label: string; detail: string; digest: string }
  | { kind: 'propose_claim'; label: string; detail: string; maximumAtomic: string }
  | { kind: 'respond_claim'; label: string; detail: string; claimAtomic: string }
  | { kind: 'decide_claim'; label: string; detail: string; claimAtomic: string }
  | { kind: 'confirming'; label: string; detail: string; operationId: string | null }
  | { kind: 'paying_out' | 'wait' | 'done' | 'cancelled'; label: string; detail: string };

export interface TenancyJourney {
  agreementId: string;
  property: string;
  depositForm?: DepositForm;
  rentTerms?: Agreement['rentTerms'];
  shareDeposit?: ShareDepositView;
  home?: Agreement['home'];
  handover?: Agreement['handover'];
  role: JourneyRole;
  requiredSecurity: string;
  sampleParties?: boolean;
  cancellable?: boolean;
  cancelled?: Agreement['cancelled'];
  stage: JourneyStage;
  next: NextAction;
  chain: null | {
    phase: TenancyAccount['phase'];
    depositMint: string;
    simulatedYield?: DepositYieldView;
    escrowAtomic: string;
    lendingValueAtomic: string;
    claimAtomic: string;
    approvedClaimAtomic: string;
    tenantOwedAtomic: string;
    landlordOwedAtomic: string;
    tenantPaidAtomic: string;
    landlordPaidAtomic: string;
    /** Earnings above the required deposit the tenant may claim now (release rules of the program). */
    claimableAtomic: string;
    releasedAtomic: string;
    walletId: string;
    feePayer: string;
    walletChain: 'solana:devnet' | null;
  };
}

const usd = (atomic: string) => `${(Number(atomic) / 1e6).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} test USDC`;
const waiting = (label: string, detail: string): NextAction => ({ kind: 'wait', label, detail });
const cancelledStep = (agreement: Agreement): NextAction => ({
  kind: 'cancelled',
  label: 'Cancelled before the deposit was secured',
  detail: `Cancelled by the ${agreement.cancelled!.by} on ${agreement.cancelled!.at}. Nothing was locked.`,
});

/** Pure: agreement-level next step before any chain state exists. */
export function agreementStep(agreement: Agreement, role: JourneyRole): NextAction | null {
  if (agreement.cancelled) return cancelledStep(agreement);
  if (!agreement.parties.arbitrator)
    return role === 'landlord'
      ? { kind: 'invite_arbitrator', label: 'Invite a neutral arbitrator', detail: 'They only decide if you and the tenant disagree at move-out.' }
      : waiting('Waiting for the arbitrator', 'The landlord is inviting a neutral person for disputes.');
  const digest = agreementDigest(agreement)!;
  const accepted = (side: 'tenant' | 'landlord') => agreement.accepted[side]?.digest === digest;
  if (role !== 'arbitrator' && !accepted(role))
    return {
      kind: 'accept_agreement',
      label: 'Review the deposit agreement',
      detail: agreement.depositForm?.kind === 'shares'
        ? `${agreement.property} · USD deposit covered at 150% by test TSLA. Below 125% asks for top-up, without forced sale. Settlement in shares; silence never awards the landlord. Arbitration timeout returns shares to the tenant. Issuer can pause, block, burn or upgrade. Test tokens only; no yield or legal advice.`
        : `${agreement.property} · ${usd(agreement.requiredSecurity)} deposit · tenant keeps value above an approved deduction at settlement. ${agreement.releaseAllowed ? 'Tenant may claim surplus during the tenancy.' : 'Surplus remains locked until settlement.'} Test tokens only; site-minted tUSDC receives labelled simulated yield paid by this site.`,
      digest,
    };
  if (!accepted('tenant') || !accepted('landlord'))
    return waiting('Waiting for the other side to accept', 'Nothing moves until tenant and landlord accept the same terms.');
  return null;
}

/** Pure: next step from finalized chain state and this person's role. */
export function chainStep(
  role: JourneyRole,
  t: Pick<TenancyAccount, 'phase' | 'requiredSecurityAtomic' | 'claimAtomic' | 'tenantOwedAtomic' | 'landlordOwedAtomic'> & { depositMint?: string },
  pull: boolean,
): { stage: JourneyStage; next: NextAction } {
  // Site-minted tUSDC stays in the escrow as cash; older Circle-USDC tenancies are supplied to devnet lending.
  const cashOnly = t.depositMint === SOLANA_TEST_USDC_MINT;
  switch (t.phase) {
    case 'awaiting-funding':
      return {
        stage: 'deposit',
        next: role === 'tenant'
          ? { kind: 'secure_deposit', label: `Secure your ${usd(t.requiredSecurityAtomic)} deposit`, detail: cashOnly ? 'One approval locks the deposit in cash escrow until move-out. The site pays the tenant labelled simulated yield in test USDC.' : 'One approval locks the deposit for this home and supplies it to devnet lending. Devnet lending pays nothing, so earnings are simulated.' }
          : waiting('Waiting for the tenant’s deposit', 'The empty escrow is ready; the tenant approves the deposit.'),
      };
    case 'active':
      return {
        stage: 'living',
        next: role === 'landlord'
          ? waiting('Deposit secured · nothing needs you now', 'At move-out you can propose a deduction (including zero). The tenant must agree or the arbitrator decides. Deposit earnings belong to the tenant.')
          : role === 'tenant'
            ? waiting(cashOnly ? 'Your deposit is locked in the escrow' : 'Your deposit is secured in devnet lending', `At move-out the landlord proposes a deduction (or none); you then agree or dispute. ${cashOnly ? 'The deposit stays as cash; this site pays the tenant labelled simulated yield.' : 'Devnet lending pays nothing, so earnings are simulated.'}`)
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
          ? { kind: 'paying_out', label: 'Paying out', detail: 'Payouts go to each side’s own account while Home is open. Keep Home open; failed attempts retry here.' }
          : { kind: 'done', label: 'All paid out', detail: 'This tenancy is closed.' },
      };
    }
  }
}

export function operationStep(
  next: NextAction,
  operations: Pick<SolanaOperation, 'id' | 'walletId' | 'signature' | 'state' | 'nonce'>[],
  walletId: string,
  nonce: string,
): NextAction {
  const own = operations.filter((op) => op.walletId === walletId);
  const pending = own.find((op) => op.signature && ['signed', 'broadcast', 'unknown'].includes(op.state));
  if (pending)
    return { kind: 'confirming', label: 'Waiting for network confirmation', detail: 'Your approval was sent. Check again if it takes longer than usual.', operationId: pending.id };
  const latest = own.findLast((op) => op.nonce === nonce);
  return latest?.state === 'expired' && latest.signature
    ? { ...next, detail: 'The network did not include this approval before it expired, so it can no longer take effect. Approve again.' }
    : next;
}

export async function tenancyJourney(
  store: Store,
  identity: VerifiedIdentity,
  agreement: Agreement,
  resolveServices: typeof solanaServicesFor = solanaServicesFor,
  readShares: typeof readShareDeposit = readShareDeposit,
): Promise<TenancyJourney> {
  const role = agreementRole(agreement, identity);
  const base = { agreementId: agreement.id, property: agreement.property, role, depositForm: agreement.depositForm, rentTerms: agreement.rentTerms, requiredSecurity: agreement.requiredSecurity, chain: null,
    home: agreement.home, handover: agreement.handover, cancelled: agreement.cancelled, cancellable: false,
    sampleParties: Object.values(agreement.parties).some((party) => party?.subject.startsWith('test-signer:')) };
  if (agreement.depositForm?.kind === 'shares') {
    const shareDeposit = await readShares(store, identity, agreement.id);
    const shareBase = { ...base, depositForm: agreement.depositForm, shareDeposit };
    const early = agreementStep(agreement, role);
    if (early) return { ...shareBase, stage: 'agreement', next: early };
    if (shareDeposit.deployment === 'not_deployed') return { ...shareBase, stage: 'space', next: waiting('Share deposit not deployed yet', 'The reviewed factory is not deployed. No transaction is available.') };
    if (!shareDeposit.escrow) return { ...shareBase, stage: 'space', next: role === 'landlord' ? { kind: 'create_space', label: 'Prepare the share escrow', detail: 'Create the empty escrow bound to these accepted terms.' } : waiting('Waiting for the landlord', 'The landlord creates the accepted share escrow.') };
    if (shareDeposit.state === 'AwaitingLock') return { ...shareBase, stage: 'deposit', next: role === 'tenant' ? { kind: 'secure_deposit', label: 'Lock test TSLA for your deposit', detail: 'Approve exactly the reviewed shares, then pledge. Activation needs 150% cover.' } : waiting('Waiting for the tenant', 'The tenant locks test TSLA at 150% cover.') };
    if (shareDeposit.state === 'Closed') return { ...shareBase, stage: shareDeposit.paidOut ? 'paid' : 'move-out', next: shareDeposit.paidOut ? { kind: 'done', label: 'Deposit paid out', detail: 'The payout receipt is confirmed, the escrow is closed and actual custody is empty.' } : { kind: 'settle', label: 'Collect the share payout', detail: 'Landlord award has priority; tenant collects the remainder. Payout sides are independent.' } };
    if (shareDeposit.state === 'ClaimPending' || shareDeposit.state === 'ClaimContested' || shareDeposit.returnDeadline)
      return { ...shareBase, stage: 'move-out', next: waiting('Move-out share settlement', 'Review the available claim, arbitration and timeout actions below. Silence is not consent.') };
    return { ...shareBase, stage: 'living', next: role === 'landlord' ? { kind: 'propose_claim', label: 'Prepare the move-out deduction', detail: 'Record the move-out inspection first. The USD claim is converted once to shares.', maximumAtomic: agreement.requiredSecurity } : waiting(shareDeposit.needsTopUp ? 'Please top up your share deposit' : 'Your share deposit is locked', 'Test TSLA is locked in the deposit, not spendable or loan collateral. The tenant may request its return at move-out.') };
  }
  const cancelledState = agreement.cancelled
    ? await cancellationState(store, identity, agreement, resolveServices)
    : null;
  if (agreement.cancelled && (cancelledState!.phase === null || cancelledState!.phase === 'awaiting-funding'))
    return { ...base, stage: 'agreement', next: cancelledStep(agreement) };
  const early = agreementStep({ ...agreement, cancelled: undefined }, role);
  if (early) return { ...base, cancellable: !agreement.cancelled && role !== 'arbitrator', stage: 'agreement', next: early };
  const services = await resolveServices(store, agreement.id);
  if (!services)
    return { ...base, stage: 'space', next: waiting('Deposit service not configured', 'The operator must configure the reviewed devnet deployment and fee sponsor.') };
  const setup = (await services.initialization.status(identity)).initialization;
  if (setup?.state !== 'finalized' && !(agreement.cancelled && cancelledState?.phase && cancelledState.phase !== 'awaiting-funding')) {
    const pending = setup && ['signed', 'broadcast', 'unknown'].includes(setup.state);
    return {
      ...base,
      cancellable: !agreement.cancelled && role !== 'arbitrator' && !pending,
      stage: 'space',
      next: pending
        ? { kind: 'confirming', label: 'Preparing the escrow…', detail: 'Waiting for final confirmation on the network.', operationId: null }
        : role === 'landlord'
          ? { kind: 'create_space', label: 'Prepare the empty escrow', detail: 'One approval creates the empty escrow. It holds no security until the tenant funds it.' }
          : waiting('Waiting for the landlord', 'The landlord prepares the empty escrow for these terms.'),
    };
  }
  let snapshot;
  try {
    snapshot = await services.service.snapshot(identity);
  } catch (error) {
    if (error instanceof SolanaServiceError && error.code === 'identity_expired')
      return { ...base, stage: 'space', next: waiting('Sign in again', 'Your session expired. Sign in with your passkey to continue.') };
    throw error;
  }
  const t = snapshot.tenancy;
  const { stage, next } = chainStep(role, t, services.config.escrowVersion === 'pull-v2');
  const paid = (landlord: boolean) =>
    snapshot.operations
      .filter((op) => op.state === 'finalized' && op.action.kind === 'payout' && op.action.landlord === landlord)
      .reduce((sum, op) => sum + BigInt(op.expectedDeltas.find((delta) => delta.direction === 'credit')?.minimumAtomic ?? '0'), 0n)
      .toString();
  const yieldGateway = new RpcSolanaGateway(services.config);
  const simulatedYield = await readDepositYield(store, agreement, t, snapshot.operations, yieldGateway.rpc.bind(yieldGateway));
  const result: TenancyJourney = {
    ...base,
    cancellable: !agreement.cancelled && role !== 'arbitrator' && t.phase === 'awaiting-funding' &&
      !snapshot.operations.some((op) => (op.action.kind === 'fund' || op.action.kind === 'fund_and_supply') &&
        ['signed', 'broadcast', 'unknown'].includes(op.state)),
    stage,
    next: operationStep(next, snapshot.operations, snapshot.walletId, t.nextNonce),
    chain: {
      phase: t.phase,
      depositMint: t.depositMint,
      simulatedYield,
      escrowAtomic: t.accountedIdleAtomic,
      lendingValueAtomic: snapshot.receiptValueAtomic,
      claimAtomic: t.claimAtomic,
      approvedClaimAtomic: t.approvedClaimAtomic,
      tenantOwedAtomic: t.tenantOwedAtomic,
      landlordOwedAtomic: t.landlordOwedAtomic,
      tenantPaidAtomic: paid(false),
      landlordPaidAtomic: paid(true),
      claimableAtomic: (() => {
        if (!t.releasePermitted || t.phase !== 'active' || t.depositMint === SOLANA_TEST_USDC_MINT) return '0';
        const idle = BigInt(t.accountedIdleAtomic);
        const surplus = idle + BigInt(snapshot.receiptValueAtomic) - BigInt(t.requiredSecurityAtomic);
        return (surplus <= 0n ? 0n : surplus < idle ? surplus : idle).toString();
      })(),
      releasedAtomic: t.releasedEarningsAtomic,
      walletId: snapshot.walletId,
      feePayer: snapshot.feePayer,
      walletChain: snapshot.walletChain === 'solana:devnet' ? 'solana:devnet' : null,
    },
  };
  return result;
}

/** Only cash tenancies authorize operator-sponsored Solana account creation or payouts. */
export async function advanceTenancyJourney(
  store: Store,
  identity: VerifiedIdentity,
  agreement: Agreement,
  dependencies: {
    read?: typeof tenancyJourney;
    accounts?: typeof ensurePayoutAccounts;
    services?: typeof solanaServicesFor;
  } = {},
) {
  const read = dependencies.read ?? tenancyJourney;
  const before = await read(store, identity, agreement);
  if (agreement.depositForm?.kind === 'shares') return { payout: null, journey: before };
  let payout = null;
  if (before.next.kind === 'create_space') await (dependencies.accounts ?? ensurePayoutAccounts)(store, agreement.id);
  if (before.next.kind === 'paying_out') {
    const services = await (dependencies.services ?? solanaServicesFor)(store, agreement.id);
    if (!services) throw new SolanaServiceError(503, 'solana_unavailable', 'The deposit service is not configured.');
    payout = await services.service.payout(identity);
  }
  return { payout, journey: await read(store, identity, agreement) };
}

export async function myTenancies(store: Store, identity: VerifiedIdentity) {
  const rows = await store.scan<Agreement>('agreement:', '', 200);
  return rows
    .map((row) => row.value)
    .filter((agreement) => (agreement.network === 'solana' || agreement.depositForm?.kind === 'shares') && Object.values(agreement.parties).some((party) => party?.subject === identity.subject))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
