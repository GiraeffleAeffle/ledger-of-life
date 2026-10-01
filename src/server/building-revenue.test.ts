import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseTransaction, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import investments from '../../contracts/evm/deployments/local-investments-46630.json' with { type: 'json' };
import { LocalStore } from './store.ts';
import { BUILDING_ACTION_ABI, BUILDING_TOKEN_ABI, validateBuildingActionTransaction, type BuildingActionReview, type BuildingOperation } from './building-revenue-signing.ts';
import { readBuildingView, type BuildingManifest, type BuildingRpc } from './building-revenue.ts';
import { prepareBuildingAction, readBuildingPosition, submitBuildingAction } from './building-revenue-claims.ts';
import { setConnectorPayoutWallet } from './local-ai-hosts.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { EvmSigningRequest } from '../wallets/types.ts';

const holder = privateKeyToAccount(('0x' + '02'.repeat(32)) as Hex);
const distributor = getAddress('0x1111111111111111111111111111111111111111');
const foreign = getAddress('0x3333333333333333333333333333333333333333');
const unitToken = getAddress(investments.assets['demo-neighbourhood-homes'].unitAddress);
const payoutToken = getAddress(investments.cashAddress);
const manifest: BuildingManifest = { version: 3, chainId: 46630, status: 'deployed', distributor, payoutToken, unitToken, rewardDuration: 604800,
  rewardsSpec: { scheme: 'staking_stream_v1', scale: '1000000000000000000000000000000000000' },
  deploymentBlock: 1, runtimeCodeHash: keccak256('0x1234'), dependencyCodeHashes: { payoutToken: keccak256('0x1234'), unitToken: keccak256('0x1234') } };

function reviewed(operation: BuildingOperation, quantityRaw: string | null = null) {
  const review: BuildingActionReview = { distributor, unitToken, account: holder.address, operation, quantityRaw };
  const data = operation === 'approve'
    ? encodeFunctionData({ abi: BUILDING_TOKEN_ABI, functionName: 'approve', args: [distributor, BigInt(quantityRaw!)] })
    : quantityRaw === null ? encodeFunctionData({ abi: BUILDING_ACTION_ABI, functionName: operation as 'claim' | 'exit' | 'sync' })
      : encodeFunctionData({ abi: BUILDING_ACTION_ABI, functionName: operation as 'stake' | 'unstake', args: [BigInt(quantityRaw)] });
  return { review, transaction: { chainId: 46630, to: operation === 'approve' ? unitToken : distributor, value: 0n, data } };
}

test('staking signing scope refuses foreign accounts, wrong targets, changed amounts, trailing calldata and native value', () => {
  for (const operation of ['approve', 'stake', 'unstake', 'claim', 'exit', 'sync'] as BuildingOperation[]) {
    const { review, transaction } = reviewed(operation, ['approve', 'stake', 'unstake'].includes(operation) ? '100' : null);
    validateBuildingActionTransaction(transaction, review, holder.address, manifest);
    assert.throws(() => validateBuildingActionTransaction(transaction, { ...review, account: foreign }, holder.address, manifest), /another account/);
    assert.throws(() => validateBuildingActionTransaction({ ...transaction, to: foreign }, review, holder.address, manifest), /contract and calldata/);
    assert.throws(() => validateBuildingActionTransaction({ ...transaction, value: 1n }, review, holder.address, manifest), /native value/);
    assert.throws(() => validateBuildingActionTransaction({ ...transaction, data: transaction.data + '00' }, review, holder.address, manifest), /calldata/);
  }
  const { review, transaction } = reviewed('approve', '100');
  assert.throws(() => validateBuildingActionTransaction(transaction, { ...review, quantityRaw: '101' }, holder.address, manifest), /calldata/);
  assert.throws(() => validateBuildingActionTransaction(transaction, { ...review, distributor: foreign }, holder.address, manifest), /pinned/);
  assert.throws(() => validateBuildingActionTransaction(transaction, { ...review, quantityRaw: (2n ** 256n - 1n).toString() }, holder.address, manifest), /finite/);
  assert.throws(() => validateBuildingActionTransaction(transaction, review, holder.address, { ...manifest, version: 2 }), /pinned/);
  assert.throws(() => validateBuildingActionTransaction(transaction, review, holder.address, { ...manifest, distributor: null }), /deployed/);
});

function chainFixture() {
  let allowance = 0n, staked = 0n, units = 1000n, earned = 50n, sends = 0, failWait = false;
  const receipts = new Map<Hex, { status: 'success'; transactionHash: Hex; blockNumber: bigint }>();
  const rpc = {
    getChainId: async () => 46630, getCode: async () => '0x1234', getBlockNumber: async () => 20n,
    getTransactionCount: async () => 0, estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
    estimateGas: async () => 50000n, getBalance: async () => 100000000n,
    readContract: async (input: { functionName: string }) => {
      switch (input.functionName) {
        case 'payoutToken': return payoutToken; case 'unitToken': return unitToken;
        case 'balanceOf': return units; case 'stakedOf': return staked; case 'totalStaked': return staked;
        case 'allowance': return allowance; case 'earned': return earned;
        case 'rewardPerUnit': return 100n; case 'pendingRevenue': return 10n;
        case 'rewardDuration': return 604800n; case 'rewardScale': return 10n ** 36n;
        case 'rewardRate': return 10n ** 36n; case 'periodFinish': return 604900n; case 'lastUpdateTime': return 100n;
        case 'streamRemainingScaled': return 604800n * 10n ** 36n;
        case 'undistributedScaled': case 'rewardRemainderScaled': return 0n;
      }
      throw new Error('Unknown fixture read');
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const receipt = receipts.get(hash);
      if (receipt) return receipt;
      const error = new Error('Receipt unavailable'); error.name = 'TransactionReceiptNotFoundError'; throw error;
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      sends++;
      const tx = parseTransaction(serializedTransaction), hash = keccak256(serializedTransaction);
      assert.equal(tx.to?.toLowerCase(), tx.data!.slice(0, 10) === '0x095ea7b3' ? unitToken.toLowerCase() : distributor.toLowerCase());
      if (tx.to?.toLowerCase() === unitToken.toLowerCase()) {
        const call = decodeFunctionData({ abi: BUILDING_TOKEN_ABI, data: tx.data! });
        assert.equal(call.functionName, 'approve'); allowance = (call.args as [Hex, bigint])[1];
      } else {
        const call = decodeFunctionData({ abi: BUILDING_ACTION_ABI, data: tx.data! });
        if (call.functionName === 'stake') { units -= call.args[0]; staked += call.args[0]; allowance -= call.args[0]; }
        if (call.functionName === 'unstake') { units += call.args[0]; staked -= call.args[0]; }
        if (call.functionName === 'claim') earned = 0n;
        if (call.functionName === 'exit') { units += staked; staked = 0n; earned = 0n; }
      }
      receipts.set(hash, { status: 'success', transactionHash: hash, blockNumber: 10n }); return hash;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => { if (failWait) throw new Error('Timeout'); return receipts.get(hash)!; },
    getLogs: async (input: { event: { name: string } }) => {
      if (input.event.name === 'Transfer') return [{ args: { value: 101n }, blockNumber: 10n, transactionHash: keccak256(toHex('revenue')), removed: false }];
      return input.event.name === 'Staked' && staked > 0n ? [{ args: { account: holder.address, amount: staked }, removed: false }] : [];
    },
  } as unknown as BuildingRpc;
  return { rpc, sends: () => sends, setWaitFailure: (value: boolean) => { failWait = value; } };
}

async function signPrepared(request: EvmSigningRequest) {
  const tx = request.transaction;
  return holder.signTransaction({ type: 'eip1559', chainId: 46630, to: getAddress(tx.to), data: tx.data as Hex,
    value: 0n, nonce: Number(tx.nonce), gas: BigInt(tx.gasLimit as string), maxFeePerGas: BigInt(tx.maxFeePerGas as string),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas as string) });
}

test('finite staking prepares reject insufficient holdings, allowance, stake and invented claim quantities', async () => {
  const store = new LocalStore(':memory:'), chain = chainFixture(), options = { rpc: chain.rpc, loadManifest: async () => manifest };
  try {
    await assert.rejects(prepareBuildingAction(store, holder.address, 'wallet', 'stake', '1001', options), /does not hold/);
    await assert.rejects(prepareBuildingAction(store, holder.address, 'wallet', 'stake', '100', options), /Approve this exact/);
    await assert.rejects(prepareBuildingAction(store, holder.address, 'wallet', 'unstake', '1', options), /own deposited/);
    await assert.rejects(prepareBuildingAction(store, holder.address, 'wallet', 'claim', '1', options), /do not accept/);
    await assert.rejects(prepareBuildingAction(store, holder.address, 'wallet', 'approve', '0', options), /positive/);
  } finally { await store.close(); }
});

test('approve then stake, partial unstake and exit keep own account state; retries and GET reconcile the persisted hash', async () => {
  const store = new LocalStore(':memory:'), chain = chainFixture(), options = { rpc: chain.rpc, loadManifest: async () => manifest };
  try {
    const approval = await prepareBuildingAction(store, holder.address, 'wallet', 'approve', '100', options);
    const signed = await signPrepared(approval.plan.request);
    const submitted = await submitBuildingAction(store, holder.address, approval.plan.id, signed, options);
    assert.equal(submitted.status, 'confirmed');
    assert.deepEqual(await submitBuildingAction(store, holder.address, approval.plan.id, signed, { ...options, now: () => Date.now() + 300000 }), submitted);
    assert.equal(chain.sends(), 1);
    const stake = await prepareBuildingAction(store, holder.address, 'wallet', 'stake', '100', options);
    chain.setWaitFailure(true);
    assert.equal((await submitBuildingAction(store, holder.address, stake.plan.id, await signPrepared(stake.plan.request), options)).status, 'pending');
    chain.setWaitFailure(false);
    const position = await readBuildingPosition(store, holder.address, options);
    assert.equal(position.stakedRaw, '100'); assert.equal(position.walletUnitsRaw, '900');
    assert.equal(position.receipts.find(receipt => receipt.operation === 'stake')?.status, 'confirmed');
    const withdrawal = await prepareBuildingAction(store, holder.address, 'wallet', 'unstake', '40', options);
    await submitBuildingAction(store, holder.address, withdrawal.plan.id, await signPrepared(withdrawal.plan.request), options);
    assert.equal((await readBuildingPosition(store, holder.address, options)).stakedRaw, '60');
    const exit = await prepareBuildingAction(store, holder.address, 'wallet', 'exit', undefined, options);
    await submitBuildingAction(store, holder.address, exit.plan.id, await signPrepared(exit.plan.request), options);
    const exited = await readBuildingPosition(store, holder.address, options);
    assert.equal(exited.walletUnitsRaw, '1000'); assert.equal(exited.stakedRaw, '0'); assert.equal(exited.earnedRaw, '0');
  } finally { await store.close(); }
});

test('serialized staking submit rejects a changed fee before broadcasting', async () => {
  const store = new LocalStore(':memory:'), chain = chainFixture(), options = { rpc: chain.rpc, loadManifest: async () => manifest };
  try {
    const { plan } = await prepareBuildingAction(store, holder.address, 'wallet', 'claim', undefined, options);
    const tx = plan.request.transaction;
    const tampered = await holder.signTransaction({ type: 'eip1559', chainId: 46630, to: distributor, data: tx.data as Hex, value: 0n,
      nonce: Number(tx.nonce), gas: BigInt(tx.gasLimit!), maxFeePerGas: BigInt(tx.maxFeePerGas!) + 1n, maxPriorityFeePerGas: 0n });
    await assert.rejects(submitBuildingAction(store, holder.address, plan.id, tampered, options), /fee review/);
    assert.equal(chain.sends(), 0);
  } finally { await store.close(); }
});
test('permissionless sync requires pending income, not stake ownership, and cannot be changed into a claim', async () => {
  const store = new LocalStore(':memory:'), chain = chainFixture();
  const options = { rpc: chain.rpc, loadManifest: async () => manifest };
  try {
    const { plan } = await prepareBuildingAction(store, holder.address, 'wallet', 'sync', undefined, options);
    const review = plan.request.buildingAction!;
    assert.throws(() => validateBuildingActionTransaction({
      ...plan.request.transaction, data: encodeFunctionData({ abi: BUILDING_ACTION_ABI, functionName: 'claim' }),
    }, review, holder.address, manifest), /calldata/);
    await assert.rejects(prepareBuildingAction(store, holder.address, 'wallet', 'sync', '1', options), /do not accept/);
    const rpc = { ...chain.rpc, readContract: async (input: Parameters<BuildingRpc['readContract']>[0]) =>
      input.functionName === 'pendingRevenue' ? 0n : chain.rpc.readContract(input) } as BuildingRpc;
    await assert.rejects(prepareBuildingAction(store, holder.address, 'wallet', 'sync', undefined, { ...options, rpc }), /No new incoming/);
    const zeroEarnedRpc = { ...chain.rpc, readContract: async (input: Parameters<BuildingRpc['readContract']>[0]) =>
      input.functionName === 'earned' ? 0n : chain.rpc.readContract(input) } as BuildingRpc;
    await assert.rejects(prepareBuildingAction(store, holder.address, 'wallet', 'claim', undefined, { ...options, rpc: zeroEarnedRpc }), /No whole atomic/);
  } finally { await store.close(); }
});

test('public building counters exclude free, failed and other-payee answers', async () => {
  const store = new LocalStore(':memory:'), chain = chainFixture();
  try {
    await store.create('local-ai:request:1', { request: { state: 'completed', payment: { state: 'settled' }, review: { payTo: distributor }, usage: { outputTokens: 104, wallMs: 2000 } } });
    await store.create('local-ai:request:2', { request: { state: 'completed', payment: { state: 'settled' }, review: { payTo: foreign }, usage: { outputTokens: 500, wallMs: 999999 } } });
    await store.create('local-ai:request:3', { request: { state: 'completed', payment: { state: 'none' }, review: null, usage: { outputTokens: 600, wallMs: 999999 } } });
    await store.create('local-ai:request:4', { request: { state: 'failed', payment: { state: 'settled' }, review: { payTo: distributor }, usage: { outputTokens: 700, wallMs: 999999 } } });
    const view = await readBuildingView(store, { rpc: chain.rpc, loadManifest: async () => manifest });
    assert.equal(view.gpuTokensServed, 104); assert.equal(view.paidAnswers, 1); assert.equal(view.revenueRaw, '101');
    assert.equal(view.heat.runtimeSeconds, 2); assert.equal(view.heat.nominalPowerWatts, null); assert.equal(view.totalStakedRaw, '0');
  } finally { await store.close(); }
});

test('host payout is owner-only, reversible to verified wallets and refuses arbitrary payees', async () => {
  const store = new LocalStore(':memory:');
  const identity = { subject: 'owner', wallets: [{ id: 'wallet', chainType: 'ethereum', address: holder.address }, { id: 'other', chainType: 'ethereum', address: foreign }] } as VerifiedIdentity;
  try {
    await store.create('local-ai:connector-registry', { hosts: [{ id: 'host', name: 'GPU', ownerSubject: 'owner', payoutWallet: holder.address,
      state: 'active', models: [], lastHeartbeat: null, ollamaReachable: false, awake: false, publicKey: 'unused', nonces: [] }], invitations: [] });
    assert.equal((await setConnectorPayoutWallet(store, identity, 'host', foreign)).payoutWallet, foreign);
    assert.equal((await setConnectorPayoutWallet(store, identity, 'host', holder.address)).payoutWallet, holder.address);
    await assert.rejects(setConnectorPayoutWallet(store, { ...identity, subject: 'other' }, 'host', foreign), /owner/);
    await assert.rejects(setConnectorPayoutWallet(store, identity, 'host', distributor), /verified wallet/);
  } finally { await store.close(); }
});
