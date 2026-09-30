import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalStore } from './store.ts';
import { MAX_TEST_DOLLARS, prepareTestDollars, submitTestDollars, TEST_DOLLAR_ABI, TEST_DOLLAR_ADDRESS } from './test-dollars.ts';

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const mint = (to = owner.address, amount = 1_000_000_000n) => encodeFunctionData({ abi: TEST_DOLLAR_ABI, functionName: 'mint', args: [to, amount] });
async function signed(overrides: Partial<TransactionSerializableEIP1559> = {}, signer = owner) {
  return signer.signTransaction({ type: 'eip1559', chainId: 46630, to: TEST_DOLLAR_ADDRESS, data: mint(), value: 0n, nonce: 0, gas: 120_000n, maxFeePerGas: 4n, maxPriorityFeePerGas: 1n, ...overrides });
}
function fixture() {
  const store = new LocalStore(':memory:');
  const state = { time: 1_000_000, broadcasts: 0, balanceReads: 0, mined: false, known: true, lookupFails: false, latestNonce: 0 };
  const clock = () => state.time;
  const prepareClient = {
    getBalance: async () => { state.balanceReads++; return 1n; },
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    getTransactionCount: async () => state.latestNonce,
    estimateGas: async () => 100_000n,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!state.mined) throw new TransactionReceiptNotFoundError({ hash });
      return { status: 'success' };
    },
    request: async () => {
      if (state.lookupFails) throw new Error('Transaction lookup unavailable.');
      return state.known ? { blockNumber: null } : null;
    },
  } as unknown as NonNullable<Parameters<typeof prepareTestDollars>[2]>;
  const client = {
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => { state.broadcasts++; return keccak256(serializedTransaction); },
    waitForTransactionReceipt: async () => ({ status: 'success' }),
    readContract: async () => 2_000_000_000n,
    request: prepareClient.request,
  } as unknown as NonNullable<Parameters<typeof submitTestDollars>[3]>;
  return { store, state, clock, prepareClient, client };
}
for (const [name, transaction] of [
  ['wrong chain', () => signed({ chainId: 1 })],
  ['wrong target', () => signed({ to: other.address })],
  ['wrong function', () => signed({ data: encodeFunctionData({ abi: TEST_DOLLAR_ABI, functionName: 'balanceOf', args: [owner.address] }) })],
  ['recipient is not signer', () => signed({ data: mint(other.address) })],
  ['amount above cap', () => signed({ data: mint(owner.address, MAX_TEST_DOLLARS + 1n) })],
  ['zero amount', () => signed({ data: mint(owner.address, 0n) })],
  ['signer is not verified wallet', () => signed({}, other)],
  ['ETH value attached', () => signed({ value: 1n })],
  ['unknown calldata', () => signed({ data: '0x12345678' })],
] as const) {
  test(`refuses ${name} without broadcasting`, async (t) => {
    const f = fixture();
    t.after(() => f.store.close());
    await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
    await assert.rejects(submitTestDollars(f.store, owner.address, await transaction(), f.client, f.clock));
    assert.equal(f.state.broadcasts, 0);
  });
}
test('accepts the prepared self-mint and returns confirmed balance', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  const serialized = await signed();
  assert.deepEqual(await submitTestDollars(f.store, owner.address, serialized, f.client, f.clock),
    { hash: keccak256(serialized), status: 'confirmed', testUsdAtomic: '2000000000' });
  assert.equal(f.state.broadcasts, 1);
});

test('refuses a second prepare inside the limit window without another RPC call', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  f.state.time += 59_999;
  await assert.rejects(prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock), /one minute/);
  assert.equal(f.state.balanceReads, 1);
});

for (const [name, overrides] of [
  ['nonce', { nonce: 1 }],
  ['gas', { gas: 120_001n }],
  ['maximum fee', { maxFeePerGas: 5n }],
  ['priority fee', { maxPriorityFeePerGas: 2n }],
  ['mint amount within cap', { data: mint(owner.address, 2_000_000_000n) }],
  ['access list', { accessList: [{ address: owner.address, storageKeys: [] }] }],
] as const) {
  test(`refuses a signed transaction with changed ${name}`, async (t) => {
    const f = fixture();
    t.after(() => f.store.close());
    await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
    await assert.rejects(submitTestDollars(f.store, owner.address, await signed(overrides), f.client, f.clock), /does not match/);
    assert.equal(f.state.broadcasts, 0);
  });
}

test('refuses a submit at the preparation expiry boundary', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  f.state.time += 120_000;
  await assert.rejects(submitTestDollars(f.store, owner.address, await signed(), f.client, f.clock), /expired/);
  assert.equal(f.state.broadcasts, 0);
});

test('limits invalid submit attempts without consuming the prepared transaction', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  for (let attempt = 0; attempt < 3; attempt++)
    await assert.rejects(submitTestDollars(f.store, owner.address, 'invalid', f.client, f.clock), /Invalid signed/);
  const serialized = await signed();
  await assert.rejects(submitTestDollars(f.store, owner.address, serialized, f.client, f.clock), /Too many/);
  f.state.time += 60_000;
  const result = await submitTestDollars(f.store, owner.address, serialized, f.client, f.clock);
  assert.equal(result.status, 'confirmed');
  assert.equal(f.state.broadcasts, 1);
});

test('bounds a stalled receipt wait and keeps one pending mint until mined', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  const waiting = Promise.withResolvers<void>();
  const confirmedWait = f.client.waitForTransactionReceipt;
  f.client.waitForTransactionReceipt = () => { waiting.resolve(); return Promise.withResolvers<never>().promise; };
  const serialized = await signed();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const submission = submitTestDollars(f.store, owner.address, serialized, f.client, f.clock);
  await waiting.promise;
  await assert.rejects(submitTestDollars(f.store, owner.address, serialized, f.client, f.clock), /pending/);
  t.mock.timers.tick(10_000);
  assert.deepEqual(await submission, { hash: keccak256(serialized), status: 'pending' });
  assert.equal(f.state.broadcasts, 1);
  t.mock.timers.reset();
  f.state.time += 120_000;
  await assert.rejects(prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock), /still pending/);
  f.state.mined = true;
  f.state.time += 60_000;
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  f.client.waitForTransactionReceipt = confirmedWait;
  const next = await submitTestDollars(f.store, owner.address, serialized, f.client, f.clock);
  assert.equal(next.status, 'confirmed');
  assert.equal(f.state.broadcasts, 2);
});

test('returns pending when the RPC receipt waiter reports its timeout', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  f.client.waitForTransactionReceipt = async ({ hash }) => { throw new WaitForTransactionReceiptTimeoutError({ hash }); };
  const serialized = await signed();
  assert.deepEqual(await submitTestDollars(f.store, owner.address, serialized, f.client, f.clock),
    { hash: keccak256(serialized), status: 'pending' });
});

test('only one concurrent submit can broadcast the prepared mint', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  const serialized = await signed();
  const results = await Promise.allSettled([
    submitTestDollars(f.store, owner.address, serialized, f.client, f.clock),
    submitTestDollars(f.store, owner.address, serialized, f.client, f.clock),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.state.broadcasts, 1);
});

test('a rejected broadcast unknown to the node restores the review for a safe retry', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  f.state.known = false;
  const send = f.client.sendRawTransaction;
  f.client.sendRawTransaction = async () => { throw new Error('Broadcast rejected.'); };
  const serialized = await signed();
  await assert.rejects(submitTestDollars(f.store, owner.address, serialized, f.client, f.clock), /Broadcast rejected/);
  f.client.sendRawTransaction = send;
  const result = await submitTestDollars(f.store, owner.address, serialized, f.client, f.clock);
  assert.equal(result.status, 'confirmed');
  assert.equal(f.state.broadcasts, 1);
});

for (const scenario of ['known transaction', 'failed lookup'] as const) {
  test(`an ambiguous broadcast with ${scenario} keeps its pending reservation`, async (t) => {
    const f = fixture();
    t.after(() => f.store.close());
    await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
    f.state.lookupFails = scenario === 'failed lookup';
    f.client.sendRawTransaction = async () => { throw new Error('Broadcast connection lost.'); };
    const serialized = await signed();
    await assert.rejects(submitTestDollars(f.store, owner.address, serialized, f.client, f.clock), /Broadcast connection lost/);
    await assert.rejects(submitTestDollars(f.store, owner.address, serialized, f.client, f.clock), /pending/);
  });
}

test('a missing transaction stays reserved when recent but can mint again after two minutes', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  const wait = f.client.waitForTransactionReceipt;
  f.client.waitForTransactionReceipt = async ({ hash }) => { throw new WaitForTransactionReceiptTimeoutError({ hash }); };
  const serialized = await signed();
  await submitTestDollars(f.store, owner.address, serialized, f.client, f.clock);
  f.state.known = false;
  f.state.time += 60_000;
  await assert.rejects(prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock), /still pending/);
  f.state.time += 60_000;
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  f.client.waitForTransactionReceipt = wait;
  const result = await submitTestDollars(f.store, owner.address, serialized, f.client, f.clock);
  assert.equal(result.status, 'confirmed');
  assert.equal(f.state.broadcasts, 2);
});

test('a consumed latest nonce releases the pending mint even if its hash is still known', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  const wait = f.client.waitForTransactionReceipt;
  f.client.waitForTransactionReceipt = async ({ hash }) => { throw new WaitForTransactionReceiptTimeoutError({ hash }); };
  await submitTestDollars(f.store, owner.address, await signed(), f.client, f.clock);
  f.state.latestNonce = 1;
  f.state.time += 60_000;
  await prepareTestDollars(f.store, owner.address, f.prepareClient, f.clock);
  f.client.waitForTransactionReceipt = wait;
  const result = await submitTestDollars(f.store, owner.address, await signed({ nonce: 1 }), f.client, f.clock);
  assert.equal(result.status, 'confirmed');
  assert.equal(f.state.broadcasts, 2);
});
