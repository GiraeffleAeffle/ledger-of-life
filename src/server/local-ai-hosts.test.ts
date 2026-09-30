import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { LocalStore } from './store.ts';
import { AccessError } from './errors.ts';
import { approveHostPairing, authenticateConnector, cancelConnectorInference, chooseConnectorHost, completeConnectorJob, connectorSigningBytes,
  createHostPairing, enqueueConnectorInference, hostPairingAllowed, parseConnectorBody, pollConnectorJob, publicConnectorHosts,
  readConnectorBody, recordHostHeartbeat, revokeConnectorHost, sanitizeConnectorAnswer, type ConnectorInferenceInput } from './local-ai-hosts.ts';

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
  wallets: [{ id: 'one', chainType: 'ethereum', address: wallet }, { id: 'two', chainType: 'ethereum', address: alternateWallet }], passkeyCount: 0, backupLoginLinked: true };
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
async function pairing(store: LocalStore, now = Date.now(), address = 'address') {
  const keys = generateKeyPairSync('ed25519');
  const pair = await createHostPairing(store, { name: 'Home GPU', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }, address, now);
  return { ...pair, keys };
}
async function approved(store: LocalStore, identity = owner) {
  const pair = await pairing(store, Date.now(), identity.subject);
  await approveHostPairing(store, identity, { code: pair.code });
  await recordHostHeartbeat(store, pair.hostId, { models: [input.model], ollamaReachable: true, awake: true });
  return pair;
}
async function startJob(store: LocalStore, hostId: string, requestId = 'request') {
  const outcome = enqueueConnectorInference(store, hostId, requestId, input).then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error }));
  await setImmediate();
  return { outcome };
}

test('pairing binds one canonical Ed25519 key, is single use, and exposes no authentication secrets', async () => {
  const store = new LocalStore(':memory:');
  try {
    const first = await pairing(store);
    const second = await pairing(store);
    assert.match(first.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(Date.parse(first.expiresAt) > Date.now(), true);
    assert.equal(hostPairingAllowed(owner), true); // Existing session is sufficient; no pretend passkey re-auth.
    const results = await Promise.allSettled([approveHostPairing(store, owner, { code: first.code }), approveHostPairing(store, owner, { code: first.code })]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const list = await publicConnectorHosts(store);
    assert.equal(list.find((host) => host.id === first.hostId)!.payoutWallet, wallet);
    assert.equal(list.find((host) => host.id === second.hostId)!.state, 'pending');
    for (const host of list) for (const key of ['publicKey', 'code', 'nonces', 'pairingExpiresAt']) assert.equal(key in host, false);
    const wrong = signed(first.hostId, second.keys.privateKey);
    await assert.rejects(authenticateConnector(store, wrong.request, wrong.raw), /Invalid connector signature/);
    const good = signed(first.hostId, first.keys.privateKey);
    assert.equal((await authenticateConnector(store, good.request, good.raw)).id, first.hostId);
  } finally { await store.close(); }
});

test('pairing expires at ten minutes and cannot admit non-EVM, non-allowlisted or foreign payout wallets', async () => {
  const store = new LocalStore(':memory:');
  try {
    const pair = await pairing(store, 1000000);
    const notAllowed = { ...owner, wallets: [{ id: 'foreign', address: alternateWallet, chainType: 'ethereum' as const }], passkeyCount: 10 };
    const notEvm = { ...owner, wallets: [{ id: 'solana', address: wallet, chainType: 'solana' as const }] };
    assert.equal(hostPairingAllowed(notAllowed), false);
    assert.equal(hostPairingAllowed(notEvm), false);
    await assert.rejects(approveHostPairing(store, notAllowed, { code: pair.code }, 1000001), /allowlisted EVM/);
    await assert.rejects(approveHostPairing(store, notEvm, { code: pair.code }, 1000001), /allowlisted EVM/);
    await assert.rejects(approveHostPairing(store, owner, { code: pair.code, payoutWallet: thirdWallet }, 1000001), /own verified EVM/);
    await assert.rejects(approveHostPairing(store, owner, { code: pair.code }, 1600000), /expired/);
    assert.deepEqual(await publicConnectorHosts(store, 1600000), []);
    const fresh = await pairing(store, 1600000);
    assert.equal((await approveHostPairing(store, owner, { code: fresh.code, payoutWallet: alternateWallet }, 1600001)).payoutWallet, alternateWallet);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
    await assert.rejects(createHostPairing(store, { name: 'Wrong', publicKey: rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }, 'wrong', 1600002), /Ed25519/);
    await assert.rejects(createHostPairing(store, { name: 'Wrong', publicKey: 'not-base64' }, 'wrong', 1600002), /Ed25519/);
  } finally { await store.close(); }
});

test('pairing has persistent per-address and global caps despite address rotation; windows and stored buckets expire', async () => {
  const store = new LocalStore(':memory:');
  try {
    for (let index = 0; index < 5; index++) await pairing(store, 1000000, 'one-address');
    await assert.rejects(pairing(store, 1000000, 'one-address'), /Too many/);
    for (let index = 0; index < 25; index++) await pairing(store, 1000000, `spoof-${index}`);
    await assert.rejects(pairing(store, 1000000, 'another-spoof'), /Too many/);
    await pairing(store, 1600000, 'one-address');
    const record = await store.get<{ rate: { total: number; addresses: Record<string, number> }; hosts: unknown[] }>('local-ai:connector-registry');
    assert.equal(record!.rate.total, 1);
    assert.equal(Object.keys(record!.rate.addresses).length, 1);
    assert.equal(record!.hosts.length, 1);
  } finally { await store.close(); }
});

test('signed requests bind exact bytes, method, path, timestamp, nonce and host ID; replay is atomic', async () => {
  const store = new LocalStore(':memory:');
  try {
    const pair = await approved(store);
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
    const pair = await approved(first);
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

test('pending and revoked keys cannot authenticate, heartbeat or lease jobs; only owner can revoke', async () => {
  const store = new LocalStore(':memory:');
  try {
    const pair = await pairing(store);
    const pending = signed(pair.hostId, pair.keys.privateKey);
    await assert.rejects(authenticateConnector(store, pending.request, pending.raw), AccessError);
    await assert.rejects(pollConnectorJob(store, pair.hostId, 0), AccessError);
    await assert.rejects(recordHostHeartbeat(store, pair.hostId, { models: [], awake: true, ollamaReachable: true }), AccessError);
    await assert.rejects(enqueueConnectorInference(store, pair.hostId, 'pending', input), AccessError);
    await approveHostPairing(store, owner, { code: pair.code });
    await assert.rejects(revokeConnectorHost(store, other, pair.hostId), /Only the host owner/);
    await revokeConnectorHost(store, owner, pair.hostId);
    const revoked = signed(pair.hostId, pair.keys.privateKey);
    await assert.rejects(authenticateConnector(store, revoked.request, revoked.raw), /revoked/);
    await assert.rejects(pollConnectorJob(store, pair.hostId, 0), /revoked/);
    await assert.rejects(recordHostHeartbeat(store, pair.hostId, { models: [], awake: true, ollamaReachable: true }), /revoked/);
  } finally { await store.close(); }
});

test('routing honors own scope, model, heartbeat age, self-payment exclusion and explicit wake capability', async () => {
  const store = new LocalStore(':memory:');
  try {
    const city = await approved(store, other);
    const own = await approved(store);
    const now = Date.now();
    assert.equal((await chooseConnectorHost(store, { subject: owner.subject }, input.model, 'city', now))!.id, own.hostId);
    assert.equal(await chooseConnectorHost(store, {}, input.model, 'own', now), null);
    assert.equal(await chooseConnectorHost(store, { subject: owner.subject, payer: wallet.toUpperCase() }, input.model, 'own', now), null);
    assert.equal((await chooseConnectorHost(store, { subject: owner.subject, payer: wallet }, input.model, 'city', now))!.id, city.hostId);
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
    const host = await approved(store);
    const unrelated = await approved(store, other);
    const { outcome } = await startJob(store, host.hostId);
    await assert.rejects(enqueueConnectorInference(store, host.hostId, 'second', input), /busy/);
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
    const host = await approved(store);
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
    const host = await approved(store);
    const queued = await startJob(store, host.hostId, 'queued');
    await publicConnectorHosts(store, Date.now() + 30000);
    assert.match((await queued.outcome).error!.message, /expired/);
    assert.deepEqual(await pollConnectorJob(store, host.hostId, 0), { job: null });
    const running = await startJob(store, host.hostId, 'running');
    const picked = await pollConnectorJob(store, host.hostId, 0);
    await assert.rejects(completeConnectorJob(store, host.hostId, { jobId: picked.job!.id, response: answer }, Date.now() + 90000), /expired/);
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
    const host = await approved(store);
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
    assert.equal((await publicConnectorHosts(store))[0].availability, 'offline');
    await assert.rejects(pollConnectorJob(store, host.hostId, 25001), /25 seconds/);
  } finally { await store.close(); }
});

test('text-only inference limits reject extra tools, images, roles, overlong messages and unsafe options before queuing', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await approved(store);
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
