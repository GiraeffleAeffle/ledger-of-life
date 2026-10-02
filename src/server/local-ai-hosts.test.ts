import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { LocalStore } from './store.ts';
import { AccessError } from './errors.ts';
import { authenticateConnector, cancelConnectorInference, checkConnectorHeaders, chooseConnectorHost, completeConnectorJob, connectorSigningBytes,
  createHostInvitation, createHostPairing, enqueueConnectorInference, hostPairingAllowed, parseConnectorBody, pollConnectorJob, publicConnectorHosts,
  readConnectorBody, recordHostHeartbeat, releaseConnectorHost, reserveConnectorHost, revokeConnectorHost, sanitizeConnectorAnswer, suspendConnectorHost, ownedConnectorHosts, type ConnectorInferenceInput } from './local-ai-hosts.ts';
import { signedHostRoute } from '../../app/api/local-ai/hosts/_http.ts';

const wallet = '0x1111111111111111111111111111111111111111';
const alternateWallet = '0x2222222222222222222222222222222222222222';
const thirdWallet = '0x3333333333333333333333333333333333333333';
const originalAllowlist = process.env.LOCAL_AI_HOST_OWNER_WALLETS;
process.env.LOCAL_AI_HOST_OWNER_WALLETS = `${wallet},${thirdWallet}`;
after(() => {
  if (originalAllowlist === undefined) delete process.env.LOCAL_AI_HOST_OWNER_WALLETS;
  else process.env.LOCAL_AI_HOST_OWNER_WALLETS = originalAllowlist;
});
const owner: VerifiedIdentity = { subject: 'did:privy:owner', sessionId: 'session', expiresAt: 2000000000,
  wallets: [{ id: 'one', chainType: 'ethereum', address: wallet }, { id: 'two', chainType: 'ethereum', address: alternateWallet }], passkeyCount: 0 };
const other: VerifiedIdentity = { ...owner, subject: 'did:privy:other', wallets: [{ id: 'third', chainType: 'ethereum', address: thirdWallet }] };
const input: ConnectorInferenceInput = { model: 'test-model', messages: [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Private question' }],
  options: { num_ctx: 8192, num_predict: 64, temperature: 0.35 } };
const answer = { model: input.model, done: true, done_reason: 'stop', message: { role: 'assistant', content: '  Complete answer.  ' },
  prompt_eval_count: 20, eval_count: 10, eval_duration: 200000000, total_duration: 400000000 };
function signed(hostId: string, key: KeyObject, body = '{}', timestamp = Date.now(), pathname = '/api/local-ai/hosts/poll', nonce = randomBytes(16).toString('hex'), method = 'POST') {
  const raw = Buffer.from(body);
  const headers = { 'content-type': 'application/json', 'x-host-id': hostId, 'x-host-timestamp': String(timestamp), 'x-host-nonce': nonce,
    'x-host-signature': sign(null, connectorSigningBytes(method, pathname, String(timestamp), nonce, raw), key).toString('base64') };
  return { raw, request: new Request(`https://app.example${pathname}`, { method, headers, ...(method === 'POST' ? { body: raw } : {}) }) };
}
async function pairing(store: LocalStore, now = Date.now(), identity = owner) {
  const keys = generateKeyPairSync('ed25519');
  const invitation = await createHostInvitation(store, identity, { payoutWallet: identity.wallets[0].address }, now);
  const pair = await createHostPairing(store, { code: invitation.code, name: 'Home GPU', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }, now);
  return { ...pair, keys };
}
async function connected(store: LocalStore, identity = owner) {
  const pair = await pairing(store, Date.now(), identity);
  await recordHostHeartbeat(store, pair.hostId, { models: [input.model], ollamaReachable: true, awake: true });
  return pair;
}
async function startJob(store: LocalStore, hostId: string, requestId = 'request') {
  await reserveConnectorHost(store, hostId, requestId);
  const outcome = enqueueConnectorInference(store, hostId, requestId, input).then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error }));
  await setImmediate();
  return { outcome };
}

test('owner invitations are hashed, single use, account/payout bound and activate only their canonical Ed25519 key', async () => {
  const store = new LocalStore(':memory:');
  try {
    const invitation = await createHostInvitation(store, owner, { payoutWallet: alternateWallet }, 1000000);
    assert.match(invitation.code, /^[A-HJ-NP-Z2-9]{12}$/);
    assert.equal(invitation.expiresAt, new Date(1600000).toISOString());
    const persisted = JSON.stringify(await store.scan('local-ai:'));
    assert.equal(persisted.includes(invitation.code), false);
    assert.equal(persisted.includes(createHash('sha256').update(invitation.code).digest('hex')), true);
    assert.deepEqual(await publicConnectorHosts(store, 1000001, owner.subject), []);
    const keys = generateKeyPairSync('ed25519');
    const body = { code: invitation.code, name: 'Home GPU', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    const results = await Promise.allSettled([createHostPairing(store, body, 1000001), createHostPairing(store, body, 1000001)]);
    const paired = results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<{ hostId: string }>;
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const host = (await publicConnectorHosts(store, 1000001, owner.subject))[0];
    assert.equal(host.id, paired.value.hostId);
    assert.equal(host.state, 'active');
    assert.equal(host.payoutWallet, alternateWallet);
    assert.equal(host.own, true);
    assert.equal((await publicConnectorHosts(store, 1000001, other.subject))[0].own, false);
    assert.equal((await publicConnectorHosts(store, 1000001))[0].own, false);
    for (const key of ['ownerSubject', 'publicKey', 'code', 'codeHash', 'nonces', 'pairingExpiresAt']) assert.equal(key in host, false);
    const wrong = signed(host.id, generateKeyPairSync('ed25519').privateKey, '{}', 1000001);
    await assert.rejects(authenticateConnector(store, wrong.request, wrong.raw, 1000001), /Invalid connector signature/);
    const good = signed(host.id, keys.privateKey, '{}', 1000001);
    assert.equal((await authenticateConnector(store, good.request, good.raw, 1000001)).ownerSubject, owner.subject);
    await assert.rejects(revokeConnectorHost(store, other, host.id), /Only the host owner/);
    await revokeConnectorHost(store, owner, host.id);
    assert.deepEqual(await publicConnectorHosts(store, 1000001, owner.subject), []);
  } finally { await store.close(); }
});

test('invitations expire at ten minutes and accept verified EVM ownership with an unambiguous verified payout', async () => {
  const store = new LocalStore(':memory:');
  try {
    const notAllowed = { ...owner, wallets: [{ id: 'foreign', address: alternateWallet, chainType: 'ethereum' as const }], passkeyCount: 10 };
    const notEvm = { ...owner, wallets: [{ id: 'solana', address: wallet, chainType: 'solana' as const }] };
    assert.equal(hostPairingAllowed(notAllowed), true);
    assert.equal(hostPairingAllowed(notEvm), false);
    await createHostInvitation(store, notAllowed, {}, 1000000);
    await assert.rejects(createHostInvitation(store, notEvm, {}, 1000000), /verified EVM/);
    await assert.rejects(createHostInvitation(store, owner, { payoutWallet: thirdWallet }, 1000000), /own verified EVM/);
    await assert.rejects(createHostInvitation(store, owner, {}, 1000000), /Choose a verified/);
    const invitation = await createHostInvitation(store, other, {}, 1000000);
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    await assert.rejects(createHostPairing(store, { code: invitation.code, name: 'Home GPU', publicKey }, 1600000), /expired/);
    const fresh = await createHostInvitation(store, other, {}, 1600000);
    const pair = await createHostPairing(store, { code: fresh.code, name: 'Home GPU', publicKey }, 1600001);
    assert.equal((await publicConnectorHosts(store, 1600001, other.subject)).find((host) => host.id === pair.hostId)!.payoutWallet, thirdWallet);
  } finally { await store.close(); }
});

test('community host limits are atomic; suspension blocks signatures and cannot bypass account/global capacity', async () => {
  const store = new LocalStore(':memory:');
  try {
    const community = { ...owner, subject: 'community', wallets: [{ id: 'community', chainType: 'ethereum' as const, address: alternateWallet }] };
    const first = await pairing(store, 1000000, community);
    const second = await pairing(store, 1000000, community);
    assert.equal((await ownedConnectorHosts(store, community, 1000000))[0].kind, 'community');
    assert.equal((await pairing(store, 1000000, other)).hostId.length, 36);
    assert.equal((await ownedConnectorHosts(store, other, 1000000))[0].kind, 'operator');
    await assert.rejects(createHostInvitation(store, community, {}, 1000000), /at most two/);
    await assert.rejects(suspendConnectorHost(store, community, first.hostId, true), /Only an operator/);
    await suspendConnectorHost(store, owner, first.hostId, true);
    const signedRequest = signed(first.hostId, first.keys.privateKey, '{}', 1000001);
    await assert.rejects(authenticateConnector(store, signedRequest.request, signedRequest.raw, 1000001), /unknown or revoked/);
    await assert.rejects(createHostInvitation(store, community, {}, 1000000), /at most two/);
    assert.equal((await ownedConnectorHosts(store, community, 1000000))[0].state, 'suspended');
    await suspendConnectorHost(store, owner, first.hostId, false);
    await authenticateConnector(store, signedRequest.request, signedRequest.raw, 1000001);
    await revokeConnectorHost(store, community, second.hostId);
    await pairing(store, 1000000, community);
    for (let index = 0; index < 46; index++) await pairing(store, 1000000, { ...community, subject: `account-${index}` });
    const overflowOwner = { ...community, subject: 'capacity-overflow' };
    const overflowInvite = await createHostInvitation(store, overflowOwner, {}, 1000000);
    await pairing(store, 1000000, { ...community, subject: 'account-46' });
    await assert.rejects(createHostPairing(store, { code: overflowInvite.code, name: 'GPU', publicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }, 1000000), /50 hosts/);
    await assert.rejects(createHostInvitation(store, overflowOwner, {}, 1000000), /50 hosts/);
  } finally { await store.close(); }
});

test('legacy invitation floods are reduced to the latest unused code per subject before concurrent redemption', async () => {
  const store = new LocalStore(':memory:');
  try {
    const invitations = ['AAAAAAAAAAAA', 'BBBBBBBBBBBB', 'CCCCCCCCCCCC'].map(code => ({ code }));
    await store.create('local-ai:connector-registry', { hosts: [], invitations: invitations.map(({ code }) => ({
      codeHash: createHash('sha256').update(code).digest('hex'), ownerSubject: other.subject, payoutWallet: thirdWallet, expiresAt: 1600000,
    })) });
    const results = await Promise.allSettled(invitations.map(invitation => createHostPairing(store, {
      code: invitation.code, name: 'Community device', publicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    }, 1000001)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message, /expired, used, or unknown/);
    await pairing(store, 1000001, other);
    assert.equal((await ownedConnectorHosts(store, other, 1000001)).length, 2);
    await assert.rejects(createHostInvitation(store, other, {}, 1000001), /at most two/);
  } finally { await store.close(); }
});

test('malformed pairing cannot consume invitations and unknown codes cannot fill shared capacity', async () => {
  const store = new LocalStore(':memory:');
  try {
    const invitation = await createHostInvitation(store, other, {}, 1000000);
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const valid = { code: invitation.code, name: 'Home GPU', publicKey };
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
    for (const body of [{ ...valid, code: 'BAD' }, { ...valid, name: 'x'.repeat(81) }, { ...valid, name: String.fromCharCode(0) },
      { ...valid, publicKey: 'not-base64' }, { ...valid, publicKey: rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') },
      { ...valid, publicKey: publicKey + String.fromCharCode(10) }, { ...valid, payoutWallet: wallet }]) {
      await assert.rejects(createHostPairing(store, body, 1000000), /Unsupported|invitation code|name|Ed25519/);
    }
    const before = await store.get<{ hosts: unknown[]; invitations: unknown[] }>('local-ai:connector-registry');
    assert.deepEqual(before!.hosts, []);
    assert.equal(before!.invitations.length, 1);
    for (let index = 0; index < 1030; index++) {
      await assert.rejects(createHostPairing(store, { ...valid, code: 'AAAAAAAAAAAA' }, 1000000), /expired, used, or unknown/);
    }
    const after = await store.get<typeof before>('local-ai:connector-registry');
    assert.deepEqual(after!.hosts, before!.hosts);
    assert.deepEqual(after!.invitations, before!.invitations);
    const pair = await createHostPairing(store, valid, 1000000);
    assert.equal((await publicConnectorHosts(store, 1000000))[0].id, pair.hostId);
    const next = await createHostInvitation(store, other, {}, 1000000);
    await assert.rejects(createHostPairing(store, { ...valid, code: next.code }, 1000000), /already has an active/);
    const newKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    await createHostPairing(store, { ...valid, code: next.code, publicKey: newKey }, 1000000);
  } finally { await store.close(); }
});

test('legacy persisted source hashes are removed without invalidating host invitations', async () => {
  const store = new LocalStore(':memory:');
  try {
    const code = 'AAAAAAAAAAAA';
    await store.create('local-ai:connector-registry', {
      hosts: [],
      invitations: [{ codeHash: createHash('sha256').update(code).digest('hex'), ownerSubject: other.subject, payoutWallet: thirdWallet, expiresAt: 1600000 }],
      rate: [{ source: createHash('sha256').update('192.0.2.1').digest('hex'), started: 1000000, count: 5 }],
    });
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const pair = await createHostPairing(store, { code, name: 'Host', publicKey }, 1000000);
    const registry = await store.get<{ rate?: unknown; hosts: { id: string }[] }>('local-ai:connector-registry');
    assert.equal('rate' in registry!, false);
    assert.equal(registry!.hosts[0].id, pair.hostId);
    assert.equal((await publicConnectorHosts(store, 1000000, other.subject))[0].payoutWallet, thirdWallet);
  } finally { await store.close(); }
});

test('signed requests bind exact bytes, method, path, timestamp, nonce and host ID; replay is atomic', async () => {
  const store = new LocalStore(':memory:');
  try {
    const pair = await connected(store);
    const timestamp = Date.now();
    const original = signed(pair.hostId, pair.keys.privateKey, '{}', timestamp);
    await assert.rejects(authenticateConnector(store, original.request, Buffer.from('{ }'), timestamp), /signature/);
    for (const field of ['x-host-timestamp', 'x-host-nonce', 'x-host-id', 'x-host-signature']) {
      const headers = new Headers(original.request.headers);
      headers.set(field, field === 'x-host-timestamp' ? String(timestamp + 1) : field === 'x-host-nonce' ? 'a'.repeat(32) : field === 'x-host-id' ? 'wrong-host' : 'a'.repeat(86) + '==');
      await assert.rejects(authenticateConnector(store, new Request(original.request.url, { method: 'POST', headers }), original.raw, timestamp));
    }
    for (const [field, value] of [
      ['x-host-id', ''], ['x-host-timestamp', ''], ['x-host-timestamp', '1.5'], ['x-host-timestamp', '-1'], ['x-host-timestamp', '9999999999999999'],
      ['x-host-nonce', ''], ['x-host-nonce', 'a'.repeat(31)], ['x-host-nonce', 'g'.repeat(32)], ['x-host-signature', ''], ['x-host-signature', 'not-base64'],
    ]) {
      const headers = new Headers(original.request.headers);
      headers.set(field, value);
      await assert.rejects(authenticateConnector(store, new Request(original.request.url, { method: 'POST', headers }), original.raw, timestamp), AccessError);
    }
    for (const request of [new Request(original.request.url, { method: 'PUT', headers: original.request.headers }), new Request('https://app.example/api/local-ai/hosts/result', { method: 'POST', headers: original.request.headers })])
      await assert.rejects(authenticateConnector(store, request, original.raw, timestamp), /signature/);
    const replay = await Promise.allSettled([authenticateConnector(store, original.request, original.raw, timestamp), authenticateConnector(store, original.request, original.raw, timestamp)]);
    assert.equal(replay.filter((result) => result.status === 'fulfilled').length, 1);
    assert.match((replay.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.message, /already been used/);
    for (const delta of [-60001, 60001]) {
      const stale = signed(pair.hostId, pair.keys.privateKey, '{}', timestamp + delta);
      await assert.rejects(authenticateConnector(store, stale.request, stale.raw, timestamp), /timestamp/);
    }
    for (const delta of [-60000, 60000]) {
      const boundary = signed(pair.hostId, pair.keys.privateKey, '{}', timestamp + delta);
      await authenticateConnector(store, boundary.request, boundary.raw, timestamp);
    }
    const renewed = signed(pair.hostId, pair.keys.privateKey, '{}', timestamp + 120001, '/api/local-ai/hosts/poll', original.request.headers.get('x-host-nonce')!);
    await authenticateConnector(store, renewed.request, renewed.raw, timestamp + 120001);
  } finally { await store.close(); }
});

test('reopening SQLite preserves replay rejection and revocation while no prompt is durably queued', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-registry-'));
  const filename = join(directory, 'test.sqlite');
  const first = new LocalStore(filename);
  let second: LocalStore | undefined;
  let firstClosed = false;
  try {
    const pair = await connected(first);
    const request = signed(pair.hostId, pair.keys.privateKey);
    await authenticateConnector(first, request.request, request.raw);
    const running = await startJob(first, pair.hostId);
    const picked = await pollConnectorJob(first, pair.hostId, 0);
    await completeConnectorJob(first, pair.hostId, { jobId: picked.job!.id, response: answer });
    assert.equal((await running.outcome).value!.answer, 'Complete answer.');
    await first.close();
    firstClosed = true;
    second = new LocalStore(filename);
    await assert.rejects(authenticateConnector(second, request.request, request.raw), /already been used/);
    assert.deepEqual(await pollConnectorJob(second, pair.hostId, 0), { job: null });
    assert.equal(JSON.stringify(await second.scan('local-ai:')).includes('Private question'), false);
    await revokeConnectorHost(second, owner, pair.hostId);
    await second.close();
    second = new LocalStore(filename);
    const fresh = signed(pair.hostId, pair.keys.privateKey);
    await assert.rejects(authenticateConnector(second, fresh.request, fresh.raw), AccessError);
  } finally {
    if (!firstClosed) await first.close();
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown and revoked keys cannot authenticate, heartbeat or reserve jobs; only the owner can revoke', async () => {
  const store = new LocalStore(':memory:');
  try {
    const pair = await connected(store);
    const unknown = signed('unknown-host', pair.keys.privateKey);
    await assert.rejects(authenticateConnector(store, unknown.request, unknown.raw), AccessError);
    await assert.rejects(pollConnectorJob(store, 'unknown-host', 0), AccessError);
    await assert.rejects(recordHostHeartbeat(store, 'unknown-host', { models: [], awake: true, ollamaReachable: true }), AccessError);
    await assert.rejects(reserveConnectorHost(store, 'unknown-host', 'unknown'), AccessError);
    await assert.rejects(revokeConnectorHost(store, other, pair.hostId), /Only the host owner/);
    await reserveConnectorHost(store, pair.hostId, 'revoked-request');
    await revokeConnectorHost(store, owner, pair.hostId);
    const revoked = signed(pair.hostId, pair.keys.privateKey);
    await assert.rejects(authenticateConnector(store, revoked.request, revoked.raw), AccessError);
    await assert.rejects(pollConnectorJob(store, pair.hostId, 0), AccessError);
    await assert.rejects(recordHostHeartbeat(store, pair.hostId, { models: [], awake: true, ollamaReachable: true }), AccessError);
    await assert.rejects(reserveConnectorHost(store, pair.hostId, 'new-request'), AccessError);
    await assert.rejects(enqueueConnectorInference(store, pair.hostId, 'revoked-request', input), /no matching reservation/);
    assert.deepEqual(await publicConnectorHosts(store), []);
  } finally { await store.close(); }
});

test('routing honors own scope, model, heartbeat age, own-wallet compute and explicit wake capability', async () => {
  const store = new LocalStore(':memory:');
  try {
    const city = await connected(store, other);
    const own = await connected(store);
    const now = Date.now();
    assert.equal((await chooseConnectorHost(store, { subject: owner.subject }, input.model, 'city', now))!.id, own.hostId);
    assert.equal(await chooseConnectorHost(store, {}, input.model, 'own', now), null);
    assert.equal((await chooseConnectorHost(store, { subject: owner.subject, payer: wallet.toUpperCase() }, input.model, 'own', now))!.id, own.hostId);
    assert.equal((await chooseConnectorHost(store, { subject: owner.subject, payer: wallet }, input.model, 'city', now))!.id, own.hostId);
    assert.equal((await chooseConnectorHost(store, { subject: 'unrelated', payer: wallet }, input.model, 'city', now))!.id, city.hostId);
    assert.equal(await chooseConnectorHost(store, { subject: owner.subject }, 'missing-model', 'city', now), null);
    await recordHostHeartbeat(store, own.hostId, { models: [input.model], ollamaReachable: false, awake: false }, now);
    assert.equal((await publicConnectorHosts(store, now)).find((host) => host.id === own.hostId)!.availability, 'asleep');
    assert.equal(await chooseConnectorHost(store, { subject: owner.subject }, input.model, 'own', now), null);
    await recordHostHeartbeat(store, own.hostId, { models: [input.model], ollamaReachable: false, awake: false, canWake: true }, now);
    assert.equal((await chooseConnectorHost(store, { subject: owner.subject }, input.model, 'city', now))!.id, own.hostId);
    assert.equal((await publicConnectorHosts(store, now + 75000)).find((host) => host.id === own.hostId)!.availability, 'asleep');
    assert.equal((await publicConnectorHosts(store, now + 75001)).find((host) => host.id === own.hostId)!.availability, 'offline');
    assert.equal(await chooseConnectorHost(store, { subject: owner.subject }, input.model, 'own', now + 75001), null);
    for (const body of [{ models: Array(17).fill('m'), awake: true, ollamaReachable: true }, { models: ['m'.repeat(129)], awake: true, ollamaReachable: true }, { models: [], awake: 'yes', ollamaReachable: true }])
      await assert.rejects(recordHostHeartbeat(store, own.hostId, body), /Invalid host heartbeat/);
  } finally { await store.close(); }
});

test('one lease is assigned only once to its chosen host and a complete result returns sanitized usage without persisting text', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await connected(store);
    const unrelated = await connected(store, other);
    const { outcome } = await startJob(store, host.hostId);
    await assert.rejects(reserveConnectorHost(store, host.hostId, 'second'), /busy/);
    assert.deepEqual(await pollConnectorJob(store, unrelated.hostId, 0), { job: null });
    const picked = await pollConnectorJob(store, host.hostId, 0);
    assert.deepEqual(picked.job!.messages, input.messages);
    assert.equal(Date.parse(picked.job!.expiresAt) > Date.now(), true);
    assert.deepEqual(await pollConnectorJob(store, host.hostId, 0), { job: null });
    await assert.rejects(completeConnectorJob(store, unrelated.hostId, { jobId: picked.job!.id, response: answer }), /unassigned/);
    await assert.rejects(completeConnectorJob(store, host.hostId, { jobId: 'wrong', response: answer }), /unassigned/);
    await completeConnectorJob(store, host.hostId, { jobId: picked.job!.id, response: answer });
    const completed = await outcome;
    assert.equal(completed.error, null);
    assert.equal(completed.value!.answer, 'Complete answer.');
    assert.equal(completed.value!.usage.inputTokens, 20);
    assert.equal(completed.value!.usage.outputTokens, 10);
    assert.equal(completed.value!.usage.evalMs, 200);
    assert.equal(completed.value!.usage.tokensPerSecond, 50);
    await assert.rejects(completeConnectorJob(store, host.hostId, { jobId: picked.job!.id, response: answer }), /already completed/);
    const persisted = JSON.stringify(await store.scan('local-ai:'));
    assert.equal(persisted.includes('Private question'), false);
    assert.equal(persisted.includes('Complete answer'), false);
    assert.equal((await chooseConnectorHost(store, { subject: owner.subject }, input.model, 'own'))!.id, host.hostId);
  } finally { await store.close(); }
});

test('incomplete, wrong-model, oversized and connector-error answers reject the lease with no success returned', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await connected(store);
    const invalid = [{ ...answer, done: false }, { ...answer, done_reason: 'length' }, { ...answer, model: 'wrong' }, { ...answer, model: undefined },
      { ...answer, message: { role: 'user', content: 'pretend' } }, { ...answer, message: { role: 'assistant', content: ' ' } },
      { ...answer, message: { role: 'assistant', content: 'x'.repeat(16001) } }, { ...answer, error: 'failed' }];
    for (const response of invalid) {
      const { outcome } = await startJob(store, host.hostId);
      const picked = await pollConnectorJob(store, host.hostId, 0);
      await completeConnectorJob(store, host.hostId, { jobId: picked.job!.id, response });
      const result = await outcome;
      assert.equal(result.value, null);
      assert.match(result.error!.message, /incomplete answer/);
      assert.deepEqual(await pollConnectorJob(store, host.hostId, 0), { job: null });
    }
    const { outcome } = await startJob(store, host.hostId);
    const picked = await pollConnectorJob(store, host.hostId, 0);
    await completeConnectorJob(store, host.hostId, { jobId: picked.job!.id, error: 'Private endpoint failed with a secret' });
    assert.match((await outcome).error!.message, /inference failed/);
    assert.equal(JSON.stringify(await store.scan('local-ai:')).includes('secret'), false);
    const sanitized = sanitizeConnectorAnswer({ ...answer, prompt_eval_count: -1, eval_count: 1.5, total_duration: Infinity, load_duration: -1, eval_duration: 'fake' }, input.model, 10);
    assert.deepEqual(sanitized.usage, { inputTokens: null, outputTokens: null, wallMs: 10, totalMs: null, loadMs: null, evalMs: null, tokensPerSecond: null });
    assert.equal(sanitizeConnectorAnswer({ ...answer, message: { role: 'assistant', content: 'x'.repeat(16000) } }, input.model, 1).answer.length, 16000);
  } finally { await store.close(); }
});

test('pickup and result deadlines fail cleanly, release the host, and erase queued questions; retention cancellation does too', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await connected(store);
    const queued = await startJob(store, host.hostId, 'queued');
    await publicConnectorHosts(store, Date.now() + 30000);
    assert.match((await queued.outcome).error!.message, /expired/);
    assert.deepEqual(await pollConnectorJob(store, host.hostId, 0), { job: null });
    const running = await startJob(store, host.hostId, 'running');
    const picked = await pollConnectorJob(store, host.hostId, 0);
    await assert.rejects(completeConnectorJob(store, host.hostId, { jobId: picked.job!.id, response: answer }, Date.parse(picked.job!.expiresAt)), /expired/);
    assert.match((await running.outcome).error!.message, /expired/);
    const canceled = await startJob(store, host.hostId, 'erased-request');
    cancelConnectorInference(store, 'different-request');
    cancelConnectorInference(store, 'erased-request');
    assert.match((await canceled.outcome).error!.message, /erased/);
    assert.deepEqual(await pollConnectorJob(store, host.hostId, 0), { job: null });
    assert.equal(JSON.stringify(await store.scan('local-ai:')).includes('Private question'), false);
  } finally { await store.close(); }
});

test('long polling wakes for work, is bounded to one waiter, and revocation interrupts both polling and inference', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await connected(store);
    const poll = pollConnectorJob(store, host.hostId, 1000);
    await setImmediate();
    await assert.rejects(pollConnectorJob(store, host.hostId, 100), /one outstanding poll/);
    const { outcome } = await startJob(store, host.hostId);
    const picked = await poll;
    assert.equal(picked.job!.model, input.model);
    await recordHostHeartbeat(store, host.hostId, { models: [input.model], awake: true, ollamaReachable: true });
    const idlePoll = pollConnectorJob(store, host.hostId, 1000).then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error }));
    await setImmediate();
    await revokeConnectorHost(store, owner, host.hostId);
    assert.match((await outcome).error!.message, /revoked/);
    assert.match((await idlePoll).error!.message, /revoked/);
    assert.deepEqual(await publicConnectorHosts(store), []);
    await assert.rejects(pollConnectorJob(store, host.hostId, 25001), /25 seconds/);
  } finally { await store.close(); }
});

test('text-only inference limits reject extra tools, images, roles, overlong messages and unsafe options before queuing', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await connected(store);
    const invalid = [{ ...input, tools: [] }, { ...input, model: 'm'.repeat(129) }, { ...input, messages: Array(9).fill(input.messages[0]) },
      { ...input, messages: [{ role: 'tool', content: 'text' }] }, { ...input, messages: [{ role: 'user', content: 'x'.repeat(4001) }] },
      { ...input, messages: Array(4).fill({ role: 'user', content: 'x'.repeat(4000) }) }, { ...input, messages: [{ role: 'user', content: 'hi', images: ['base64'] }] },
      ...[{ num_ctx: 8193 }, { num_predict: 15 }, { num_predict: 193 }, { temperature: 1.01 }, { temperature: NaN }, { extra: true }].map((options) => ({ ...input, options: { ...input.options, ...options } }))];
    for (const body of invalid) await assert.rejects(enqueueConnectorInference(store, host.hostId, 'invalid', body as ConnectorInferenceInput), /Unsupported|Invalid/);
    assert.deepEqual(await pollConnectorJob(store, host.hostId, 0), { job: null });
  } finally { await store.close(); }
});

test('streaming body limits cancel oversized streams before JSON, preserve exact bytes, and reject malformed JSON objects', async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('x'.repeat(40))); }, cancel() { canceled = true; } });
  const tooLarge = new Request('https://app.example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
  await assert.rejects(readConnectorBody(tooLarge, 32), /too large/);
  assert.equal(canceled, true);
  const raw = Buffer.from('{ "question": "ü" }\n');
  const request = new Request('https://app.example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  assert.deepEqual(await readConnectorBody(request, raw.length), raw);
  assert.deepEqual(parseConnectorBody(raw), { question: 'ü' });
  assert.throws(() => parseConnectorBody(Buffer.from('[1]')), /object/);
  assert.throws(() => parseConnectorBody(Buffer.from('{')));
  assert.throws(() => parseConnectorBody(Buffer.from([0xff])));
  await assert.rejects(readConnectorBody(new Request('https://app.example', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1000' }, body: '{}' }), 32), /too large/);
  await assert.rejects(readConnectorBody(new Request('https://app.example', { method: 'POST', headers: { 'content-type': 'application/json-invalid' }, body: '{}' }), 32), /Send JSON/);
});

test('a single-wallet owner routes to its own payout without self-payment while another account cannot buy from that wallet', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await connected(store, other);
    const self = { subject: other.subject, payer: thirdWallet.toUpperCase() };
    assert.equal((await chooseConnectorHost(store, self, input.model, 'own'))!.id, host.hostId);
    assert.equal((await chooseConnectorHost(store, self, input.model, 'city'))!.id, host.hostId);
    assert.equal(await chooseConnectorHost(store, { subject: owner.subject, payer: thirdWallet }, input.model, 'city'), null);
  } finally { await store.close(); }
});

test('reservation races admit only one request, never expose a job, and return busy capacity without losing host quotes', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await connected(store, other);
    const claims = await Promise.allSettled([reserveConnectorHost(store, host.hostId, 'first'), reserveConnectorHost(store, host.hostId, 'second')]);
    assert.equal(claims.filter((claim) => claim.status === 'fulfilled').length, 1);
    const requestId = claims[0].status === 'fulfilled' ? 'first' : 'second';
    const loser = requestId === 'first' ? 'second' : 'first';
    assert.match((claims.find((claim) => claim.status === 'rejected') as PromiseRejectedResult).reason.message, /busy/);
    assert.deepEqual(await pollConnectorJob(store, host.hostId, 0), { job: null });
    assert.equal((await chooseConnectorHost(store, { subject: other.subject, payer: thirdWallet }, input.model, 'own'))!.id, host.hostId);
    releaseConnectorHost(store, host.hostId, loser);
    await assert.rejects(reserveConnectorHost(store, host.hostId, loser), /busy/);
    await assert.rejects(enqueueConnectorInference(store, host.hostId, loser, input), /no matching reservation/);
    releaseConnectorHost(store, host.hostId, requestId);
    await assert.rejects(enqueueConnectorInference(store, host.hostId, requestId, input), /no matching reservation/);
    const { outcome } = await startJob(store, host.hostId, loser);
    releaseConnectorHost(store, host.hostId, loser);
    await assert.rejects(reserveConnectorHost(store, host.hostId, requestId), /busy/);
    const picked = await pollConnectorJob(store, host.hostId, 0);
    await completeConnectorJob(store, host.hostId, { jobId: picked.job!.id, response: answer });
    assert.equal((await outcome).value!.answer, 'Complete answer.');
  } finally { await store.close(); }
});

test('quotes prefer an unoccupied host with equal ownership and cancelled or expired reservations cannot enqueue later', async () => {
  const store = new LocalStore(':memory:');
  try {
    const first = await connected(store);
    const second = await connected(store);
    const now = Date.now();
    await reserveConnectorHost(store, first.hostId, 'cancelled', now);
    assert.equal((await chooseConnectorHost(store, { subject: owner.subject }, input.model, 'own', now))!.id, second.hostId);
    cancelConnectorInference(store, 'cancelled');
    await assert.rejects(enqueueConnectorInference(store, first.hostId, 'cancelled', input), /no matching reservation/);
    assert.deepEqual(await pollConnectorJob(store, first.hostId, 0), { job: null });
    await reserveConnectorHost(store, first.hostId, 'expired', now);
    await publicConnectorHosts(store, now + 30000);
    await assert.rejects(enqueueConnectorInference(store, first.hostId, 'expired', input), /no matching reservation/);
    await reserveConnectorHost(store, first.hostId, 'replacement', now + 30000);
    releaseConnectorHost(store, first.hostId, 'replacement');
    assert.equal((await chooseConnectorHost(store, { subject: owner.subject }, input.model, 'own', now + 30000))!.id, first.hostId);
  } finally { await store.close(); }
});

test('aborted long polls release their waiter immediately and never claim subsequently queued work', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await connected(store);
    const controller = new AbortController();
    const poll = pollConnectorJob(store, host.hostId, 25000, undefined, controller.signal);
    await setImmediate();
    controller.abort();
    const replacement = pollConnectorJob(store, host.hostId, 0);
    assert.deepEqual(await poll, { job: null });
    assert.deepEqual(await replacement, { job: null });
    const { outcome } = await startJob(store, host.hostId);
    assert.deepEqual(await pollConnectorJob(store, host.hostId, 0, undefined, controller.signal), { job: null });
    const picked = await pollConnectorJob(store, host.hostId, 0);
    assert.deepEqual(picked.job!.messages, input.messages);
    await completeConnectorJob(store, host.hostId, { jobId: picked.job!.id, response: answer });
    assert.equal((await outcome).value!.answer, 'Complete answer.');
  } finally { await store.close(); }
});

test('an abort during a registry await releases polling capacity before that await finishes and leaves queued work unclaimed', async () => {
  const store = new LocalStore(':memory:');
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  try {
    const host = await connected(store);
    const update = store.update.bind(store);
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let delayed = true;
    store.update = async <T>(key: string, change: (value: T) => T): Promise<T> => {
      if (delayed) { delayed = false; entered(); await gate; }
      return update(key, change);
    };
    const controller = new AbortController();
    const poll = pollConnectorJob(store, host.hostId, 25000, undefined, controller.signal);
    await reached;
    controller.abort();
    assert.deepEqual(await pollConnectorJob(store, host.hostId, 0), { job: null });
    const { outcome } = await startJob(store, host.hostId);
    unblock();
    assert.deepEqual(await poll, { job: null });
    const picked = await pollConnectorJob(store, host.hostId, 0);
    assert.deepEqual(picked.job!.messages, input.messages);
    await completeConnectorJob(store, host.hostId, { jobId: picked.job!.id, response: answer });
    assert.equal((await outcome).value!.answer, 'Complete answer.');
  } finally { unblock(); await store.close(); }
});

test('blocked body reads meet the overall deadline even if stream cancellation stalls or rejects', { timeout: 1000 }, async () => {
  for (const rejectCancellation of [false, true]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{')); },
      cancel() { cancelled = true; return rejectCancellation ? Promise.reject(new Error('cancel failed')) : new Promise<void>(() => {}); },
    });
    const request = new Request('https://app.example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    await assert.rejects(readConnectorBody(request, 1024, 20), /deadline exceeded/);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  }
});

test('body abort cancels a stalled reader promptly and also rejects a request that was already aborted', { timeout: 1000 }, async () => {
  for (const abortBeforeRead of [false, true]) {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
    const request = new Request('https://app.example', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal, body: stream, duplex: 'half' } as RequestInit);
    if (abortBeforeRead) controller.abort();
    const reading = readConnectorBody(request, 1024).then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error }));
    if (!abortBeforeRead) { await setImmediate(); controller.abort(); }
    assert.match((await reading).error!.message, /aborted/);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  }
});

test('signed routes reject missing or malformed authentication headers before reading an indefinitely blocked body', { timeout: 1000 }, async () => {
  const keys = generateKeyPairSync('ed25519');
  const original = signed('valid-host', keys.privateKey);
  for (const [field, value] of [['x-host-id', ''], ['x-host-timestamp', ''], ['x-host-timestamp', '1.5'],
    ['x-host-timestamp', String(Date.now() - 60001)], ['x-host-nonce', ''], ['x-host-nonce', 'bad'],
    ['x-host-signature', ''], ['x-host-signature', 'not-base64']]) {
    const headers = new Headers(original.request.headers);
    headers.set(field, value);
    const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const request = new Request(original.request.url, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit);
    assert.throws(() => checkConnectorHeaders(request), AccessError);
    const response = await signedHostRoute(request, 1024, async () => ({ ok: true }));
    assert.equal(response.status, 403);
    void stream.cancel().catch(() => {});
  }
});

test('registry cutover preserves active paired keys and durable replay while discarding obsolete pending pairing secrets', async () => {
  const store = new LocalStore(':memory:');
  try {
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const now = Date.now();
    const previous = signed('existing-host', keys.privateKey, '{}', now);
    const host = { id: 'existing-host', name: 'Existing GPU', publicKey, ownerSubject: other.subject, payoutWallet: thirdWallet,
      models: [input.model], lastHeartbeat: now, state: 'active', ollamaReachable: true, awake: true, canWake: false,
      code: null, pairingExpiresAt: now + 600000, nonces: [{ nonce: previous.request.headers.get('x-host-nonce'), timestamp: now }] };
    await store.create('local-ai:connector-registry', {
      hosts: [host, { ...host, id: 'pending-host', state: 'pending', code: 'ABCD2345', ownerSubject: null, payoutWallet: null, nonces: [] }],
      rate: { started: now, total: 30, addresses: { unknown: 5 } },
    });
    const list = await publicConnectorHosts(store, now, other.subject);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, host.id);
    assert.equal(list[0].payoutWallet, thirdWallet);
    assert.equal(list[0].own, true);
    await assert.rejects(authenticateConnector(store, previous.request, previous.raw, now), /already been used/);
    const fresh = signed(host.id, keys.privateKey, '{}', now);
    assert.equal((await authenticateConnector(store, fresh.request, fresh.raw, now)).id, host.id);
    const pending = signed('pending-host', keys.privateKey, '{}', now);
    await assert.rejects(authenticateConnector(store, pending.request, pending.raw, now), AccessError);
    const persisted = JSON.stringify(await store.scan('local-ai:'));
    assert.equal(persisted.includes('ABCD2345'), false);
    assert.equal(persisted.includes('pairingExpiresAt'), false);
    const { outcome } = await startJob(store, host.id);
    const picked = await pollConnectorJob(store, host.id, 0);
    await completeConnectorJob(store, host.id, { jobId: picked.job!.id, response: answer });
    assert.equal((await outcome).value!.answer, 'Complete answer.');
    const newHost = await pairing(store, now, other);
    assert.equal((await publicConnectorHosts(store, now)).some((entry) => entry.id === newHost.hostId), true);
  } finally { await store.close(); }
});
test('one subject retains only its latest unused invitation and cannot exhaust shared slots or bypass its hourly creation rate', async () => {
  const store = new LocalStore(':memory:');
  try {
    const first = await createHostInvitation(store, other, {}, 1000000);
    let latest = first;
    for (let index = 1; index < 5; index++) latest = await createHostInvitation(store, other, {}, 1000000 + index);
    const saved = await store.get<{ invitations: { ownerSubject: string; codeHash: string }[] }>('local-ai:connector-registry');
    assert.equal(saved!.invitations.filter(row => row.ownerSubject === other.subject).length, 1);
    assert.equal(saved!.invitations[0].codeHash, createHash('sha256').update(latest.code).digest('hex'));
    await assert.rejects(createHostInvitation(store, other, {}, 1000010), /five host invitations/);
    await createHostInvitation(store, owner, { payoutWallet: wallet }, 1000010);
    const key = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await assert.rejects(createHostPairing(store, { code: first.code, name: 'GPU', publicKey: key }, 1000010), /expired, used, or unknown/);
    await createHostPairing(store, { code: latest.code, name: 'GPU', publicKey: key }, 1000010);
    await createHostInvitation(store, other, {}, 4600000);
  } finally { await store.close(); }
});
test('community aliases cannot use trusted branding or invisible formatting, and refused names do not consume the invitation', async () => {
  const store = new LocalStore(':memory:');
  try {
    const community = { ...other, wallets: [{ id: 'community', chainType: 'ethereum' as const, address: alternateWallet }] };
    const invitation = await createHostInvitation(store, community, {}, 1000000);
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    for (const name of ['Official GPU', 'OPERATOR GPU', 'Ledger of Life desktop', 'Ｏｆｆｉｃｉａｌ GPU', ...[0x202e, 0x200b, 0x034f].map(code => `GPU${String.fromCodePoint(code)}`)]) {
      await assert.rejects(createHostPairing(store, { code: invitation.code, name, publicKey }, 1000000), /host name|must not claim/);
    }
    const pair = await createHostPairing(store, { code: invitation.code, name: 'Neighbour GPU', publicKey }, 1000000);
    assert.equal((await ownedConnectorHosts(store, community, 1000000)).find(host => host.id === pair.hostId)!.kind, 'community');
  } finally { await store.close(); }
});
