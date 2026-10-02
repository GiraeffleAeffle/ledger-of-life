import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationStatusLabel, claimAmount, confirmationStalled, currentHomeTenancy, HOME_STAGES, homeSituation, homeStage, invitationKey, invitationPayload, invitationStatus, pollingPaused, settlementSplit } from './home-journey-logic.ts';
import type { PublicListing } from '../server/listings.ts';

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

test('cancelled tenancies never drive Home or Today while another tenancy is live', () => {
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
const homeState = { tenancyIds: [], hasCurrent: false, homeKnown: true, browsing: false };

test('each open application and landlord review remains reachable alongside other listings', () => {
  const listings = [listing('offer', null), listing('application-1', 'applicant'), listing('application-2', 'applicant'), listing('review-1', 'landlord'), listing('review-2', 'landlord')];
  const result = homeSituation({ ...homeState, listings });
  assert.deepEqual(result.applicationListings.map(l => l.id), ['application-1', 'application-2']);
  assert.deepEqual(result.reviewListings.map(l => l.id), ['review-1', 'review-2']);
  assert.equal(result.showBrowser, false);
});

test('unreadable home state never becomes a newcomer or duplicates its chosen listing', () => {
  const listings = [listing('own-home', 'chosen', 'let', 'unavailable-home'), listing('other-home', null)];
  const unknown = homeSituation({ ...homeState, listings, tenancyIds: ['unavailable-home'], homeKnown: false, browsing: true });
  assert.equal(unknown.showBrowser, false);
  assert.deepEqual(unknown.applicationListings, []);
  assert.equal(homeSituation({ ...homeState, listings: [], homeKnown: false }).showBrowser, false);
  assert.equal(homeSituation({ ...homeState, listings: [listing('offer', null)] }).showBrowser, true);
});

test('a current home hides offers until an explicit browser request', () => {
  const state = { ...homeState, listings: [listing('offer', null)], hasCurrent: true };
  assert.equal(homeSituation(state).showBrowser, false);
  assert.equal(homeSituation({ ...state, browsing: true }).showBrowser, true);
});

test('rejected and closed applications are not presented as waiting for a decision', () => {
  assert.equal(applicationStatusLabel(listing('rejected', 'applicant', 'let')), 'Not chosen');
  assert.equal(applicationStatusLabel(listing('closed', 'applicant', 'closed')), 'Listing closed');
  assert.equal(applicationStatusLabel(listing('selected', 'chosen', 'let')), 'Chosen · agreement next');
  const listings = [listing('rejected', 'applicant', 'let'), listing('pending', 'applicant'), listing('recorded', 'chosen', 'let', 'tenancy')];
  assert.deepEqual(homeSituation({ ...homeState, listings, tenancyIds: ['tenancy'] }).applicationListings.map(l => l.id), ['rejected', 'pending']);
});
