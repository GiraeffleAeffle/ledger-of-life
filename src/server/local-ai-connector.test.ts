import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { LocalStore } from './store.ts';
import { createHostInvitation, createHostPairing, pollConnectorJob, recordHostHeartbeat, completeConnectorJob, publicConnectorHosts, setConnectorFreePublicAnswers, chooseConnectorHost } from './local-ai-hosts.ts';
import { executeAiRequest, libraryOwner, paidOwner, purgeVisitorText, readAiRequest, sweepAiText } from './local-ai.ts';
import { localAiStatus, localAiUsage } from './local-ai-operations.ts';
import { revokeVisitor } from './local-ai-session.ts';
import { AI_MODEL } from './local-ai-runtime.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { LocalAiRequest } from './local-ai-types.ts';

const payout = '0x1111111111111111111111111111111111111111';
const identity: VerifiedIdentity = { subject: 'did:privy:connector-owner', sessionId: 'session', expiresAt: Date.now() + 600_000,
  wallets: [{ id: 'wallet', address: payout, chainType: 'ethereum' }], passkeyCount: 1, backupLoginLinked: true };
const visitor = libraryOwner('c'.repeat(64));
const input = { mode: 'library', prompt: 'Explain why the stub is not real inference.', maxOutputTokens: 64, context: 'general', hostScope: 'city', publicQuestion: true };
const url = (id: string) => `http://localhost/api/local-ai/requests/${id}`;
const response = (answer: string) => ({ model: AI_MODEL, done: true, done_reason: 'stop', message: { role: 'assistant', content: answer }, eval_count: 13 });

async function fixture(run: (store: LocalStore, hostId: string) => Promise<void>) {
  const store = new LocalStore(':memory:');
  const oldUrl = process.env.LOCAL_AI_OLLAMA_URL;
  const oldOwners = process.env.LOCAL_AI_HOST_OWNER_WALLETS;
  delete process.env.LOCAL_AI_OLLAMA_URL;
  process.env.LOCAL_AI_HOST_OWNER_WALLETS = payout;
  try {
    const invitation = await createHostInvitation(store, identity, {});
    const { publicKey } = generateKeyPairSync('ed25519');
    const pair = await createHostPairing(store, { code: invitation.code, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), name: 'Test connector' }, 'consumer-test');
    await recordHostHeartbeat(store, pair.hostId, { models: [AI_MODEL], ollamaReachable: true, awake: true });
    await setConnectorFreePublicAnswers(store, identity, pair.hostId, true);
    await run(store, pair.hostId);
  } finally {
    if (oldUrl === undefined) delete process.env.LOCAL_AI_OLLAMA_URL; else process.env.LOCAL_AI_OLLAMA_URL = oldUrl;
    if (oldOwners === undefined) delete process.env.LOCAL_AI_HOST_OWNER_WALLETS; else process.env.LOCAL_AI_HOST_OWNER_WALLETS = oldOwners;
    await store.close();
  }
}

test('public consent gates city routing and immutable scope survives connector completion', async () => {
  await fixture(async (store, hostId) => {
    const id = randomUUID();
    await assert.rejects(executeAiRequest(store, id, visitor, { ...input, hostScope: 'own', publicQuestion: false }, url(id), null), /explicitly mark public/);
    await assert.rejects(executeAiRequest(store, id, visitor, { ...input, publicQuestion: false }, url(id), null), /explicitly mark public/);
    const pending = executeAiRequest(store, id, visitor, input, url(id), null);
    const { job } = await pollConnectorJob(store, hostId, 1000);
    assert.ok(job);
    await completeConnectorJob(store, hostId, { jobId: job.id, response: response('A synthetic connector answer.') });
    const completed = await pending;
    assert.equal(completed.state, 'completed');
    assert.equal(completed.host?.id, hostId);
    assert.equal(completed.host?.own, false);
    assert.equal(completed.answer, 'A synthetic connector answer.');
    await assert.rejects(executeAiRequest(store, id, visitor, { ...input, prompt: 'A different public question.' }, url(id), null), /different inference inputs/);
    assert.equal((await readAiRequest(store, id, visitor)).answer, completed.answer);
    assert.ok(!JSON.stringify(completed).includes(identity.subject));
  });
});

test('one verified EVM wallet can privately use its own host without payment, balances or facilitator configuration', async () => {
  await fixture(async (store, hostId) => {
    const owner = paidOwner(identity);
    const status = await localAiStatus(store, owner);
    assert.equal(status.configured, true);
    assert.equal(status.ownHostAvailable, true);
    assert.equal(status.mode, 'connector');
    assert.equal(status.hosts?.find((host) => host.id === hostId)?.own, true);
    assert.ok(!JSON.stringify(status).includes(identity.subject));
    const anonymous = await publicConnectorHosts(store);
    assert.equal(anonymous.find((host) => host.id === hostId)?.own, false);
    assert.ok(!JSON.stringify(anonymous).includes(identity.subject));
    const id = randomUUID();
    const ownInput = { ...input, mode: 'paid', hostScope: 'own', publicQuestion: false };
    const pending = executeAiRequest(store, id, owner, ownInput, url(id), null);
    const { job } = await pollConnectorJob(store, hostId, 1000);
    assert.ok(job);
    await completeConnectorJob(store, hostId, { jobId: job.id, response: response('Private answer on my own compute.') });
    const completed = await pending;
    assert.equal(completed.state, 'completed');
    assert.equal(completed.answer, 'Private answer on my own compute.');
    assert.equal(completed.host?.own, true);
    assert.equal(completed.host?.payoutWallet, null);
    assert.equal(completed.payment.state, 'none');
    assert.equal(completed.payment.amountAtomic, '0');
    assert.equal(completed.payment.receipt, null);
    assert.equal(completed.review, null);
    assert.equal(completed.paymentRequired, null);
    assert.equal((await readAiRequest(store, id, owner)).answer, completed.answer);
    const usage = await localAiUsage(store);
    assert.equal(usage.settledAtomic, '0');
    assert.equal(usage.successfulPaidRequests, 0);
    assert.equal(usage.successfulOwnRequests, 1);
  });
});

test('busy connector leaves the second request ready without consuming quota and resumes the same request', async () => {
  await fixture(async (store, hostId) => {
    const first = randomUUID(), second = randomUUID();
    const pending = executeAiRequest(store, first, visitor, input, url(first), null);
    const { job } = await pollConnectorJob(store, hostId, 1000);
    assert.ok(job);
    const ready = await executeAiRequest(store, second, visitor, input, url(second), null);
    assert.equal(ready.state, 'ready');
    assert.equal((await store.get<{ count: number }>(`local-ai:visitor:${visitor.visitor}`))?.count, 1);
    assert.equal((await store.get<{ attempts: number }>(`local-ai:library-day:${new Date().toISOString().slice(0, 10)}`))?.attempts, 1);
    await completeConnectorJob(store, hostId, { jobId: job.id, response: response('First completed answer.') });
    await pending;
    await recordHostHeartbeat(store, hostId, { models: [], ollamaReachable: true, awake: true });
    const unavailable = await executeAiRequest(store, second, visitor, input, url(second), null);
    assert.equal(unavailable.state, 'ready');
    assert.equal(unavailable.requestFingerprint, ready.requestFingerprint);
    assert.equal((await store.get<{ count: number }>(`local-ai:visitor:${visitor.visitor}`))?.count, 1);
    await recordHostHeartbeat(store, hostId, { models: [AI_MODEL], ollamaReachable: true, awake: true });
    const resumed = executeAiRequest(store, second, visitor, input, url(second), null);
    const { job: next } = await pollConnectorJob(store, hostId, 1000);
    assert.ok(next);
    await completeConnectorJob(store, hostId, { jobId: next.id, response: response('Resumed answer without a new request.') });
    const completed = await resumed;
    assert.equal(completed.id, ready.id);
    assert.equal(completed.requestFingerprint, ready.requestFingerprint);
    assert.equal(completed.answer, 'Resumed answer without a new request.');
    assert.equal((await store.get<{ count: number }>(`local-ai:visitor:${visitor.visitor}`))?.count, 2);
  });
});

test('clearing before pickup prevents the queued question from reaching a host', async () => {
  await fixture(async (store, hostId) => {
    const id = randomUUID();
    const pending = executeAiRequest(store, id, visitor, input, url(id), null);
    const denied = assert.rejects(pending, /session has ended/);
    // The request reaches its awaiting-inference boundary before the next event-loop turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await revokeVisitor(store, visitor.visitor);
    await purgeVisitorText(store, visitor.visitor);
    await denied;
    assert.equal((await pollConnectorJob(store, hostId, 0)).job, null);
    const saved = await store.get<{ request: LocalAiRequest }>(`local-ai:request:${id}`);
    assert.equal(saved?.request.state, 'interrupted');
    assert.equal(saved?.request.prompt, '');
    assert.equal(saved?.request.answer, null);
  });
});

test('clearing a picked-up visitor job cancels it and a late answer cannot reappear in storage', async () => {
  await fixture(async (store, hostId) => {
    const id = randomUUID();
    const pending = executeAiRequest(store, id, visitor, input, url(id), null);
    const denied = assert.rejects(pending, /session has ended/);
    const { job } = await pollConnectorJob(store, hostId, 1000);
    assert.ok(job);
    await revokeVisitor(store, visitor.visitor);
    await purgeVisitorText(store, visitor.visitor);
    await denied;
    await assert.rejects(completeConnectorJob(store, hostId, { jobId: job.id, response: response('Late private output must never be stored.') }), /expired|unassigned|completed/);
    await assert.rejects(readAiRequest(store, id, visitor), /session has ended/);
    const saved = await store.get<{ request: LocalAiRequest }>(`local-ai:request:${id}`);
    assert.equal(saved?.request.state, 'interrupted');
    assert.equal(saved?.request.prompt, '');
    assert.equal(saved?.request.answer, null);
    assert.equal((await pollConnectorJob(store, hostId, 0)).job, null);
  });
});

test('a lost connector process is reported interrupted and contributes no settled revenue after text cleanup', async () => {
  const store = new LocalStore(':memory:');
  const id = randomUUID(), now = Date.now();
  const owner = { subject: 'customer', walletId: 'payer', payer: '0x2222222222222222222222222222222222222222' as const };
  const request: LocalAiRequest = { id, mode: 'paid', state: 'running', model: AI_MODEL, prompt: 'Question whose connector process disappeared.',
    maxOutputTokens: 64, requestFingerprint: 'immutable', createdAt: new Date(now - 900_000).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
    answer: null, usage: null, error: null, review: null, paymentRequired: null, approval: null,
    payment: { state: 'authorized', amountAtomic: '10000', receipt: null }, host: { id: 'lost', name: 'Lost connector', own: false, payoutWallet: payout } };
  try {
    await store.create(`local-ai:request:${id}`, { id, mode: 'paid', owner, request, payee: payout, paymentJournal: { signed: null, hash: null }, runningAt: now - 900_000 });
    assert.equal((await sweepAiText(store, '', now)).scrubbed, 1);
    const interrupted = await readAiRequest(store, id, owner);
    assert.equal(interrupted.state, 'interrupted');
    assert.equal(interrupted.prompt, '');
    const usage = await localAiUsage(store);
    assert.equal(usage.failedRequests, 1);
    assert.equal(usage.settledAtomic, '0');
  } finally { await store.close(); }
});

test('sleeping connector keeps the first saved request alive beyond the former cold-start deadline', async () => {
  await fixture(async (store, hostId) => {
    await recordHostHeartbeat(store, hostId, { models: [AI_MODEL], ollamaReachable: false, awake: false, canWake: true });
    const id = randomUUID(), started = Date.now();
    const pending = executeAiRequest(store, id, visitor, input, url(id), null);
    const { job } = await pollConnectorJob(store, hostId, 1000);
    assert.ok(job);
    assert.ok(Date.parse(job.expiresAt) - started >= 239000);
    const saved = await pending;
    assert.equal(saved.state, 'running');
    assert.ok(Date.now() - started < 5000, 'HTTP-side execution must return before cold loading finishes');
    await store.update<{ runningAt: number }>(`local-ai:request:${id}`, (row) => { row.runningAt -= 110000; return row; });
    assert.equal((await readAiRequest(store, id, visitor)).state, 'running');
    await completeConnectorJob(store, hostId, { jobId: job.id, response: response('The first question survived wake and cold model loading.') }, started + 120000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const completed = await readAiRequest(store, id, visitor);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.answer, 'The first question survived wake and cold model loading.');
    assert.equal(completed.payment.state, 'none');
    assert.equal((await executeAiRequest(store, id, visitor, input, url(id), null)).answer, completed.answer);
    assert.equal((await pollConnectorJob(store, hostId, 0)).job, null);
  });
});

test('free routing requires owner opt-in while paid routing remains available without it', async () => {
  await fixture(async (store, hostId) => {
    await setConnectorFreePublicAnswers(store, identity, hostId, false);
    assert.equal((await publicConnectorHosts(store)).find((host) => host.id === hostId)?.freePublicAnswers, false);
    const id = randomUUID();
    await assert.rejects(executeAiRequest(store, id, visitor, input, url(id), null), /No online host/);
    assert.equal((await pollConnectorJob(store, hostId, 0)).job, null);
    assert.equal((await chooseConnectorHost(store, {}, AI_MODEL, 'city'))?.id, hostId);
    await assert.rejects(setConnectorFreePublicAnswers(store, { ...identity, subject: 'other-account' }, hostId, true), /Only the host owner/);
    const invitation = await createHostInvitation(store, identity, {});
    const { publicKey } = generateKeyPairSync('ed25519');
    const other = await createHostPairing(store, { code: invitation.code, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), name: 'Free opted-in host' }, 'free-routing');
    await recordHostHeartbeat(store, other.hostId, { models: [AI_MODEL], ollamaReachable: true, awake: true });
    await setConnectorFreePublicAnswers(store, identity, other.hostId, true);
    const pending = executeAiRequest(store, id, visitor, input, url(id), null);
    const { job } = await pollConnectorJob(store, other.hostId, 1000);
    assert.ok(job);
    assert.equal((await pollConnectorJob(store, hostId, 0)).job, null);
    await completeConnectorJob(store, other.hostId, { jobId: job.id, response: response('Only an opted-in host answers for free.') });
    const completed = await pending;
    assert.equal(completed.host?.id, other.hostId);
    assert.equal(completed.host?.payoutWallet, null);
    assert.equal(completed.review, null);
    assert.equal(completed.payment.receipt, null);
  });
});

test('connector free answers retain shared and visitor allowance bounds', async () => {
  await fixture(async (store, hostId) => {
    const dayKey = `local-ai:library-day:${new Date().toISOString().slice(0, 10)}`;
    await store.create(dayKey, { attempts: 30 });
    let id = randomUUID();
    await assert.rejects(executeAiRequest(store, id, visitor, input, url(id), null), /30 daily/);
    assert.equal((await pollConnectorJob(store, hostId, 0)).job, null);
    await store.update(dayKey, () => ({ attempts: 0 }));
    await store.update(`local-ai:visitor:${visitor.visitor}`, () => ({ count: 3 }));
    id = randomUUID();
    await assert.rejects(executeAiRequest(store, id, visitor, input, url(id), null), /three free/);
    assert.equal((await pollConnectorJob(store, hostId, 0)).job, null);
    assert.equal((await store.get<{ attempts: number }>(dayKey))?.attempts, 0);
    assert.equal((await chooseConnectorHost(store, {}, AI_MODEL, 'city'))?.id, hostId);
  });
});

test('clearing a detached running request records interruption without an unhandled rejection', async () => {
  await fixture(async (store, hostId) => {
    const unhandled: unknown[] = [];
    const observe = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', observe);
    try {
      const id = randomUUID();
      const pending = executeAiRequest(store, id, visitor, input, url(id), null);
      const { job } = await pollConnectorJob(store, hostId, 1000);
      assert.ok(job);
      assert.equal((await pending).state, 'running');
      await revokeVisitor(store, visitor.visitor);
      await purgeVisitorText(store, visitor.visitor);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      const saved = await store.get<{ request: LocalAiRequest }>(`local-ai:request:${id}`);
      assert.equal(saved?.request.state, 'interrupted');
      assert.equal(saved?.request.prompt, '');
      assert.equal(saved?.request.answer, null);
      await assert.rejects(completeConnectorJob(store, hostId, { jobId: job.id, response: response('Late answer is fenced.') }), /expired|unassigned|completed/);
    } finally { process.off('unhandledRejection', observe); }
  });
});
