import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAiProgress, type AiProgressEvents } from './local-ai-progress-state.ts';
import type { LocalAiRequest } from '../server/local-ai-types.ts';
import { LocalStore } from '../server/store.ts';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createHostInvitation, createHostPairing, recordHostHeartbeat, setConnectorFreePublicAnswers, pollConnectorJob, completeConnectorJob } from '../server/local-ai-hosts.ts';
import { executeAiRequest, readAiRequest, libraryOwner } from '../server/local-ai.ts';
import { AI_MODEL } from '../server/local-ai-runtime.ts';

const at = '2026-10-02T12:00:00.000Z';
const request: LocalAiRequest = {
  id: '66a920aa-1ef0-4cb9-b4dc-cee64b192b78', mode: 'paid', state: 'running', model: 'local', prompt: 'Question',
  maxOutputTokens: 64, requestFingerprint: 'fingerprint', createdAt: at, expiresAt: '2026-10-02T12:10:00.000Z',
  answer: null, usage: null, error: null, payment: { state: 'authorized', amountAtomic: '6400', receipt: null },
  review: null, paymentRequired: null, approval: null, host: { id: 'host', name: 'Host', own: false, payoutWallet: null },
};

test('cold host waits for evidence and never claims an unreported wake signal', () => {
  const progress = deriveAiProgress({ request, progressEvents: { authorizedAt: at, queuedAt: at } });
  assert.equal(progress.stage, 'waiting_host');
  assert.equal(progress.money, 'authorized');
  assert.equal(progress.startedAt, at);
  assert.deepEqual(progress.events, { authorizedAt: at, queuedAt: at });
});

test('awake heartbeat is not connector pickup; pickup does not prove model readiness', () => {
  const events: AiProgressEvents = { hostAwakeAt: at };
  assert.equal(deriveAiProgress({ request, progressEvents: events }).stage, 'host_awake');
  const pickedUp = deriveAiProgress({ request, progressEvents: { pickedUpAt: at } });
  assert.equal(pickedUp.stage, 'answering');
  assert.equal(pickedUp.events.modelReachableAt, undefined);
});

for (const pickedUp of [false, true]) test(`failure ${pickedUp ? 'after' : 'before'} pickup preserves evidence without a charge`, () => {
  const progress = deriveAiProgress({ request: { ...request, state: 'failed' },
    progressEvents: { authorizedAt: at, ...(pickedUp ? { pickedUpAt: at } : {}), finishedAt: at },
    paymentJournal: { signed: null, hash: null } });
  assert.equal(progress.stage, 'failed');
  assert.equal(progress.money, 'not_charged');
  assert.equal(progress.events.pickedUpAt, pickedUp ? at : undefined);
  assert.equal(progress.endedAt, at);
});

test('saved result awaits canonical settlement, not just a signed transaction', () => {
  const progress = deriveAiProgress({ request: { ...request, state: 'settling', payment: { ...request.payment, state: 'pending' } },
    progressEvents: { answerReceivedAt: at }, paymentJournal: { signed: 'signed', hash: '0x123' } });
  assert.equal(progress.stage, 'confirming');
  assert.equal(progress.money, 'pending');
  assert.equal(progress.settlementTransaction, '0x123');
});

test('confirmed settlement is paid and a canonical revert is not charged', () => {
  const paid = deriveAiProgress({ request: { ...request, state: 'completed', payment: { ...request.payment, state: 'settled' } }, completedAt: at });
  assert.equal(paid.stage, 'paid');
  assert.equal(paid.money, 'paid');
  assert.equal(paid.endedAt, at);
  const reverted = deriveAiProgress({ request: { ...request, state: 'failed', payment: { ...request.payment, state: 'failed' } }, paymentJournal: { signed: 'signed', hash: '0x123' } });
  assert.equal(reverted.money, 'not_charged');
});

test('request reads retain cold-host, heartbeat and pickup evidence after the job fails', async () => {
  const store = new LocalStore(':memory:');
  const previousUrl = process.env.LOCAL_AI_OLLAMA_URL;
  const previousOwners = process.env.LOCAL_AI_HOST_OWNER_WALLETS;
  delete process.env.LOCAL_AI_OLLAMA_URL;
  const payout = '0x1111111111111111111111111111111111111111';
  process.env.LOCAL_AI_HOST_OWNER_WALLETS = payout;
  try {
    const identity = { subject: 'did:privy:progress-proof', sessionId: 'session', expiresAt: Date.now() + 600000,
      wallets: [{ id: 'wallet', address: payout, chainType: 'ethereum' as const }], passkeyCount: 1 };
    const invitation = await createHostInvitation(store, identity, {});
    const { publicKey } = generateKeyPairSync('ed25519');
    const { hostId } = await createHostPairing(store, { code: invitation.code,
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), name: 'Cold progress host' });
    await recordHostHeartbeat(store, hostId, { models: [AI_MODEL], ollamaReachable: false, awake: false, canWake: true });
    await setConnectorFreePublicAnswers(store, identity, hostId, true);
    const owner = libraryOwner('d'.repeat(64));
    const id = randomUUID();
    await executeAiRequest(store, id, owner, { mode: 'library', prompt: 'Synthetic progress proof question.', maxOutputTokens: 64,
      context: 'general', hostScope: 'city', publicQuestion: true }, `http://localhost/api/local-ai/requests/${id}`, null);
    const cold = await readAiRequest(store, id, owner);
    assert.ok(cold.progress);
    assert.equal(cold.progress.stage, 'waiting_host');
    assert.ok(cold.progress.events.queuedAt);
    await recordHostHeartbeat(store, hostId, { models: [AI_MODEL], ollamaReachable: true, awake: true, canWake: true });
    const awake = await readAiRequest(store, id, owner);
    assert.ok(awake.progress);
    assert.equal(awake.progress.stage, 'host_awake');
    const { job } = await pollConnectorJob(store, hostId, 0);
    assert.ok(job);
    const pickedUp = await readAiRequest(store, id, owner);
    assert.ok(pickedUp.progress);
    assert.equal(pickedUp.progress.stage, 'answering');
    assert.ok(pickedUp.progress.events.pickedUpAt);
    await completeConnectorJob(store, hostId, { jobId: job.id, error: 'Synthetic failure' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const failed = await readAiRequest(store, id, owner);
    assert.ok(failed.progress);
    assert.equal(failed.progress.stage, 'failed');
    assert.equal(failed.progress.events.pickedUpAt, pickedUp.progress.events.pickedUpAt);
    assert.equal(failed.payment.amountAtomic, '0');
    assert.equal(failed.answer, null);
  } finally {
    if (previousUrl === undefined) delete process.env.LOCAL_AI_OLLAMA_URL; else process.env.LOCAL_AI_OLLAMA_URL = previousUrl;
    if (previousOwners === undefined) delete process.env.LOCAL_AI_HOST_OWNER_WALLETS; else process.env.LOCAL_AI_HOST_OWNER_WALLETS = previousOwners;
    await store.close();
  }
});
