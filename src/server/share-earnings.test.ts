import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { encodeFunctionData, getAddress, keccak256, parseAbi, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFile } from 'node:fs/promises';
import { LocalStore } from './store.ts';
import { assertPreparedEarningsCall, EARNINGS_ESCROW_ABI, prepareShareEarnings, readShareEarnings, shareEarningsEnabled, submitShareEarnings } from './share-earnings.ts';

const escrow = getAddress('0x1111111111111111111111111111111111111111');
const other = getAddress('0x2222222222222222222222222222222222222222');
const data = encodeFunctionData({ abi: EARNINGS_ESCROW_ABI, functionName: 'fund', args: [3n, 1_900_000_000n] });
const call = { to: escrow, data, nonce: 7, chainId: 46630 as const, value: '0x0' as const, gas: '0x927c0' as const, maxFeePerGas: '0x2' as const, maxPriorityFeePerGas: '0x0' as const };

test('earnings relay rejects altered value, recipient, calldata, nonce and chain', () => {
  const tx = { ...call, value: 0n, gas: 600000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 0n };
  assertPreparedEarningsCall(tx, [call]);
  for (const altered of [
    { ...tx, value: 1n }, { ...tx, to: other }, { ...tx, nonce: 8 }, { ...tx, chainId: 4663 },
    { ...tx, gas: 600001n }, { ...tx, maxFeePerGas: 3n }, { ...tx, maxPriorityFeePerGas: 1n }, { ...tx, accessList: [{ address: other, storageKeys: [] }] },
    { ...tx, data: encodeFunctionData({ abi: EARNINGS_ESCROW_ABI, functionName: 'fund', args: [4n, 1_900_000_000n] }) },
    { ...tx, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: [other, 1501000000n] }) },
  ]) assert.throws(() => assertPreparedEarningsCall(altered, [call]), /exact prepared earnings call/);
});

test('production cannot enable the local rehearsal even with an operator override', () => {
  assert.equal(shareEarningsEnabled({ NODE_ENV: 'production', ALLOW_OPERATOR_TEST_ACTIONS: '1', SOLANA_TEST_SIGNER_MODE: '1', SOLANA_CLUSTER: 'devnet' }), false);
  assert.equal(shareEarningsEnabled({ NODE_ENV: 'development', VERCEL: '1', SOLANA_TEST_SIGNER_MODE: '1', SOLANA_CLUSTER: 'devnet' }), false);
});

test('confirmed and ambiguous submissions cannot replay a reviewed call', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../docs/evidence/SOLANA_PULL_DEVNET_DEPLOYMENT_2026-09-25.json', import.meta.url), 'utf8'));
  const saved = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'development', SOLANA_TEST_SIGNER_MODE: '1', SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    SOLANA_DEPLOYMENT_MANIFEST: JSON.stringify({ ...manifest, maxObservationAgeMs: 15000, maximumSponsorLamports: '10000000', agreementId: 'a', tenancyAddress: manifest.escrowProgram }),
  });
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  const store = new LocalStore(':memory:');
  // A public deterministic test key, never a deployment or user secret.
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
  const bindingKey = `shared-pool-earnings:${account.address.toLowerCase()}:prepared`;
  const prepared = { ...call, nonce: 0 };
  const transaction = { type: 'eip1559' as const, ...prepared, value: 0n, gas: 600000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 0n };
  const signed = await account.signTransaction(transaction);
  const hash = keccak256(signed);
  const binding = { calls: [prepared], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  let broadcasts = 0;
  const client = {
    sendRawTransaction: async () => { broadcasts++; return hash; },
    waitForTransactionReceipt: async () => ({ transactionHash: hash, status: 'success' }),
    request: async () => { throw new Error('Lookup unavailable'); },
  } as unknown as NonNullable<Parameters<typeof submitShareEarnings>[3]>;
  try {
    await store.create(bindingKey, binding);
    await assert.rejects(submitShareEarnings(store, account.address, await account.signTransaction({ ...transaction, maxFeePerGas: 3n }), client), /exact prepared/);
    assert.equal(broadcasts, 0);
    await submitShareEarnings(store, account.address, signed, client);
    await assert.rejects(submitShareEarnings(store, account.address, signed, client), /exact prepared/);
    assert.equal(broadcasts, 1);
    await store.update(bindingKey, () => binding);
    const ambiguous = { ...client, sendRawTransaction: async () => { broadcasts++; throw new Error('Lost RPC response'); } };
    await assert.rejects(submitShareEarnings(store, account.address, signed, ambiguous), /Lost RPC response/);
    await assert.rejects(submitShareEarnings(store, account.address, signed, client), /pending/);
    assert.equal(broadcasts, 2);
    assert.equal((await store.get<{ pendingHash: string }>(bindingKey))?.pendingHash, hash);
  } finally {
    await store.close();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});

describe('local earnings broadcast recovery and setup status', () => {
  const saved = { ...process.env };
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
  const ownerKey = `shared-pool-earnings:${account.address.toLowerCase()}`;
  const bindingKey = `${ownerKey}:prepared`;
  const time = 1_900_000_000_000;
  const prepared = { ...call, nonce: 0 };
  const nextCall = { ...call, nonce: 1 };
  const binding = { calls: [prepared, nextCall], expiresAt: time / 1000 + 3600 };
  const transaction = { type: 'eip1559' as const, ...prepared, value: 0n, gas: 600000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 0n };
  const ready = { status: 'ready', escrow, vault: other, usd: other, transactionHashes: [] };
  type Prepared = typeof binding & { pendingHash?: string; pendingAt?: number; pendingNonce?: number };
  type Client = NonNullable<Parameters<typeof prepareShareEarnings>[3]>;

  before(async () => {
    const manifest = JSON.parse(await readFile(new URL('../../docs/evidence/SOLANA_PULL_DEVNET_DEPLOYMENT_2026-09-25.json', import.meta.url), 'utf8'));
    Object.assign(process.env, {
      NODE_ENV: 'development', SOLANA_TEST_SIGNER_MODE: '1', SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      SOLANA_DEPLOYMENT_MANIFEST: JSON.stringify({ ...manifest, maxObservationAgeMs: 15000, maximumSponsorLamports: '10000000', agreementId: 'a', tenancyAddress: manifest.escrowProgram }),
    });
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL;
  });
  after(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  for (const lookup of ['null', 'known', 'failure']) {
    test(`refused broadcast with ${lookup} lookup ${lookup === 'null' ? 'restores the exact review' : 'retains its reservation'}`, async () => {
      const store = new LocalStore(':memory:');
      const signed = await account.signTransaction(transaction);
      const hash = keccak256(signed);
      let broadcasts = 0;
      const client = {
        sendRawTransaction: async () => { broadcasts++; throw new Error('Broadcast refused'); },
        request: async () => {
          if (lookup === 'failure') throw new Error('Lookup failed');
          return lookup === 'null' ? null : { hash };
        },
        waitForTransactionReceipt: async () => { throw new Error('Must not wait after refusal'); },
      } as unknown as NonNullable<Parameters<typeof submitShareEarnings>[3]>;
      try {
        await store.create(bindingKey, binding);
        await assert.rejects(submitShareEarnings(store, account.address, signed, client, () => time), /Broadcast refused/);
        const pending = (await store.get<Prepared>(bindingKey))!;
        if (lookup === 'null') {
          assert.deepEqual(pending, binding);
          const confirmedClient = { ...client, sendRawTransaction: async () => { broadcasts++; return hash; },
            waitForTransactionReceipt: async () => ({ status: 'success' }) } as unknown as typeof client;
          assert.deepEqual(await submitShareEarnings(store, account.address, signed, confirmedClient, () => time), { hash });
          assert.deepEqual((await store.get<Prepared>(bindingKey))!.calls, [nextCall]);
          assert.equal(broadcasts, 2);
        } else {
          assert.equal(pending.pendingHash, hash);
          assert.equal(pending.pendingAt, time);
          assert.equal(pending.pendingNonce, 0);
          assert.deepEqual(pending.calls, [nextCall]);
          await assert.rejects(submitShareEarnings(store, account.address, signed, client, () => time), /pending/);
          assert.equal(broadcasts, 1);
        }
      } finally { await store.close(); }
    });
  }

  for (const scenario of [
    { name: 'recent unknown hash', known: null, age: 119_999, latest: 0, recover: false },
    { name: 'aged unknown hash', known: null, age: 120_000, latest: 0, recover: true },
    { name: 'aged known hash', known: { hash: 'known' }, age: 120_000, latest: 0, recover: false },
    { name: 'consumed nonce', known: { hash: 'known' }, age: 0, latest: 1, recover: true },
    { name: 'failed lookup', known: null, age: 120_000, latest: 0, recover: false, failedLookup: true },
  ]) {
    test(`prepare reconciles ${scenario.name} without guessing acceptance`, async () => {
      const store = new LocalStore(':memory:');
      const hash = keccak256(await account.signTransaction(transaction));
      const pending = { ...binding, calls: [nextCall], pendingHash: hash, pendingAt: time - scenario.age, pendingNonce: 0 };
      const client = {
        getTransactionReceipt: async () => { throw new TransactionReceiptNotFoundError({ hash }); },
        request: async () => { if (scenario.failedLookup) throw new Error('Lookup failed'); return scenario.known; },
        getTransactionCount: async ({ blockTag }: { blockTag: string }) => blockTag === 'latest' ? scenario.latest : 1,
        getBalance: async () => 1n,
        readContract: async () => 0n,
        estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
      } as unknown as Client;
      try {
        await store.create(ownerKey, ready);
        await store.create(bindingKey, pending);
        if (scenario.recover) {
          const steps = await prepareShareEarnings(store, account.address, 'mint', client, () => time);
          assert.equal(steps[0].transaction.nonce, 1);
          assert.equal((await store.get<Prepared>(bindingKey))!.pendingHash, undefined);
        } else {
          await assert.rejects(prepareShareEarnings(store, account.address, 'mint', client, () => time), scenario.failedLookup ? /Lookup failed/ : /pending/);
          assert.deepEqual(await store.get(bindingKey), pending);
        }
      } finally { await store.close(); }
    });
  }

  test('no test ETH rejects preparation without replacing an existing review', async () => {
    const store = new LocalStore(':memory:');
    const client = {
      getBalance: async () => 0n,
      readContract: async () => { throw new Error('Must check gas before preparing'); },
    } as unknown as Client;
    try {
      await store.create(ownerKey, ready);
      await store.create(bindingKey, binding);
      await assert.rejects(prepareShareEarnings(store, account.address, 'mint', client, () => time), /No test ETH for network fees/);
      assert.deepEqual(await store.get(bindingKey), binding);
    } finally { await store.close(); }
  });

  test('incomplete setup is readable for resume without exposing signed journal bytes', async () => {
    const store = new LocalStore(':memory:');
    const starting = { status: 'starting', vault: other, usd: other, escrow, landlord: other, arbitrator: other,
      deploy: { signed: 'private journal bytes' }, accept: {} };
    const client = { readContract: async () => { throw new Error('Incomplete setup must not read contract state'); } } as unknown as Client;
    try {
      await store.create(ownerKey, starting);
      assert.deepEqual(await readShareEarnings(store, account.address, client), { status: 'starting', vault: other, usd: other, escrow });
      await assert.rejects(prepareShareEarnings(store, account.address, 'mint', client, () => time), /Resume setup first/);
      assert.deepEqual(await store.get(ownerKey), starting);
    } finally { await store.close(); }
  });
});
