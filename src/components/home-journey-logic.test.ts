import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationStatusLabel, claimAmount, confirmationStalled, currentHomeTenancy, HOME_STAGES, homeSituation, homeStage, invitationKey, invitationPayload, invitationStatus, pollingPaused, recoverExpiredRentReview, settlementSplit, tenancyNeedsPerson } from './home-journey-logic.ts';
import type { PublicListing } from '../server/listings.ts';
import { prepareEmptyEscrowReview, signEmptyEscrowReview } from './home-journey-logic.ts';
import type { SolanaInitializationView } from '../server/solana-initialization.ts';

test('empty escrow preparation cannot sign; signing requires the explicitly prepared unexpired review', async () => {
  const review: SolanaInitializationView = {
    setupMode: 'staged', agreementId: 'listing-review', tenancyAddress: 'escrow', escrowProgram: 'program',
    policyHash: 'digest', leaseIdHex: 'lease', tenantDestination: 'tenant-token', landlordDestination: 'landlord-token',
    tenant: 'tenant', landlord: 'landlord', arbitrator: 'arbitrator', requiredSecurityAtomic: '1300000000',
    depositMint: 'mint', releasePermitted: true, state: 'prepared', transactionBase64: 'unsigned',
    messageSha256: 'message', expiresAt: new Date(Date.now() + 90000).toISOString(), lastValidBlockHeight: '123',
    signature: null, simulation: { slot: '100', sponsorDebitCeilingLamports: '2000000', networkFeeLamports: '10000' },
    lastError: null, receipt: null, signedRoles: [], role: 'landlord', walletId: 'wallet',
    feePayer: 'sponsor', cluster: 'devnet', walletChain: 'solana:devnet',
  };
  const calls: { path: string; body: unknown }[] = [];
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    calls.push({ path, body });
    return { initialization: review } as T;
  };
  let signatures = 0;
  const sign = async (input: SolanaInitializationView) => { assert.equal(input, review); signatures++; return 'exact-signed-message'; };
  const prepared = await prepareEmptyEscrowReview(request, review.agreementId);
  assert.equal(prepared, review);
  assert.equal(signatures, 0);
  assert.deepEqual(calls.map(call => call.body), [{ action: 'advance', agreementId: review.agreementId }, { action: 'prepare' }]);
  await assert.rejects(signEmptyEscrowReview(null, request, sign), /Prepare and review/);
  await assert.rejects(signEmptyEscrowReview({ ...review, expiresAt: new Date(0).toISOString() }, request, sign), /expired/);
  assert.equal(signatures, 0);
  await signEmptyEscrowReview(prepared, request, sign);
  assert.equal(signatures, 1);
  assert.deepEqual(calls.at(-1)?.body, { action: 'sign', signedTxBase64: 'exact-signed-message' });
});

test('share attention separates living top-ups from voluntary actions and move-out deadlines', () => {
  const living = { stage: 'living', next: { kind: 'wait' }, depositForm: { kind: 'shares' }, shareDeposit: { needsTopUp: false, actions: ['requestReturn', 'withdraw'] } };
  assert.equal(tenancyNeedsPerson(living), false);
  assert.equal(tenancyNeedsPerson({ ...living, next: { kind: 'propose_claim' }, shareDeposit: { needsTopUp: false, actions: ['proposeClaim'] } }), false);
  assert.equal(tenancyNeedsPerson({ ...living, shareDeposit: { ...living.shareDeposit, needsTopUp: true } }), true);
  assert.equal(tenancyNeedsPerson({ ...living, next: { kind: 'propose_claim' }, shareDeposit: { needsTopUp: true, actions: ['proposeClaim'] } }), false);
  assert.equal(tenancyNeedsPerson({ ...living, stage: 'move-out', shareDeposit: { needsTopUp: false, actions: ['approve', 'pledge', 'acceptClaim'] } }), true);
  assert.equal(tenancyNeedsPerson({ ...living, stage: 'move-out', shareDeposit: { needsTopUp: false, actions: ['approve', 'pledge'] } }), false);
  assert.equal(tenancyNeedsPerson({ ...living, stage: 'move-out', shareDeposit: { needsTopUp: false, actions: ['lowerClaim'] } }), false);
  assert.equal(tenancyNeedsPerson({ ...living, stage: 'move-out', shareDeposit: { needsTopUp: false, actions: ['approve', 'pledge', 'withdraw', 'requestReturn'] } }), false);
  assert.equal(tenancyNeedsPerson({ ...living, stage: 'deposit', shareDeposit: { needsTopUp: false, actions: ['approve', 'pledge'] } }), true);
});

test('cash setup requires its person while automatic confirmation and payout remain passive', () => {
  for (const kind of ['accept_agreement', 'create_space', 'secure_deposit', 'respond_claim', 'decide_claim']) {
    assert.equal(tenancyNeedsPerson({ stage: 'agreement', next: { kind } }), true);
  }
  for (const kind of ['wait', 'confirming', 'paying_out', 'done', 'cancelled', 'propose_claim']) {
    assert.equal(tenancyNeedsPerson({ stage: 'living', next: { kind } }), false);
  }
});

test('claim respects the full deposit and six-decimal atomic precision', () => {
  assert.equal(claimAmount('0,50', '1000001'), '500000');
  assert.equal(claimAmount('1.000001', '1000001'), '1000001');
  assert.equal(claimAmount('0', '1000001'), '0');
  assert.throws(() => claimAmount('1.000002', '1000001'), /maximum/);
  assert.throws(() => claimAmount('0.0000001', '1000001'), /six decimal/);
});

test('settlement preview preserves the deposit including a zero claim', () => {
  assert.deepEqual(settlementSplit('1000001', '500001'), { tenantAtomic: '500000', landlordAtomic: '500001' });
  assert.deepEqual(settlementSplit('1000001', '0'), { tenantAtomic: '1000001', landlordAtomic: '0' });
  assert.throws(() => settlementSplit('1000001', '1000002'), /deposit/);
});

test('invitation is scoped to account and agreement and expires at exactly 24 hours', () => {
  assert.notEqual(invitationKey('alice', 'home'), invitationKey('bob', 'home'));
  assert.notEqual(invitationKey('alice', 'home'), invitationKey('alice', 'other'));
  assert.equal(invitationStatus(1000, 1000 + 86_400_000 - 1), 'valid');
  assert.equal(invitationStatus(1000, 1000 + 86_400_000), 'expired');
  assert.equal(invitationPayload('{'), null);
  assert.deepEqual(invitationPayload(JSON.stringify({ id: 'home', role: 'arbitrator', token: 'a'.repeat(64) })),
    { id: 'home', role: 'arbitrator', token: 'a'.repeat(64) });
});

test('waiting thresholds surface persistent failures and stalled confirmation', () => {
  assert.equal(pollingPaused(2), false);
  assert.equal(pollingPaused(3), true);
  assert.equal(confirmationStalled(0, 89_999), false);
  assert.equal(confirmationStalled(0, 90_000), true);
});

test('Home progress keeps prepare and fund in Secure without skipping move-out or payout', () => {
  assert.equal(homeStage('agreement'), 2);
  assert.equal(homeStage('space'), 3);
  assert.equal(homeStage('deposit'), 3);
  assert.equal(homeStage('living'), 4);
  assert.equal(homeStage('move-out'), 5);
  assert.equal(homeStage('paid'), HOME_STAGES.length - 1);
});

test('listing progress distinguishes a pending application from a chosen or ended application', () => {
  assert.equal(homeStage(undefined, { relation: null, status: 'open' }), 0);
  assert.equal(homeStage(undefined, { relation: 'applicant', status: 'open' }), 1);
  assert.equal(homeStage(undefined, { relation: 'landlord', status: 'open' }), 1);
  assert.equal(homeStage(undefined, { relation: 'chosen', status: 'let' }), 2);
  assert.equal(homeStage(undefined, { relation: 'applicant', status: 'closed' }), 0);
  assert.equal(homeStage('living', { relation: 'applicant', status: 'open' }), 4);
});

test('cancelled tenancies never drive Home while another tenancy is live', () => {
  const cancelled = { stage: 'agreement', next: { kind: 'cancelled' } };
  const living = { stage: 'living', next: { kind: 'wait' } };
  const accepting = { stage: 'agreement', next: { kind: 'accept_agreement' } };
  assert.equal(currentHomeTenancy([cancelled]), undefined);
  assert.equal(currentHomeTenancy([cancelled, living]), living);
  assert.equal(currentHomeTenancy([cancelled, living, accepting]), accepting);
  assert.equal(currentHomeTenancy([{ stage: 'paid', next: { kind: 'done' } }, cancelled]), undefined);
});

const listing = (id: string, relation: PublicListing['relation'], status: PublicListing['status'] = 'open', agreementId: string | null = null) => ({
  id, relation, status, agreementId, applications: [{ id: `${id}-application`, name: 'Applicant', message: '', at: '2026-10-02T00:00:00Z' }],
});
const homeState = { tenancyIds: [], hasCurrent: false, homeKnown: true };

test('each open application and landlord review remains reachable alongside other listings', () => {
  const listings = [listing('offer', null), listing('application-1', 'applicant'), listing('application-2', 'applicant'), listing('review-1', 'landlord'), listing('review-2', 'landlord')];
  const result = homeSituation({ ...homeState, listings });
  assert.deepEqual(result.applicationListings.map(l => l.id), ['application-1', 'application-2']);
  assert.deepEqual(result.reviewListings.map(l => l.id), ['review-1', 'review-2']);
  assert.equal(result.showBrowser, false);
});

test('unreadable home state never becomes a newcomer or duplicates its chosen listing', () => {
  const listings = [listing('own-home', 'chosen', 'let', 'unavailable-home'), listing('other-home', null)];
  const unknown = homeSituation({ ...homeState, listings, tenancyIds: ['unavailable-home'], homeKnown: false });
  assert.equal(unknown.showBrowser, false);
  assert.deepEqual(unknown.applicationListings, []);
  assert.equal(homeSituation({ ...homeState, listings: [], homeKnown: false }).showBrowser, false);
  assert.equal(homeSituation({ ...homeState, listings: [listing('offer', null)] }).showBrowser, true);
});

test('a current home keeps available offers behind the browser row', () => {
  const state = { ...homeState, listings: [listing('offer', null)], hasCurrent: true };
  assert.equal(homeSituation(state).showBrowser, false);
});

test('rejected and closed applications are not presented as waiting for a decision', () => {
  assert.equal(applicationStatusLabel(listing('rejected', 'applicant', 'let')), 'Not chosen');
  assert.equal(applicationStatusLabel(listing('closed', 'applicant', 'closed')), 'Listing closed');
  assert.equal(applicationStatusLabel(listing('selected', 'chosen', 'let')), 'Chosen · agreement next');
  const listings = [listing('rejected', 'applicant', 'let'), listing('pending', 'applicant'), listing('recorded', 'chosen', 'let', 'tenancy')];
  assert.deepEqual(homeSituation({ ...homeState, listings, tenancyIds: ['tenancy'] }).applicationListings.map(l => l.id), ['rejected', 'pending']);
});

test('rent expiry discards stale signed state before preparing a fresh review; ambiguous failures retain bytes', async () => {
  let signed: string | null = '0x02abcd';
  let review: string | null = null;
  const expired = Object.assign(new Error('The rent review expired before signing.'), { status: 409 });
  assert.equal(await recoverExpiredRentReview(expired, () => { signed = null; }, async () => {
    assert.equal(signed, null);
    review = 'fresh exact transfer';
  }), true);
  assert.equal(signed, null);
  assert.equal(review, 'fresh exact transfer');
  signed = '0x02abcd';
  for (const reason of [new Error('Network response lost'), Object.assign(new Error('Only identical bytes may be retried.'), { status: 409 })]) {
    assert.equal(await recoverExpiredRentReview(reason, () => { signed = null; }, async () => { review = 'unexpected'; }), false);
    assert.equal(signed, '0x02abcd');
    assert.equal(review, 'fresh exact transfer');
  }
  await assert.rejects(recoverExpiredRentReview(expired, () => { signed = null; }, async () => { throw new Error('Refresh unavailable'); }), /Refresh unavailable/);
  assert.equal(signed, null);
});
