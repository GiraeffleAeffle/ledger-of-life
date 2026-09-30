import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, keccak256, type TransactionSerializableEIP1559 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalStore } from './store.ts';
import { prepareMarketAction, readSharedMarket, readUnhealthyLoans, readCollateralSafety, submitMarketTransaction, SHARED_POOL_ABI, SHARED_TOKEN_ABI, SHARED_STOCK, SHARED_USD, type SharedMarketManifest } from './shared-market.ts';

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const pool = '0x3333333333333333333333333333333333333333';
const oracle = '0x4444444444444444444444444444444444444444';
const issuer = { beacon: '0x5555555555555555555555555555555555555555', implementation: '0x6666666666666666666666666666666666666666', registry: '0x5555555555555555555555555555555555555555', codeHashes: { beacon: keccak256('0x01'), implementation: keccak256('0x01'), registry: keccak256('0x01') } } as const;
const config: SharedMarketManifest = { chainId: 46630, usd: SHARED_USD, stock: SHARED_STOCK, oracle, pool, codeHashes: { usd: keccak256('0x01'), stock: keccak256('0x01'), oracle: keccak256('0x01'), pool: keccak256('0x01') }, updater: other.address, source: { chainId: 4663, feed: '0x4A1166a659A55625345e9515b32adECea5547C38' }, seed: { receiver: '0x000000000000000000000000000000000000dEaD', assets: '10000000000' }, collateralIssuer: issuer };
const deposit = encodeFunctionData({ abi: SHARED_POOL_ABI, functionName: 'deposit', args: [100n, owner.address] });
const reviewed = { chainId: 46630 as const, to: pool, data: deposit, value: '0x0', nonce: 0, gas: '0x1d4c0', maxFeePerGas: '0x4', maxPriorityFeePerGas: '0x1' };
async function signed(overrides: Partial<TransactionSerializableEIP1559> = {}, signer = owner) {
  return signer.signTransaction({ type: 'eip1559', chainId: 46630, to: pool, data: deposit, value: 0n, nonce: 0, gas: 120_000n, maxFeePerGas: 4n, maxPriorityFeePerGas: 1n, ...overrides });
}
const verification = {
  getChainId: async () => 46630, getCode: async () => '0x01',
  getStorageAt: async () => `0x${'0'.repeat(24)}${issuer.beacon.slice(2)}`,
  readContract: async ({ functionName, address }: { functionName: string; address: string }) => {
    if (functionName === 'asset') return SHARED_USD;
    if (functionName === 'stock') return SHARED_STOCK;
    if (functionName === 'oracle') return oracle;
    if (functionName === 'decimals') return address === SHARED_USD ? 6 : 18;
    if (functionName === 'implementation') return issuer.implementation;
    if (functionName === 'ACCESS_CONTROLLED_REGISTRY') return issuer.registry;
    if (['paused','isBlocked','collateralShortfall'].includes(functionName)) return false;
    throw new Error(`Unexpected read ${functionName}`);
  },
};
/** Reads the preflight makes, for a wallet with plenty of both tokens and an empty position. */
const marketReads = (request: { functionName: string; address: string }) => {
  if (['allowance', 'balanceOf'].includes(request.functionName)) return 10n ** 30n;
  if (request.functionName === 'position') return [0n, 0n, 0n, 0n, 0n, true];
  if (request.functionName === 'maxWithdraw') return 0n;
  return verification.readContract(request);
};
const rejectionReasons: Record<string, RegExp> = {
  target: /Target is not the shared market/,
  selector: /Encoded function signature "0x12345678" not found on ABI/,
  receiver: /Deposit receiver must be the signer/,
  'withdrawal owner': /Withdrawal receiver and owner must be the signer/,
  'withdrawal receiver': /Withdrawal receiver and owner must be the signer/,
  'ETH value': /Market calls must not send ETH/,
  chain: /Use Robinhood Chain testnet/,
  signer: /Transaction was not signed by your verified wallet/,
  'approval spender': /Approve only the shared pool for an exact positive amount/,
  'review amount': /Signed transaction does not match the prepared market review/,
  'trailing calldata': /Noncanonical market calldata/,
};
for (const [name, overrides, signer] of [
  ['target', { to: other.address }], ['selector', { data: '0x12345678' }],
  ['receiver', { data: encodeFunctionData({ abi: SHARED_POOL_ABI, functionName: 'deposit', args: [100n, other.address] }) }],
  ['withdrawal owner', { data: encodeFunctionData({ abi: SHARED_POOL_ABI, functionName: 'withdraw', args: [100n, owner.address, other.address] }) }],
  ['withdrawal receiver', { data: encodeFunctionData({ abi: SHARED_POOL_ABI, functionName: 'withdraw', args: [100n, other.address, owner.address] }) }],
  ['ETH value', { value: 1n }], ['chain', { chainId: 1 }], ['signer', {}, other],
  ['approval spender', { to: SHARED_USD, data: encodeFunctionData({ abi: SHARED_TOKEN_ABI, functionName: 'approve', args: [other.address, 100n] }) }],
  ['review amount', { data: encodeFunctionData({ abi: SHARED_POOL_ABI, functionName: 'deposit', args: [101n, owner.address] }) }],
  ['trailing calldata', { data: `${deposit}00` }],
] as const) {
  test(`submit rejects different ${name} before broadcasting`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'market-test-'));
    const old = process.env.SHARED_MARKET_MANIFEST_FILE;
    process.env.SHARED_MARKET_MANIFEST_FILE = join(dir, 'manifest.json');
    await writeFile(process.env.SHARED_MARKET_MANIFEST_FILE, JSON.stringify(config));
    const store = new LocalStore(':memory:');
    t.after(async () => { store.close(); if (old === undefined) delete process.env.SHARED_MARKET_MANIFEST_FILE; else process.env.SHARED_MARKET_MANIFEST_FILE = old; await rm(dir, { recursive: true, force: true }); });
    await store.create(`shared-market:${owner.address.toLowerCase()}`, { nextPrepareAt: 0, submitWindowAt: 0, submitAttempts: 0, prepared: { transaction: reviewed, expiresAt: 200_000, operation: 'lend', quantity: '100', approval: false } });
    let broadcasts = 0;
    const client = { ...verification, sendRawTransaction: async () => { broadcasts++; } } as unknown as NonNullable<Parameters<typeof submitMarketTransaction>[3]>;
    await assert.rejects(submitMarketTransaction(store, owner.address, await signed(overrides as Partial<TransactionSerializableEIP1559>, signer), client, () => 100_000), rejectionReasons[name]);
    assert.equal(broadcasts, 0);
  });
}
test('undeployed market preserves confirmed balances without inventing a price', async () => {
  const client = { readContract: async ({ address }: { address: string }) => address === SHARED_STOCK ? 5n * 10n**18n : 123_000_000n } as unknown as Parameters<typeof readSharedMarket>[1];
  const view = await readSharedMarket(owner.address, client, async () => null);
  assert.equal(view.status, 'not_deployed'); assert.equal(view.walletValueAtomic, null); assert.equal(view.priceAtomic, null);
  assert.equal(view.sharesRaw, '5000000000000000000'); assert.equal(view.testUsdAtomic, '123000000');
});
test('undeployed wallet read failures return unknown quantities, not factual zero', async () => {
  const client = { readContract: async () => { throw new Error('RPC unavailable'); } } as unknown as Parameters<typeof readSharedMarket>[1];
  const view = await readSharedMarket(owner.address, client, async () => null);
  assert.equal(view.sharesRaw, null); assert.equal(view.testUsdAtomic, null);
});
test('one copied round values wallet and collateral; stale or never-copied pricing supplies no valuation or invented provenance', async () => {
  let fresh = true; let copied = true;
  const client = { ...verification, readContract: async (request: { functionName: string; address: string }) => {
    const { functionName, address } = request;
    if (functionName === 'market') return [100n, 150n, 50n, 3333n, 500n, 166n, 350_000_000n, 100n, fresh, 513n];
    if (functionName === 'position') return [10n**18n, 20n, 350_000_000n, 0n, 175_000_000n, fresh];
    if (functionName === 'balanceOf') return address === SHARED_STOCK ? 2n*10n**18n : 100n;
    if (functionName === 'netContributed') return 100n;
    if (functionName === 'previewRedeem') return 90n;
    if (functionName === 'maxWithdraw') return 90n;
    if (functionName === 'latest') return copied ? [42n, 35_000_000_000n, 100n, 10n**18n, 110n] : [0n, 0n, 0n, 0n, 0n];
    if (['borrowerCount','borrowerAt','borrowersPage'].includes(functionName)) throw new Error('Wallet reads must never enumerate the borrower registry.');
    return verification.readContract(request);
  } } as unknown as NonNullable<Parameters<typeof readSharedMarket>[1]>;
  const view = await readSharedMarket(owner.address, client, async () => config, () => 120_000);
  assert.equal(view.walletValueAtomic, '700000000'); assert.equal(view.loan?.valueAtomic, '350000000'); assert.equal(view.lender?.earnedAtomic, '-10'); assert.equal(view.price?.sourceRoundId, '42'); assert.equal(view.price?.ageSeconds, 20);
  assert.equal('unhealthyLoans' in view, false);
  assert.equal(view.pool?.effectiveBorrowApyBps, 513);
  copied = false;
  const unset = await readSharedMarket(owner.address, client, async () => config);
  assert.equal(unset.price, null); assert.equal(unset.priceAtomic, null); assert.equal(unset.walletValueAtomic, null);
  copied = true;
  fresh = false;
  const stale = await readSharedMarket(owner.address, client, async () => config);
  assert.equal(stale.price?.stale, true); assert.equal(stale.walletValueAtomic, null); assert.equal(stale.loan?.valueAtomic, null);
});

test('the reviewed self deposit broadcasts once and cannot be replayed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'market-success-'));
  const old = process.env.SHARED_MARKET_MANIFEST_FILE;
  process.env.SHARED_MARKET_MANIFEST_FILE = join(dir, 'manifest.json');
  await writeFile(process.env.SHARED_MARKET_MANIFEST_FILE, JSON.stringify(config));
  const store = new LocalStore(':memory:');
  t.after(async () => { store.close(); if (old === undefined) delete process.env.SHARED_MARKET_MANIFEST_FILE; else process.env.SHARED_MARKET_MANIFEST_FILE = old; await rm(dir, { recursive: true, force: true }); });
  await store.create(`shared-market:${owner.address.toLowerCase()}`, { nextPrepareAt: 0, submitWindowAt: 0, submitAttempts: 0, prepared: { transaction: reviewed, expiresAt: 200_000, operation: 'lend', quantity: '100', approval: false } });
  let broadcasts = 0;
  const client = { ...verification, sendRawTransaction: async () => { broadcasts++; }, waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: 'success', transactionHash: hash }) } as unknown as NonNullable<Parameters<typeof submitMarketTransaction>[3]>;
  const serialized = await signed();
  assert.deepEqual(await submitMarketTransaction(store, owner.address, serialized, client, () => 100_000), { hash: keccak256(serialized), status: 'confirmed' });
  await assert.rejects(submitMarketTransaction(store, owner.address, serialized, client, () => 100_000), /expired/);
  assert.equal(broadcasts, 1);
});

test('a confirmed transaction lets the wallet prepare its next action at once; a failed review or a replaced transaction still waits a minute', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'market-window-'));
  const old = process.env.SHARED_MARKET_MANIFEST_FILE;
  process.env.SHARED_MARKET_MANIFEST_FILE = join(dir, 'manifest.json');
  await writeFile(process.env.SHARED_MARKET_MANIFEST_FILE, JSON.stringify(config));
  const store = new LocalStore(':memory:');
  t.after(async () => { store.close(); if (old === undefined) delete process.env.SHARED_MARKET_MANIFEST_FILE; else process.env.SHARED_MARKET_MANIFEST_FILE = old; await rm(dir, { recursive: true, force: true }); });
  let time = 100_000; let gas = 1n; let replacement: string | null = null;
  const client = { ...verification,
    readContract: async (request: { functionName: string; address: string }) => marketReads(request),
    getBalance: async () => gas, getTransactionCount: async () => 0, estimateGas: async () => 100_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    sendRawTransaction: async () => {}, waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: 'success', transactionHash: replacement ?? hash }),
  } as unknown as NonNullable<Parameters<typeof prepareMarketAction>[5]>;
  const now = () => time;
  const prepare = () => prepareMarketAction(store, owner.address, 'lend', '100', undefined, client, now);
  assert.deepEqual((await prepare()).steps[0].transaction, reviewed);
  assert.equal((await submitMarketTransaction(store, owner.address, await signed(), client, now)).status, 'confirmed');
  time += 1_000;
  assert.equal((await prepare()).steps.length, 1, 'the next action after a confirmed one must not wait a minute');
  time += 120_001; gas = 0n;
  await assert.rejects(prepare(), /test ETH/);
  gas = 1n; time += 59_000;
  await assert.rejects(prepare(), /Wait one minute between market requests/);
  time += 1_000;
  assert.equal((await prepare()).steps.length, 1);
  // A same-nonce replacement from the wallet is not the reviewed transaction: no confirmation, no reset.
  replacement = keccak256('0x01');
  await assert.rejects(submitMarketTransaction(store, owner.address, await signed(), client, now), /replaced/);
  time += 1_000;
  await assert.rejects(prepare(), /Wait one minute between market requests/);
});

test('a shortfall is refused before any approval is offered, and a pool revert reads as a plain refusal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'market-preflight-'));
  const old = process.env.SHARED_MARKET_MANIFEST_FILE;
  process.env.SHARED_MARKET_MANIFEST_FILE = join(dir, 'manifest.json');
  await writeFile(process.env.SHARED_MARKET_MANIFEST_FILE, JSON.stringify(config));
  const store = new LocalStore(':memory:');
  t.after(async () => { store.close(); if (old === undefined) delete process.env.SHARED_MARKET_MANIFEST_FILE; else process.env.SHARED_MARKET_MANIFEST_FILE = old; await rm(dir, { recursive: true, force: true }); });
  let time = 100_000; let allowanceReads = 0; let estimates = 0;
  const client = { ...verification,
    // The owner's live case: 1,000 tUSDG, no test TSLA; after that, 1 TSLA of collateral and 175 tUSDG of room.
    readContract: async (request: { functionName: string; address: string }) => {
      if (request.functionName === 'allowance') allowanceReads++;
      if (request.functionName === 'balanceOf') return request.address === SHARED_STOCK ? 0n : 1_000_000_000n;
      if (request.functionName === 'position') return [10n ** 18n, 0n, 350_000_000n, 0n, 175_000_000n, true];
      return marketReads(request);
    },
    getBalance: async () => 1n, getTransactionCount: async () => 0, estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => { estimates++; throw new Error('Execution reverted for an unknown reason. Estimate Gas Arguments: …'); },
  } as unknown as NonNullable<Parameters<typeof prepareMarketAction>[5]>;
  await assert.rejects(prepareMarketAction(store, owner.address, 'deposit_collateral', String(10n ** 18n), undefined, client, () => time),
    /You hold 0 official test TSLA, less than 1\. Get test TSLA from Robinhood’s faucet first\./);
  assert.equal(allowanceReads + estimates, 0, 'no approval may be prepared for collateral the wallet does not hold');
  time += 60_000;
  await assert.rejects(prepareMarketAction(store, owner.address, 'borrow', '100000000', undefined, client, () => time),
    (error: Error) => /^The market would refuse this borrow now\. Borrowing is limited to 50%/.test(error.message) && !/Estimate Gas/.test(error.message));
});

for (const trigger of ['paused', 'isBlocked', 'collateralShortfall', 'implementation', 'ACCESS_CONTROLLED_REGISTRY', 'beacon storage', 'issuer code'] as const) {
  test(`issuer ${trigger} suspends the collateral market`, async () => {
    const client = { ...verification,
      getStorageAt: async () => trigger === 'beacon storage' ? `0x${'0'.repeat(64)}` : verification.getStorageAt(),
      getCode: async ({ address }: { address: string }) => trigger === 'issuer code' && address === issuer.implementation ? '0x02' : '0x01',
      readContract: async (request: { functionName: string; address: string }) => request.functionName === trigger
        ? ['implementation','ACCESS_CONTROLLED_REGISTRY'].includes(trigger) ? other.address : true
        : verification.readContract(request),
    } as unknown as NonNullable<Parameters<typeof readCollateralSafety>[1]>;
    const safety = await readCollateralSafety(config, client);
    assert.equal(safety.suspended, true);
    assert.equal(safety.suspensionReasons.length, 1);
  });
}

test('liquidation discovery scans one bounded page with four concurrent calls, shares its short cache and rate-limits each wallet', async t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const addresses = Array.from({ length: 21 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  let pageReads = 0; let positionReads = 0; let active = 0; let maxActive = 0;
  const client = { ...verification, readContract: async (request: { functionName: string; address: string; args?: readonly unknown[] }) => {
    if (request.functionName === 'borrowersPage') { pageReads++; assert.deepEqual(request.args, [1n, 21n]); return addresses; }
    if (request.functionName === 'position') {
      positionReads++; active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve(); active--;
      // A stale position must not be suggested for liquidation.
      return [10n**18n, 100n, 120n, 8333n, 0n, request.args?.[0] !== addresses[0]];
    }
    return verification.readContract(request);
  } } as unknown as NonNullable<Parameters<typeof readUnhealthyLoans>[4]>;
  const clock = () => 1_700_000_000_000;
  const page = await readUnhealthyLoans(store, owner.address, '1', 20, client, async () => config, clock);
  assert.equal(page.scanned, 20); assert.equal(page.nextCursor, '21');
  assert.equal(page.observedAt, 1_700_000_000);
  assert.equal(positionReads, 20); assert.equal(maxActive, 4);
  assert.deepEqual(page.loans.map(loan => loan.borrower), addresses.slice(1, 20));
  const samePage = await readUnhealthyLoans(store, other.address, '1', 20, client, async () => config, clock);
  assert.deepEqual(samePage, page); assert.equal(pageReads, 1);
  await assert.rejects(readUnhealthyLoans(store, owner.address, '21', 20, client, async () => config, clock), /ten seconds/);
});

test('liquidation page rejects oversized/noncanonical requests before any RPC', async t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const client = new Proxy({}, { get() { throw new Error('RPC must not be called'); } }) as NonNullable<Parameters<typeof readUnhealthyLoans>[4]>;
  for (const [cursor, size] of [['0',21],['-1',20],['01',20],['18446744073709551616',20],['0',0],['0',1.5]] as const)
    await assert.rejects(readUnhealthyLoans(store, owner.address, cursor, size, client, async () => config), /cursor|page size/);
});

test('expired discovery budget stops before starting per-borrower reads', async t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  let time = 1_000_000; let positionReads = 0;
  const client = { ...verification, readContract: async (request: { functionName: string; address: string }) => {
    if (request.functionName === 'borrowersPage') { time += 5_001; return [owner.address]; }
    if (request.functionName === 'position') { positionReads++; throw new Error('Not expected'); }
    return verification.readContract(request);
  } } as unknown as NonNullable<Parameters<typeof readUnhealthyLoans>[4]>;
  await assert.rejects(readUnhealthyLoans(store, owner.address, '200', 20, client, async () => config, () => time), /time budget/);
  assert.equal(positionReads, 0);
});

test('issuer suspension rejects a reviewed borrow but preserves reviewed dollar repayment', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'market-suspended-'));
  const old = process.env.SHARED_MARKET_MANIFEST_FILE;
  process.env.SHARED_MARKET_MANIFEST_FILE = join(dir, 'manifest.json');
  await writeFile(process.env.SHARED_MARKET_MANIFEST_FILE, JSON.stringify(config));
  const store = new LocalStore(':memory:');
  t.after(async () => { store.close(); if (old === undefined) delete process.env.SHARED_MARKET_MANIFEST_FILE; else process.env.SHARED_MARKET_MANIFEST_FILE = old; await rm(dir, { recursive: true, force: true }); });
  let broadcasts = 0;
  const client = { ...verification,
    readContract: async (request: { functionName: string; address: string }) => request.functionName === 'paused' ? true : verification.readContract(request),
    sendRawTransaction: async () => { broadcasts++; },
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: 'success', transactionHash: hash }),
  } as unknown as NonNullable<Parameters<typeof submitMarketTransaction>[3]>;
  const borrowData = encodeFunctionData({ abi: SHARED_POOL_ABI, functionName: 'borrow', args: [1_000_000n] });
  const key = `shared-market:${owner.address.toLowerCase()}`;
  const record = { nextPrepareAt: 0, submitWindowAt: 0, submitAttempts: 0, prepared: { transaction: { ...reviewed, data: borrowData }, expiresAt: 200_000, operation: 'borrow', quantity: '1000000', approval: false } };
  await store.create(key, record);
  await assert.rejects(submitMarketTransaction(store, owner.address, await signed({ data: borrowData }), client, () => 100_000), /suspended/);
  assert.equal(broadcasts, 0);
  const repayData = encodeFunctionData({ abi: SHARED_POOL_ABI, functionName: 'repay', args: [1_000_000n] });
  await store.update(key, () => ({ ...record, prepared: { ...record.prepared, operation: 'repay', transaction: { ...reviewed, data: repayData } } }));
  const result = await submitMarketTransaction(store, owner.address, await signed({ data: repayData }), client, () => 100_000);
  assert.equal(result.status, 'confirmed'); assert.equal(broadcasts, 1);
});

test('an issuer upgrade breaking token reads still exposes suspended loan and dollar recovery state', async () => {
  const client = { ...verification, readContract: async (request: { functionName: string; address: string }) => {
    const { functionName, address } = request;
    if (functionName === 'implementation') return other.address;
    if (address === SHARED_STOCK && ['balanceOf','decimals'].includes(functionName)) throw new Error('Upgraded token no longer supports this read.');
    if (functionName === 'market') return [100n, 150n, 50n, 3333n, 500n, 166n, 0n, 0n, false, 513n];
    if (functionName === 'position') return [10n**18n, 20n, 0n, 0n, 0n, false];
    if (functionName === 'balanceOf') return 100n;
    if (functionName === 'netContributed') return 100n;
    if (functionName === 'previewRedeem' || functionName === 'maxWithdraw') return 90n;
    if (functionName === 'latest') return [42n, 35_000_000_000n, 100n, 10n**18n, 110n];
    return verification.readContract(request);
  } } as unknown as NonNullable<Parameters<typeof readSharedMarket>[1]>;
  const view = await readSharedMarket(owner.address, client, async () => config);
  assert.equal(view.status, 'suspended'); assert.equal(view.sharesRaw, null);
  assert.match(view.suspensionReasons[0], /implementation changed/);
  assert.equal(view.priceAtomic, null); assert.equal(view.walletValueAtomic, null);
  assert.equal(view.loan?.sharesRaw, (10n**18n).toString()); assert.equal(view.loan?.debtAtomic, '20');
  assert.equal(view.testUsdAtomic, '100'); assert.equal(view.lender?.maxWithdrawAtomic, '90');
});
