import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore } from './store.ts';
import { applyToListing, chooseApplicant, closeListing, createListing, listListings, withdrawApplication } from './listings.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';

const person = (subject: string): VerifiedIdentity => ({
  subject, sessionId: `session-${subject}`, expiresAt: Date.now() / 1000 + 3600,
  passkeyCount: 1,
  wallets: [{ id: `wallet-${subject}`, address: `address-${subject}`, chainType: 'solana' }],
});

async function listing(store: LocalStore, landlord: VerifiedIdentity) {
  return createListing(store, landlord, { title: 'A test home', rentMonthly: '900000000', requiredSecurity: '1000000', releaseAllowed: true });
}

test('applicant can withdraw before choice and reapply; other people cannot withdraw it', async () => {
  const store = new LocalStore(':memory:');
  try {
    const landlord = person('landlord'), tenant = person('tenant');
    const home = await listing(store, landlord);
    await applyToListing(store, tenant, home.id, { name: 'Tenant', message: 'I would like to rent here.' });
    await assert.rejects(() => withdrawApplication(store, person('outsider'), home.id), /no application/);
    await withdrawApplication(store, tenant, home.id);
    assert.equal((await listListings(store, landlord))[0].applicants, 0);
    await applyToListing(store, tenant, home.id, { name: 'Tenant', message: 'I would like to rent here.' });
    assert.equal((await listListings(store, landlord))[0].applicants, 1);
  } finally { await store.close(); }
});

test('landlord can close only an unchosen listing; chosen tenancy remains intact', async () => {
  const store = new LocalStore(':memory:');
  try {
    const landlord = person('landlord'), tenant = person('tenant');
    const home = await listing(store, landlord);
    await assert.rejects(() => closeListing(store, tenant, home.id), /Only the landlord/);
    await closeListing(store, landlord, home.id);
    await assert.rejects(() => applyToListing(store, tenant, home.id, { name: 'Tenant', message: 'I would like to rent here.' }), /no longer available/);
    const second = await listing(store, landlord);
    await applyToListing(store, tenant, second.id, { name: 'Tenant', message: 'I would like to rent here.' });
    const application = (await listListings(store, landlord)).find((entry) => entry.id === second.id)?.applications?.[0];
    assert.ok(application);
    await chooseApplicant(store, landlord, second.id, application.id);
    await assert.rejects(() => closeListing(store, landlord, second.id), /chosen tenancy/);
    await assert.rejects(() => withdrawApplication(store, tenant, second.id), /chosen or closed/);
  } finally { await store.close(); }
});

test('applications accept nicknames and optional short messages with bounded lengths', async () => {
  const store = new LocalStore(':memory:');
  try {
    const landlord = person('landlord');
    const home = await listing(store, landlord);
    await applyToListing(store, person('minimal'), home.id, { name: 'AB' });
    await applyToListing(store, person('maximal'), home.id, { name: 'N'.repeat(40), message: 'M'.repeat(500) });
    await applyToListing(store, person('short-message'), home.id, { name: 'Alias', message: 'Hi' });
    for (const [subject, input] of [
      ['short', { name: 'A' }],
      ['long', { name: 'N'.repeat(41) }],
      ['long-message', { name: 'Alias', message: 'M'.repeat(501) }],
    ] as const) await assert.rejects(() => applyToListing(store, person(subject), home.id, input));
    const applications = (await listListings(store, landlord))[0].applications!;
    assert.equal(applications.find(application => application.name === 'AB')?.message, '');
    assert.equal(applications.find(application => application.name === 'Alias')?.message, 'Hi');
    assert.equal(applications.find(application => application.name.length === 40)?.message.length, 500);
    await store.update<{ applications: { name: string; message: string }[] }>(`listing:${home.id}`, value => ({
      ...value,
      applications: value.applications.map((application, index) => index === 0
        ? { ...application, name: 'Legacy '.repeat(10), message: 'Earlier message '.repeat(100) }
        : application),
    }));
    const legacy = (await listListings(store, landlord))[0].applications![0];
    assert.equal(legacy.name, 'Legacy '.repeat(10));
    assert.equal(legacy.message, 'Earlier message '.repeat(100));
  } finally { await store.close(); }
});
