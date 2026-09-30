import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import type { LocalAiRequest } from './local-ai-types.ts';
import { LocalStore } from './store.ts';
import { executeAiRequest, libraryOwner, purgeVisitorText, readAiRequest, sweepAiText } from './local-ai.ts';
import { localAiUsage } from './local-ai-operations.ts';
import { facilitatorAccount, inspectAiReceipt, recoverExpiredUnsignedSettlement, validatePaymentPayload, verifyCanonicalTransfer, type AiPaidRecord, type AiPayment } from './local-ai-payment.ts';
import { prepareInferencePayment } from '../wallets/inference-signing.ts';
import { validateEvmSigningRequest } from '../wallets/signing-policy.ts';
import { revokeVisitor } from './local-ai-session.ts';
import { TEST_USDG_ADDRESS } from '../wallets/inference-token.ts';
import { inferenceCharge, inferenceMaximum } from './local-ai-runtime.ts';
import { x402UptoPermit2ProxyABI, x402UptoPermit2ProxyAddress } from '@x402/evm';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, hashTypedData, keccak256, parseAbi, parseAbiParameters, parseTransaction, recoverTypedDataAddress, type Hex, type TransactionReceipt, type TypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const owner = libraryOwner('a'.repeat(64));
const other = libraryOwner('b'.repeat(64));
const route = (id: string) => `http://localhost:4175/api/local-ai/requests/${id}`;
const first = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';
const body = { mode: 'library', prompt: 'Explain deposit release carefully.', maxOutputTokens: 64, context: 'housing' };

test('free visitor owns actual persisted inference; replay never reruns or bills', async () => {
  const store = new LocalStore(':memory:');
  const originalFetch = globalThis.fetch;
  const oldUrl = process.env.LOCAL_AI_OLLAMA_URL;
  process.env.LOCAL_AI_OLLAMA_URL = 'http://local-test';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ model: process.env.LOCAL_AI_MODEL || 'qwen3.8:27b-ud-q3-k-xl', done: true, done_reason: 'stop',
      message: { content: 'A deposit is held until the agreed release.' }, prompt_eval_count: 22, eval_count: 11, eval_duration: 200_000_000 });
  };
  try {
    const completed = await executeAiRequest(store, first, owner, body, route(first), null);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.payment.amountAtomic, '0');
    assert.equal(completed.payment.receipt, null);
    assert.match(completed.answer!, /agreed release/);
    const replay = await executeAiRequest(store, first, owner, body, route(first), null);
    assert.deepEqual(replay, completed);
    assert.equal(calls, 1);
    await assert.rejects(() => executeAiRequest(store, first, owner, { ...body, prompt: 'Different input.' }, route(first), null), /different inference inputs/);
    await assert.rejects(() => readAiRequest(store, first, other), /another visitor/);
    const usage = await localAiUsage(store);
    assert.equal(usage.successfulLibraryRequests, 1);
    assert.equal(usage.successfulPaidRequests, 0);
    assert.equal(usage.settledAtomic, '0');
    assert.equal(usage.knownOutputTokens, 11);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) delete process.env.LOCAL_AI_OLLAMA_URL;
    else process.env.LOCAL_AI_OLLAMA_URL = oldUrl;
    await store.close();
  }
});

test('incomplete inference is terminal, does not count revenue, and cannot be replayed as success', async () => {
  const store = new LocalStore(':memory:');
  const originalFetch = globalThis.fetch;
  const oldUrl = process.env.LOCAL_AI_OLLAMA_URL;
  process.env.LOCAL_AI_OLLAMA_URL = 'http://local-test';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ done: false, message: { content: 'partial' } }); };
  try {
    const failed = await executeAiRequest(store, second, owner, body, route(second), null);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.answer, null);
    assert.equal(failed.payment.state, 'none');
    assert.equal((await executeAiRequest(store, second, owner, body, route(second), null)).state, 'failed');
    assert.equal(calls, 1);
    assert.equal((await localAiUsage(store)).settledAtomic, '0');
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) delete process.env.LOCAL_AI_OLLAMA_URL;
    else process.env.LOCAL_AI_OLLAMA_URL = oldUrl;
    await store.close();
  }
});

test('shared daily quota prevents cookie rotation from starting a thirty-first model call', async () => {
  const store = new LocalStore(':memory:');
  const originalFetch = globalThis.fetch;
  const oldUrl = process.env.LOCAL_AI_OLLAMA_URL;
  process.env.LOCAL_AI_OLLAMA_URL = 'http://local-test';
  const day = `local-ai:library-day:${new Date().toISOString().slice(0, 10)}`;
  await store.create(day, { attempts: 29 });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ done: false }); };
  const last = '55555555-5555-4555-8555-555555555555';
  const denied = '66666666-6666-4666-8666-666666666666';
  try {
    assert.equal((await executeAiRequest(store, last, owner, body, route(last), null)).state, 'failed');
    await assert.rejects(() => executeAiRequest(store, denied, other, body, route(denied), null), /30 daily inference attempts/);
    assert.equal(calls, 1);
    assert.equal((await store.get<{ attempts: number }>(day))?.attempts, 30);
    assert.equal((await localAiUsage(store)).settledAtomic, '0');
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) delete process.env.LOCAL_AI_OLLAMA_URL;
    else process.env.LOCAL_AI_OLLAMA_URL = oldUrl;
    await store.close();
  }
});

test('clearing the desk during inference revokes its in-flight result and all subsequent reads', async () => {
  const store = new LocalStore(':memory:');
  const originalFetch = globalThis.fetch;
  const oldUrl = process.env.LOCAL_AI_OLLAMA_URL;
  process.env.LOCAL_AI_OLLAMA_URL = 'http://local-test';
  let enter!: () => void;
  let finish!: (response: Response) => void;
  const started = new Promise<void>((resolve) => { enter = resolve; });
  const answer = new Promise<Response>((resolve) => { finish = resolve; });
  globalThis.fetch = async () => { enter(); return answer; };
  const id = '77777777-7777-4777-8777-777777777777';
  try {
    const pending = executeAiRequest(store, id, owner, body, route(id), null);
    await started;
    await revokeVisitor(store, owner.visitor);
    finish(Response.json({ model: process.env.LOCAL_AI_MODEL || 'qwen3.8:27b-ud-q3-k-xl',
      done: true, done_reason: 'stop', message: { content: 'Private answer from the local model.' } }));
    await assert.rejects(pending, /session has ended/);
    assert.equal((await store.get<{ request: LocalAiRequest }>(`local-ai:request:${id}`))?.request.answer, null);
    await assert.rejects(() => readAiRequest(store, id, owner), /session has ended/);
    await assert.rejects(() => executeAiRequest(store, id, owner, body, route(id), null), /session has ended/);
    await assert.rejects(() => readAiRequest(store, id, other), /another visitor/);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) delete process.env.LOCAL_AI_OLLAMA_URL;
    else process.env.LOCAL_AI_OLLAMA_URL = oldUrl;
    await store.close();
  }
});

test('stale running inference becomes interrupted without answer or paid revenue', async () => {
  const store = new LocalStore(':memory:');
  const id = '44444444-4444-4444-8444-444444444444';
  const request: LocalAiRequest = {
    id, mode: 'library', state: 'running', model: 'qwen3.8:27b-ud-q3-k-xl',
    prompt: body.prompt, maxOutputTokens: body.maxOutputTokens, requestFingerprint: `0x${'ab'.repeat(32)}`,
    createdAt: new Date(Date.now() - 200000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    answer: null, usage: null, error: null, payment: { state: 'none', amountAtomic: '0', receipt: null },
    review: null, paymentRequired: null, approval: null,
  };
  try {
    await store.create(`local-ai:request:${id}`, { id, owner, mode: 'library', request, runningAt: Date.now() - 160000 });
    const interrupted = await readAiRequest(store, id, owner);
    assert.equal(interrupted.state, 'interrupted');
    assert.equal(interrupted.answer, null);
    assert.equal(interrupted.payment.receipt, null);
    assert.equal((await localAiUsage(store)).settledAtomic, '0');
    await assert.rejects(() => readAiRequest(store, id, other), /another visitor/);
  } finally { await store.close(); }
});

test('completed library and paid results retain text until grace and preserve the public usage summary', async () => {
  const store = new LocalStore(':memory:');
  const originalFetch = globalThis.fetch;
  const oldUrl = process.env.LOCAL_AI_OLLAMA_URL;
  process.env.LOCAL_AI_OLLAMA_URL = 'http://local-test';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ model: process.env.LOCAL_AI_MODEL || 'qwen3.8:27b-ud-q3-k-xl',
      done: true, done_reason: 'stop', message: { content: 'Private generated answer' },
      prompt_eval_count: 13, eval_count: 6, eval_duration: 200_000_000 });
  };
  try {
    const completed = await executeAiRequest(store, first, owner, body, route(first), null);
    const now = Date.now();
    const key = `local-ai:request:${first}`;
    const record = (await store.get<Record<string, unknown>>(key))!;
    const paidId = '88888888-8888-4888-8888-888888888888';
    const paidKey = `local-ai:request:${paidId}`;
    await store.create(paidKey, { ...record, id: paidId, mode: 'paid', owner: { subject: 'owner', walletId: 'wallet', payer: TEST_USDG_ADDRESS },
      request: { ...completed, id: paidId, mode: 'paid', payment: { state: 'settled', amountAtomic: '10000',
        receipt: { success: true, transaction: '0xreceipt' } } } });
    await store.update<typeof record>(key, (value) => ({ ...value, completedAt: new Date(now - 600_001).toISOString() }));
    await store.update<typeof record>(paidKey, (value) => ({ ...value, completedAt: new Date(now - 599_999).toISOString() }));
    const before = await localAiUsage(store);
    assert.equal((await store.get<{ request: LocalAiRequest }>(key))?.request.answer, 'Private generated answer');
    assert.equal((await readAiRequest(store, first, owner)).answer, null);
    assert.equal((await store.get<{ request: LocalAiRequest }>(key))?.request.prompt, '');
    assert.equal((await sweepAiText(store, '', now)).scrubbed, 0);
    assert.equal((await store.get<{ request: LocalAiRequest }>(paidKey))?.request.answer, 'Private generated answer');
    const paid = await sweepAiText(store, '', now + 2);
    assert.equal(paid.scrubbed, 1);
    assert.equal((await store.get<{ request: LocalAiRequest }>(paidKey))?.request.prompt, '');
    assert.deepEqual(await localAiUsage(store), before);
    assert.equal((await executeAiRequest(store, first, owner, body, route(first), null)).purgedAt != null, true);
    assert.equal(calls, 1);
    await assert.rejects(() => executeAiRequest(store, first, owner, { ...body, prompt: 'Different input.' }, route(first), null), /different inference inputs/);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) delete process.env.LOCAL_AI_OLLAMA_URL;
    else process.env.LOCAL_AI_OLLAMA_URL = oldUrl;
    await store.close();
  }
});

test('abandoned pre-payment quote purges after expiry; active inference and payment remain private but intact', async () => {
  const store = new LocalStore(':memory:');
  const now = Date.now();
  const base: LocalAiRequest = { id: first, mode: 'library', state: 'payment_required', model: 'local-model',
    prompt: body.prompt, maxOutputTokens: 64, requestFingerprint: 'immutable', createdAt: new Date(now - 2_000_000).toISOString(),
    expiresAt: new Date(now - 600_001).toISOString(), answer: 'Saved output', usage: null, error: null,
    payment: { state: 'quoted', amountAtomic: '0', receipt: null }, review: null, paymentRequired: null, approval: null };
  try {
    const variants = ['payment_required', 'running', 'settling', 'authorized', 'pending'] as const;
    for (const [index, variant] of variants.entries()) {
      const id = `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`;
      await store.create(`local-ai:request:${id}`, { id, mode: 'library', owner, request: {
        ...base, id, state: variant === 'running' || variant === 'settling' ? variant : 'payment_required',
        payment: { ...base.payment, state: variant === 'authorized' || variant === 'pending' ? variant : 'quoted' },
      }, paymentJournal: null });
    }
    assert.equal((await sweepAiText(store, '', now)).scrubbed, 1);
    for (const [index] of variants.entries()) {
      const id = `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`;
      const saved = (await store.get<{ request: LocalAiRequest }>(`local-ai:request:${id}`))!.request;
      assert.equal(saved.prompt, index === 0 ? '' : body.prompt);
      assert.equal(saved.answer, index === 0 ? null : 'Saved output');
    }
  } finally { await store.close(); }
});

test('visitor clear erases its active and saved text across every page without erasing another visitor', async () => {
  const store = new LocalStore(':memory:');
  const now = Date.now();
  const old = new Date(now - 700_000).toISOString();
  const request: LocalAiRequest = { id: first, mode: 'library', state: 'completed', model: 'local-model',
    prompt: body.prompt, maxOutputTokens: 64, requestFingerprint: 'immutable', createdAt: old, expiresAt: old,
    answer: 'Private answer', usage: null, error: null, payment: { state: 'none', amountAtomic: '0', receipt: null },
    review: null, paymentRequired: null, approval: null };
  try {
    for (let index = 0; index < 205; index++) {
      const id = `local-ai:request:${String(index).padStart(4, '0')}`;
      await store.create(id, { id, mode: 'library', owner: index === 204 ? other : owner,
        request: { ...request, state: index === 203 ? 'running' : 'completed' }, paymentJournal: null, completedAt: old });
    }
    await purgeVisitorText(store, owner.visitor);
    assert.equal((await store.get<{ request: LocalAiRequest }>('local-ai:request:0202'))?.request.answer, null);
    const interrupted = await store.get<{ request: LocalAiRequest }>('local-ai:request:0203');
    assert.equal(interrupted?.request.state, 'interrupted');
    assert.equal(interrupted?.request.prompt, '');
    assert.equal(interrupted?.request.answer, null);
    assert.equal((await store.get<{ request: LocalAiRequest }>('local-ai:request:0204'))?.request.answer, 'Private answer');
    const firstPage = await sweepAiText(store, '', now);
    assert.equal(firstPage.scrubbed, 0);
    assert.equal(firstPage.next, 'local-ai:request:0199');
    const secondPage = await sweepAiText(store, firstPage.next!, now);
    assert.equal(secondPage.scrubbed, 1);
    assert.equal(secondPage.next, null);
    assert.equal((await sweepAiText(store, '', now)).scrubbed, 0);
    assert.equal((await store.get<{ request: LocalAiRequest }>('local-ai:request:0204'))?.request.answer, null);
  } finally { await store.close(); }
});

test('JSON-RPC inference signing preserves uint256 precision and rejects altered payment authority', async () => {
  const account = privateKeyToAccount(`0x${'71'.repeat(32)}`);
  const wallet = { id: 'personal', address: account.address, chainType: 'ethereum' as const, connected: true };
  const review = { walletId: wallet.id, operationId: first, description: 'Pay for one completed answer',
    expiresAt: new Date(Date.now() + 600_000).toISOString(), requestId: first,
    requestFingerprint: `0x${'ab'.repeat(32)}` as Hex, resourceUrl: route(first),
    chainId: 46630 as const, asset: TEST_USDG_ADDRESS, payTo: privateKeyToAccount(`0x${'72'.repeat(32)}`).address,
    maxOutputTokens: 100, facilitatorAddress: privateKeyToAccount(`0x${'77'.repeat(32)}`).address, amountAtomic: '10000', nonce: ((1n << 255n) + 12345n).toString(), validAfter: '0', deadline: `${Math.floor(Date.now() / 1000) + 600}` };
  const typed = prepareInferencePayment(review, wallet);
  const wire = JSON.parse(JSON.stringify(typed)) as typeof typed;
  const signature = await account.signTypedData<TypedData, 'PermitWitnessTransferFrom'>(wire);
  const canonicalMessage = {
    ...typed.message, permitted: { ...typed.message.permitted, amount: 10000n },
    nonce: BigInt(review.nonce), deadline: BigInt(review.deadline),
    witness: { ...typed.message.witness, validAfter: 0n },
  };
  assert.equal(hashTypedData<TypedData, 'PermitWitnessTransferFrom'>(wire), hashTypedData({ ...typed, message: canonicalMessage }));
  assert.equal(await recoverTypedDataAddress<TypedData, 'PermitWitnessTransferFrom'>({ ...wire, signature }), account.address);
  assert.throws(() => prepareInferencePayment({ ...review, amountAtomic: '100000' }, wallet), /does not match/);
  assert.throws(() => prepareInferencePayment({ ...review, nonce: '-1' }, wallet), /does not match/);
  assert.throws(() => prepareInferencePayment({ ...review, payTo: wallet.address }, wallet), /does not match/);
  assert.throws(() => prepareInferencePayment(review, { ...wallet, connected: false }), /does not match/);
});

test('payment identifier, owner, nonce, recipient and maximum amount must match immutable quote', () => {
  const payer = privateKeyToAccount(`0x${'73'.repeat(32)}`).address;
  const payee = privateKeyToAccount(`0x${'74'.repeat(32)}`).address;
  const facilitator = privateKeyToAccount(`0x${'78'.repeat(32)}`).address;
  const accepted: PaymentRequirements = { scheme: 'upto', network: 'eip155:46630', asset: TEST_USDG_ADDRESS,
    amount: '10000', payTo: payee, maxTimeoutSeconds: 1200, extra: { assetTransferMethod: 'permit2', facilitatorAddress: facilitator } };
  const authorization = { from: payer, permitted: { token: TEST_USDG_ADDRESS, amount: '10000' },
    spender: x402UptoPermit2ProxyAddress,
    nonce: '234', deadline: String(Math.floor(Date.now() / 1000) + 600),
    witness: { to: payee, facilitator, validAfter: '0' } };
  const payload: PaymentPayload = { x402Version: 2, accepted, resource: { url: route(first) },
    extensions: { 'payment-identifier': { info: { required: true, id: first } } },
    payload: { signature: `0x${'55'.repeat(65)}`, permit2Authorization: authorization } };
  assert.equal(validatePaymentPayload(payload, accepted, first, payer, payee, route(first), 10000n, facilitator).nonce, '234');
  assert.throws(() => validatePaymentPayload(payload, accepted, first, payer, payer, route(first), 10000n, facilitator), /reviewed/);
  assert.throws(() => validatePaymentPayload(payload, { ...accepted, amount: '20000' }, first, payer, payee, route(first), 10000n, facilitator), /reviewed/);
  assert.throws(() => validatePaymentPayload(payload, accepted, second, payer, payee, route(first), 10000n, facilitator), /reviewed/);
  assert.throws(() => validatePaymentPayload(payload, accepted, first, payer, payee, route(second), 10000n, facilitator), /reviewed/);
  const changed: PaymentPayload = { ...payload, payload: { signature: `0x${'55'.repeat(65)}`,
    permit2Authorization: { ...authorization, nonce: '01' } } };
  assert.throws(() => validatePaymentPayload(changed, accepted, first, payer, payee, route(first), 10000n, facilitator), /reviewed/);
  assert.throws(() => validatePaymentPayload(payload, accepted, first, payer, payee, route(first), 9900n, facilitator), /reviewed/);
  assert.throws(() => validatePaymentPayload({ ...payload, payload: { signature: `0x${'55'.repeat(65)}`,
    permit2Authorization: { ...authorization, witness: { ...authorization.witness, facilitator: payer } } } },
    accepted, first, payer, payee, route(first), 10000n, facilitator), /reviewed/);
});

test('finite Permit2 approval cannot become an unlimited or redirected wallet signature', () => {
  const wallet = { id: 'personal', address: privateKeyToAccount(`0x${'75'.repeat(32)}`).address,
    chainType: 'ethereum' as const, connected: true };
  const abi = parseAbi(['function approve(address,uint256) returns (bool)']);
  const finite = encodeFunctionData({ abi, functionName: 'approve',
    args: ['0x000000000022D473030F116dDEE9F6B43aC78BA3', 100000n] });
  const request = { walletId: wallet.id, operationId: `local-ai-approval:${first}`,
    description: 'Approve finite token spend', expiresAt: new Date(Date.now() + 500000).toISOString(),
    transaction: { chainId: 46630 as const, to: TEST_USDG_ADDRESS, from: wallet.address,
      data: finite, nonce: 0, value: '0x0' as const, gasLimit: '0x15f90' as const,
      maxFeePerGas: '0x3b9aca00' as const, maxPriorityFeePerGas: '0x0' as const } };
  assert.doesNotThrow(() => validateEvmSigningRequest(request, wallet));
  assert.throws(() => validateEvmSigningRequest({ ...request, transaction: { ...request.transaction,
    data: encodeFunctionData({ abi, functionName: 'approve',
      args: ['0x000000000022D473030F116dDEE9F6B43aC78BA3', 2n ** 256n - 1n] }) } }, wallet), /finite/);
  assert.throws(() => validateEvmSigningRequest({ ...request, transaction: { ...request.transaction,
    data: encodeFunctionData({ abi, functionName: 'approve',
      args: [privateKeyToAccount(`0x${'76'.repeat(32)}`).address, 100000n] }) } }, wallet), /finite/);
});

test('canonical receipt requires exactly one matching token Transfer, not merely receipt success', () => {
  const payer = privateKeyToAccount(`0x${'81'.repeat(32)}`).address;
  const payee = privateKeyToAccount(`0x${'82'.repeat(32)}`).address;
  const abi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const event = (amount: bigint) => ({ address: TEST_USDG_ADDRESS,
    topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from: payer, to: payee } }),
    data: encodeAbiParameters(parseAbiParameters('uint256'), [amount]) });
  const receipt = (amounts: bigint[]) => ({ status: 'success', logs: amounts.map(event) });
  assert.equal(verifyCanonicalTransfer(receipt([10000n]) as unknown as TransactionReceipt, payer, payee, 10000n), true);
  assert.equal(verifyCanonicalTransfer(receipt([]) as unknown as TransactionReceipt, payer, payee, 10000n), false);
  assert.equal(verifyCanonicalTransfer(receipt([9000n]) as unknown as TransactionReceipt, payer, payee, 10000n), false);
  assert.equal(verifyCanonicalTransfer(receipt([10000n, 10000n]) as unknown as TransactionReceipt, payer, payee, 10000n), false);
});

test('confirmed settlement requires the journaled upto proxy call and canonical matching receipt', async () => {
  const facilitator = privateKeyToAccount(`0x${'91'.repeat(32)}`);
  const payer = privateKeyToAccount(`0x${'92'.repeat(32)}`).address;
  const payee = privateKeyToAccount(`0x${'93'.repeat(32)}`).address;
  const signature = `0x${'55'.repeat(65)}` as Hex;
  const authorization = { from: payer, permitted: { token: TEST_USDG_ADDRESS, amount: '10000' },
    spender: x402UptoPermit2ProxyAddress, nonce: '314', deadline: String(Math.floor(Date.now() / 1000) + 600),
    witness: { to: payee, facilitator: facilitator.address, validAfter: '0' } };
  const accepted: PaymentRequirements = { scheme: 'upto', network: 'eip155:46630',
    asset: TEST_USDG_ADDRESS, amount: '10000', payTo: payee, maxTimeoutSeconds: 1200,
    extra: { assetTransferMethod: 'permit2', facilitatorAddress: facilitator.address } };
  const payload: PaymentPayload = { x402Version: 2, accepted, payload: { signature, permit2Authorization: authorization } };
  const data = encodeFunctionData({ abi: x402UptoPermit2ProxyABI, functionName: 'settle', args: [
    { permitted: { token: TEST_USDG_ADDRESS, amount: 10000n }, nonce: 314n, deadline: BigInt(authorization.deadline) },
    600n, payer, { to: payee, facilitator: facilitator.address, validAfter: 0n }, signature,
  ] });
  const sign = (callData: Hex) => facilitator.signTransaction({ type: 'eip1559', chainId: 46630,
    to: x402UptoPermit2ProxyAddress, data: callData, value: 0n, nonce: 5,
    gas: 300000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 0n });
  const journal: AiPayment = { payload, amount: '600', requirements: accepted, signed: await sign(data), hash: null, nonce: 5 };
  journal.hash = keccak256(journal.signed!);
  const abi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const transfer = { address: TEST_USDG_ADDRESS,
    topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from: payer, to: payee } }),
    data: encodeAbiParameters(parseAbiParameters('uint256'), [600n]) };
  const blockHash = `0x${'ab'.repeat(32)}` as Hex;
  let tip = 44n;
  let canonicalBlockHash = blockHash;
  let input = data;
  let available = true;
  const rpc = {
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!available) throw new Error('Receipt not found');
      return { status: 'success', transactionHash: hash, blockHash, blockNumber: 42n, logs: [transfer] };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => ({
      hash, blockHash, from: facilitator.address, to: x402UptoPermit2ProxyAddress,
      input, nonce: 5, value: 0n, chainId: 46630, gas: 300000n,
      maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 0n,
    }),
    getBlock: async () => ({ hash: canonicalBlockHash }),
    getBlockNumber: async () => tip,
  } as unknown as Parameters<typeof inspectAiReceipt>[3];
  assert.equal(await inspectAiReceipt(journal, payer, payee, rpc, facilitator.address), 'settled');
  journal.amount = '700';
  assert.equal(await inspectAiReceipt(journal, payer, payee, rpc, facilitator.address), 'pending');
  journal.amount = '600';
  tip = 43n;
  assert.equal(await inspectAiReceipt(journal, payer, payee, rpc, facilitator.address), 'pending');
  tip = 44n; canonicalBlockHash = `0x${'cd'.repeat(32)}` as Hex;
  assert.equal(await inspectAiReceipt(journal, payer, payee, rpc, facilitator.address), 'pending');
  canonicalBlockHash = blockHash; available = false;
  assert.equal(await inspectAiReceipt(journal, payer, payee, rpc, facilitator.address), 'pending');
  available = true;
  journal.signed = await sign('0xdeadbeef'); journal.hash = keccak256(journal.signed);
  input = parseTransaction(journal.signed).data!;
  assert.equal(await inspectAiReceipt(journal, payer, payee, rpc, facilitator.address), 'pending');
});

test('expired unsigned fee envelope is fenced and released, but signed ambiguity keeps its lane', async () => {
  const store = new LocalStore(':memory:');
  const payer = privateKeyToAccount(`0x${'94'.repeat(32)}`).address;
  const payee = privateKeyToAccount(`0x${'95'.repeat(32)}`).address;
  const facilitator = privateKeyToAccount(`0x${'96'.repeat(32)}`).address;
  const signature = `0x${'55'.repeat(65)}` as Hex;
  const auth = { from: payer, permitted: { token: TEST_USDG_ADDRESS, amount: '10000' },
    spender: x402UptoPermit2ProxyAddress, nonce: '99', deadline: '1999', witness: { to: payee, facilitator, validAfter: '0' } };
  const requirements: PaymentRequirements = { scheme: 'upto', network: 'eip155:46630',
    asset: TEST_USDG_ADDRESS, amount: '10000', payTo: payee, maxTimeoutSeconds: 1200,
    extra: { assetTransferMethod: 'permit2', facilitatorAddress: facilitator } };
  const payment: AiPayment = { payload: { x402Version: 2, accepted: requirements,
    payload: { signature, permit2Authorization: auth } }, requirements, amount: '600', signed: null, hash: null, nonce: null };
  const data = encodeFunctionData({ abi: x402UptoPermit2ProxyABI, functionName: 'settle', args: [
    { permitted: { token: TEST_USDG_ADDRESS, amount: 10000n }, nonce: 99n, deadline: 1999n },
    600n, payer, { to: payee, facilitator, validAfter: 0n }, signature,
  ] });
  const id = '88888888-8888-4888-8888-888888888888';
  const key = `local-ai:request:${id}`;
  const lane = { id, envelope: { chainId: 46630, to: x402UptoPermit2ProxyAddress, data,
    value: '0', nonce: 7, gas: '300000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '0' } };
  const rpc = { getTransactionCount: async () => 7 } as unknown as Parameters<typeof recoverExpiredUnsignedSettlement>[4];
  try {
    await store.create(key, { id, owner: { payer }, payee, request: {
      answer: 'saved answer', state: 'settling', error: null, maxOutputTokens: 100, usage: { outputTokens: 6 }, payment: { state: 'authorized', amountAtomic: '600' },
    }, paymentJournal: payment });
    await store.create('local-ai:fee-lane', lane);
    assert.equal(await recoverExpiredUnsignedSettlement(store, key, payer, payee, rpc, facilitator, 2_000_000), true);
    const stopped = await store.get<{ request: { state: string; payment: { state: string } }; paymentJournal: AiPayment }>(key);
    assert.equal(stopped?.request.state, 'failed');
    assert.equal(stopped?.request.payment.state, 'failed');
    assert.equal((await store.get<{ id: string }>('local-ai:fee-lane'))?.id, '');
    await store.update<AiPaidRecord>(key, (row) => {
      row.request.state = 'settling';
      row.paymentJournal!.signed = '0x02aa';
      row.paymentJournal!.hash = `0x${'aa'.repeat(32)}` as Hex;
      return row;
    });
    await store.update('local-ai:fee-lane', () => lane);
    assert.equal(await recoverExpiredUnsignedSettlement(store, key, payer, payee, rpc, facilitator, 2_000_000), false);
    assert.equal((await store.get<{ id: string }>('local-ai:fee-lane'))?.id, id);
  } finally { await store.close(); }
});

test('a facilitator key from the environment wins over the key file and must be a private key', async () => {
  const saved = { key: process.env.LOCAL_AI_FACILITATOR_PRIVATE_KEY, file: process.env.LOCAL_AI_FACILITATOR_KEY_FILE };
  const key = `0x${'1'.repeat(64)}` as Hex;
  try {
    // The file does not exist: only the environment can supply the key.
    process.env.LOCAL_AI_FACILITATOR_KEY_FILE = '/nonexistent/facilitator.key';
    process.env.LOCAL_AI_FACILITATOR_PRIVATE_KEY = key;
    assert.equal((await facilitatorAccount()).address, privateKeyToAccount(key).address);
    process.env.LOCAL_AI_FACILITATOR_PRIVATE_KEY = 'not-a-key';
    await assert.rejects(facilitatorAccount(), /Invalid dedicated facilitator key/);
    delete process.env.LOCAL_AI_FACILITATOR_PRIVATE_KEY;
    await assert.rejects(facilitatorAccount(), /ENOENT/);
  } finally {
    if (saved.key === undefined) delete process.env.LOCAL_AI_FACILITATOR_PRIVATE_KEY; else process.env.LOCAL_AI_FACILITATOR_PRIVATE_KEY = saved.key;
    if (saved.file === undefined) delete process.env.LOCAL_AI_FACILITATOR_KEY_FILE; else process.env.LOCAL_AI_FACILITATOR_KEY_FILE = saved.file;
  }
});

test('per-token charging permits zero and exact cap while rejecting unmeasured or excessive output', () => {
  const cap = inferenceMaximum(64);
  assert.equal(cap, 6400n);
  assert.equal(inferenceCharge(0, cap), 0n);
  assert.equal(inferenceCharge(1, cap), 100n);
  assert.equal(inferenceCharge(63, cap), 6300n);
  assert.equal(inferenceCharge(64, cap), cap);
  for (const tokens of [null, -1, 0.5, 65, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => inferenceCharge(tokens, cap));
  for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => inferenceMaximum(limit));
});
