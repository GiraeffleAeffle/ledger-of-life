import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, keccak256, parseAbi, parseAbiParameters, parseTransaction,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TEST_CITY_INVESTMENTS } from '../data/local-investments.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { ROBINHOOD_TESTNET } from './robinhood-demo.ts';
import {
  cancelLocalInvestment, prepareLocalInvestment, readLocalInvestments, reconcileLocalInvestment,
  submitLocalInvestment, type InvestmentRpc, type LocalInvestmentManifest, type LocalInvestmentOrder,
} from './local-investments.ts';
import { LocalStore, type Store } from './store.ts';

const buyer = privateKeyToAccount(`0x${'12'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'34'.repeat(32)}`);
const identity: VerifiedIdentity = { subject: 'test-owned-person', sessionId: 'test-session', expiresAt: Date.now() + 3600_000, wallets: [{ id: 'personal-wallet', chainType: 'ethereum', address: buyer.address }], passkeyCount: 1 };
const unitAddresses = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'].map(getAddress);
const marketAddresses = ['0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444'].map(getAddress);
const code = '0x6001600055' as Hex;
const codeHash = keccak256(code);
const eventAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)', 'event Bought(address indexed buyer,uint256 usdIn,uint256 stockOut)', 'event Sold(address indexed seller,uint256 stockIn,uint256 usdOut)']);
const blockHash = `0x${'aa'.repeat(32)}` as Hex;
const cash = 30_000_000n;

type MockState = { sent: Hex[]; receipt: 'missing' | 'reverted' | 'success' | 'unknown'; correctLogs: boolean; wrongSellEvent: boolean; wrongCashRecipient: boolean; nonce: number; pendingNonce: number | null; currentCash: bigint; deskCash: bigint; allowance: bigint; unitAllowance: bigint; bought: bigint; native: bigint };
function fixtureRpc(): { rpc: InvestmentRpc; state: MockState } {
  const state: MockState = { sent: [], receipt: 'missing', correctLogs: true, wrongSellEvent: false, wrongCashRecipient: false, nonce: 0, pendingNonce: null, currentCash: cash, deskCash: cash, allowance: 0n, unitAllowance: 0n, bought: 0n, native: 3_000_000_000_000_000n };
  const entryFor = (address: string) => {
    const index = unitAddresses.findIndex((unit) => unit.toLowerCase() === address.toLowerCase());
    return index >= 0 ? index : marketAddresses.findIndex((market) => market.toLowerCase() === address.toLowerCase());
  };
  const makeLog = (contract: Address, name: 'Bought' | 'Sold' | 'Transfer', indexed: Address[], value: bigint[]) => name !== 'Transfer' ? {
    address: contract,
    topics: name === 'Bought'
      ? encodeEventTopics({ abi: eventAbi, eventName: 'Bought', args: { buyer: indexed[0] } })
      : encodeEventTopics({ abi: eventAbi, eventName: 'Sold', args: { seller: indexed[0] } }),
    data: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [value[0], value[1]]),
  } : {
    address: contract,
    topics: encodeEventTopics({ abi: eventAbi, eventName: 'Transfer', args: { from: indexed[0], to: indexed[1] } }),
    data: encodeAbiParameters(parseAbiParameters('uint256'), [value[0]]),
  };
  const fake = {
    getChainId: async () => 46630,
    getCode: async () => code,
    getBalance: async () => state.native,
    getTransactionCount: async ({ blockTag }: { blockTag: 'pending' | 'latest' }) => blockTag === 'pending' ? state.pendingNonce ?? state.nonce : state.nonce,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n }),
    getBlockNumber: async () => 20n,
    getBlock: async () => ({ hash: blockHash }),
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      state.sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (state.receipt === 'missing') { const missing = new Error('not found'); missing.name = 'TransactionReceiptNotFoundError'; throw missing; }
      if (state.receipt === 'unknown') throw new Error('RPC transport unavailable');
      const parsed = parseTransaction(state.sent.find((raw) => keccak256(raw) === hash)!);
      const marketIndex = marketAddresses.findIndex((market) => market.toLowerCase() === parsed.to?.toLowerCase());
      const units = state.correctLogs ? 2n * 10n ** 18n : 3n * 10n ** 18n;
      const selling = parsed.data?.startsWith('0x' + keccak256(new TextEncoder().encode('sell(uint256,uint256)')).slice(2, 10));
      const logs = marketIndex < 0 ? [] : selling ? [
        makeLog(marketAddresses[marketIndex], state.wrongSellEvent ? 'Bought' : 'Sold', [buyer.address], state.wrongSellEvent ? [2_000_000n, 2n * 10n ** 18n] : [2n * 10n ** 18n, 2_000_000n]),
        makeLog(ROBINHOOD_TESTNET.usd, 'Transfer', [marketAddresses[marketIndex], state.wrongCashRecipient ? other.address : buyer.address], [2_000_000n]),
        makeLog(unitAddresses[marketIndex], 'Transfer', [buyer.address, marketAddresses[marketIndex]], [units]),
      ] : [
        makeLog(marketAddresses[marketIndex], 'Bought', [buyer.address], [2_000_000n, 2n * 10n ** 18n]),
        makeLog(ROBINHOOD_TESTNET.usd, 'Transfer', [buyer.address, marketAddresses[marketIndex]], [2_000_000n]),
        makeLog(unitAddresses[marketIndex], 'Transfer', [marketAddresses[marketIndex], buyer.address], [units]),
      ];
      return { status: state.receipt, transactionHash: hash, blockHash, blockNumber: 17n, logs };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const parsed = parseTransaction(state.sent.find((raw) => keccak256(raw) === hash)!);
      return { hash, blockHash, from: buyer.address, nonce: parsed.nonce, to: parsed.to, input: parsed.data,
        value: parsed.value ?? 0n, chainId: parsed.chainId, gas: parsed.gas,
        maxFeePerGas: parsed.maxFeePerGas, maxPriorityFeePerGas: parsed.maxPriorityFeePerGas };
    },
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      const index = entryFor(address);
      const project = TEST_CITY_INVESTMENTS[index];
      if (address.toLowerCase() === ROBINHOOD_TESTNET.usd.toLowerCase()) {
        if (functionName === 'decimals') return 6;
        if (functionName === 'balanceOf') return (args?.[0] as string).toLowerCase() === buyer.address.toLowerCase() ? state.currentCash : state.deskCash;
        if (functionName === 'allowance') return state.allowance;
      }
      if (index < 0 || !project) throw new Error('Unexpected contract');
      const isUnit = address.toLowerCase() === unitAddresses[index].toLowerCase();
      if (isUnit) {
        if (functionName === 'name') return project.name;
        if (functionName === 'symbol') return project.symbol;
        if (functionName === 'decimals') return 18;
        if (functionName === 'totalSupply') return BigInt(project.totalUnitsRaw);
        if (functionName === 'balanceOf') return (args?.[0] as string).toLowerCase() === buyer.address.toLowerCase() ? state.bought : BigInt(project.totalUnitsRaw) - state.bought;
        if (functionName === 'allowance') return state.unitAllowance;
      } else {
        if (functionName === 'owner') return other.address;
        if (functionName === 'usd') return ROBINHOOD_TESTNET.usd;
        if (functionName === 'stock') return unitAddresses[index];
        if (functionName === 'price') return 1_000_000n;
        if (functionName === 'quoteBuy') return BigInt(args![0] as bigint) * 10n ** 18n / 1_000_000n;
        if (functionName === 'quoteSell') return BigInt(args![0] as bigint) * 1_000_000n / 10n ** 18n;
      }
      throw new Error('Unexpected contract call');
    },
  };
  return { rpc: fake as unknown as InvestmentRpc, state };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'investment-test-'));
  const manifest = join(directory, 'manifest.json');
  const deployment: LocalInvestmentManifest = {
    version: 1, chainId: 46630, cashAddress: ROBINHOOD_TESTNET.usd, cashCodeHash: codeHash, operator: other.address,
    assets: Object.fromEntries(TEST_CITY_INVESTMENTS.map((project, index) => [project.id, {
      unitAddress: unitAddresses[index], marketAddress: marketAddresses[index], unitCodeHash: codeHash,
      marketCodeHash: codeHash, priceAtomic: project.priceAtomicPerUnit, totalSupplyRaw: project.totalUnitsRaw,
      name: project.name, symbol: project.symbol,
    }])) as LocalInvestmentManifest['assets'],
  };
  await writeFile(manifest, JSON.stringify(deployment));
  process.env.LOCAL_INVESTMENTS_MANIFEST_FILE = manifest;
  const store = new LocalStore(':memory:');
  const { rpc, state } = fixtureRpc();
  return { store, state, rpc, cleanup: async () => { await store.close(); delete process.env.LOCAL_INVESTMENTS_MANIFEST_FILE; await rm(directory, { recursive: true, force: true }); } };
}
async function sign(order: LocalInvestmentOrder, signer = buyer) {
  const step = order.steps.find((entry) => entry.request)!;
  const tx = step.request!.transaction;
  const serialized = await signer.signTransaction({ type: 'eip1559', chainId: 46630, to: tx.to as Address, data: tx.data as Hex, value: 0n,
    nonce: Number(tx.nonce), gas: BigInt(tx.gasLimit!), maxFeePerGas: BigInt(tx.maxFeePerGas!), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas!) });
  return { step, serialized };
}

test('parallel prepares reserve one atomic wallet lane; request replay returns its original order, not a second spend', async () => {
  const testbed = await setup();
  try {
    const input = { requestId: 'unique-request-123', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000' };
    const results = await Promise.allSettled([
      prepareLocalInvestment(testbed.store, identity, input, testbed.rpc),
      prepareLocalInvestment(testbed.store, identity, { ...input, requestId: 'other-request-123' }, testbed.rpc),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const winner = results.find((result) => result.status === 'fulfilled');
    assert(winner?.status === 'fulfilled');
    const requestId = winner.value.id === (results[0].status === 'fulfilled' ? results[0].value.id : '') ? input.requestId : 'other-request-123';
    const repeated = await prepareLocalInvestment(testbed.store, identity, { ...input, requestId }, testbed.rpc);
    assert.equal(repeated.id, winner.value.id);
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, { ...input, requestId, cashAtomic: '3000000' }, testbed.rpc), /different review/);
    assert.equal(testbed.state.sent.length, 0);
  } finally { await testbed.cleanup(); }
});

test('foreign and altered signed calls cannot enter the durable lane; cancelling unsigned or approval-only review is safe', async () => {
  const testbed = await setup();
  try {
    const order = await prepareLocalInvestment(testbed.store, identity, { requestId: 'first-request-123', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000' }, testbed.rpc);
    const { step } = await sign(order);
    const foreign = await sign(order, other);
    await assert.rejects(submitLocalInvestment(testbed.store, identity, order.id, step.id, foreign.serialized, testbed.rpc), /different wallet/);
    const alternate = await buyer.signTransaction({ type: 'eip1559', chainId: 46630, nonce: 0, to: other.address, data: '0x', value: 0n,
      gas: 600000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n });
    await assert.rejects(submitLocalInvestment(testbed.store, identity, order.id, step.id, alternate, testbed.rpc), /reviewed call/);
    assert.equal((await cancelLocalInvestment(testbed.store, identity, order.id)).state, 'cancelled');
    assert.equal(testbed.state.sent.length, 0);
  } finally { await testbed.cleanup(); }
});

test('failed durable signed write prevents any broadcast', async () => {
  const testbed = await setup();
  try {
    const order = await prepareLocalInvestment(testbed.store, identity, { requestId: 'durability-request', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000' }, testbed.rpc);
    const { step, serialized } = await sign(order);
    const unsafeStore: Store = { ...testbed.store, get: testbed.store.get.bind(testbed.store), create: testbed.store.create.bind(testbed.store), scan: testbed.store.scan.bind(testbed.store), close: testbed.store.close.bind(testbed.store),
      update: async () => { throw new Error('durable write failed'); } };
    await assert.rejects(submitLocalInvestment(unsafeStore, identity, order.id, step.id, serialized, testbed.rpc), /durable write failed/);
    assert.equal(testbed.state.sent.length, 0);
    assert.equal((await readLocalInvestments(testbed.store, identity, testbed.rpc)).order?.state, 'review');
  } finally { await testbed.cleanup(); }
});

test('approval receipt alone cannot complete purchase; unknown receipts stay pending and identical signed retry is safe', async () => {
  const testbed = await setup();
  try {
    const order = await prepareLocalInvestment(testbed.store, identity, { requestId: 'approval-request', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000' }, testbed.rpc);
    const { step, serialized } = await sign(order);
    assert.equal(order.steps[1].request, null);
    const pending = await submitLocalInvestment(testbed.store, identity, order.id, step.id, serialized, testbed.rpc);
    assert.equal(pending.state, 'pending');
    testbed.state.receipt = 'unknown';
    assert.equal((await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc)).state, 'pending');
    const duplicate = await submitLocalInvestment(testbed.store, identity, order.id, step.id, serialized, testbed.rpc);
    assert.equal(duplicate.state, 'pending');
    assert(testbed.state.sent.every((raw) => raw === serialized));
    testbed.state.receipt = 'success';
    const approved = await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc);
    assert.equal(approved.state, 'review');
    assert(approved.steps[1].request);
    assert.equal(testbed.state.bought, 0n);
    assert.equal((await cancelLocalInvestment(testbed.store, identity, order.id)).state, 'cancelled');
  } finally { await testbed.cleanup(); }
});

test('a successful receipt with mismatched token effects cannot claim a purchase', async () => {
  const testbed = await setup();
  try {
    testbed.state.allowance = 4_000_000n;
    const order = await prepareLocalInvestment(testbed.store, identity, { requestId: 'purchase-request', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000' }, testbed.rpc);
    const { step, serialized } = await sign(order);
    await submitLocalInvestment(testbed.store, identity, order.id, step.id, serialized, testbed.rpc);
    testbed.state.correctLogs = false;
    testbed.state.receipt = 'success';
    assert.equal((await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc)).state, 'pending');
    assert.equal((await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc)).state, 'pending');
  } finally { await testbed.cleanup(); }
});

test('canonical failure is terminal and an exact cash/unit purchase remains visible after reload', async () => {
  const testbed = await setup();
  try {
    testbed.state.allowance = 4_000_000n;
    const order = await prepareLocalInvestment(testbed.store, identity, { requestId: 'purchase-request', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000' }, testbed.rpc);
    const { step, serialized } = await sign(order);
    await submitLocalInvestment(testbed.store, identity, order.id, step.id, serialized, testbed.rpc);
    testbed.state.receipt = 'success';
    assert.equal((await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc)).state, 'completed');
    const refreshed = await readLocalInvestments(testbed.store, identity, testbed.rpc);
    assert.equal(refreshed.order?.state, 'completed');
    assert.equal(refreshed.order?.steps[0].hash, keccak256(serialized));
    testbed.state.nonce = 1;
    const following = await prepareLocalInvestment(testbed.store, identity, { requestId: 'following-request', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000' }, testbed.rpc);
    const signed = await sign(following);
    testbed.state.receipt = 'missing';
    await submitLocalInvestment(testbed.store, identity, following.id, signed.step.id, signed.serialized, testbed.rpc);
    testbed.state.receipt = 'reverted';
    assert.equal((await reconcileLocalInvestment(testbed.store, identity, following.id, testbed.rpc)).state, 'failed');
  } finally { await testbed.cleanup(); }
});

test('the second fictional issuer executes against its own pinned desk and unit, never a stock or first-issuer balance', async () => {
  const testbed = await setup();
  try {
    testbed.state.allowance = 2_000_000n;
    const view = await readLocalInvestments(testbed.store, identity, testbed.rpc);
    assert.equal(view.state, 'ready');
    assert.equal(view.cashAtomic, cash.toString());
    assert.equal(view.assets[1].unitAddress, unitAddresses[1]);
    const order = await prepareLocalInvestment(testbed.store, identity, {
      requestId: 'second-issuer-request', projectId: TEST_CITY_INVESTMENTS[1].id, cashAtomic: '2000000',
    }, testbed.rpc);
    assert.equal(order.minimumUnitsRaw, (2n * 10n ** 18n).toString());
    assert.equal(order.steps.length, 1);
    assert.equal(order.steps[0].request?.transaction.to, marketAddresses[1]);
    const { step, serialized } = await sign(order);
    await submitLocalInvestment(testbed.store, identity, order.id, step.id, serialized, testbed.rpc);
    testbed.state.receipt = 'success';
    assert.equal((await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc)).state, 'completed');
  } finally { await testbed.cleanup(); }
});

test('pending external nonce and foreign wallet fail closed; GET never broadcasts or silently mints funds', async () => {
  const testbed = await setup();
  try {
    testbed.state.pendingNonce = 1;
    const input = { requestId: 'contended-request', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000' };
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, input, testbed.rpc), /pending/);
    testbed.state.pendingNonce = null;
    const order = await prepareLocalInvestment(testbed.store, identity, input, testbed.rpc);
    const { step, serialized } = await sign(order);
    testbed.state.pendingNonce = 1;
    await assert.rejects(submitLocalInvestment(testbed.store, identity, order.id, step.id, serialized, testbed.rpc), /nonce contention/);
    assert.equal((await readLocalInvestments(testbed.store, identity, testbed.rpc)).order?.id, order.id);
    assert.equal(testbed.state.sent.length, 0);
    const foreign: VerifiedIdentity = { ...identity, wallets: [{ id: 'foreign-wallet', address: other.address, chainType: 'ethereum' }] };
    await assert.rejects(readLocalInvestments(testbed.store, foreign, testbed.rpc), /does not belong/);
    assert.equal(testbed.state.currentCash, cash);
    assert.equal(testbed.state.bought, 0n);
  } finally { await testbed.cleanup(); }
});

test('unsupported chain, absent deployed code, unknown issuer and noncanonical spend cannot reserve a buy', async () => {
  const testbed = await setup();
  try {
    const input = { requestId: 'identity-check-request', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000' };
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, { ...input, projectId: 'real-strausberg-provider' }, testbed.rpc), /Unknown fictional/);
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, { ...input, cashAtomic: '02000000' }, testbed.rpc), /canonical/);
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, { ...input, cashAtomic: '100000001' }, testbed.rpc), /limit/);
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, { ...input, cashAtomic: '999' }, testbed.rpc), /at least 0.001/);
    const foreignChain = { ...testbed.rpc, getChainId: async () => 1 } as InvestmentRpc;
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, input, foreignChain), /Wrong test network/);
    const missingCode = { ...testbed.rpc, getCode: async () => '0x' } as InvestmentRpc;
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, input, missingCode), /cash contract identity/);
    assert.equal(testbed.state.sent.length, 0);
  } finally { await testbed.cleanup(); }
});

test('delayed approval reconciliation cannot move a submitted buy backwards into review', async () => {
  const testbed = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const order = await prepareLocalInvestment(testbed.store, identity, {
      requestId: 'delayed-approval-request', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000',
    }, testbed.rpc);
    const approval = await sign(order);
    await submitLocalInvestment(testbed.store, identity, order.id, approval.step.id, approval.serialized, testbed.rpc);
    testbed.state.receipt = 'success';
    const delayed = {
      ...testbed.rpc,
      getTransactionReceipt: async (input: Parameters<InvestmentRpc['getTransactionReceipt']>[0]) => {
        const observed = await testbed.rpc.getTransactionReceipt(input);
        entered.resolve();
        await release.promise;
        return observed;
      },
    } as InvestmentRpc;
    const oldRead = reconcileLocalInvestment(testbed.store, identity, order.id, delayed);
    await entered.promise;
    const approved = await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc);
    testbed.state.nonce = 1;
    testbed.state.allowance = 2_000_000n;
    testbed.state.receipt = 'missing';
    const buy = await sign(approved);
    await submitLocalInvestment(testbed.store, identity, order.id, buy.step.id, buy.serialized, testbed.rpc);
    release.resolve();
    assert.equal((await oldRead).state, 'pending');
    const latest = (await readLocalInvestments(testbed.store, identity, testbed.rpc)).order!;
    assert.equal(latest.state, 'pending');
    assert.equal(latest.steps.find((step) => step.kind === 'buy')?.state, 'pending');
  } finally {
    release.resolve();
    await testbed.cleanup();
  }
});

test('a confirmed competing nonce releases the lane without preparing or sending a replacement purchase', async () => {
  const testbed = await setup();
  let consumed = false;
  let attempts = 0;
  const replacementHash = `0x${'bb'.repeat(32)}` as Hex;
  const replacement = { hash: replacementHash, from: buyer.address, nonce: 0, blockHash, blockNumber: 21n };
  const conflicting = {
    ...testbed.rpc,
    getBlockNumber: async () => consumed ? 23n : 20n,
    getTransactionCount: async ({ blockNumber }: { blockNumber?: bigint }) => consumed && (blockNumber === undefined || blockNumber >= 21n) ? 1 : 0,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: blockHash, transactions: blockNumber === 21n ? [replacement] : [] }),
    getTransaction: async ({ hash }: { hash: Hex }) => hash === replacementHash ? replacement : testbed.rpc.getTransaction({ hash }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash === replacementHash) return { status: 'success', transactionHash: hash, blockHash, blockNumber: 21n, logs: [] };
      const missing = new Error('not found'); missing.name = 'TransactionReceiptNotFoundError'; throw missing;
    },
    sendRawTransaction: async () => { attempts++; consumed = true; throw new Error('nonce too low'); },
  } as unknown as InvestmentRpc;
  try {
    testbed.state.allowance = 2_000_000n;
    const order = await prepareLocalInvestment(testbed.store, identity, {
      requestId: 'competing-nonce-request', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000',
    }, conflicting);
    const signed = await sign(order);
    await submitLocalInvestment(testbed.store, identity, order.id, signed.step.id, signed.serialized, conflicting);
    const resolved = await reconcileLocalInvestment(testbed.store, identity, order.id, conflicting);
    assert.equal(resolved.state, 'failed');
    assert.equal(resolved.steps[0].hash, keccak256(signed.serialized));
    assert.equal(attempts, 1);
    const next = await prepareLocalInvestment(testbed.store, identity, {
      requestId: 'explicit-next-request', projectId: TEST_CITY_INVESTMENTS[1].id, cashAtomic: '2000000',
    }, conflicting);
    assert.notEqual(next.id, order.id);
    assert.equal(next.state, 'review');
    assert.equal(attempts, 1);
  } finally { await testbed.cleanup(); }
});

test('a canonically encoded zero-tip wallet transaction is accepted without allowing a changed fee', async () => {
  const testbed = await setup();
  const zeroTip = { ...testbed.rpc, estimateFeesPerGas: async () => ({ maxFeePerGas: 12_000_000n, maxPriorityFeePerGas: 0n }) } as InvestmentRpc;
  try {
    testbed.state.allowance = 2_000_000n;
    const order = await prepareLocalInvestment(testbed.store, identity, {
      requestId: 'zero-tip-request', projectId: TEST_CITY_INVESTMENTS[0].id, cashAtomic: '2000000',
    }, zeroTip);
    const signed = await sign(order);
    const tx = signed.step.request!.transaction;
    const changed = await buyer.signTransaction({
      type: 'eip1559', chainId: 46630, nonce: Number(tx.nonce), to: tx.to as Address, data: tx.data as Hex,
      value: 0n, gas: BigInt(tx.gasLimit!), maxFeePerGas: BigInt(tx.maxFeePerGas!), maxPriorityFeePerGas: 1n,
    });
    await assert.rejects(submitLocalInvestment(testbed.store, identity, order.id, signed.step.id, changed, zeroTip), /reviewed call/);
    assert.equal(testbed.state.sent.length, 0);
    assert.equal((await submitLocalInvestment(testbed.store, identity, order.id, signed.step.id, signed.serialized, zeroTip)).state, 'pending');
    testbed.state.receipt = 'success';
    assert.equal((await reconcileLocalInvestment(testbed.store, identity, order.id, zeroTip)).state, 'completed');
  } finally { await testbed.cleanup(); }
});

test('sell-back reviews approve exact units, persist signed bytes, and verify Sold plus both transfers after reload', async () => {
  const testbed = await setup();
  try {
    testbed.state.bought = 5n * 10n ** 18n;
    const input = { requestId: 'sell-roundtrip-request', projectId: TEST_CITY_INVESTMENTS[1].id, direction: 'sell', unitsRaw: (2n * 10n ** 18n).toString() };
    const order = await prepareLocalInvestment(testbed.store, identity, input, testbed.rpc);
    assert.equal(order.direction, 'sell');
    assert.equal(order.cashAtomic, '2000000');
    assert.equal(order.minimumUnitsRaw, input.unitsRaw);
    assert.equal(order.steps[1].request, null);
    const approval = await sign(order);
    assert.equal(approval.step.request!.transaction.to, unitAddresses[1]);
    assert.deepEqual(decodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), data: approval.step.request!.transaction.data as Hex }).args, [marketAddresses[1], 2n * 10n ** 18n]);
    const unsafeStore: Store = { ...testbed.store, get: testbed.store.get.bind(testbed.store), create: testbed.store.create.bind(testbed.store), scan: testbed.store.scan.bind(testbed.store), close: testbed.store.close.bind(testbed.store), update: async () => { throw new Error('durable write failed'); } };
    await assert.rejects(submitLocalInvestment(unsafeStore, identity, order.id, approval.step.id, approval.serialized, testbed.rpc), /durable write/);
    assert.equal(testbed.state.sent.length, 0);
    await submitLocalInvestment(testbed.store, identity, order.id, approval.step.id, approval.serialized, testbed.rpc);
    assert.equal((await readLocalInvestments(testbed.store, identity, testbed.rpc)).order!.state, 'pending');
    testbed.state.receipt = 'success';
    testbed.state.nonce = 1;
    testbed.state.unitAllowance = 2n * 10n ** 18n;
    const ready = await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc);
    const sale = await sign(ready);
    assert.deepEqual(decodeFunctionData({ abi: parseAbi(['function sell(uint256,uint256) returns (uint256)']), data: sale.step.request!.transaction.data as Hex }).args, [2n * 10n ** 18n, 2_000_000n]);
    testbed.state.receipt = 'missing';
    await submitLocalInvestment(testbed.store, identity, order.id, sale.step.id, sale.serialized, testbed.rpc);
    testbed.state.receipt = 'success';
    for (const flaw of ['correctLogs', 'wrongSellEvent', 'wrongCashRecipient'] as const) {
      testbed.state[flaw] = flaw !== 'correctLogs';
      assert.equal((await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc)).state, 'pending');
      testbed.state[flaw] = flaw === 'correctLogs';
    }
    const completed = await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.steps[1].hash, keccak256(sale.serialized));
    assert.equal((await prepareLocalInvestment(testbed.store, identity, input, testbed.rpc)).id, order.id);
  } finally { await testbed.cleanup(); }
});

test('sell-back refuses missing holdings, empty desk cash, dust, changed quote and orders above 100 units', async () => {
  const testbed = await setup();
  try {
    const input = { requestId: 'sell-refusal-request', projectId: TEST_CITY_INVESTMENTS[0].id, direction: 'sell', unitsRaw: (2n * 10n ** 18n).toString() };
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, input, testbed.rpc), /Not enough fictional/);
    testbed.state.bought = 101n * 10n ** 18n;
    testbed.state.deskCash = 0n;
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, input, testbed.rpc), /desk lacks tUSDG/);
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, { ...input, unitsRaw: '1' }, testbed.rpc), /too small/);
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, { ...input, unitsRaw: '02000000000000000000' }, testbed.rpc), /canonical/);
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, { ...input, unitsRaw: (100n * 10n ** 18n + 1n).toString() }, testbed.rpc), /limit/);
    testbed.state.deskCash = 200_000_000n;
    const changedQuote = { ...testbed.rpc, readContract: async (args: Parameters<InvestmentRpc['readContract']>[0]) => args.functionName === 'quoteSell' ? 1n : testbed.rpc.readContract(args) } as InvestmentRpc;
    await assert.rejects(prepareLocalInvestment(testbed.store, identity, input, changedQuote), /quote changed/);
    const boundary = await prepareLocalInvestment(testbed.store, identity, { ...input, unitsRaw: (100n * 10n ** 18n).toString() }, testbed.rpc);
    assert.equal(boundary.cashAtomic, '100000000');
    await cancelLocalInvestment(testbed.store, identity, boundary.id);
    const order = await prepareLocalInvestment(testbed.store, identity, { ...input, requestId: 'sell-preflight-request' }, testbed.rpc);
    const approval = await sign(order);
    testbed.state.deskCash = 0n;
    await assert.rejects(submitLocalInvestment(testbed.store, identity, order.id, approval.step.id, approval.serialized, testbed.rpc), /desk lacks tUSDG/);
    assert.equal(testbed.state.sent.length, 0);
  } finally { await testbed.cleanup(); }
});

test('a reviewed sell-back rechecks unit approval, wallet holdings and desk cash before sending, and chain failure stays terminal', async () => {
  const testbed = await setup();
  try {
    testbed.state.bought = 2n * 10n ** 18n;
    testbed.state.unitAllowance = testbed.state.bought;
    const order = await prepareLocalInvestment(testbed.store, identity, {
      requestId: 'sell-send-refusal-request', projectId: TEST_CITY_INVESTMENTS[0].id, direction: 'sell', unitsRaw: testbed.state.bought.toString(),
    }, testbed.rpc);
    const sale = await sign(order);
    const foreign = await sign(order, other);
    await assert.rejects(submitLocalInvestment(testbed.store, identity, order.id, sale.step.id, foreign.serialized, testbed.rpc), /different wallet/);
    testbed.state.unitAllowance = 0n;
    await assert.rejects(submitLocalInvestment(testbed.store, identity, order.id, sale.step.id, sale.serialized, testbed.rpc), /unit approval/);
    testbed.state.unitAllowance = testbed.state.bought;
    testbed.state.bought = 0n;
    await assert.rejects(submitLocalInvestment(testbed.store, identity, order.id, sale.step.id, sale.serialized, testbed.rpc), /units remain/);
    testbed.state.bought = 2n * 10n ** 18n;
    testbed.state.deskCash = 1_999_999n;
    await assert.rejects(submitLocalInvestment(testbed.store, identity, order.id, sale.step.id, sale.serialized, testbed.rpc), /desk lacks tUSDG/);
    assert.equal(testbed.state.sent.length, 0);
    testbed.state.deskCash = 2_000_000n;
    await submitLocalInvestment(testbed.store, identity, order.id, sale.step.id, sale.serialized, testbed.rpc);
    testbed.state.receipt = 'reverted';
    const failed = await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'sell failed on chain.');
    testbed.state.receipt = 'success';
    assert.equal((await reconcileLocalInvestment(testbed.store, identity, order.id, testbed.rpc)).state, 'failed');
  } finally { await testbed.cleanup(); }
});
