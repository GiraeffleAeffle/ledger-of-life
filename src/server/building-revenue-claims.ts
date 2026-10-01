import { randomUUID } from 'node:crypto';
import { encodeFunctionData, formatUnits, getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import type { EvmSigningRequest } from '../wallets/types.ts';
import { BUILDING_ACTION_ABI, BUILDING_TOKEN_ABI, validateBuildingActionTransaction, type BuildingOperation } from './building-revenue-signing.ts';
import { BUILDING_ABI, buildingRpc, loadBuildingManifest, verifyBuildingDeployment, type BuildingReadOptions } from './building-revenue.ts';
import { reviewedOperatorFees, reviewedOperatorGas } from './ownership-gas.ts';
import type { Store } from './store.ts';

type Options = BuildingReadOptions & { now?: () => number };
type ActionPlan = {
  id: string; request: EvmSigningRequest;
  review: { operation: BuildingOperation; amount: string; asset: 'tHOME' | 'tUSDG'; distributor: string };
  signed?: Hex; hash?: Hex; status: 'review' | 'pending' | 'confirmed' | 'failed';
};

export async function readBuildingPosition(store: Store, wallet: string, options: Options = {}) {
  const account = getAddress(wallet), manifest = await (options.loadManifest ?? loadBuildingManifest)();
  const receipts: { operation: BuildingOperation; quantityRaw: string | null; hash: Hex; status: 'pending' | 'confirmed' | 'failed' }[] = [];
  if (!manifest?.distributor) return { configured: false, distributor: null, account,
    walletUnitsRaw: '0', walletUnits: '0', stakedRaw: '0', staked: '0', earnedRaw: '0', earned: '0', allowanceRaw: '0', pendingRevenueRaw: '0', receipts };
  const rpc = options.rpc ?? buildingRpc;
  await verifyBuildingDeployment(manifest, rpc);
  const [walletUnits, staked, earned, allowance, pendingRevenue] = await Promise.all([
    rpc.readContract({ address: manifest.unitToken, abi: BUILDING_TOKEN_ABI, functionName: 'balanceOf', args: [account] }),
    rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'stakedOf', args: [account] }),
    rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'earned', args: [account] }),
    rpc.readContract({ address: manifest.unitToken, abi: BUILDING_TOKEN_ABI, functionName: 'allowance', args: [account, manifest.distributor] }),
    rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'pendingRevenue' }),
  ]);
  let cursor = '';
  do {
    const rows = await store.scan<ActionPlan>(`building-revenue:action:${account.toLowerCase()}:`, cursor, 500);
    for (const row of rows) {
      cursor = row.key;
      let plan = row.value;
      if (!plan.hash || plan.status === 'review' || plan.review.distributor.toLowerCase() !== manifest.distributor.toLowerCase()) continue;
      if (plan.status === 'pending') {
        const hash = plan.hash;
        let receipt;
        try { receipt = await rpc.getTransactionReceipt({ hash }); }
        catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error; }
        if (receipt && receipt.transactionHash.toLowerCase() === hash.toLowerCase() &&
            await rpc.getBlockNumber() >= receipt.blockNumber + 2n) {
          plan = await store.update<ActionPlan>(row.key, current => current.hash === hash
            ? { ...current, status: receipt.status === 'success' ? 'confirmed' : 'failed' } : current);
        }
      }
      receipts.push({ operation: plan.review.operation, quantityRaw: plan.request.buildingAction!.quantityRaw,
        hash: plan.hash!, status: plan.status as 'pending' | 'confirmed' | 'failed' });
    }
    if (rows.length < 500) break;
  } while (true);
  return { configured: true, distributor: manifest.distributor, account,
    walletUnitsRaw: walletUnits.toString(), walletUnits: formatUnits(walletUnits, 18),
    stakedRaw: staked.toString(), staked: formatUnits(staked, 18), earnedRaw: earned.toString(), earned: formatUnits(earned, 6),
    allowanceRaw: allowance.toString(), pendingRevenueRaw: pendingRevenue.toString(), receipts };
}

export async function prepareBuildingAction(store: Store, wallet: string, walletId: string, operation: string, quantity?: string, options: Options = {}) {
  if (!['approve', 'stake', 'unstake', 'claim', 'exit', 'sync'].includes(operation)) throw new Error('Unknown building staking action.');
  const manifest = await (options.loadManifest ?? loadBuildingManifest)();
  if (!manifest?.distributor) throw new Error('Building staking distributor is not deployed.');
  const rpc = options.rpc ?? buildingRpc, account = getAddress(wallet);
  const position = await readBuildingPosition(store, wallet, { ...options, loadManifest: async () => manifest });
  const needsQuantity = ['approve', 'stake', 'unstake'].includes(operation);
  if (needsQuantity && (!quantity || !/^[1-9][0-9]{0,77}$/.test(quantity))) throw new Error('Choose a positive atomic tHOME amount.');
  if (!needsQuantity && quantity !== undefined) throw new Error('Claim, exit and sync do not accept an amount or recipient.');
  const amount = needsQuantity ? BigInt(quantity!) : 0n;
  if (['approve', 'stake'].includes(operation) && amount > BigInt(position.walletUnitsRaw))
    throw new Error('Your wallet does not hold that many fictional tHOME units.');
  if (operation === 'stake' && amount > BigInt(position.allowanceRaw))
    throw new Error('Approve this exact tHOME amount to the building contract first, then prepare the stake.');
  if (operation === 'unstake' && amount > BigInt(position.stakedRaw)) throw new Error('Unstake only your own deposited tHOME units.');
  if (operation === 'claim' && BigInt(position.earnedRaw) === 0n) throw new Error('No whole atomic tUSDG reward is claimable yet.');
  if (operation === 'sync' && BigInt(position.pendingRevenueRaw) === 0n) throw new Error('No new incoming building revenue needs a stream yet.');
  if (operation === 'exit' && BigInt(position.stakedRaw) === 0n && BigInt(position.earnedRaw) === 0n)
    throw new Error('There is no building stake or reward to exit.');
  const review = { distributor: manifest.distributor, unitToken: manifest.unitToken, account,
    operation: operation as BuildingOperation, quantityRaw: needsQuantity ? quantity! : null };
  const data = operation === 'approve'
    ? encodeFunctionData({ abi: BUILDING_TOKEN_ABI, functionName: 'approve', args: [manifest.distributor, amount] })
    : needsQuantity
      ? encodeFunctionData({ abi: BUILDING_ACTION_ABI, functionName: operation as 'stake' | 'unstake', args: [amount] })
      : encodeFunctionData({ abi: BUILDING_ACTION_ABI, functionName: operation as 'claim' | 'exit' | 'sync' });
  const to = operation === 'approve' ? manifest.unitToken : manifest.distributor;
  validateBuildingActionTransaction({ chainId: 46630, to, data, value: 0n }, review, account, manifest);
  const [nonce, latest, fees, gas, native] = await Promise.all([
    rpc.getTransactionCount({ address: account, blockTag: 'pending' }), rpc.getTransactionCount({ address: account, blockTag: 'latest' }),
    rpc.estimateFeesPerGas(), rpc.estimateGas({ account, to, data, value: 0n }), rpc.getBalance({ address: account }),
  ]);
  const limit = reviewedOperatorGas(gas, 'transfer'), reviewedFees = reviewedOperatorFees(fees);
  if (nonce !== latest || native < limit * reviewedFees.maxFeePerGas) throw new Error('Wallet nonce is busy or testnet gas is insufficient.');
  const id = randomUUID(), expiresAt = new Date((options.now ?? Date.now)() + 120000).toISOString();
  const transaction = { chainId: 46630 as const, from: account, to, data, value: '0x0' as const, nonce,
    gasLimit: `0x${limit.toString(16)}` as Hex, maxFeePerGas: `0x${reviewedFees.maxFeePerGas.toString(16)}` as Hex,
    maxPriorityFeePerGas: `0x${reviewedFees.maxPriorityFeePerGas.toString(16)}` as Hex };
  const displayedAmount = needsQuantity ? formatUnits(amount, 18) : operation === 'sync' ? formatUnits(BigInt(position.pendingRevenueRaw), 6) : position.earned;
  const description = operation === 'exit'
    ? `Unstake all your ${position.staked} fictional tHOME and claim your accrued tUSDG (currently ${position.earned}) to your own wallet.`
    : operation === 'claim' ? `Claim your accrued fictional tUSDG to your own wallet (currently ${position.earned}; final reward may change before execution).`
      : operation === 'sync' ? `Start streaming new income to stakers (anyone can do this). Currently ${displayedAmount} fictional tUSDG is pending; this call schedules streaming and pays you nothing.`
        : `${operation === 'approve' ? 'Approve only' : operation === 'stake' ? 'Stake' : 'Unstake'} ${displayedAmount} fictional tHOME ${operation === 'approve' ? 'to' : 'in'} the pinned building staking contract.`;
  const plan: ActionPlan = { id, request: { walletId, operationId: `building-revenue:${id}`,
    description: `${description} Building income streams to actual stakers over seven days, not instantly. Testnet only; no value or legal rights.`, expiresAt, buildingAction: review, transaction },
    review: { operation: review.operation, amount: displayedAmount, asset: needsQuantity ? 'tHOME' : 'tUSDG', distributor: manifest.distributor }, status: 'review' };
  await store.create(`building-revenue:action:${account.toLowerCase()}:${id}`, plan);
  return { plan };
}

export async function submitBuildingAction(store: Store, wallet: string, planId: string, signed: string, options: Options = {}) {
  if (!/^[0-9a-f-]{36}$/.test(planId) || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(signed) || signed.length > 20000)
    throw new Error('Invalid signed building staking transaction.');
  const account = getAddress(wallet), key = `building-revenue:action:${account.toLowerCase()}:${planId}`;
  const plan = await store.get<ActionPlan>(key);
  if (!plan?.request.buildingAction) throw new Error('Prepare your own building staking action first.');
  const manifest = await (options.loadManifest ?? loadBuildingManifest)();
  if (!manifest?.distributor) throw new Error('Building staking distributor is not deployed.');
  const rpc = options.rpc ?? buildingRpc;
  await verifyBuildingDeployment(manifest, rpc);
  const serialized = signed as `0x02${string}`, tx = parseTransaction(serialized), expected = plan.request.transaction;
  validateBuildingActionTransaction(tx, plan.request.buildingAction, account, manifest);
  if (tx.type !== 'eip1559' || tx.nonce !== expected.nonce || tx.gas !== BigInt(expected.gasLimit!) ||
      tx.maxFeePerGas !== BigInt(expected.maxFeePerGas!) || (tx.maxPriorityFeePerGas ?? 0n) !== BigInt(expected.maxPriorityFeePerGas!) ||
      tx.accessList?.length || getAddress(await recoverTransactionAddress({ serializedTransaction: serialized })) !== account)
    throw new Error('Signed building action differs from the exact wallet, nonce, gas, or fee review.');
  if (plan.signed && plan.signed !== serialized) throw new Error('Only identical signed building transaction bytes may be retried.');
  if (!plan.signed && (options.now ?? Date.now)() >= Date.parse(plan.request.expiresAt)) throw new Error('Building staking review expired.');
  const hash = keccak256(serialized);
  await store.update<ActionPlan>(key, current => {
    if (current.signed && current.signed !== serialized) throw new Error('Building action already signed differently.');
    return { ...current, signed: serialized, hash, status: current.status === 'review' ? 'pending' : current.status };
  });
  let receipt;
  try { receipt = await rpc.getTransactionReceipt({ hash }); }
  catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error; }
  if (!receipt) {
    try { await rpc.sendRawTransaction({ serializedTransaction: serialized }); }
    catch { /* Only the persisted hash can establish success after an ambiguous send. */ }
  }
  // Always wait for confirmations, even when a receipt was already found. Never accept a replacement's receipt.
  try { receipt = await rpc.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 10000, checkReplacement: false }); }
  catch { return { hash, status: 'pending' as const }; }
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('Building transaction receipt does not match its persisted signed bytes.');
  await store.update<ActionPlan>(key, current => ({ ...current, status: receipt.status === 'success' ? 'confirmed' : 'failed' }));
  if (receipt.status !== 'success') throw new Error('Exact building staking transaction reverted.');
  return { hash, status: 'confirmed' as const };
}
