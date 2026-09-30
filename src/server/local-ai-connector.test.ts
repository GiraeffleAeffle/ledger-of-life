import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { LocalStore } from './store.ts';
import { approveHostPairing, createHostPairing, pollConnectorJob, recordHostHeartbeat, completeConnectorJob } from './local-ai-hosts.ts';
import { executeAiRequest, libraryOwner, readAiRequest, sweepAiText } from './local-ai.ts';
import { AI_MODEL } from './local-ai-runtime.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { LocalAiRequest } from './local-ai-types.ts';

const payout = '0x1111111111111111111111111111111111111111';
const identity: VerifiedIdentity = { subject: 'did:privy:connector-owner', sessionId: 'session', expiresAt: Date.now() + 600_000,
  wallets: [{ id: 'wallet', address: payout, chainType: 'ethereum' }], passkeyCount: 1, backupLoginLinked: true };
const visitor = libraryOwner('c'.repeat(64));
const input = { mode: 'library', prompt: 'Explain why the stub is not real inference.', maxOutputTokens: 64, context: 'general', hostScope: 'city', publicQuestion: true };

test('explicit public scope delivers through its quoted connector and cannot be changed on replay', async () => {
  const store = new LocalStore(':memory:');
  const oldUrl = process.env.LOCAL_AI_OLLAMA_URL;
  const oldOwners = process.env.LOCAL_AI_HOST_OWNER_WALLETS;
  delete process.env.LOCAL_AI_OLLAMA_URL;
  process.env.LOCAL_AI_HOST_OWNER_WALLETS = payout;
  try {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pair = await createHostPairing(store, { publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), name: 'Test connector' }, 'consumer-test');
    await approveHostPairing(store, identity, { code: pair.code });
    await recordHostHeartbeat(store, pair.hostId, { models: [AI_MODEL], ollamaReachable: true, awake: true });
    const id = randomUUID();
    const url = `http://localhost/api/local-ai/requests/${id}`;
    await assert.rejects(executeAiRequest(store, id, visitor, { ...input, hostScope: 'own', publicQuestion: false }, url, null), /No online host/);
    await assert.rejects(executeAiRequest(store, id, visitor, { ...input, publicQuestion: false }, url, null), /explicitly mark public/);
    const pending = executeAiRequest(store, id, visitor, input, url, null);
    const { job } = await pollConnectorJob(store, pair.hostId, 1000);
    assert.ok(job);
    assert.equal(job.messages.find((message) => message.role === 'user')?.content, input.prompt);
    await completeConnectorJob(store, pair.hostId, { jobId: job.id, response: { model: AI_MODEL, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'This answer came from a test connector, not the owner GPU.' }, eval_count: 13 } });
    const completed = await pending;
    assert.equal(completed.state, 'completed');
    assert.equal(completed.host?.id, pair.hostId);
    assert.equal(completed.host?.payoutWallet.toLowerCase(), payout);
    assert.equal(completed.answer, 'This answer came from a test connector, not the owner GPU.');
    assert.equal(completed.payment.state, 'none');
    await assert.rejects(executeAiRequest(store, id, visitor, { ...input, hostScope: 'own' }, url, null), /different inference inputs/);
    assert.equal((await readAiRequest(store, id, visitor)).answer, completed.answer);
  } finally {
    if (oldUrl === undefined) delete process.env.LOCAL_AI_OLLAMA_URL; else process.env.LOCAL_AI_OLLAMA_URL = oldUrl;
    if (oldOwners === undefined) delete process.env.LOCAL_AI_HOST_OWNER_WALLETS; else process.env.LOCAL_AI_HOST_OWNER_WALLETS = oldOwners;
    await store.close();
  }
});

test('a lost connector process cannot keep an authorized question forever or create revenue', async () => {
  const store = new LocalStore(':memory:');
  const id = randomUUID();
  const now = Date.now();
  const request: LocalAiRequest = { id, mode: 'paid', state: 'running', model: AI_MODEL, prompt: 'Question whose connector process disappeared.',
    maxOutputTokens: 64, requestFingerprint: 'immutable', createdAt: new Date(now - 800_000).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
    answer: null, usage: null, error: null, review: null, paymentRequired: null, approval: null,
    payment: { state: 'authorized', amountAtomic: '10000', receipt: null }, host: { id: 'lost', name: 'Lost connector', ownerSubject: identity.subject, payoutWallet: payout } };
  try {
    await store.create(`local-ai:request:${id}`, { id, mode: 'paid', owner: { subject: 'customer', walletId: 'payer', payer: '0x2222222222222222222222222222222222222222' },
      request, payee: payout, paymentJournal: { signed: null, hash: null }, runningAt: now - 800_000 });
    assert.equal((await sweepAiText(store, '', now)).scrubbed, 1);
    const saved = await store.get<{ request: LocalAiRequest; paymentJournal: { signed: null; hash: null } }>(`local-ai:request:${id}`);
    assert.equal(saved?.request.state, 'interrupted');
    assert.equal(saved?.request.prompt, '');
    assert.equal(saved?.request.answer, null);
    assert.equal(saved?.request.payment.receipt, null);
    assert.equal(saved?.paymentJournal.signed, null);
  } finally { await store.close(); }
});
