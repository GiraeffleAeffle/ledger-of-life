import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalStore } from './store.ts';
import { agreementDigest, type Agreement } from './agreements.ts';
import { applyToListing, chooseApplicant, createListing, listListings } from './listings.ts';
import { agreementStep, chainStep } from './journey.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';

const person = (name: string): VerifiedIdentity => ({
  subject: `did:test:${name}`,
  sessionId: 's',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  wallets: [{ id: `w-${name}`, address: `${name.padEnd(32, '1').slice(0, 32)}Wallet1111`, chainType: 'solana' }],
  passkeyCount: 1,
  backupLoginLinked: true,
});

test('choosing an applicant creates an agreement binding landlord and that applicant only', async () => {
  const store = new LocalStore(':memory:');
  const [landlord, alice, bob] = ['landlord', 'alice', 'bob'].map(person);
  const listing = await createListing(store, landlord, {
    title: 'Lindenstraße 12, 2 rooms', description: '', rentMonthly: '900000000', requiredSecurity: '2700000000', releaseAllowed: true,
  });
  await assert.rejects(applyToListing(store, landlord, listing.id, { name: 'Me', message: 'my own flat please' }), /own listing/);
  await applyToListing(store, alice, listing.id, { name: 'Alice', message: 'Quiet, employed, two cats.' });
  const bobView = await applyToListing(store, bob, listing.id, { name: 'Bob', message: 'Student, references attached.' });
  assert.equal(bobView.applications, undefined, 'applicants never see each other');
  await assert.rejects(applyToListing(store, bob, listing.id, { name: 'Bob', message: 'Second try at this.' }), /already applied/);
  const landlordView = (await listListings(store, landlord)).find((item) => item.id === listing.id)!;
  assert.equal(landlordView.applications?.length, 2);
  await assert.rejects(chooseApplicant(store, alice, listing.id, landlordView.applications![0].id), /Only the landlord/);
  const chosen = await chooseApplicant(store, landlord, listing.id, landlordView.applications!.find((a) => a.name === 'Alice')!.id);
  const agreement = (await store.get<Agreement>(`agreement:${chosen.agreementId}`))!;
  assert.equal(agreement.parties.landlord?.subject, landlord.subject);
  assert.equal(agreement.parties.tenant?.subject, alice.subject);
  assert.equal(agreement.requiredSecurity, '2700000000');
  assert.equal((await listListings(store, alice)).find((item) => item.id === listing.id)?.relation, 'chosen');
  const bobAfter = (await listListings(store, bob)).find((item) => item.id === listing.id)!;
  assert.deepEqual([bobAfter.status, bobAfter.relation, bobAfter.agreementId], ['let', 'applicant', null]);
  assert.equal((await listListings(store, person('dave'))).find((item) => item.id === listing.id), undefined);
  await assert.rejects(applyToListing(store, person('carol'), listing.id, { name: 'Carol', message: 'Too late perhaps?' }), /no longer available/);
  await store.close();
});

test('concurrent choices leave one agreement and retrying the winner is idempotent', async () => {
  const store = new LocalStore(':memory:');
  try {
    const [landlord, alice, bob] = ['landlord', 'alice', 'bob'].map(person);
    const listing = await createListing(store, landlord, {
      title: 'Lindenstraße 12, 2 rooms', rentMonthly: '900000000', requiredSecurity: '2700000000', releaseAllowed: true,
    });
    await applyToListing(store, alice, listing.id, { name: 'Alice', message: 'Quiet, employed, two cats.' });
    await applyToListing(store, bob, listing.id, { name: 'Bob', message: 'Student, references attached.' });
    const applications = (await listListings(store, landlord)).find((item) => item.id === listing.id)!.applications!;
    const aliceId = applications.find((item) => item.name === 'Alice')!.id;
    const bobId = applications.find((item) => item.name === 'Bob')!.id;
    const results = await Promise.allSettled([
      chooseApplicant(store, landlord, listing.id, aliceId),
      chooseApplicant(store, landlord, listing.id, bobId),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.match(String(losers[0].reason), /already chosen/);
    const agreementId = winners[0].value.agreementId!;
    const chosenId = winners[0] === results[0] ? aliceId : bobId;
    assert.equal((await chooseApplicant(store, landlord, listing.id, chosenId)).agreementId, agreementId);
    const agreements = await store.scan<Agreement>('agreement:');
    assert.deepEqual(agreements.map((row) => row.value.id), [agreementId]);
    assert.equal(agreements[0].value.parties.tenant?.subject, chosenId === aliceId ? alice.subject : bob.subject);
  } finally {
    await store.close();
  }
});

test('agreement steps: arbitrator first, then each side accepts the same digest', () => {
  const party = (name: string) => ({ subject: name, wallet: { id: name, address: name, chainType: 'solana' as const } });
  const agreement: Agreement = {
    id: 'a', network: 'solana', property: 'Flat', requiredSecurity: '1000000', releaseAllowed: true, createdAt: '', revision: 0,
    parties: { landlord: party('l'), tenant: party('t') }, invitations: {}, accepted: {}, records: [],
  };
  assert.equal(agreementStep(agreement, 'landlord')?.kind, 'invite_arbitrator');
  assert.equal(agreementStep(agreement, 'tenant')?.kind, 'wait');
  agreement.parties.arbitrator = party('x');
  assert.equal(agreementStep(agreement, 'tenant')?.kind, 'accept_agreement');
  agreement.accepted.tenant = { digest: agreementDigest(agreement)!, at: '' };
  assert.equal(agreementStep(agreement, 'tenant')?.kind, 'wait');
  agreement.accepted.landlord = { digest: agreementDigest(agreement)!, at: '' };
  assert.equal(agreementStep(agreement, 'landlord'), null);
});

test('chain steps give exactly one actor the move each phase', () => {
  const t = (phase: string, owed = '0') => ({
    phase, requiredSecurityAtomic: '1000000', claimAtomic: '200000', tenantOwedAtomic: owed, landlordOwedAtomic: '0',
  }) as Parameters<typeof chainStep>[1];
  const actors = (phase: string, owed?: string) =>
    (['tenant', 'landlord', 'arbitrator'] as const).filter((role) => !['wait', 'done', 'paying_out'].includes(chainStep(role, t(phase, owed), true).next.kind));
  assert.deepEqual(actors('awaiting-funding'), ['tenant']);
  assert.deepEqual(actors('active'), ['landlord']);
  assert.deepEqual(actors('claim-proposed'), ['tenant']);
  assert.deepEqual(actors('disputed'), ['arbitrator']);
  assert.deepEqual(actors('closed', '5'), []);
  assert.equal(chainStep('tenant', t('closed', '5'), true).next.kind, 'paying_out');
  assert.equal(chainStep('tenant', t('closed'), true).next.kind, 'done');
});
