import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { EvmSigningRequest } from '../wallets/types.ts';
import type { Store } from './store.ts';
import { prepareBuildingAction, readBuildingPosition, submitBuildingAction, type ActionPlan } from './building-revenue-claims.ts';
import { prepareLocalInvestment, readLocalInvestments, reconcileLocalInvestment, submitLocalInvestment, type InvestmentRpc, type LocalInvestmentOrder } from './local-investments.ts';
import type { BuildingReadOptions } from './building-revenue.ts';
type Options = BuildingReadOptions & { investmentRpc?: InvestmentRpc };

export type ReinvestPhase = 'claim' | 'buy' | 'approve' | 'stake' | 'completed' | 'stopped';
export type ReinvestRecord = {
  id: string; account: string; phase: ReinvestPhase; claimedRaw: string | null; unitsRaw: string | null;
  claimId: string; approveId: string; stakeId: string; buyRequestId: string; orderId: string | null;
  error: string | null;
};
export type ReinvestView = ReinvestRecord & {
  request: EvmSigningRequest | null; stepId: string | null; pending: boolean;
  receipts: { operation: string; hash: string; status: string }[];
};
type OwnReceipt = { planId: string; operation: string; status: string; claimedRaw: string | null; hash: string };
const walletOf = (identity: VerifiedIdentity) => {
  const wallet = identity.wallets.find(item => item.chainType === 'ethereum');
  if (!wallet) throw new Error('Your account has no Robinhood wallet.');
  return { ...wallet, address: getAddress(wallet.address) };
};
const keyOf = (account: string) => `building-revenue:reinvest:${account.toLowerCase()}`;

/** A confirmed claim's event, never its estimate or the wallet balance, determines the buy. */
export function advanceReinvest(record: ReinvestRecord, receipts: OwnReceipt[], order: LocalInvestmentOrder | null): ReinvestRecord {
  const result = { ...record };
  const actionId = result.phase === 'claim' ? result.claimId : result.phase === 'approve' ? result.approveId : result.stakeId;
  const action = receipts.find(item => item.planId === actionId);
  if (['claim', 'approve', 'stake'].includes(result.phase) && action) {
    if (action.status === 'failed') return { ...result, phase: 'stopped', error: 'The exact building transaction failed. No subsequent step was sent; already claimed cash or bought units remain in your wallet.' };
    if (action.status !== 'confirmed') return result;
    if (result.phase === 'claim') {
      if (action.claimedRaw === null) return { ...result, phase: 'stopped', error: 'The confirmed claim amount could not be verified from its receipt.' };
      result.claimedRaw = action.claimedRaw;
      if (BigInt(action.claimedRaw) < 1000n || BigInt(action.claimedRaw) > 100_000_000n)
        return { ...result, phase: 'stopped', error: 'Claimed cash is in your wallet. Reinvestment orders need 0.001–100 tUSDG; use the desk separately or accumulate more earnings.' };
      result.phase = 'buy';
    } else result.phase = result.phase === 'approve' ? 'stake' : 'completed';
  }
  if (result.phase === 'buy' && order && order.id === result.orderId) {
    if (order.projectId !== 'demo-neighbourhood-homes' || order.direction !== 'buy' || order.cashAtomic !== result.claimedRaw)
      throw new Error('Reinvestment order differs from the confirmed claim.');
    if (order.state === 'completed') { result.unitsRaw = order.minimumUnitsRaw; result.phase = 'approve'; }
    else if (['failed', 'cancelled'].includes(order.state))
      return { ...result, phase: 'stopped', error: 'The desk purchase did not complete. Your remaining claimed cash stays in your wallet; no stake was sent.' };
  }
  return result;
}

export async function readBuildingReinvest(store: Store, identity: VerifiedIdentity, options: Options = {}): Promise<ReinvestView | null> {
  const wallet = walletOf(identity), key = keyOf(wallet.address);
  let record = await store.get<ReinvestRecord>(key);
  if (!record) return null;
  const position = await readBuildingPosition(store, wallet.address, options);
  let order: LocalInvestmentOrder | null = null;
  if (record.orderId) order = await reconcileLocalInvestment(store, identity, record.orderId, options.investmentRpc);
  record = await store.update<ReinvestRecord>(key, current => advanceReinvest(current, position.receipts, order));
  const planId = record.phase === 'claim' ? record.claimId : record.phase === 'approve' ? record.approveId : record.stakeId;
  const plan = ['claim', 'approve', 'stake'].includes(record.phase)
    ? await store.get<ActionPlan>(`building-revenue:action:${wallet.address.toLowerCase()}:${planId}`) : null;
  const step = record.phase === 'buy' ? order?.steps.find(item => item.state === 'ready' && item.request) : null;
  const pending = Boolean(plan?.status === 'pending' || (record.phase === 'buy' && order?.state === 'pending'));
  const request = pending ? null : plan?.status === 'review' && Date.now() < Date.parse(plan.request.expiresAt) ? plan.request : step?.request ?? null;
  return { ...record, pending, request, stepId: request ? (step?.id ?? plan?.id ?? null) : null,
    receipts: [...position.receipts.filter(item => [record!.claimId, record!.approveId, record!.stakeId].includes(item.planId)),
      ...(order?.steps.filter(item => item.hash).map(item => ({ operation: `${item.kind} at desk`, hash: item.hash!, status: item.state })) ?? [])] };
}

export async function startBuildingReinvest(store: Store, identity: VerifiedIdentity, options: Options = {}) {
  const wallet = walletOf(identity), key = keyOf(wallet.address);
  const existing = await store.get<ReinvestRecord>(key);
  if (existing && !['completed', 'stopped'].includes(existing.phase)) return prepareBuildingReinvest(store, identity, options);
  const position = await readBuildingPosition(store, wallet.address, options);
  if (!position.configured || BigInt(position.earnedRaw) < 1000n || BigInt(position.earnedRaw) > 100_000_000n)
    throw new Error('Reinvest needs verified claimable earnings of 0.001–100 fictional tUSDG.');
  if (position.receipts.some(item => item.status === 'pending')) throw new Error('Wait for the pending building receipt first.');
  const market = await readLocalInvestments(store, identity, options.investmentRpc);
  if (market.order && ['review', 'pending'].includes(market.order.state)) throw new Error('Finish the existing desk order before reinvesting.');
  const record: ReinvestRecord = { id: randomUUID(), account: wallet.address, phase: 'claim', claimedRaw: null, unitsRaw: null,
    claimId: randomUUID(), approveId: randomUUID(), stakeId: randomUUID(), buyRequestId: randomUUID(), orderId: null, error: null };
  if (existing) await store.update<ReinvestRecord>(key, current => {
    if (!['completed', 'stopped'].includes(current.phase)) return current;
    return record;
  });
  else {
    try { await store.create(key, record); }
    catch (error) { if (!await store.get(key)) throw error; }
  }
  return prepareBuildingReinvest(store, identity, options);
}

export async function prepareBuildingReinvest(store: Store, identity: VerifiedIdentity, options: Options = {}) {
  const wallet = walletOf(identity), key = keyOf(wallet.address);
  const view = await readBuildingReinvest(store, identity, options);
  if (!view) throw new Error('Start your reinvestment first.');
  if (view.pending || ['completed', 'stopped'].includes(view.phase) || view.request) return view;
  if (view.phase === 'buy') {
    let record = view;
    if (record.orderId) {
      const order = await reconcileLocalInvestment(store, identity, record.orderId, options.investmentRpc);
      if (order.state === 'expired') record = { ...record, buyRequestId: randomUUID(), orderId: null };
    }
    await store.update<ReinvestRecord>(key, current => current.id === record.id ? { ...current, buyRequestId: record.buyRequestId, orderId: record.orderId } : current);
    const order = await prepareLocalInvestment(store, identity, { requestId: record.buyRequestId, projectId: 'demo-neighbourhood-homes', direction: 'buy', cashAtomic: record.claimedRaw }, options.investmentRpc);
    await store.update<ReinvestRecord>(key, current => {
      if (current.id !== record.id || current.phase !== 'buy') throw new Error('Reinvestment changed during review.');
      return { ...current, orderId: order.id };
    });
  } else {
    const field = view.phase === 'claim' ? 'claimId' : view.phase === 'approve' ? 'approveId' : 'stakeId';
    let id = view[field];
    const old = await store.get<ActionPlan>(`building-revenue:action:${wallet.address.toLowerCase()}:${id}`);
    if (old?.status === 'review' && Date.now() >= Date.parse(old.request.expiresAt)) {
      const next = await store.update<ReinvestRecord>(key, current => current[field] === id ? { ...current, [field]: randomUUID() } : current);
      id = next[field];
    }
    await prepareBuildingAction(store, wallet.address, wallet.id, view.phase, view.phase === 'claim' ? undefined : view.unitsRaw!, { ...options, planId: id });
  }
  return readBuildingReinvest(store, identity, options);
}

export async function submitBuildingReinvest(store: Store, identity: VerifiedIdentity, stepId: string, signedTransaction: string, options: Options = {}) {
  const wallet = walletOf(identity), record = await store.get<ReinvestRecord>(keyOf(wallet.address));
  if (!record) throw new Error('Start your reinvestment first.');
  if (record.phase === 'buy' && record.orderId) await submitLocalInvestment(store, identity, record.orderId, stepId, signedTransaction, options.investmentRpc);
  else {
    const expected = record.phase === 'claim' ? record.claimId : record.phase === 'approve' ? record.approveId : record.phase === 'stake' ? record.stakeId : null;
    if (stepId !== expected) throw new Error('Review only the current reinvestment step.');
    await submitBuildingAction(store, wallet.address, stepId, signedTransaction, options);
  }
  return readBuildingReinvest(store, identity, options);
}
