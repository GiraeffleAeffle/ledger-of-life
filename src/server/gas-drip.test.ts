import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, parseTransaction, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalStore } from './store.ts';
import { dripTestGas, GAS_DRIP_AMOUNT, GAS_DRIP_THRESHOLD } from './gas-drip.ts';

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
function fixture() {
  const store = new LocalStore(':memory:');
  const state = { time: Date.UTC(2026, 8, 30, 12), balance: 0n, chain: 46630, nonceReads: 0, receipts: false, waits: false, broadcasts: [] as Hex[], recipientReads: [] as string[] };
  const client = {
    getChainId: async () => state.chain,
    getBalance: async ({ address }: { address: string }) => { state.recipientReads.push(address); return state.balance; },
    getTransactionCount: async () => { state.nonceReads++; return state.nonceReads - 1; },
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 21_000n,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!state.receipts || !state.broadcasts.some((signed) => keccak256(signed) === hash)) throw new TransactionReceiptNotFoundError({ hash });
      return { status: 'success', transactionHash: hash };
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      // The actual signed bytes must already be durable at every broadcast.
      const journal = await store.get<{ wallets: Record<string, { signed: Hex }> }>('robinhood-gas-drip:46630');
      assert.ok(Object.values(journal!.wallets).some((value) => value.signed === serializedTransaction));
      state.broadcasts.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (state.waits) return new Promise<never>(() => {});
      return { status: 'success', transactionHash: hash };
    },
  } as unknown as NonNullable<NonNullable<Parameters<typeof dripTestGas>[3]>['client']>;
  const options = { client, environment: { ROBINHOOD_GAS_DRIP_PRIVATE_KEY: `0x${'33'.repeat(32)}` }, now: () => state.time, receiptTimeoutMs: 5 };
  return { store, state, options };
}

test('drips the fixed amount only to the verified wallet, then refuses the account and wallet for 24 hours', async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const result = await dripTestGas(f.store, 'person', owner.address, f.options);
  assert.equal(result.status, 'confirmed');
  const transaction = parseTransaction(f.state.broadcasts[0]);
  assert.equal(transaction.to?.toLowerCase(), owner.address.toLowerCase());
  assert.equal(transaction.value, GAS_DRIP_AMOUNT);
  assert.equal(transaction.chainId, 46630);
  assert.ok(f.state.recipientReads.every((address) => address === owner.address));
  f.state.time += 86_399_999;
  await assert.rejects(dripTestGas(f.store, 'person', other.address, f.options), /once per 24 hours/);
  await assert.rejects(dripTestGas(f.store, 'different-person', owner.address, f.options), /once per 24 hours/);
  assert.equal(f.state.broadcasts.length, 1);
  f.state.time++;
  assert.equal((await dripTestGas(f.store, 'person', owner.address, f.options)).status, 'confirmed');
});

for (const balance of [GAS_DRIP_THRESHOLD, GAS_DRIP_THRESHOLD + 1n]) {
  test(`refuses a wallet with ${balance} wei without signing or sending`, async (t) => {
    const f = fixture(); t.after(() => f.store.close()); f.state.balance = balance;
    assert.deepEqual(await dripTestGas(f.store, 'person', owner.address, f.options), { status: 'sufficient_balance' });
    assert.equal(f.state.nonceReads, 0); assert.equal(f.state.broadcasts.length, 0);
  });
}

test('without a host key returns unconfigured without RPC or a transfer', async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  assert.deepEqual(await dripTestGas(f.store, 'person', owner.address, { ...f.options, environment: {} }), { status: 'unconfigured' });
  assert.equal(f.state.recipientReads.length, 0); assert.equal(f.state.broadcasts.length, 0);
});

test('caps actual drips at 200 per UTC day and opens the next day', async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  for (let index = 1; index <= 200; index++) {
    const wallet = `0x${index.toString(16).padStart(40, '0')}`;
    assert.equal((await dripTestGas(f.store, `person-${index}`, wallet, f.options)).status, 'confirmed');
  }
  await assert.rejects(dripTestGas(f.store, 'person-201', other.address, f.options), /daily test ETH limit/);
  assert.equal(f.state.broadcasts.length, 200);
  f.state.time = Date.UTC(2026, 9, 1);
  assert.equal((await dripTestGas(f.store, 'person-201', other.address, f.options)).status, 'confirmed');
});

test('returns pending after a bounded receipt wait and recovers identical journaled bytes without signing again', async (t) => {
  const f = fixture(); t.after(() => f.store.close()); f.state.waits = true;
  const first = await dripTestGas(f.store, 'person', owner.address, f.options);
  assert.equal(first.status, 'pending');
  assert.equal(first.hash, keccak256(f.state.broadcasts[0]));
  // On recovery all signing prerequisites fail if called; the persisted bytes are sufficient.
  f.options.client.getTransactionCount = async () => { throw new Error('must not sign again'); };
  f.options.client.estimateFeesPerGas = async () => { throw new Error('must not sign again'); };
  f.state.balance = GAS_DRIP_AMOUNT; f.state.waits = false;
  const recovered = await dripTestGas(f.store, 'person', owner.address, f.options);
  assert.deepEqual(recovered, { status: 'confirmed', hash: first.hash });
  assert.deepEqual(f.state.broadcasts, [f.state.broadcasts[0], f.state.broadcasts[0]]);
  assert.equal(f.state.nonceReads, 1);
});

test('never signs or broadcasts on a non-testnet RPC', async (t) => {
  const f = fixture(); t.after(() => f.store.close()); f.state.chain = 1;
  await assert.rejects(dripTestGas(f.store, 'person', owner.address, f.options), /46630/);
  assert.equal(f.state.nonceReads, 0); assert.equal(f.state.broadcasts.length, 0);
});

test('concurrent requests reserve a wallet atomically and send only one transfer', async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const results = await Promise.allSettled([
    dripTestGas(f.store, 'person', owner.address, f.options),
    dripTestGas(f.store, 'person', owner.address, f.options),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.state.broadcasts.length, 1);
});

test('a later person can use the faucet after an earlier pending transfer mines', async (t) => {
  const f = fixture(); t.after(() => f.store.close()); f.state.waits = true;
  assert.equal((await dripTestGas(f.store, 'first-person', owner.address, f.options)).status, 'pending');
  f.state.receipts = true; f.state.waits = false;
  assert.equal((await dripTestGas(f.store, 'next-person', other.address, f.options)).status, 'confirmed');
  assert.equal(f.state.broadcasts.length, 2);
  assert.equal(parseTransaction(f.state.broadcasts[1]).to?.toLowerCase(), other.address.toLowerCase());
});

test('distinct concurrent accounts charge only winning transfers and refund signer-lane losers', async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    subject: `concurrent-person-${index}`,
    wallet: `0x${(index + 1).toString(16).padStart(40, '0')}`,
  }));
  const results = await Promise.allSettled(candidates.map(({ subject, wallet }) => dripTestGas(f.store, subject, wallet, f.options)));
  const winners = candidates.filter((_, index) => results[index].status === 'fulfilled');
  const losers = candidates.filter((_, index) => results[index].status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 7);
  const ledger = await f.store.get<{ count: number; accounts: Record<string, number>; wallets: Record<string, { signed?: Hex }> }>('robinhood-gas-drip:46630');
  assert.equal(ledger!.count, winners.length);
  assert.deepEqual(Object.keys(ledger!.accounts).sort(), winners.map(({ subject }) => subject).sort());
  assert.deepEqual(Object.keys(ledger!.wallets).sort(), winners.map(({ wallet }) => wallet).sort());
  assert.equal(f.state.broadcasts.length, winners.length);
  for (const { subject, wallet } of losers) {
    assert.equal(ledger!.accounts[subject], undefined);
    assert.equal(ledger!.wallets[wallet], undefined);
  }
  // A losing account is still eligible immediately; neither its wallet nor account was charged.
  assert.equal((await dripTestGas(f.store, losers[0].subject, losers[0].wallet, f.options)).status, 'confirmed');
});

test('a pre-signing RPC failure refunds its reservation and permits an immediate retry', async (t) => {
  const f = fixture(); t.after(() => f.store.close()); f.state.chain = 1;
  await assert.rejects(dripTestGas(f.store, 'person', owner.address, f.options), /46630/);
  const ledger = await f.store.get<{ count: number; accounts: Record<string, number>; wallets: Record<string, unknown> }>('robinhood-gas-drip:46630');
  assert.deepEqual(ledger!.accounts, {});
  assert.deepEqual(ledger!.wallets, {});
  assert.equal(ledger!.count, 0);
  f.state.chain = 46630;
  assert.equal((await dripTestGas(f.store, 'person', owner.address, f.options)).status, 'confirmed');
});

test('expired unsigned leases are refunded and pruned without losing a signed pending journal', async (t) => {
  const f = fixture(); t.after(() => f.store.close()); f.state.waits = true;
  assert.equal((await dripTestGas(f.store, 'signed-person', owner.address, f.options)).status, 'pending');
  const signer = privateKeyToAccount(f.options.environment.ROBINHOOD_GAS_DRIP_PRIVATE_KEY as Hex).address;
  await f.store.update<{ count: number; accounts: Record<string, number>; wallets: Record<string, unknown> }>('robinhood-gas-drip:46630', (value) => {
    value.count++;
    value.accounts['expired-person'] = f.state.time - 60_000;
    value.wallets[other.address.toLowerCase()] = {
      subject: 'expired-person', signer, at: f.state.time - 60_000,
      lease: 'expired', busyUntil: f.state.time, operation: 'expired-gas-drip',
    };
    return value;
  });
  // Keep the requesting wallet funded so the call only prunes stale infrastructure reservations.
  f.state.balance = GAS_DRIP_THRESHOLD;
  assert.equal((await dripTestGas(f.store, 'new-person', '0x0000000000000000000000000000000000000009', f.options)).status, 'sufficient_balance');
  const ledger = await f.store.get<{ count: number; accounts: Record<string, number>; wallets: Record<string, { signed?: Hex }> }>('robinhood-gas-drip:46630');
  assert.equal(ledger!.count, 1);
  assert.equal(ledger!.accounts['expired-person'], undefined);
  assert.equal(ledger!.wallets[other.address.toLowerCase()], undefined);
  assert.equal(ledger!.wallets[owner.address.toLowerCase()].signed, f.state.broadcasts[0]);
  assert.equal(ledger!.accounts['signed-person'], f.state.time);
});
