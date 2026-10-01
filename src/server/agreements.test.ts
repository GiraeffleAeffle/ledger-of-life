import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore } from './store.ts';
import {
  createAgreement,
  getAgreement,
  inviteToAgreement,
  joinAgreement,
  acceptAgreement,
  addAgreementRecord,
} from './agreements.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
const person = (subject: string): VerifiedIdentity => ({
  subject,
  sessionId: `session-${subject}`,
  expiresAt: Date.now() / 1000 + 3600,
  passkeyCount: 1,
  wallets: [{ id: `wallet-${subject}`, address: `address-${subject}`, chainType: 'solana' }],
});
test('verified tenancy invitations bind independent people and an immutable accepted agreement', async () => {
  const store = new LocalStore(':memory:');
  const landlord = person('landlord'),
    tenant = person('tenant'),
    arbitrator = person('arbitrator');
  const agreement = await createAgreement(store, landlord, {
    network: 'solana',
    property: 'Example apartment',
    requiredSecurity: '3000000000',
    releaseAllowed: true,
  });
  await assert.rejects(() => getAgreement(store, agreement.id, tenant), /not a verified party/);
  await assert.rejects(
    () => acceptAgreement(store, agreement.id, landlord, 'wrong'),
    /All parties/,
  );
  const invitation = await inviteToAgreement(store, agreement.id, landlord, 'tenant');
  await assert.rejects(
    () => joinAgreement(store, agreement.id, landlord, 'tenant', invitation.token),
    /Each role/,
  );
  await assert.rejects(
    () => joinAgreement(store, agreement.id, tenant, 'tenant', 'f'.repeat(64)),
    /invalid/,
  );
  await joinAgreement(store, agreement.id, tenant, 'tenant', invitation.token);
  await assert.rejects(
    () => joinAgreement(store, agreement.id, person('intruder'), 'tenant', invitation.token),
    /already used/,
  );
  await assert.rejects(
    () => inviteToAgreement(store, agreement.id, tenant, 'arbitrator'),
    /landlord/,
  );
  const review = await inviteToAgreement(store, agreement.id, landlord, 'arbitrator');
  const joined = await joinAgreement(store, agreement.id, arbitrator, 'arbitrator', review.token);
  assert.ok(joined.digest);
  assert.equal('invitations' in joined, false);
  await assert.rejects(
    () => acceptAgreement(store, agreement.id, arbitrator, joined.digest!),
    /tenant and landlord/,
  );
  await assert.rejects(
    () => acceptAgreement(store, agreement.id, tenant, '0x' + '0'.repeat(64)),
    /same agreement/,
  );
  await acceptAgreement(store, agreement.id, tenant, joined.digest!);
  const accepted = await acceptAgreement(store, agreement.id, landlord, joined.digest!);
  const duplicate = await acceptAgreement(store, agreement.id, landlord, joined.digest!);
  assert.equal(accepted.accepted.tenant?.digest, accepted.accepted.landlord?.digest);
  assert.equal(duplicate.revision, accepted.revision);
  await assert.rejects(
    () =>
      addAgreementRecord(
        store,
        agreement.id,
        person('outsider'),
        'Repair evidence',
        'The entry inspection records this mark.',
      ),
    /not a verified party/,
  );
  const recorded = await addAgreementRecord(
    store,
    agreement.id,
    tenant,
    'Entry inspection',
    'The entry inspection records the same wall mark before move-in.',
  );
  assert.equal(recorded.records.length, 1);
  assert.equal(recorded.records[0].by, 'tenant');
  assert.equal(recorded.digest, accepted.digest);
  assert.equal(recorded.accepted.tenant?.digest, accepted.accepted.tenant?.digest);
  assert.equal(
    (await getAgreement(store, agreement.id, arbitrator)).records[0].body,
    recorded.records[0].body,
  );
  await assert.rejects(
    () => getAgreement(store, agreement.id, { ...tenant, wallets: person('replacement').wallets }),
    /not a verified party/,
  );
  await store.close();
});
