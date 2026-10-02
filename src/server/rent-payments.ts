import { randomUUID } from 'node:crypto';
import { decodeEventLog, encodeFunctionData, formatUnits, getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionReceipt } from 'viem';
import { BUILDING_RENT_MEANING, BUILDING_RENT_SHARE_BPS, RENT_BUILDING_ID, berlinRentMonth, splitBuildingRent } from '../domain/rent.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { EvmSigningRequest } from '../wallets/types.ts';
import { TEST_USDG_ADDRESS } from '../wallets/inference-token.ts';
import { RENT_TOKEN_ABI, validateRentTransfer } from '../wallets/rent-signing.ts';
import { agreementDigest, agreementRole, walletFor, type Agreement } from './agreements.ts';
import { buildingRpc, loadBuildingManifest, verifyBuildingDeployment, type BuildingReadOptions } from './building-revenue.ts';
import { AccessError, ConflictError } from './errors.ts';
import { reviewedOperatorFees, reviewedOperatorGas } from './ownership-gas.ts';
import { tenancyJourney } from './journey.ts';
import type { Store } from './store.ts';

export type RentStep = { id: string; kind: 'landlord' | 'building'; recipient: string; amountRaw: string; state: 'prepared' | 'signed' | 'submitted' | 'confirmed' | 'stopped'; request: EvmSigningRequest | null; signed?: Hex; hash?: Hex; error: string | null; retryable?: boolean };
export type RentPayment = { id: string; agreementId: string; month: string; flatLabel: string; tenantWallet: string; landlordWallet: string; distributor: string; token: string; rentMonthly: string; landlordRaw: string; buildingRaw: string; state: 'prepared' | 'pending' | 'confirmed' | 'stopped'; error: string | null; steps: RentStep[]; createdAt: string };
export type RentPublicPayment = Omit<RentPayment, 'tenantWallet' | 'steps'> & { steps: Omit<RentStep, 'signed'>[] };
export type RentView = { agreementId: string; month: string; rentMonthly: string; landlordRaw: string; buildingRaw: string; role: 'tenant' | 'landlord'; active: boolean; payment: RentPublicPayment | null; history: RentPublicPayment[] };
export type RentReceipt = Pick<TransactionReceipt, 'status' | 'transactionHash'> & { logs: { address: string; data: Hex; topics: [] | [Hex, ...Hex[]] }[] };
type Options = BuildingReadOptions & { now?: () => number; readJourney?: typeof tenancyJourney };
const RENT_REVIEW_LIFETIME_MS = 2 * 60_000;
const keyOf = (id: string, month: string) => `rent-payment:${id}:${month}`;
const stateOf = (steps: RentStep[]): RentPayment['state'] => steps.every(step => step.state === 'confirmed') ? 'confirmed' : steps.some(step => step.state === 'stopped') ? 'stopped' : steps.some(step => step.signed) ? 'pending' : 'prepared';
async function context(store: Store, identity: VerifiedIdentity, id: string, pay: boolean, options: Options) {
  if (!/^[a-zA-Z0-9-]{1,160}$/.test(id)) throw new AccessError('This tenancy is unavailable.');
  const agreement = await store.get<Agreement>(`agreement:${id}`);
  if (!agreement) throw new AccessError('This tenancy is unavailable.');
  const role = agreementRole(agreement, identity);
  if (role === 'arbitrator' || (pay && role !== 'tenant')) throw new AccessError('Only the tenant can pay rent; only tenant and landlord can read it.');
  if (!agreement.rentTerms) { if (pay) throw new ConflictError('Rent payments are only available for the fictional building.'); return null; }
  if (agreement.rentTerms.shareBps !== BUILDING_RENT_SHARE_BPS || agreement.rentTerms.buildingId !== RENT_BUILDING_ID) throw new ConflictError('The agreed building rent terms are invalid.');
  const digest = agreementDigest(agreement);
  const accepted = Boolean(digest && agreement.accepted.tenant?.digest === digest && agreement.accepted.landlord?.digest === digest);
  const journey = await (options.readJourney ?? tenancyJourney)(store, identity, agreement);
  const active = !agreement.cancelled && accepted && journey.stage === 'living' && (agreement.depositForm?.kind === 'shares' ? journey.shareDeposit?.state === 'Active' : journey.chain?.phase === 'active');
  return { agreement, role, active };
}
async function journals(store: Store, id: string) {
  const result: RentPayment[] = []; let cursor = '';
  do { const rows = await store.scan<RentPayment>(`rent-payment:${id}:`, cursor, 100); result.push(...rows.map(row => row.value)); if (rows.length < 100) break; cursor = rows[rows.length - 1].key; } while (true);
  return result.sort((a,b) => b.month.localeCompare(a.month));
}
function visible(payment: RentPayment, role: 'tenant' | 'landlord'): RentPublicPayment {
  const { tenantWallet: _, steps, ...rest } = payment; void _;
  return { ...rest, steps: steps.map(step => { const { signed: _, ...value } = step; void _; return { ...value, request: role === 'tenant' && step.state === 'prepared' ? step.request : null }; }) };
}
export function verifyRentReceipt(receipt: RentReceipt, payment: RentPayment, step: RentStep) {
  if (!step.hash || receipt.transactionHash.toLowerCase() !== step.hash.toLowerCase() || receipt.status !== 'success') throw new Error('The exact rent transaction did not succeed.');
  const transfers = receipt.logs.flatMap(log => {
    try { const decoded = decodeEventLog({ abi: RENT_TOKEN_ABI, data: log.data, topics: log.topics }); return decoded.eventName === 'Transfer' ? [{ token: log.address, ...decoded.args }] : []; } catch { return []; }
  });
  if (transfers.length !== 1 || getAddress(transfers[0].token) !== getAddress(payment.token) || getAddress(transfers[0].from) !== getAddress(payment.tenantWallet) || getAddress(transfers[0].to) !== getAddress(step.recipient) || transfers[0].value !== BigInt(step.amountRaw)) throw new Error('Rent receipt differs from the exact Transfer token, sender, recipient or amount.');
}
async function deployment(options: Options) {
  const manifest = await (options.loadManifest ?? loadBuildingManifest)();
  if (!manifest?.distributor || getAddress(manifest.payoutToken) !== getAddress(TEST_USDG_ADDRESS)) throw new ConflictError('The fictional building tUSDG distributor is not deployed.');
  const rpc = options.rpc ?? buildingRpc; await verifyBuildingDeployment(manifest, rpc); return { manifest, rpc };
}
async function recover(store: Store, payment: RentPayment, broadcast: boolean, options: Options) {
  const pending = payment.steps.find(step => step.signed && ['signed','submitted'].includes(step.state));
  if (!pending?.hash || !pending.signed) return payment;
  const { manifest, rpc } = await deployment(options);
  if (getAddress(payment.distributor) !== getAddress(manifest.distributor!) || getAddress(payment.token) !== getAddress(manifest.payoutToken)) throw new ConflictError('The saved rent payment differs from the deployed building.');
  let receipt;
  try { receipt = await rpc.getTransactionReceipt({ hash: pending.hash }); }
  catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error; }
  let error: string | null = null;
  if (!receipt && broadcast) {
    try { const hash = await rpc.sendRawTransaction({ serializedTransaction: pending.signed }); if (hash.toLowerCase() !== pending.hash.toLowerCase()) throw new Error('RPC returned another transaction hash.'); }
    catch { error = 'Submission is unresolved. Only the saved signed transaction is retried; no replacement rent payment is allowed.'; }
    await store.update<RentPayment>(keyOf(payment.agreementId,payment.month), current => {
      const target = current.steps.find(step => step.id === pending.id)!;
      if (target.hash !== pending.hash || !['signed', 'submitted'].includes(target.state)) return current;
      const steps = current.steps.map(step => step.id === pending.id ? { ...step, state: 'submitted' as const, error } : step);
      return { ...current, state: stateOf(steps), error, steps };
    });
  }
  if (receipt || broadcast) {
    try { receipt = await rpc.waitForTransactionReceipt({ hash: pending.hash, confirmations: 3, timeout: 1000, checkReplacement: false }); }
    catch { return (await store.get<RentPayment>(keyOf(payment.agreementId,payment.month)))!; }
  }
  if (!receipt) return payment;
  const confirmedReceipt = receipt;
  try { verifyRentReceipt(confirmedReceipt,payment,pending); }
  catch (cause) {
    const error = cause instanceof Error ? cause.message : 'Rent receipt verification failed.';
    return store.update<RentPayment>(keyOf(payment.agreementId,payment.month), current => {
      const target = current.steps.find(step => step.id === pending.id)!;
      if (target.hash !== pending.hash || !['signed', 'submitted'].includes(target.state)) return current;
      return { ...current, state: 'stopped', error, steps: current.steps.map(step => step.id === pending.id ? { ...step, state: 'stopped', error, retryable: confirmedReceipt.status === 'reverted' && confirmedReceipt.transactionHash.toLowerCase() === pending.hash!.toLowerCase() } : step) };
    });
  }
  return store.update<RentPayment>(keyOf(payment.agreementId,payment.month), current => {
    const target = current.steps.find(step => step.id === pending.id)!;
    if (target.hash !== pending.hash || !['signed', 'submitted'].includes(target.state)) return current;
    const steps = current.steps.map(step => step.id === pending.id ? { ...step, state: 'confirmed' as const, error: null } : step);
    return { ...current, steps, state: stateOf(steps), error: null };
  });
}
export async function readRent(store: Store, identity: VerifiedIdentity, id: string, options: Options = {}): Promise<RentView | null> {
  const ctx = await context(store,identity,id,false,options); if (!ctx) return null;
  const month = berlinRentMonth((options.now ?? Date.now)()), history: RentPayment[] = [];
  for (const payment of await journals(store,id)) history.push(await recover(store,payment,ctx.role === 'tenant',options));
  return { agreementId:id, month, rentMonthly:ctx.agreement.rentTerms!.rentMonthly, ...splitBuildingRent(ctx.agreement.rentTerms!.rentMonthly), role:ctx.role, active:ctx.active, payment:history.find(item => item.month === month) ? visible(history.find(item => item.month === month)!,ctx.role) : null, history:history.map(item => visible(item,ctx.role)) };
}
export async function prepareRent(store: Store, identity: VerifiedIdentity, id: string, options: Options = {}) {
  const ctx = await context(store,identity,id,true,options);
  if (!ctx?.active) throw new ConflictError('Rent can only be paid in an active tenancy after both parties accept these terms.');
  const wallet = walletFor(identity,'robinhood'), terms = ctx.agreement.rentTerms!;
  const currentMonth = berlinRentMonth((options.now ?? Date.now)());
  const unfinished = (await journals(store,id)).find(item => item.month < currentMonth && item.state !== 'confirmed');
  const month = unfinished?.month ?? currentMonth, key = keyOf(id,month);
  const { manifest, rpc } = await deployment(options);
  let payment = unfinished ?? await store.get<RentPayment>(key);
  if (!payment) {
    const split = splitBuildingRent(terms.rentMonthly);
    payment = { id:randomUUID(), agreementId:id, month, flatLabel:ctx.agreement.property, tenantWallet:getAddress(wallet.address), landlordWallet:getAddress(terms.landlordWallet), distributor:manifest.distributor!, token:manifest.payoutToken, rentMonthly:terms.rentMonthly, ...split, state:'prepared',error:null,createdAt:new Date((options.now ?? Date.now)()).toISOString(),steps:[] };
    payment.steps = (['landlord','building'] as const).map(kind => ({ id:randomUUID(),kind,recipient:kind === 'building' ? payment!.distributor : payment!.landlordWallet,amountRaw:kind === 'building' ? payment!.buildingRaw : payment!.landlordRaw,state:BigInt(kind === 'building' ? payment!.buildingRaw : payment!.landlordRaw) === 0n ? 'confirmed' : 'prepared',request:null,error:null }));
    try { await store.create(key,payment); } catch (error) { payment = await store.get<RentPayment>(key); if (!payment) throw error; }
  }
  payment = await recover(store,payment,true,options);
  if (payment.state === 'confirmed') {
    if (month !== currentMonth) return readRent(store,identity,id,options);
    throw new ConflictError('Rent for this calendar month is already paid. A second payment is refused.');
  }
  const step = payment.steps.find(item => item.state !== 'confirmed')!;
  if (step.signed && !step.retryable) return readRent(store,identity,id,options);
  if (step.request && step.state === 'prepared' && Date.parse(step.request.expiresAt) > (options.now ?? Date.now)()) return readRent(store,identity,id,options);
  try {
    if (getAddress(payment.tenantWallet) !== getAddress(wallet.address) || getAddress(payment.distributor) !== getAddress(manifest.distributor!)) throw new ConflictError('The saved payment wallet or distributor changed.');
    const review = { agreementId:id,month,buildingId:terms.buildingId,shareBps:terms.shareBps,rentMonthly:payment.rentMonthly,tenantWallet:payment.tenantWallet,landlordWallet:payment.landlordWallet,distributor:payment.distributor,kind:step.kind };
    const data = encodeFunctionData({ abi:RENT_TOKEN_ABI,functionName:'transfer',args:[getAddress(step.recipient),BigInt(step.amountRaw)] });
    validateRentTransfer({ chainId:46630,to:payment.token,data,value:0n },review,wallet.address);
    const account = getAddress(wallet.address);
    const [nonce,latest,fees,gas,native,balance] = await Promise.all([rpc.getTransactionCount({address:account,blockTag:'pending'}),rpc.getTransactionCount({address:account,blockTag:'latest'}),rpc.estimateFeesPerGas(),rpc.estimateGas({account,to:getAddress(payment.token),data,value:0n}),rpc.getBalance({address:account}),rpc.readContract({address:getAddress(payment.token),abi:RENT_TOKEN_ABI,functionName:'balanceOf',args:[account]})]);
    const limit = reviewedOperatorGas(gas,'transfer'), reviewedFees = reviewedOperatorFees(fees);
    const remaining = payment.steps.filter(item => item.state !== 'confirmed').reduce((sum,item) => sum + BigInt(item.amountRaw),0n);
    if (nonce !== latest || native < limit * reviewedFees.maxFeePerGas || BigInt(balance) < remaining) throw new ConflictError('Wait for the wallet nonce or add enough test tUSDG and test ETH for the remaining rent transfers.');
    const request: EvmSigningRequest = { walletId:wallet.id,operationId:`rent-payment:${step.id}`,description:`Pay ${formatUnits(BigInt(step.amountRaw),6)} test dollars (tUSDG) for ${month} to ${step.kind === 'landlord' ? 'the landlord' : 'the fictional building distributor'}. ${BUILDING_RENT_MEANING} Deposit stays separate; its earnings belong to the tenant. Testnet only; no value, no rights; not legal advice.`,expiresAt:new Date((options.now ?? Date.now)()+RENT_REVIEW_LIFETIME_MS).toISOString(),rentTransfer:review,transaction:{chainId:46630,from:account,to:payment.token,data,value:'0x0',nonce,gasLimit:`0x${limit.toString(16)}`,maxFeePerGas:`0x${reviewedFees.maxFeePerGas.toString(16)}`,maxPriorityFeePerGas:`0x${reviewedFees.maxPriorityFeePerGas.toString(16)}`} };
    await store.update<RentPayment>(key,current => { const target = current.steps.find(item => item.id === step.id)!; if ((target.signed && !target.retryable) || target.state === 'confirmed' || (target.state === 'prepared' && target.request && Date.parse(target.request.expiresAt) > (options.now ?? Date.now)())) return current; const steps = current.steps.map(item => item.id === step.id ? { ...item,request,state:'prepared' as const,signed:undefined,hash:undefined,retryable:false,error:null } : item); return { ...current,steps,state:stateOf(steps),error:null }; });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'Rent preparation failed.';
    await store.update<RentPayment>(key,current => {
      const target = current.steps.find(item => item.id === step.id)!;
      if (target.signed || target.state === 'confirmed' || JSON.stringify(target.request) !== JSON.stringify(step.request)) return current;
      return { ...current,state:'stopped',error,steps:current.steps.map(item => item.id === step.id ? { ...item,state:'stopped',request:null,error } : item) };
    });
  }
  return readRent(store,identity,id,options);
}
export async function submitRent(store: Store, identity: VerifiedIdentity, id: string, stepId: string, signed: string, options: Options = {}) {
  const ctx = await context(store,identity,id,true,options);
  const payment = (await journals(store,id)).find(item => item.steps.some(step => step.id === stepId));
  if (!payment || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(signed) || signed.length > 20000) throw new ConflictError('Prepare the exact rent transfer before submitting.');
  const step = payment.steps.find(item => item.id === stepId)!, request = step.request;
  if (!step.signed && !ctx?.active) throw new ConflictError('A new rent transfer requires an active tenancy and both accepted terms.');
  if (payment.steps.find(item => item.state !== 'confirmed')?.id !== stepId && step.state !== 'confirmed') throw new ConflictError('Submit only the current reviewed rent step.');
  if (!request?.rentTransfer) throw new ConflictError('Prepare the exact rent transfer before signing.');
  const wallet = walletFor(identity,'robinhood'), serialized = signed as `0x02${string}`, tx = parseTransaction(serialized), expected = request.transaction;
  validateRentTransfer(tx,request.rentTransfer,wallet.address);
  if (tx.type !== 'eip1559' || tx.nonce !== expected.nonce || tx.gas !== BigInt(expected.gasLimit!) || tx.maxFeePerGas !== BigInt(expected.maxFeePerGas!) || (tx.maxPriorityFeePerGas ?? 0n) !== BigInt(expected.maxPriorityFeePerGas!) || tx.accessList?.length || getAddress(await recoverTransactionAddress({serializedTransaction:serialized})) !== getAddress(payment.tenantWallet)) throw new ConflictError('Signed rent differs from the exact wallet, nonce, gas or fee review.');
  if (step.signed && step.signed !== serialized) throw new ConflictError('Only the identical saved signed rent bytes may be retried.');
  if (!step.signed && Date.parse(request.expiresAt) <= (options.now ?? Date.now)()) throw new ConflictError('The rent review expired before signing.');
  const { manifest } = await deployment(options);
  if (getAddress(manifest.distributor!) !== getAddress(payment.distributor)) throw new ConflictError('The rent distributor changed.');
  await store.update<RentPayment>(keyOf(id,payment.month),current => { const target = current.steps.find(item => item.id === stepId)!; if (target.signed && target.signed !== serialized) throw new ConflictError('Rent was already signed differently.'); if (JSON.stringify(target.request) !== JSON.stringify(request)) throw new ConflictError('The rent review changed; review again.'); if (target.state === 'confirmed') return current; if (target.state !== 'prepared' && !target.signed) throw new ConflictError('Prepare the stopped rent step again.'); return {...current,state:'pending',error:null,steps:current.steps.map(item => item.id === stepId ? {...item,signed:serialized,hash:keccak256(serialized),state:'signed',error:null}:item)}; });
  await recover(store,(await store.get<RentPayment>(keyOf(id,payment.month)))!,true,options);
  return readRent(store,identity,id,options);
}
