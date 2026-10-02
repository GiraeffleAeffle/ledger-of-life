import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createPublicClient, decodeEventLog, defineChain, encodeFunctionData, getAddress, http, keccak256,
  parseAbi, parseTransaction, recoverTransactionAddress, type Address, type Hex, type TransactionReceipt,
} from 'viem';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { EvmSigningRequest } from '../wallets/types.ts';
import { TEST_CITY_INVESTMENTS, type TestCityInvestmentId } from '../data/local-investments.ts';
import { walletFor } from './agreements.ts';
import { ROBINHOOD_TESTNET } from './robinhood-demo.ts';
import type { Store } from './store.ts';
import { ConflictError } from './errors.ts';
import { WorkflowError } from '../domain/errors.ts';

const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const rpc = createPublicClient({ chain, transport: http() });
const tokenAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
const deskAbi = parseAbi(['function usd() view returns (address)', 'function stock() view returns (address)', 'function price() view returns (uint256)', 'function owner() view returns (address)', 'function quoteBuy(uint256) view returns (uint256)', 'function quoteSell(uint256) view returns (uint256)', 'function buy(uint256,uint256) returns (uint256)', 'function sell(uint256,uint256) returns (uint256)', 'event Bought(address indexed buyer,uint256 usdIn,uint256 stockOut)', 'event Sold(address indexed seller,uint256 stockIn,uint256 usdOut)']);
const network = { chainId: 46630 as const, name: 'Robinhood Chain Testnet', explorerUrl: 'https://explorer.testnet.chain.robinhood.com' };
const scale = 10n ** 18n;
const manifestFile = 'contracts/evm/deployments/local-investments-46630.json';
const timeoutMs = 10 * 60_000;
const maxSpend = 100_000_000n; // At most 100 test USD per order.
const maxUnits = 100n * scale;

export type LocalInvestmentAsset = { projectId: TestCityInvestmentId; unitAddress: string; marketAddress: string; unitDecimals: 18; priceAtomic: string; holdingRaw: string | null; totalSupplyRaw: string; availableUnitsRaw: string | null; error: string | null };
export type LocalInvestmentStep = { id: string; kind: 'approve' | 'buy' | 'sell'; state: 'ready' | 'pending' | 'confirmed' | 'failed'; request: EvmSigningRequest | null; hash: `0x${string}` | null };
export type LocalInvestmentOrder = { id: string; projectId: TestCityInvestmentId; direction: 'buy' | 'sell'; state: 'review' | 'pending' | 'completed' | 'failed' | 'expired' | 'cancelled'; cashAtomic: string; minimumUnitsRaw: string; expiresAt: string; steps: LocalInvestmentStep[]; error: string | null };
export type LocalInvestmentView = { state: 'ready' | 'not_configured' | 'unavailable'; network: typeof network; owner: string; cashAddress: string; cashAtomic: string | null; nativeAtomic: string | null; assets: LocalInvestmentAsset[]; order: LocalInvestmentOrder | null; error: string | null };
export type LocalInvestmentManifest = { version: 1; chainId: 46630; cashAddress: Address; cashCodeHash: Hex; operator: Address; assets: Record<TestCityInvestmentId, { unitAddress: Address; marketAddress: Address; unitCodeHash: Hex; marketCodeHash: Hex; priceAtomic: string; totalSupplyRaw: string; name: string; symbol: string; deployment?: { unitHash: Hex | null; deskHash: Hex | null; seedHash: Hex | null } }> };
type ReviewedTx = { chainId: 46630; to: Address; data: Hex; value: '0x0'; nonce: number; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
type PrivateStep = { id: string; kind: LocalInvestmentStep['kind']; state: LocalInvestmentStep['state']; transaction: ReviewedTx; signed: Hex | null; hash: Hex | null; nonceConflict?: { hash: Hex; blockHash: Hex; blockNumber: string } };
type PrivateOrder = { id: string; projectId: TestCityInvestmentId; owner: string; walletId: string; subject: string; manifestHash: Hex; cashAtomic: string; minimumUnitsRaw: string; preparedBlock: string; expiresAt: string; steps: PrivateStep[]; state: LocalInvestmentOrder['state']; error: string | null };
type Lane = { active: string | null; lastOrderId?: string; requests: Record<string, { digest: string; orderId: string }>; orders: Record<string, PrivateOrder> };
export type InvestmentRpc = typeof rpc;
function assert(condition: unknown, reason: string): asserts condition { if (!condition) throw new ConflictError(reason); }
const keyFor = (identity: VerifiedIdentity) => `local-investments:${createHash('sha256').update(identity.subject).digest('hex')}`;
const emptyLane = (): Lane => ({ active: null, requests: {}, orders: {} });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (value: string) => getAddress(value);
function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value)) throw new WorkflowError('Choose a canonical positive test-USD atomic amount.');
  const parsed = BigInt(value);
  if (parsed < 1000n) throw new WorkflowError('Buy at least 0.001 fictional test USD (tUSDG).');
  if (parsed > maxSpend) throw new WorkflowError('The per-order test spend limit is 100 test USD.');
  return parsed;
}
function unitAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,20}$/.test(value)) throw new WorkflowError('Choose a canonical positive fictional-unit atomic amount.');
  const parsed = BigInt(value);
  if (parsed > maxUnits) throw new WorkflowError('The per-order limit is 100 fictional test units.');
  return parsed;
}
const isSell = (order: PrivateOrder) => order.steps.some((step) => step.kind === 'sell');
function selected(identity: VerifiedIdentity) {
  const wallet = walletFor(identity, 'robinhood');
  return { ...wallet, address: address(wallet.address) };
}
function publicOrder(order: PrivateOrder, now = Date.now()): LocalInvestmentOrder {
  return {
    id: order.id, projectId: order.projectId, direction: isSell(order) ? 'sell' : 'buy', state: order.state, cashAtomic: order.cashAtomic,
    minimumUnitsRaw: order.minimumUnitsRaw, expiresAt: order.expiresAt, error: order.error,
    steps: order.steps.map((step, index) => ({
      id: step.id, kind: step.kind, state: step.state, hash: step.hash,
      request: order.state === 'review' && step.state === 'ready' && order.steps.slice(0, index).every((prior) => prior.state === 'confirmed') && now < Date.parse(order.expiresAt) ? {
        walletId: order.walletId, operationId: step.id,
        description: `${step.kind === 'approve' ? `Approve exact ${isSell(order) ? 'fictional test units' : 'tUSDG'} for` : step.kind === 'sell' ? 'Sell back fictional test units in' : 'Buy fictional test units in'} ${order.projectId} · no value, no rights`,
        expiresAt: order.expiresAt, transaction: {
          chainId: step.transaction.chainId, to: step.transaction.to, data: step.transaction.data,
          value: step.transaction.value, nonce: step.transaction.nonce, gasLimit: step.transaction.gas,
          maxFeePerGas: step.transaction.maxFeePerGas, maxPriorityFeePerGas: step.transaction.maxPriorityFeePerGas,
        },
      } : null,
    })),
  };
}
async function manifest(): Promise<{ value: LocalInvestmentManifest; hash: Hex } | null> {
  let bytes: string;
  try { bytes = await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ process.env.LOCAL_INVESTMENTS_MANIFEST_FILE || manifestFile), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(bytes) as LocalInvestmentManifest;
  assert(value.version === 1 && value.chainId === 46630 && same(address(value.cashAddress), ROBINHOOD_TESTNET.usd), 'Invalid investment manifest.');
  assert(Object.keys(value.assets).length === TEST_CITY_INVESTMENTS.length, 'Unexpected manifest assets.');
  for (const project of TEST_CITY_INVESTMENTS) {
    const asset = value.assets[project.id];
    assert(asset && asset.name === project.name && asset.symbol === project.symbol && asset.priceAtomic === project.priceAtomicPerUnit && asset.totalSupplyRaw === project.totalUnitsRaw, 'Manifest issuer does not match the fictional catalogue.');
    address(asset.unitAddress); address(asset.marketAddress);
  }
  return { value, hash: keccak256(`0x${Buffer.from(bytes).toString('hex')}`) };
}
async function verified(config: LocalInvestmentManifest, client: InvestmentRpc) {
  assert(await client.getChainId() === 46630, 'Wrong test network.');
  assert(keccak256((await client.getCode({ address: ROBINHOOD_TESTNET.usd })) || '0x') === config.cashCodeHash, 'Test cash contract identity changed.');
  assert(await client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'decimals' }) === 6, 'Test cash decimals changed.');
  for (const project of TEST_CITY_INVESTMENTS) {
    const asset = config.assets[project.id];
    const [unitCode, marketCode, name, symbol, decimals, supply, usd, stock, price, owner] = await Promise.all([
      client.getCode({ address: asset.unitAddress }), client.getCode({ address: asset.marketAddress }),
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'name' }),
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'symbol' }),
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'decimals' }),
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'totalSupply' }),
      client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: 'usd' }),
      client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: 'stock' }),
      client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: 'price' }),
      client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: 'owner' }),
    ]);
    assert(keccak256(unitCode || '0x') === asset.unitCodeHash && keccak256(marketCode || '0x') === asset.marketCodeHash &&
      name === asset.name && symbol === asset.symbol && decimals === 18 && supply.toString() === asset.totalSupplyRaw &&
      same(usd, ROBINHOOD_TESTNET.usd) && same(stock, asset.unitAddress) && same(owner, config.operator) && price.toString() === asset.priceAtomic,
      'Investment unit or desk no longer matches the reviewed manifest.');
  }
}
function bound(order: PrivateOrder, identity: VerifiedIdentity, manifestHash: Hex) {
  const wallet = selected(identity);
  assert(order.subject === identity.subject && order.walletId === wallet.id && same(order.owner, wallet.address) && order.manifestHash === manifestHash, 'Order does not belong to this verified wallet and deployment.');
}
function active(lane: Lane): PrivateOrder | null { return lane.active ? lane.orders[lane.active] : null; }
function expiry(lane: Lane, now = Date.now()) {
  const order = active(lane);
  if (order && Date.parse(order.expiresAt) <= now && order.steps.every((step) => step.state !== 'pending') && order.state !== 'completed') {
    order.state = 'expired'; order.error = 'Review expired; no unsigned step can be sent.'; lane.active = null;
  }
  return lane;
}
async function laneGet(store: Store, identity: VerifiedIdentity) { return (await store.get<Lane>(keyFor(identity))) ?? emptyLane(); }
async function laneUpdate(store: Store, identity: VerifiedIdentity, change: (lane: Lane) => Lane) {
  const key = keyFor(identity);
  try { await store.create(key, emptyLane()); } catch (error) {
    // Unique-key collisions are expected when another request created the lane concurrently.
    if (!await store.get<Lane>(key)) throw error;
  }
  return store.update<Lane>(key, change);
}
export async function readLocalInvestments(store: Store, identity: VerifiedIdentity, client: InvestmentRpc = rpc): Promise<LocalInvestmentView> {
  const wallet = selected(identity);
  const base: LocalInvestmentView = { state: 'not_configured', network, owner: wallet.address, cashAddress: ROBINHOOD_TESTNET.usd, cashAtomic: null, nativeAtomic: null, assets: [], order: null, error: null };
  const deployment = await manifest();
  if (!deployment) return base;
  const stored = await laneGet(store, identity);
  const record = stored.active && Date.now() >= Date.parse(stored.orders[stored.active].expiresAt) &&
    stored.orders[stored.active].steps.every((step) => step.state !== 'pending')
    ? await laneUpdate(store, identity, (lane) => expiry(lane))
    : stored;
  const order = active(record) ?? (record.lastOrderId ? record.orders[record.lastOrderId] : null);
  if (order) { bound(order, identity, deployment.hash); base.order = publicOrder(order); }
  try {
    await verified(deployment.value, client);
    const [cash, native, assets] = await Promise.all([
      client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'balanceOf', args: [wallet.address] }),
      client.getBalance({ address: wallet.address }),
      Promise.all(TEST_CITY_INVESTMENTS.map(async (project): Promise<LocalInvestmentAsset> => {
        const config = deployment.value.assets[project.id];
        const [holding, available] = await Promise.all([
          client.readContract({ address: config.unitAddress, abi: tokenAbi, functionName: 'balanceOf', args: [wallet.address] }),
          client.readContract({ address: config.unitAddress, abi: tokenAbi, functionName: 'balanceOf', args: [config.marketAddress] }),
        ]);
        return { projectId: project.id, unitAddress: config.unitAddress, marketAddress: config.marketAddress, unitDecimals: 18, priceAtomic: config.priceAtomic, totalSupplyRaw: config.totalSupplyRaw, holdingRaw: holding.toString(), availableUnitsRaw: available.toString(), error: null };
      })),
    ]);
    return { ...base, state: 'ready', cashAtomic: cash.toString(), nativeAtomic: native.toString(), assets };
  } catch {
    return { ...base, state: 'unavailable', error: 'Unable to verify this testnet deployment or current balances. No zero balance is implied.' };
  }
}
export async function prepareLocalInvestment(store: Store, identity: VerifiedIdentity, input: { requestId: unknown; projectId: unknown; direction?: unknown; cashAtomic?: unknown; unitsRaw?: unknown }, client: InvestmentRpc = rpc): Promise<LocalInvestmentOrder> {
  const wallet = selected(identity);
  const requestId = input.requestId;
  assert(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(requestId), 'Invalid request ID.');
  const project = TEST_CITY_INVESTMENTS.find((item) => item.id === input.projectId);
  assert(project, 'Unknown fictional test issuer.');
  assert(input.direction === undefined || input.direction === 'buy' || input.direction === 'sell', 'Unknown test-unit order direction.');
  const selling = input.direction === 'sell';
  const quantity = selling ? unitAmount(input.unitsRaw) : amount(input.cashAtomic);
  const deployment = await manifest();
  assert(deployment, 'Test units have not been provisioned yet.');
  const digest = createHash('sha256').update(JSON.stringify([project.id, selling ? 'sell' : 'buy', quantity.toString(), wallet.id, wallet.address, deployment.hash])).digest('hex');
  const previous = (await laneGet(store, identity)).requests[requestId];
  if (previous) {
    assert(previous.digest === digest, 'Request ID already belongs to a different review.');
    const order = (await laneGet(store, identity)).orders[previous.orderId];
    assert(order, 'Original review unavailable.'); bound(order, identity, deployment.hash);
    return publicOrder(order);
  }
  await verified(deployment.value, client);
  const preparedBlock = await client.getBlockNumber();
  const asset = deployment.value.assets[project.id];
  const expected = selling ? quantity : quantity * scale / BigInt(asset.priceAtomic);
  const spend = selling ? quantity * BigInt(asset.priceAtomic) / scale : quantity;
  assert(expected > 0n && spend > 0n, 'Amount is too small for a test-unit trade.');
  assert(expected <= maxUnits, 'The per-order limit is 100 fictional test units.');
  const inputToken = selling ? asset.unitAddress : ROBINHOOD_TESTNET.usd;
  const inputAmount = selling ? expected : spend;
  const [quoted, inventory, balance, allowance, fees, nonce, latestNonce] = await Promise.all([
    client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: selling ? 'quoteSell' : 'quoteBuy', args: [inputAmount] }),
    client.readContract({ address: selling ? ROBINHOOD_TESTNET.usd : asset.unitAddress, abi: tokenAbi, functionName: 'balanceOf', args: [asset.marketAddress] }),
    client.readContract({ address: inputToken, abi: tokenAbi, functionName: 'balanceOf', args: [wallet.address] }),
    client.readContract({ address: inputToken, abi: tokenAbi, functionName: 'allowance', args: [wallet.address, asset.marketAddress] }),
    client.estimateFeesPerGas(), client.getTransactionCount({ address: wallet.address, blockTag: 'pending' }),
    client.getTransactionCount({ address: wallet.address, blockTag: 'latest' }),
  ]);
  if (selling) {
    assert(balance >= expected, 'Not enough fictional test units in your wallet to sell back.');
    assert(inventory >= spend, 'The test desk lacks tUSDG for this sell-back. No approval or sale was prepared.');
    assert(quoted === spend, 'The fixed test sell-back quote changed.');
  } else {
    assert(quoted === expected && inventory >= expected && balance >= spend, 'Quote, available units or available test cash changed.');
  }
  assert(nonce === latestNonce, 'Another wallet transaction is pending; wait before preparing an investment.');
  assert(fees.maxFeePerGas && fees.maxFeePerGas > 0n, 'Network fees unavailable.');
  const expiryAt = new Date(Date.now() + timeoutMs).toISOString();
  const id = randomUUID();
  const calls = [
    ...(allowance < inputAmount ? [{ kind: 'approve' as const, to: inputToken, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [asset.marketAddress, inputAmount] }) }] : []),
    selling
      ? { kind: 'sell' as const, to: asset.marketAddress, data: encodeFunctionData({ abi: deskAbi, functionName: 'sell', args: [expected, spend] }) }
      : { kind: 'buy' as const, to: asset.marketAddress, data: encodeFunctionData({ abi: deskAbi, functionName: 'buy', args: [spend, expected] }) },
  ];
  const steps: PrivateStep[] = calls.map((call, index) => ({ id: randomUUID(), kind: call.kind, state: 'ready', signed: null, hash: null, transaction: {
    chainId: 46630, to: call.to, data: call.data, value: '0x0', nonce: nonce + index,
    gas: '0x927c0', maxFeePerGas: `0x${(fees.maxFeePerGas! * 2n).toString(16)}`,
    maxPriorityFeePerGas: `0x${(fees.maxPriorityFeePerGas ?? 0n).toString(16)}`,
  } }));
  const order: PrivateOrder = { id, projectId: project.id, subject: identity.subject, owner: wallet.address, walletId: wallet.id, manifestHash: deployment.hash, cashAtomic: spend.toString(), minimumUnitsRaw: expected.toString(), preparedBlock: preparedBlock.toString(), expiresAt: expiryAt, steps, state: 'review', error: null };
  const result = await laneUpdate(store, identity, (lane) => {
    expiry(lane);
    const existing = lane.requests[requestId];
    if (existing) { assert(existing.digest === digest, 'Request ID already belongs to a different review.'); return lane; }
    assert(!lane.active, 'Finish or verify your current test-unit order before preparing another.');
    lane.requests[requestId] = { digest, orderId: id }; lane.orders[id] = order; lane.active = id; lane.lastOrderId = id;
    return lane;
  });
  return publicOrder(result.orders[result.requests[requestId].orderId]);
}
function inspectSigned(step: PrivateStep, signed: string, owner: string): Promise<void> {
  assert(/^0x02(?:[a-fA-F0-9]{2})+$/.test(signed) && signed.length < 20_000, 'Expected a canonical signed EIP-1559 transaction.');
  const parsed = parseTransaction(signed as Hex);
  // Viem may omit canonical RLP zero fields, including Robinhood's zero priority fee.
  const reviewed = step.transaction;
  assert(parsed.type === 'eip1559' && parsed.chainId === 46630 && parsed.to && same(parsed.to, reviewed.to) &&
    parsed.data === reviewed.data && (parsed.value ?? 0n) === 0n && parsed.nonce === reviewed.nonce &&
    parsed.gas === BigInt(reviewed.gas) && parsed.maxFeePerGas === BigInt(reviewed.maxFeePerGas) &&
    (parsed.maxPriorityFeePerGas ?? 0n) === BigInt(reviewed.maxPriorityFeePerGas) && (!parsed.accessList || parsed.accessList.length === 0),
    'Signed transaction changed the reviewed call, nonce or fee ceiling.');
  return recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` }).then((signer) => { assert(same(signer, owner), 'Signed transaction belongs to a different wallet.'); });
}
export async function submitLocalInvestment(store: Store, identity: VerifiedIdentity, orderId: unknown, stepId: unknown, signed: unknown, client: InvestmentRpc = rpc): Promise<LocalInvestmentOrder> {
  assert(typeof orderId === 'string' && typeof stepId === 'string' && typeof signed === 'string', 'Invalid signed order request.');
  const deployment = await manifest(); assert(deployment, 'Investment manifest unavailable.');
  const lane = await laneGet(store, identity);
  const order = lane.orders[orderId]; assert(order && lane.active === orderId, 'No active review for this order.');
  bound(order, identity, deployment.hash);
  const index = order.steps.findIndex((step) => step.id === stepId);
  assert(index >= 0 && order.steps.slice(0, index).every((step) => step.state === 'confirmed'), 'Confirm the exact token approval before trading fictional test units.');
  const step = order.steps[index];
  await inspectSigned(step, signed, order.owner);
  const hash = keccak256(signed as Hex);
  if (step.signed) { assert(step.signed === signed && step.hash === hash, 'Only the identical signed transaction may be retried.'); return reconcileLocalInvestment(store, identity, orderId, client); }
  assert(step.state === 'ready' && Date.now() < Date.parse(order.expiresAt), 'Unsigned review expired or already used.');
  await verified(deployment.value, client);
  const [pendingNonce, confirmedNonce] = await Promise.all([
    client.getTransactionCount({ address: address(order.owner), blockTag: 'pending' }),
    client.getTransactionCount({ address: address(order.owner), blockTag: 'latest' }),
  ]);
  assert(pendingNonce === step.transaction.nonce && confirmedNonce === pendingNonce, 'Wallet nonce contention: verify other wallet transactions before signing.');
  if (step.kind === 'buy') {
    const asset = deployment.value.assets[order.projectId];
    const [allowance, balance, inventory, quote] = await Promise.all([
      client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'allowance', args: [address(order.owner), asset.marketAddress] }),
      client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'balanceOf', args: [address(order.owner)] }),
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'balanceOf', args: [asset.marketAddress] }),
      client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: 'quoteBuy', args: [BigInt(order.cashAtomic)] }),
    ]);
    assert(allowance >= BigInt(order.cashAtomic) && balance >= BigInt(order.cashAtomic) && inventory >= BigInt(order.minimumUnitsRaw) && quote === BigInt(order.minimumUnitsRaw), 'Cash, approval, quote or inventory changed before signing the buy.');
  }
  if (isSell(order)) {
    const asset = deployment.value.assets[order.projectId];
    const [holding, deskCash, quote, allowance] = await Promise.all([
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'balanceOf', args: [address(order.owner)] }),
      client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'balanceOf', args: [asset.marketAddress] }),
      client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: 'quoteSell', args: [BigInt(order.minimumUnitsRaw)] }),
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'allowance', args: [address(order.owner), asset.marketAddress] }),
    ]);
    assert(holding >= BigInt(order.minimumUnitsRaw), 'Not enough fictional test units remain to sell back.');
    assert(deskCash >= BigInt(order.cashAtomic), 'The test desk lacks tUSDG for this sell-back. This signed step was not sent.');
    assert(quote === BigInt(order.cashAtomic), 'The fixed test sell-back quote changed.');
    assert(step.kind !== 'sell' || allowance >= BigInt(order.minimumUnitsRaw), 'Confirm the exact unit approval before selling back.');
  }
  // One atomic record contains reservation, reviewed call and exact signed bytes before any send.
  await laneUpdate(store, identity, (current) => {
    const target = current.orders[orderId]; assert(target && current.active === orderId, 'Order reservation changed.');
    bound(target, identity, deployment.hash);
    const entry = target.steps[index];
    assert(target.steps.slice(0, index).every((prior) => prior.state === 'confirmed'), 'Prior approval is not confirmed.');
    assert(!entry.signed || entry.signed === signed, 'Different transaction already submitted for this step.');
    if (!entry.signed) {
      assert(entry.state === 'ready' && Date.now() < Date.parse(target.expiresAt), 'Review expired.');
      entry.signed = signed as Hex; entry.hash = hash; entry.state = 'pending'; target.state = 'pending';
    }
    return current;
  });
  return reconcileLocalInvestment(store, identity, orderId, client);
}

function matchingLogs(order: PrivateOrder, receipt: TransactionReceipt, asset: LocalInvestmentManifest['assets'][TestCityInvestmentId]): boolean {
  const buyer = address(order.owner);
  const selling = isSell(order);
  const cashFrom = selling ? asset.marketAddress : buyer, cashTo = selling ? buyer : asset.marketAddress;
  const unitsFrom = cashTo, unitsTo = cashFrom;
  let trades = 0, cash = 0, units = 0;
  for (const log of receipt.logs) {
    try {
      if (same(log.address, asset.marketAddress)) {
        const event = decodeEventLog({ abi: deskAbi, data: log.data, topics: log.topics, strict: true });
        if (event.eventName === 'Bought') {
          if (selling || !same(event.args.buyer, buyer) || event.args.usdIn !== BigInt(order.cashAtomic) || event.args.stockOut !== BigInt(order.minimumUnitsRaw)) return false;
          trades++;
        } else if (event.eventName === 'Sold') {
          if (!selling || !same(event.args.seller, buyer) || event.args.stockIn !== BigInt(order.minimumUnitsRaw) || event.args.usdOut !== BigInt(order.cashAtomic)) return false;
          trades++;
        }
      }
      if (same(log.address, ROBINHOOD_TESTNET.usd) || same(log.address, asset.unitAddress)) {
        const event = decodeEventLog({ abi: tokenAbi, data: log.data, topics: log.topics, strict: true });
        if (event.eventName !== 'Transfer') continue;
        if (same(log.address, ROBINHOOD_TESTNET.usd) && [event.args.from, event.args.to].some((party) => same(party, buyer) || same(party, asset.marketAddress))) {
          if (!same(event.args.from, cashFrom) || !same(event.args.to, cashTo) || event.args.value !== BigInt(order.cashAtomic)) return false;
          cash++;
        }
        if (same(log.address, asset.unitAddress) && [event.args.from, event.args.to].some((party) => same(party, buyer) || same(party, asset.marketAddress))) {
          if (!same(event.args.from, unitsFrom) || !same(event.args.to, unitsTo) || event.args.value !== BigInt(order.minimumUnitsRaw)) return false;
          units++;
        }
      }
    } catch { return false; }
  }
  return trades === 1 && cash === 1 && units === 1;
}
/** A higher account nonce alone is not evidence that this particular transaction failed. */
async function confirmedNonceReplacement(order: PrivateOrder, step: PrivateStep, client: InvestmentRpc) {
  const tip = await client.getBlockNumber();
  if (tip < 2n) return null;
  const confirmedHeight = tip - 2n;
  let low = BigInt(order.preparedBlock), high = confirmedHeight;
  const owner = address(order.owner);
  if (high < low || await client.getTransactionCount({ address: owner, blockNumber: high }) <= step.transaction.nonce) return null;
  // Locate the canonical block that consumed the nonce, without scanning every later block.
  while (low < high) {
    const middle = (low + high) / 2n;
    if (await client.getTransactionCount({ address: owner, blockNumber: middle }) > step.transaction.nonce) high = middle;
    else low = middle + 1n;
  }
  const block = await client.getBlock({ blockNumber: low, includeTransactions: true });
  if (!block.hash || block.number !== low) return null;
  const replacement = block.transactions.find((transaction) => typeof transaction !== 'string' &&
    same(transaction.from, owner) && transaction.nonce === step.transaction.nonce);
  if (!replacement || typeof replacement === 'string' || replacement.hash === step.hash || replacement.blockHash !== block.hash) return null;
  const [receipt, canonical, currentTip] = await Promise.all([
    client.getTransactionReceipt({ hash: replacement.hash }),
    client.getBlock({ blockNumber: low }), client.getBlockNumber(),
  ]);
  if (receipt.transactionHash !== replacement.hash || receipt.blockHash !== block.hash ||
    receipt.blockNumber !== low || canonical.hash !== block.hash || currentTip < low + 2n ||
    (receipt.status !== 'success' && receipt.status !== 'reverted')) return null;
  return { hash: replacement.hash, blockHash: block.hash, blockNumber: low.toString() };
}

export async function reconcileLocalInvestment(store: Store, identity: VerifiedIdentity, orderId: unknown, client: InvestmentRpc = rpc): Promise<LocalInvestmentOrder> {
  assert(typeof orderId === 'string', 'Invalid order ID.');
  const deployment = await manifest(); assert(deployment, 'Investment manifest unavailable.');
  const lane = await laneGet(store, identity);
  const order = lane.orders[orderId]; assert(order, 'Unknown investment order.'); bound(order, identity, deployment.hash);
  if (order.state === 'completed' || order.state === 'failed' || order.state === 'expired' || order.state === 'cancelled') return publicOrder(order);
  const step = order.steps.find((item) => item.state === 'pending');
  if (!step) {
    if (lane.active === orderId && Date.now() >= Date.parse(order.expiresAt)) {
      const expired = await laneUpdate(store, identity, (current) => expiry(current));
      return publicOrder(expired.orders[orderId]);
    }
    return publicOrder(order);
  }
  assert(step.signed && step.hash, 'Pending order has no durable signed transaction.');
  const latest = async () => {
    const current = (await laneGet(store, identity)).orders[orderId];
    assert(current, 'Investment order is unavailable.');
    return publicOrder(current);
  };
  // Unknown RPC evidence cannot be interpreted as either failure or completion.
  try {
    assert(await client.getChainId() === 46630, 'Wrong network.');
    let receipt: TransactionReceipt | null = null;
    try { receipt = await client.getTransactionReceipt({ hash: step.hash }); }
    catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error; }
    if (!receipt) {
      const conflict = await confirmedNonceReplacement(order, step, client);
      if (conflict) {
        const result = await laneUpdate(store, identity, (current) => {
          const target = current.orders[orderId];
          const entry = target?.steps.find((item) => item.id === step.id);
          if (!target || current.active !== orderId || entry?.state !== 'pending' ||
            entry.hash !== step.hash || entry.signed !== step.signed) return current;
          entry.state = 'failed'; entry.nonceConflict = conflict;
          target.state = 'failed';
          target.error = 'This nonce was used by another confirmed wallet transaction. The reviewed transaction did not execute; inspect your wallet before another trade.';
          current.active = null;
          return current;
        });
        return publicOrder(result.orders[orderId]);
      }
      const current = (await laneGet(store, identity)).orders[orderId];
      if (!current?.steps.some((item) => item.id === step.id && item.state === 'pending' && item.hash === step.hash)) return latest();
      // Retry the identical bytes, never replace its nonce or call. RPC send may be ambiguous.
      try { await client.sendRawTransaction({ serializedTransaction: step.signed }); } catch { /* query on next reconcile */ }
      return latest();
    }
    const [transaction, block, tip] = await Promise.all([
      client.getTransaction({ hash: step.hash }), client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber(),
    ]);
    if (transaction.hash !== step.hash || transaction.blockHash !== receipt.blockHash || receipt.transactionHash !== step.hash || block.hash !== receipt.blockHash || tip < receipt.blockNumber + 2n ||
      transaction.from.toLowerCase() !== order.owner.toLowerCase() || transaction.nonce !== step.transaction.nonce || !transaction.to || !same(transaction.to, step.transaction.to) ||
      transaction.input !== step.transaction.data || transaction.value !== 0n || transaction.chainId !== 46630 || transaction.gas !== BigInt(step.transaction.gas) ||
      transaction.maxFeePerGas !== BigInt(step.transaction.maxFeePerGas) || (transaction.maxPriorityFeePerGas ?? 0n) !== BigInt(step.transaction.maxPriorityFeePerGas)) return latest();
    if (receipt.status !== 'success' && receipt.status !== 'reverted') return latest();
    if (receipt.status === 'success' && step.kind !== 'approve' && !matchingLogs(order, receipt, deployment.value.assets[order.projectId])) {
      return latest(); // A successful unrelated or incomplete receipt is not a trade.
    }
    const result = await laneUpdate(store, identity, (current) => {
      const target = current.orders[orderId];
      const entry = target?.steps.find((item) => item.id === step.id);
      if (!target || current.active !== orderId || entry?.state !== 'pending' ||
        target.steps.find((item) => item.state === 'pending')?.id !== step.id) return current;
      assert(entry.signed === step.signed && entry.hash === step.hash, 'Signed transaction changed.');
      entry.state = receipt.status === 'success' ? 'confirmed' : 'failed';
      if (receipt.status !== 'success') { target.state = 'failed'; target.error = `${step.kind} failed on chain.`; current.active = null; }
      else if (target.steps.every((item) => item.state === 'confirmed')) { target.state = 'completed'; current.active = null; }
      else { target.state = target.steps.some((item) => item.state === 'pending') ? 'pending' : 'review'; }
      return current;
    });
    return publicOrder(result.orders[orderId]);
  } catch { return latest(); }
}

/** Release only a review with no signed transaction in flight; confirmed approval is not a purchase. */
export async function cancelLocalInvestment(store: Store, identity: VerifiedIdentity, orderId: unknown): Promise<LocalInvestmentOrder> {
  assert(typeof orderId === 'string', 'Invalid order ID.');
  const deployment = await manifest(); assert(deployment, 'Investment manifest unavailable.');
  const result = await laneUpdate(store, identity, (lane) => {
    const order = lane.orders[orderId];
    assert(order && lane.active === orderId, 'No active review for this order.');
    bound(order, identity, deployment.hash);
    assert(order.state === 'review' && order.steps.every((step) => step.state !== 'pending'), 'A signed pending transaction must be verified before closing this order.');
    order.state = 'cancelled';
    order.error = 'Review cancelled; a confirmed approval, if any, remains on chain.';
    lane.active = null;
    return lane;
  });
  return publicOrder(result.orders[orderId]);
}
