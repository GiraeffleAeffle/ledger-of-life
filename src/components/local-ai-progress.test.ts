import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiApprovalPollId, aiRequestPollId, aiSelectedHostStatus, aiSolanaAllowanceNotice, aiTerminalError, deriveAiProgress, isAiRequestTerminal, type AiProgressEvents } from './local-ai-progress-state.ts';
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
  const paid = deriveAiProgress({ request: { ...request, state: 'completed', payment: { ...request.payment, state: 'settled', receipt: { success: true, transaction: '0x123', network: 'eip155:46630', payer: '0x456' } } }, completedAt: at });
  assert.equal(paid.stage, 'paid');
  assert.equal(paid.money, 'paid');
  assert.equal(paid.endedAt, at);
  const reverted = deriveAiProgress({ request: { ...request, state: 'failed', payment: { ...request.payment, state: 'failed' } }, paymentJournal: { signed: 'signed', hash: '0x123' } });
  assert.equal(reverted.money, 'not_charged');
});

test('settled state without a successful receipt does not claim confirmed payment', () => {
  const progress = deriveAiProgress({ request: { ...request, state: 'completed', payment: { ...request.payment, state: 'settled' } } });
  assert.equal(progress.stage, 'confirming');
  assert.equal(progress.money, 'pending');
});

test('terminal failures stop request and approval polling and preserve purged error metadata', () => {
  const approval = { id: request.id, state: 'pending' as const, budgetAtomic: '6400', request: null, hash: 'approval-hash', error: null };
  assert.equal(aiRequestPollId(request), request.id);
  assert.equal(aiApprovalPollId(request, approval), request.id);
  for (const state of ['failed', 'interrupted', 'expired'] as const) {
    const stopped = { ...request, state, approval, purgedAt: at, prompt: '', answer: null, error: 'The connector job timed out.' };
    assert.equal(isAiRequestTerminal(stopped), true);
    assert.equal(aiRequestPollId(stopped), null);
    assert.equal(aiApprovalPollId(stopped, approval), null);
    assert.match(aiTerminalError(stopped)!, /The connector job timed out/);
    assert.match(aiTerminalError(stopped)!, /will not run again/);
    assert.equal(deriveAiProgress({ request: stopped }).money, 'not_charged');
  }
  assert.match(aiTerminalError({ ...request, state: 'interrupted', error: null })!, /No complete answer was saved/);
  assert.equal(aiTerminalError(request), null);
});

test('pending settlement is never represented as no charge even on a stopped request', () => {
  const progress = deriveAiProgress({ request: { ...request, state: 'interrupted', payment: { ...request.payment, state: 'pending' } } });
  assert.equal(progress.stage, 'failed');
  assert.equal(progress.money, 'pending');
});

test('exception recovery pauses polling, while canonical pending and cleared recovery resume it', () => {
  const approval = { id: request.id, state: 'pending' as const, budgetAtomic: '12800', request: null, hash: 'approval-hash', error: null };
  for (const state of ['running', 'settling'] as const) {
    const pending = { ...request, state, approval, payment: { ...request.payment, state: 'pending' as const } };
    assert.equal(aiRequestPollId(pending), request.id);
    for (const retryable of [false, true]) {
      const recovering = { ...pending, recovery: { stage: 'settlement_prepare' as const, code: 'settlement_unavailable', retryable } };
      assert.equal(aiRequestPollId(recovering), null);
      assert.equal(aiApprovalPollId(recovering, approval), null);
      assert.equal(aiRequestPollId({ ...recovering, recovery: null }), request.id);
      assert.equal(aiApprovalPollId({ ...recovering, recovery: null }, approval), request.id);
    }
  }
});

test('selected-host liveness is current evidence, not a claimed cause of failure or proven wake', () => {
  const host = { ...request.host!, models: ['local'], lastHeartbeat: null, state: 'active' as const,
    ollamaReachable: false, awake: false, availability: 'offline' as const };
  assert.match(aiSelectedHostStatus(request, [host])!, /currently offline/);
  assert.match(aiSelectedHostStatus(request, [host])!, /does not establish why/);
  assert.match(aiSelectedHostStatus(request, [{ ...host, availability: 'asleep', canWake: true }])!, /does not prove it will wake/);
  assert.match(aiSelectedHostStatus(request, [{ ...host, availability: 'asleep', canWake: false }])!, /cannot be woken/);
  assert.match(aiSelectedHostStatus(request, [{ ...host, availability: 'online' }])!, /not proof that the model is ready/);
  assert.match(aiSelectedHostStatus(request, [host], true)!, /status is unavailable/);
  assert.match(aiSelectedHostStatus(request, [])!, /status is unavailable/);
  assert.equal(aiSelectedHostStatus({ ...request, host: undefined }, []), null);
});

test('a confirmed Solana approval explains bounded residual allowance without inventing a receipt or revocation', () => {
  const solanaReview: NonNullable<LocalAiRequest['solanaReview']> = {
    walletId: 'solana-wallet', operationId: `local-ai:${request.id}`, requestId: request.id, requestFingerprint: request.requestFingerprint,
    description: 'One answer', expiresAt: request.expiresAt, network: 'solana-devnet', asset: 'test-mint',
    payer: 'payer', source: 'token-account', delegate: 'sponsor', payTo: 'recipient', route: 'house', hostOwnerSubject: null,
    maxOutputTokens: 128, amountAtomic: '12800', priceAtomic: '100',
  };
  const approval = { id: request.id, state: 'completed' as const, budgetAtomic: '12800', request: null, hash: 'approval-hash', error: null };
  const notice = aiSolanaAllowanceNotice({ solanaReview, approval });
  assert.match(notice!, /allowance, not a payment receipt/);
  assert.match(notice!, /0\.0128 tUSDC/);
  assert.match(notice!, /not automatically revoked/);
  assert.match(notice!, /only after this request and any settlement are resolved/);
  assert.equal(aiSolanaAllowanceNotice({ solanaReview, approval: { ...approval, state: 'pending' } }), null);
  assert.equal(aiSolanaAllowanceNotice({ solanaReview: null, approval }), null);
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
