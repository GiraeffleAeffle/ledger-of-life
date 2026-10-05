import { randomUUID } from 'node:crypto';
import { decodeEventLog, encodeFunctionData, formatUnits, getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionReceipt } from 'viem';
import { address, createNoopSigner, type Instruction } from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { getAddMemoInstruction } from '@solana-program/memo';
import { depositRewardsInstruction } from '../finance/solana/house.ts';
import type { ExpectedTokenDelta } from '../finance/solana/reconcile.ts';
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
import { loadSolanaHouseManifest, type SolanaHouseManifest } from './solana-house-config.ts';
import { configuredSolanaOperations, type PreparedSolanaOperation, type SolanaOperations, type SolanaOperationResult } from './solana-operations.ts';

export type RentSolanaReview = { id: string; walletId: string; feePayer: string; transactionBase64: string; expiresAt: string; description: string };
export type RentStep = { id: string; kind: 'landlord' | 'building' | 'rent'; recipient: string; amountRaw: string; state: 'prepared' | 'signed' | 'submitted' | 'confirmed' | 'stopped'; request: EvmSigningRequest | null; solanaRequest?: RentSolanaReview | null; operationId?: string; attempt?: number; signature?: string; signed?: Hex; hash?: Hex; error: string | null; retryable?: boolean };
export type RentPayment = { id: string; network?: 'solana-devnet' | 'robinhood-testnet'; agreementId: string; month: string; flatLabel: string; tenantWallet: string; landlordWallet: string; distributor: string; token: string; rentMonthly: string; landlordRaw: string; buildingRaw: string; state: 'prepared' | 'pending' | 'confirmed' | 'stopped'; error: string | null; steps: RentStep[]; createdAt: string };
export type RentPublicPayment = Omit<RentPayment, 'tenantWallet' | 'steps'> & { steps: Omit<RentStep, 'signed'>[] };
export type RentView = { network: 'solana-devnet' | 'robinhood-testnet'; landlordWallet: string; house: string; agreementId: string; month: string; rentMonthly: string; landlordRaw: string; buildingRaw: string; role: 'tenant' | 'landlord'; active: boolean; payment: RentPublicPayment | null; history: RentPublicPayment[] };
export type RentReceipt = Pick<TransactionReceipt, 'status' | 'transactionHash'> & { logs: { address: string; data: Hex; topics: [] | [Hex, ...Hex[]] }[] };
type RentSolanaRuntime = { operations: SolanaOperations; sponsor: { address: string } };
type Options = BuildingReadOptions & { now?: () => number; readJourney?: typeof tenancyJourney; environment?: Record<string, string | undefined>; solana?: RentSolanaRuntime; houseManifest?: SolanaHouseManifest };
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
  if (agreement.rentTerms.shareBps !== BUILDING_RENT_SHARE_BPS || (agreement.rentTerms.network !== 'solana-devnet' && agreement.rentTerms.buildingId !== RENT_BUILDING_ID)) throw new ConflictError('The agreed building rent terms are invalid.');
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
  return { ...rest, steps: steps.map(step => { const { signed: _, ...value } = step; void _; const signing = role === 'tenant' && step.state === 'prepared'; return { ...value, request: signing ? step.request : null, solanaRequest: signing ? step.solanaRequest : null }; }) };
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
  for (const payment of await journals(store,id)) history.push(payment.network === 'solana-devnet' ? await recoverSolanaRent(store,payment,options) : await recover(store,payment,ctx.role === 'tenant',options));
  const terms = ctx.agreement.rentTerms!;
  return { network: terms.network === 'solana-devnet' ? 'solana-devnet' : 'robinhood-testnet', landlordWallet: terms.landlordWallet, house: terms.house ?? terms.buildingId, agreementId:id, month, rentMonthly:terms.rentMonthly, ...splitBuildingRent(terms.rentMonthly), role:ctx.role, active:ctx.active, payment:history.find(item => item.month === month) ? visible(history.find(item => item.month === month)!,ctx.role) : null, history:history.map(item => visible(item,ctx.role)) };
}
export async function prepareRent(store: Store, identity: VerifiedIdentity, id: string, options: Options = {}) {
  const ctx = await context(store,identity,id,true,options);
  if (!ctx?.active) throw new ConflictError('Rent can only be paid in an active tenancy after both parties accept these terms.');
  if (ctx.agreement.rentTerms!.network === 'solana-devnet') return prepareSolanaRent(store,identity,ctx.agreement,options);
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
  if (step.kind === 'rent') throw new ConflictError('This payment requires its Solana rent review.');
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
  if (payment?.network === 'solana-devnet') {
    const step = payment.steps.find(item => item.id === stepId)!;
    if (!ctx?.active && !step.signature) throw new ConflictError('A new rent payment requires an active tenancy and both accepted terms.');
    if (!step.operationId || !step.solanaRequest) throw new ConflictError('Prepare the exact Solana rent review before signing.');
    const wallet = walletFor(identity,'solana');
    if (wallet.address !== payment.tenantWallet) throw new ConflictError('The saved rent wallet changed.');
    const runtime = await rentSolanaRuntime(store,options);
    assertRentOperation(payment,await runtime.operations.get(step.operationId,identity));
    try { await runtime.operations.submit({ identity,id:step.operationId,signedTransactionBase64:signed }); }
    catch (cause) {
      if (!step.signature && cause instanceof Error && /review expired/i.test(cause.message)) throw new ConflictError('The rent review expired before signing. Review the refreshed payment.');
      throw cause;
    }
    await recoverSolanaRent(store,payment,options);
    return readRent(store,identity,id,options);
  }
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

/** One public month memo and one atomic split; the agreement identifier never goes on chain. */
export async function solanaRentInstructions(input: { month: string; tenant: string; landlord: string; sponsor: string; mint: string; house: string; rewardVault: string; programId: string; rentMonthly: string }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new ConflictError('Choose a Berlin calendar month.');
  const split = splitBuildingRent(input.rentMonthly);
  const tenant = createNoopSigner(address(input.tenant)), sponsor = createNoopSigner(address(input.sponsor)), mint = address(input.mint);
  const [source] = await findAssociatedTokenPda({ owner: tenant.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [landlordAta] = await findAssociatedTokenPda({ owner: address(input.landlord), mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const instructions: Instruction[] = [
    getAddMemoInstruction({ memo: `ledger-of-life rent ${input.month}` }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: sponsor, ata: landlordAta, owner: address(input.landlord), mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    getTransferCheckedInstruction({ source, mint, destination: landlordAta, authority: tenant, amount: BigInt(split.landlordRaw), decimals: 6 }),
    await depositRewardsInstruction({ authority: tenant.address, source, house: input.house, programId: input.programId, amount: BigInt(split.buildingRaw), sourceKind: 0 }),
  ];
  const expectedDeltas: ExpectedTokenDelta[] = [
    { account: source, mint, owner: input.tenant, direction: 'debit', minimumAtomic: input.rentMonthly, maximumAtomic: input.rentMonthly },
    { account: landlordAta, mint, owner: input.landlord, direction: 'credit', minimumAtomic: split.landlordRaw, maximumAtomic: split.landlordRaw, allowCreated: true },
    { account: input.rewardVault, mint, owner: input.house, direction: 'credit', minimumAtomic: split.buildingRaw, maximumAtomic: split.buildingRaw },
  ];
  return { instructions, expectedDeltas, source, landlordAta, ...split };
}

function rentHouseManifest(options: Options) {
  const manifest = options.houseManifest ?? loadSolanaHouseManifest(options.environment ?? process.env);
  if (!manifest || manifest.cluster !== 'devnet') throw new ConflictError('Solana devnet house rent is not configured.');
  return manifest;
}
async function rentSolanaRuntime(store: Store, options: Options): Promise<RentSolanaRuntime> {
  if (options.solana) return options.solana;
  const manifest = rentHouseManifest(options);
  return configuredSolanaOperations(store,{ cluster:manifest.cluster,genesisHash:manifest.genesisHash,maximumSponsorLamports:10_000_000n },options.environment ?? process.env);
}
function assertRentOperation(payment: RentPayment, op: PreparedSolanaOperation) {
  const step = payment.steps[0];
  const expected = { agreementId:payment.agreementId,tenantWallet:payment.tenantWallet,month:payment.month,rentMonthly:payment.rentMonthly,landlordRaw:payment.landlordRaw,buildingRaw:payment.buildingRaw,shareBps:BUILDING_RENT_SHARE_BPS,landlordWallet:payment.landlordWallet,house:payment.distributor,mint:payment.token,network:payment.network };
  if (op.kind !== 'rent' || op.id !== step.operationId || op.walletId !== step.solanaRequest?.walletId || Object.entries(expected).some(([field,value]) => op.review[field] !== value)) throw new ConflictError('The reviewed operation does not belong to this exact tenancy and rent month.');
}
async function saveSolanaRentResult(store: Store, payment: RentPayment, op: SolanaOperationResult) {
  return store.update<RentPayment>(keyOf(payment.agreementId,payment.month),current => {
    const step = current.steps[0];
    if (step.operationId !== op.id || current.state === 'confirmed') return current;
    const state = op.state === 'confirmed' ? 'confirmed' : op.state === 'broadcast' ? 'submitted' : op.state === 'prepared' ? 'prepared' : 'stopped';
    const retryable = op.state === 'expired' || (op.state === 'failed' && ['transaction-error','receipt-error'].includes(op.error ?? ''));
    return { ...current,state:state === 'submitted' ? 'pending' : state,error:op.error ?? null,steps:[{ ...step,state,signature:op.signature,error:op.error ?? null,retryable }] };
  });
}
async function recoverSolanaRent(store: Store, payment: RentPayment, options: Options) {
  const step = payment.steps[0];
  if (!step?.operationId || payment.state === 'confirmed') return payment;
  const runtime = await rentSolanaRuntime(store,options);
  assertRentOperation(payment,await runtime.operations.get(step.operationId));
  return saveSolanaRentResult(store,payment,await runtime.operations.reconcile({ id:step.operationId }));
}
async function prepareSolanaRent(store: Store, identity: VerifiedIdentity, agreement: Agreement, options: Options) {
  const terms = agreement.rentTerms!;
  if (terms.network !== 'solana-devnet') throw new ConflictError('Solana rent terms are required.');
  const manifest = rentHouseManifest(options), house = manifest.houses['neighbourhood-homes'];
  if (terms.house !== house.house) throw new ConflictError('The agreed house differs from the configured Solana deployment.');
  const wallet = walletFor(identity,'solana'), currentMonth = berlinRentMonth((options.now ?? Date.now)());
  const unfinished = (await journals(store,agreement.id)).find(item => item.month < currentMonth && item.state !== 'confirmed');
  const month = unfinished?.month ?? currentMonth, key = keyOf(agreement.id,month);
  let payment = unfinished ?? await store.get<RentPayment>(key);
  if (!payment) {
    payment = { id:randomUUID(),network:'solana-devnet',agreementId:agreement.id,month,flatLabel:agreement.property,tenantWallet:wallet.address,landlordWallet:terms.landlordWallet,distributor:terms.house,token:manifest.cashMint,rentMonthly:terms.rentMonthly,...splitBuildingRent(terms.rentMonthly),state:'prepared',error:null,createdAt:new Date((options.now ?? Date.now)()).toISOString(),steps:[{id:randomUUID(),kind:'rent',recipient:terms.house,amountRaw:terms.rentMonthly,state:'prepared',request:null,error:null,attempt:0}] };
    try { await store.create(key,payment); } catch (error) { payment = await store.get<RentPayment>(key); if (!payment) throw error; }
  }
  payment = await recoverSolanaRent(store,payment,options);
  if (payment.state === 'confirmed') {
    if (month !== currentMonth) return readRent(store,identity,agreement.id,options);
    throw new ConflictError('Rent for this calendar month is already paid. A second payment is refused.');
  }
  if (payment.tenantWallet !== wallet.address || payment.landlordWallet !== terms.landlordWallet || payment.distributor !== terms.house || payment.token !== manifest.cashMint || payment.rentMonthly !== terms.rentMonthly) throw new ConflictError('The saved rent differs from the agreed wallet, amount or deployment.');
  const step = payment.steps[0];
  if ((step.signature && !step.retryable) || (step.state === 'stopped' && step.operationId && !step.retryable)) return readRent(store,identity,agreement.id,options);
  if (step.solanaRequest && step.state === 'prepared' && Date.parse(step.solanaRequest.expiresAt) > (options.now ?? Date.now)()) return readRent(store,identity,agreement.id,options);
  if (step.retryable) payment = await store.update<RentPayment>(key,current => {
    if (current.steps[0].operationId !== step.operationId || !current.steps[0].retryable) return current;
    return { ...current,state:'prepared',error:null,steps:[{ ...current.steps[0],attempt:(current.steps[0].attempt ?? 0)+1,operationId:undefined,solanaRequest:null,signature:undefined,state:'prepared',retryable:false,error:null }] };
  });
  const attempt = payment.steps[0].attempt ?? 0;
  try {
    const runtime = await rentSolanaRuntime(store,options);
    const tx = await solanaRentInstructions({ month,tenant:wallet.address,landlord:terms.landlordWallet,sponsor:runtime.sponsor.address,mint:manifest.cashMint,house:terms.house,rewardVault:house.rewardVault,programId:manifest.programId,rentMonthly:terms.rentMonthly });
    const description = `${formatUnits(BigInt(terms.rentMonthly),6)} tUSDC in one signature: ${formatUnits(BigInt(tx.landlordRaw),6)} to your landlord (${terms.landlordWallet}) and ${formatUnits(BigInt(tx.buildingRaw),6)} to the house (${terms.house}), fixed 20 % · Solana devnet. Sponsored network fees. Test tokens only, no value. Fictional units carry no rights. Deposit earnings belong to the tenant.`;
    const prepared = await runtime.operations.prepare({ identity,kind:'rent',requestId:`${payment.id}:${attempt}`,actor:address(wallet.address),walletId:wallet.id,instructions:tx.instructions,expectedDeltas:tx.expectedDeltas,review:{ agreementId:agreement.id,tenantWallet:wallet.address,month,rentMonthly:terms.rentMonthly,landlordRaw:tx.landlordRaw,buildingRaw:tx.buildingRaw,shareBps:terms.shareBps,landlordWallet:terms.landlordWallet,house:terms.house,mint:manifest.cashMint,network:terms.network,description } });
    await store.update<RentPayment>(key,current => {
      if ((current.steps[0].attempt ?? 0) !== attempt || current.state === 'confirmed' || current.steps[0].signature) return current;
      return { ...current,state:'prepared',error:null,steps:[{ ...current.steps[0],state:'prepared',operationId:prepared.id,solanaRequest:{ ...prepared,description },error:null }] };
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Solana rent preparation failed.';
    const error = message === 'Exact transaction simulation failed' ? 'Rent simulation failed. Check your site tUSDC balance for the whole month, then review again.' : message;
    await store.update<RentPayment>(key,current => current.steps[0].signature || current.steps[0].operationId || (current.steps[0].attempt ?? 0) !== attempt ? current : { ...current,state:'stopped',error,steps:[{ ...current.steps[0],state:'stopped',error }] });
  }
  return readRent(store,identity,agreement.id,options);
}
