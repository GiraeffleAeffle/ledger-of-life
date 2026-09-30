import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore } from './store.ts';
import { addAgreementRecord, createAgreement, inviteToAgreement, joinAgreement, previewAgreementInvitation } from './agreements.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';

const person = (subject: string): VerifiedIdentity => ({
  subject, sessionId: `session-${subject}`, expiresAt: Date.now() / 1000 + 3600,
  passkeyCount: 1, backupLoginLinked: true,
  wallets: [{ id: `wallet-${subject}`, address: `address-${subject}`, chainType: 'solana' }],
});

test('only current bearer token reveals home and deposit, and it stops after replacement or joining', async () => {
  const store = new LocalStore(':memory:');
  try {
    const landlord = person('landlord');
    const agreement = await createAgreement(store, landlord, { network: 'solana', property: 'Example home', requiredSecurity: '1000000', releaseAllowed: true });
    const old = await inviteToAgreement(store, agreement.id, landlord, 'arbitrator');
    assert.deepEqual(await previewAgreementInvitation(store, agreement.id, 'arbitrator', old.token), { property: 'Example home', requiredSecurity: '1000000' });
    await assert.rejects(() => previewAgreementInvitation(store, agreement.id, 'arbitrator', 'f'.repeat(64)), /invalid/);
    const replacement = await inviteToAgreement(store, agreement.id, landlord, 'arbitrator');
    await assert.rejects(() => previewAgreementInvitation(store, agreement.id, 'arbitrator', old.token), /invalid/);
    await joinAgreement(store, agreement.id, person('arbitrator'), 'arbitrator', replacement.token);
    await assert.rejects(() => previewAgreementInvitation(store, agreement.id, 'arbitrator', replacement.token), /already used/);
  } finally { await store.close(); }
});

test('signed-operation reasons are idempotent across response loss and retries', async () => {
  const store = new LocalStore(':memory:');
  try {
    const landlord = person('landlord');
    const agreement = await createAgreement(store, landlord, { network: 'solana', property: 'Example home', requiredSecurity: '1000000', releaseAllowed: true });
    const operationId = 'a'.repeat(64);
    await addAgreementRecord(store, agreement.id, landlord, 'Move-out deduction', 'Example cleaning cost', operationId);
    const repeated = await addAgreementRecord(store, agreement.id, landlord, 'Move-out deduction', 'Example cleaning cost', operationId);
    assert.equal(repeated.records.length, 1);
    await assert.rejects(() => addAgreementRecord(store, agreement.id, landlord, 'Move-out deduction', 'Different cleaning cost', operationId), /different recorded reason/);
  } finally { await store.close(); }
});
