import { createHash, randomUUID } from 'node:crypto';
import { decodeEventLog, encodeFunctionData, formatUnits, getAddress, keccak256, parseTransaction, recoverTransactionAddress, toHex, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { ShareDepositAction, ShareDepositPlan, ShareDepositTerms, ShareDepositView } from '../domain/share-deposit.ts';
import { WorkflowError } from '../domain/errors.ts';
import { agreementDigest, agreementRole, requireOpenAgreement, walletFor, type Agreement } from './agreements.ts';
import { AccessError, ConflictError } from './errors.ts';
import type { Store } from './store.ts';
import { readPriceJob, shapePriceJob } from './price-job-health.ts';
import { sharedMarketRpc } from './shared-market.ts';
import { boundEscrow, DEPOSIT_ABI, depositSafety, depositTerms, FACTORY_ABI, loadShareDepositManifest, MIRROR_ABI, requireDeposit, same, STOCK_ABI, verifyDepositPins, type DepositRpc, type ShareDepositManifest } from './share-deposit-chain.ts';
import type { Listing } from './listings.ts';

type Dependencies = { rpc?: DepositRpc; manifest?: () => Promise<ShareDepositManifest | null>; now?: () => number };
type StoredPlan = ShareDepositPlan & { subject: string; agreementHash: string; input: Record<string, unknown>; record?: Agreement['records'][number]; hash?: Hex; confirmed?: boolean; failed?: boolean };
async function recordDepositReceipt(store: Store, plan: ShareDepositPlan, hash: Hex, status: 'pending' | 'confirmed' | 'failed') {
  const key=`share-deposit-history:${plan.rentalId}`;
  if (!await store.get(key)) { try { await store.create<ShareDepositView['receipts']>(key,[]); } catch { requireDeposit(await store.get(key),'Cannot reserve deposit receipt history.'); } }
  await store.update<ShareDepositView['receipts']>(key, entries => {
    const previous=entries.find(entry=>entry.planId===plan.id);
    requireDeposit(!previous||same(previous.transactionHash,hash),'Receipt history transaction mismatch.');
    return [...entries.filter(entry=>entry.planId!==plan.id),{planId:plan.id,walletId:plan.walletId,transactionHash:hash,action:plan.action,status:previous && previous.status !== 'pending' ? previous.status : status}];
  });
}
const stateNames = ['AwaitingLock','Active','ClaimPending','ClaimContested','Closed'] as const;
const actionRoles: Partial<Record<ShareDepositAction, ShareDepositView['role']>> = { create: 'landlord', approve: 'tenant', pledge: 'tenant', withdraw: 'tenant', proposeClaim: 'landlord', acceptClaim: 'tenant', contestClaim: 'tenant', lowerClaim: 'landlord', resolveClaim: 'arbitrator', requestReturn: 'tenant' };
export function requireShareActionRole(action: ShareDepositAction, role: ShareDepositView['role']) {
  if (actionRoles[action] && actionRoles[action] !== role) throw new AccessError(`Only the ${actionRoles[action]} may ${action}.`);
}
export function shareActions(view: ShareDepositView, authorized: boolean, now: number): ShareDepositAction[] {
  if (!authorized || view.deployment !== 'deployed') return [];
  if (!view.escrow) return view.role === 'landlord' ? ['create'] : [];
  const actions: ShareDepositAction[] = [];
  const tenant = view.role === 'tenant'; const landlord = view.role === 'landlord';
  if (view.state !== 'Closed' && tenant) actions.push('approve','pledge');
  if (view.state === 'AwaitingLock') { if (tenant && BigInt(view.lockedShares) > 0n) actions.push('withdraw'); if (view.quote?.fresh && (view.coverBps ?? 0) >= 15000) actions.push('activate'); }
  if (view.state === 'Active') {
    if (tenant) { if (!view.returnDeadline) actions.push('requestReturn'); if (view.quote?.fresh && BigInt(view.maximumWithdrawShares ?? '0') > 0n) actions.push('withdraw'); }
    if (landlord && (!view.returnDeadline || now < view.returnDeadline)) actions.push('proposeClaim');
    if (view.returnDeadline && now >= view.returnDeadline) actions.push('closeUnclaimed');
  }
  if (view.state === 'ClaimPending' || view.state === 'ClaimContested') {
    const timedOut = view.arbitrationDeadline > 0 && now >= view.arbitrationDeadline;
    if (landlord) actions.push('lowerClaim');
    if (timedOut) actions.push('closeUnresolved');
    else {
      if (view.state === 'ClaimPending') { if (tenant) actions.push('acceptClaim','contestClaim'); if (now >= view.responseDeadline) actions.push('escalateClaim'); }
      if (view.role === 'arbitrator' && view.arbitrationDeadline) actions.push('resolveClaim');
    }
  }
  if (view.state === 'Closed' && !view.paidOut) actions.push('payout');
  return actions;
}
async function rental(store: Store, identity: VerifiedIdentity, id: string) {
  const agreement = await store.get<Agreement>(`agreement:${id}`);
  if (!agreement) throw new AccessError('This tenancy is unavailable.');
  const role = agreementRole(agreement, identity);
  requireDeposit(agreement.depositForm?.kind === 'shares' && agreement.depositForm.network !== 'solana-devnet', 'This tenancy does not use a Robinhood share deposit.');
  return { agreement, role };
}
async function readDepositQuote(config: ShareDepositManifest, rpc: DepositRpc, time: number): Promise<ShareDepositView['quote']> {
  const [latest, price] = await Promise.all([
    rpc.readContract({address:config.oracle,abi:MIRROR_ABI,functionName:'latest'}).catch(()=>null),
    rpc.readContract({address:config.oracle,abi:MIRROR_ABI,functionName:'latestPrice'}).catch(()=>null),
  ]);
  if (!latest || !price || price[0] === 0n || price[1] === 0n) return null;
  const date = new Date(time*1000);
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6 || (date.getUTCDay() === 1 && date.getUTCHours() < 12);
  return {priceUsd6:String(price[0]),sourceTime:Number(price[1]),copiedAt:Number(latest[4]),fresh:price[0]>0n&&price[1]>0n&&Number(price[1])<=time&&time-Number(price[1])<=(weekend?266400:93600)&&latest[3]===10n**18n};
}
export async function readShareListingQuote(store:Store,identity:VerifiedIdentity,id:string,dependencies:Dependencies={}) {
  const listing=await store.get<Listing>(`listing:${id}`);
  requireDeposit(listing?.depositForm?.kind==='shares' && listing.depositForm.network !== 'solana-devnet','This share-deposit listing is unavailable.');
  const rpc=dependencies.rpc??sharedMarketRpc;const time=Math.floor((dependencies.now??Date.now)()/1000);
  const priceJob=shapePriceJob(await readPriceJob(store),time);
  const config=await (dependencies.manifest??loadShareDepositManifest)();
  if(!config)return {deployment:'not_deployed' as const,quote:null,requiredShares:null,walletShares:null,priceJob};
  await verifyDepositPins(config,rpc);
  const wallet=walletFor(identity,'robinhood');
  const [quote,balance]=await Promise.all([readDepositQuote(config,rpc,time),rpc.readContract({address:config.stock,abi:STOCK_ABI,functionName:'balanceOf',args:[getAddress(wallet.address)]})]);
  const price=quote ? BigInt(quote.priceUsd6) : null;
  const requiredShares=quote?.fresh && price ? ((BigInt(listing.requiredSecurity)*15000n*10n**18n+price*10000n-1n)/(price*10000n)).toString():null;
  return {deployment:'deployed' as const,quote,requiredShares,walletShares:String(balance),walletAddress:wallet.address,priceJob};
}
export async function readShareDeposit(store: Store, identity: VerifiedIdentity, id: string, dependencies: Dependencies = {}): Promise<ShareDepositView> {
  const rpc = dependencies.rpc ?? sharedMarketRpc; const now = dependencies.now ?? Date.now;
  const { agreement, role } = await rental(store,identity,id); const form = agreement.depositForm!;
  requireDeposit(form.kind === 'shares', 'This tenancy uses cash.');
  const config = await (dependencies.manifest ?? loadShareDepositManifest)();
  const hash = agreementDigest(agreement);
  const wallet = getAddress(agreement.parties[role]!.wallet.address);
  const priceJob = shapePriceJob(await readPriceJob(store), Math.floor(now()/1000));
  const view: ShareDepositView = { kind:'shares', rentalId:id, deployment: config ? 'deployed' : 'not_deployed', chainId:46630, escrow:null, state:null, agreementHash:hash, form, role, quote:null, priceJob, walletShares:'0', lockedShares:'0', requiredShares:null, maximumWithdrawShares:null, coverBps:null, needsTopUp:false, claim:null, responseDeadline:0, returnDeadline:0, arbitrationDeadline:0, landlordOwed:'0', custodyShortfall:false, paidOut:false, actions:[], receipts:[], warnings:['Test TSLA has no monetary value. No yield or legal advice. The issuer can pause, block, burn or upgrade TSLA. Settlement is in shares; no sale or liquidation.'], explorerUrl:null };
  view.receipts = await store.get<ShareDepositView['receipts']>(`share-deposit-history:${id}`) ?? [];
  if (!config) { view.warnings.push('Share deposit not deployed yet'); return view; }
  await verifyDepositPins(config,rpc);
  const time = Math.floor(now()/1000);
  const [walletBalance,quote] = await Promise.all([
    rpc.readContract({address:config.stock,abi:STOCK_ABI,functionName:'balanceOf',args:[wallet]}),
    readDepositQuote(config,rpc,time),
  ]);
  view.walletShares=String(walletBalance);view.quote=quote;
  if (hash) {
    const bound = await boundEscrow(agreement,config,rpc); view.escrow=bound.escrow;
    if (bound.escrow) {
      const read = (name:string) => rpc.readContract({ address:bound.escrow!,abi:DEPOSIT_ABI,functionName:name });
      const [state,quote,claim,locked,response,ret,started,authorized,owed,shortfall] = await Promise.all([
        read('state'),read('quote'),read('claim'),rpc.readContract({address:config.stock,abi:STOCK_ABI,functionName:'balanceOf',args:[bound.escrow]}),read('responseDeadline'),read('returnDeadline'),read('arbitrationStartedAt'),read('arbitrationAuthorized'),read('landlordOwed'),read('custodyShortfall'),
      ]);
      requireDeposit(Number(state)>=0 && Number(state)<5,'Unknown escrow state.');
      view.state=stateNames[Number(state)]; const q=quote as readonly [bigint,bigint,boolean];
      view.quote=q[0] === 0n || q[1] === 0n ? null : {priceUsd6:String(q[0]),sourceTime:Number(q[1]),fresh:q[2],copiedAt:view.quote?.copiedAt ?? null};
      const c=claim as {usd6:bigint;shares:bigint;evidenceHash:Hex;price6:bigint;sourceTime:bigint};
      view.claim={usd6:String(c.usd6),shares:String(c.shares),evidenceHash:c.evidenceHash,price6:String(c.price6),sourceTime:Number(c.sourceTime)};
      view.lockedShares=String(locked);view.responseDeadline=Number(response);view.returnDeadline=Number(ret);view.arbitrationDeadline=authorized?Number(started)+form.arbitrationWindow:0;view.landlordOwed=String(owed);view.custodyShortfall=Boolean(shortfall);
      view.explorerUrl=`https://explorer.testnet.chain.robinhood.com/address/${bound.escrow}`;
    }
  }
  view.paidOut=view.state==='Closed'&&BigInt(view.lockedShares)===0n&&BigInt(view.landlordOwed)===0n&&!view.custodyShortfall&&view.receipts.some(receipt=>receipt.action==='payout'&&receipt.status==='confirmed');
  if (view.quote?.fresh) {
    const price = BigInt(view.quote.priceUsd6); const security=BigInt(form.securityUsd6);
    view.requiredShares=((security*15000n*10n**18n+price*10000n-1n)/(price*10000n)).toString();
    view.coverBps=Number(BigInt(view.lockedShares)*price*10000n/(security*10n**18n));
    view.needsTopUp=view.state==='Active' && view.coverBps<12500;
  } else view.warnings.push('The mirrored price is stale or unavailable. Price-free exits remain available.');
  if (view.state === 'AwaitingLock') view.maximumWithdrawShares=view.lockedShares;
  else if (view.state === 'Active' && view.requiredShares !== null) {
    const extra=BigInt(view.lockedShares)-BigInt(view.requiredShares);
    view.maximumWithdrawShares=(extra>0n?extra:0n).toString();
  }
  if (view.needsTopUp) view.warnings.push('Cover is below 125%. Please top up; this is an app warning, not an on-chain requirement.');
  if (view.custodyShortfall) view.warnings.push('Issuer burn or other custody shortfall: actual shares are below recorded custody.');
  const authorized = !agreement.cancelled && Boolean(hash && agreement.accepted.tenant?.digest===hash && agreement.accepted.landlord?.digest===hash);
  view.actions=shareActions(view,authorized,time);
  return view;
}
function amount(input: unknown, zero = false): bigint {
  if (typeof input!=='string' || !/^(0|[1-9][0-9]{0,77})$/.test(input) || (!zero && input==='0') || BigInt(input)>=2n**256n-1n) throw new WorkflowError('Choose an exact finite raw amount.');
  return BigInt(input);
}
export async function prepareShareDeposit(store:Store,identity:VerifiedIdentity,id:string,operation:ShareDepositAction,input:Record<string,unknown>,dependencies:Dependencies={}):Promise<ShareDepositPlan> {
  const rpc=dependencies.rpc??sharedMarketRpc;const now=dependencies.now??Date.now;
  const {agreement,role}=await rental(store,identity,id);requireOpenAgreement(agreement);requireShareActionRole(operation,role);
  const withdrawalShares = operation === 'withdraw' ? amount(input.shares) : null;
  const view=await readShareDeposit(store,identity,id,dependencies);
  requireDeposit(view.actions.includes(operation),'This share-deposit action is not available in the current state or window.');
  const config=await (dependencies.manifest??loadShareDepositManifest)();requireDeposit(config?.factory,'Share deposit not deployed yet.');
  const bound=await boundEscrow(agreement,config,rpc);const terms=depositTerms(agreement);
  let record: Agreement['records'][number] | undefined;
  if (['proposeClaim','contestClaim','resolveClaim'].includes(operation)) {
    if (typeof input.evidence !== 'string' || input.evidence.trim().length < 10 || input.evidence.length > 8000) throw new WorkflowError('Provide a move-out reason between 10 and 8,000 characters.');
    record = { id: randomUUID(), name: operation === 'proposeClaim' ? 'Move-out inspection' : operation === 'contestClaim' ? 'Dispute the deduction' : 'Arbitration decision', body: input.evidence.trim(), by: identity.subject, at: new Date(now()).toISOString() };
  }
  if (['create','approve','pledge'].includes(operation)) {
    const safety=await depositSafety(config,bound.escrow??bound.predicted,[terms.tenant,terms.landlord,terms.arbitrator],view.custodyShortfall,rpc);
    requireDeposit(!safety.suspended,`TSLA issuer safety refused inflow: ${safety.suspensionReasons.join(' ')}`);
  }
  let to:Address=bound.escrow??config.factory; const args:unknown[]=[];let abi=DEPOSIT_ABI;const functionName:string=operation;
  if (operation==='create') {to=config.factory;abi=FACTORY_ABI;args.push(terms);}
  else if (operation==='approve' || operation==='pledge') {
    const shares=amount(input.shares); requireDeposit(shares<=BigInt(view.walletShares),'Get enough test TSLA from Robinhood’s faucet (5 per claim).');
    if(operation==='approve') {to=config.stock;abi=STOCK_ABI;args.push(bound.escrow,shares);}
    else { const allowance=await rpc.readContract({address:config.stock,abi:STOCK_ABI,functionName:'allowance',args:[terms.tenant,bound.escrow!]}); requireDeposit(allowance===shares,'Approve this exact finite TSLA amount first.');args.push(shares); }
  } else if(operation==='withdraw') args.push(withdrawalShares!);
  else if(operation==='resolveClaim') args.push(amount(input.shares,true));
  else if(operation==='acceptClaim') {
    const maxShares=amount(input.maxShares,true);
    requireDeposit(maxShares>=BigInt(view.claim?.shares??'0'),'acceptClaim maximum is below the current fixed claim shares.');
    args.push(maxShares);
  }
  else if(operation==='proposeClaim') {
    const usd6=amount(input.usd6,true);requireDeposit(usd6<=terms.depositValue,'Claim exceeds the agreed security USD amount.');
    requireDeposit(usd6===0n || view.quote?.fresh,'A positive claim requires a fresh price.');
    const evidence=`0x${createHash('sha256').update(JSON.stringify({domain:'rental-move-out-evidence-v1',rentalId:id,record})).digest('hex')}`;
    args.push(usd6,evidence);
  } else if(operation==='lowerClaim') { const usd6=amount(input.usd6,true);requireDeposit(usd6<BigInt(view.claim?.usd6??'0'),'A lowered claim must be strictly smaller.');args.push(usd6); }
  else if(operation==='payout') {if(input.side!=='landlord'&&input.side!=='tenant')throw new WorkflowError('Choose a payout side.');args.push(input.side==='landlord');}
  if(operation==='withdraw') {
    const shares=BigInt(String(args[0]));
    requireDeposit(shares<=BigInt(view.lockedShares),'Withdrawal exceeds locked shares.');
    if (view.state==='Active') requireDeposit(view.quote?.fresh && view.requiredShares !== null && BigInt(view.lockedShares)-shares>=BigInt(view.requiredShares),'withdraw would leave less than the required fresh 150% cover.');
  }
  const data=encodeFunctionData({abi,functionName,args} as Parameters<typeof encodeFunctionData>[0]);
  const from=getAddress(agreement.parties[role]!.wallet.address);
  const [fees,nonce,gas]=await Promise.all([rpc.estimateFeesPerGas(),rpc.getTransactionCount({address:from,blockTag:'pending'}),rpc.estimateGas({account:from,to,data}).catch(()=>{throw new ConflictError(`The escrow would refuse ${operation} now. Check its current state, amounts and deadlines before preparing again.`);})]);
  requireDeposit(fees.maxFeePerGas!==undefined,'Network fee quote unavailable.');
  const transaction={chainId:46630 as const,to,data,value:'0x0' as const,nonce,gas:toHex(gas*120n/100n),maxFeePerGas:toHex(fees.maxFeePerGas*2n),maxPriorityFeePerGas:toHex(fees.maxPriorityFeePerGas??0n)};
  const jsonArgs=JSON.parse(JSON.stringify(args,(_,v)=>typeof v==='bigint'?v.toString():v)) as unknown[];
  const lines = [`Rental: ${agreement.property}`,`Agreement: ${view.agreementHash}`,`Chain: 46630 · Robinhood Chain Testnet`,`Contract: ${to}`,`Function: ${operation} · native value: 0 ETH`,`Exact arguments: ${JSON.stringify(jsonArgs)}`];
  let reviewedShares: bigint | null = null;
  if (['approve','pledge','withdraw','resolveClaim'].includes(operation)) reviewedShares=BigInt(String(args[operation==='approve'?1:0]));
  if (operation==='acceptClaim') { reviewedShares=BigInt(view.claim?.shares??'0');lines.push(`Reviewed maximum: ${formatUnits(BigInt(String(args[0])),18)} test TSLA; a concurrent lower claim is acceptable.`); }
  if (operation==='proposeClaim') {
    const usd=BigInt(String(args[0]));lines.push(`Claim: ${formatUnits(usd,6)} test USD · evidence hash: ${String(args[1])}`);
    if(usd===0n)reviewedShares=0n;
    else if(view.quote?.fresh) {const p=BigInt(view.quote.priceUsd6);const converted=(usd*10n**18n+p-1n)/p;reviewedShares=converted<BigInt(view.lockedShares)?converted:BigInt(view.lockedShares);lines.push('Share estimate is capped at custody and fixed at the proposal transaction’s on-chain quote; a newer quote at mining can change this estimate.');}
  }
  if (operation==='lowerClaim') { const usd=BigInt(String(args[0]));const p=BigInt(view.claim?.price6??'0');reviewedShares=p>0n?usd*10n**18n/p:0n;if(reviewedShares>BigInt(view.claim?.shares??'0'))reviewedShares=BigInt(view.claim!.shares);lines.push(`Lowered claim: ${formatUnits(usd,6)} test USD; conversion uses the original claim price, not today’s price.`); }
  if (operation==='payout') { const locked=BigInt(view.lockedShares);const owed=BigInt(view.landlordOwed);const award=owed<locked?owed:locked;reviewedShares=args[0]?award:locked-award;lines.push(`Fixed recipient: ${args[0]?terms.landlord:terms.tenant}`); }
  if (reviewedShares!==null) lines.push(`${operation==='resolveClaim'?'Maximum reviewed award (clamped to current claim)':operation==='approve'?'Exact finite allowance':operation==='proposeClaim'?'Estimated fixed claim':'Reviewed shares'}: ${formatUnits(reviewedShares,18)} test TSLA (${reviewedShares} raw).`);
  if (view.quote?.fresh) {lines.push(`Quote: ${formatUnits(BigInt(view.quote.priceUsd6),6)} USD/test TSLA · source ${new Date(view.quote.sourceTime*1000).toISOString()} · copied ${view.quote.copiedAt?new Date(view.quote.copiedAt*1000).toISOString():'unknown'}`);if(reviewedShares!==null)lines.push(`Value at this quote: ${formatUnits(reviewedShares*BigInt(view.quote.priceUsd6)/10n**18n,6)} test USD; test tokens have no monetary value.`);}
  else lines.push('No usable current USD quote. This action settles in shares without a price.');
  lines.push('Test shares only. No yield or legal advice. Settlement in kind; no forced sale. Issuer may pause, block, burn or upgrade.');
  const reviewedTerms: ShareDepositTerms = { tenant:terms.tenant, landlord:terms.landlord, arbitrator:terms.arbitrator, depositValue:terms.depositValue.toString(), agreementHash:terms.agreementHash, responseWindow:terms.responseWindow.toString(), returnWindow:terms.returnWindow.toString(), arbitrationWindow:terms.arbitrationWindow.toString() };
  const plan:ShareDepositPlan={id:randomUUID(),rentalId:id,action:operation,walletId:agreement.parties[role]!.wallet.id,chainId:46630,from,to,data,value:'0x0',transaction,review:{title:`${operation} · test TSLA deposit`,lines,factory:config.factory,escrow:bound.escrow??bound.predicted,stock:config.stock,functionName,args:jsonArgs,terms:reviewedTerms,role,approvalShares:operation==='approve'?String(args[1]):null,priceUsd6:view.quote?.fresh?view.quote.priceUsd6:null},expiresAt:new Date(now()+120000).toISOString()};
  await store.create<StoredPlan>(`share-deposit-plan:${plan.id}`,{...plan,subject:identity.subject,agreementHash:view.agreementHash!,input,record});return plan;
}
const eventNames:Record<ShareDepositAction,string>={create:'Created',approve:'Approval',pledge:'Pledged',activate:'Activated',withdraw:'Withdrawn',proposeClaim:'ClaimProposed',acceptClaim:'Closed',contestClaim:'ClaimContested',lowerClaim:'ClaimLowered',escalateClaim:'ClaimEscalated',resolveClaim:'Closed',requestReturn:'ReturnRequested',closeUnclaimed:'Closed',closeUnresolved:'Closed',payout:'Paid'};
export function requireShareReceipt(plan:ShareDepositPlan,receipt:TransactionReceipt,hash:Hex,agreement:Agreement) {
  requireDeposit(same(receipt.transactionHash,hash)&&receipt.status==='success'&&receipt.from&&same(receipt.from,plan.from)&&receipt.to&&same(receipt.to,plan.to),'Receipt does not match the prepared successful transaction.');
  const abi=plan.action==='create'?FACTORY_ABI:plan.action==='approve'?STOCK_ABI:DEPOSIT_ABI;
  const match=receipt.logs.some(log=>{
    if(!same(log.address,plan.to))return false;
    try {
      const decoded=decodeEventLog({abi,data:log.data,topics:log.topics});if(decoded.eventName!==eventNames[plan.action])return false;
      const a=decoded.args as unknown as Record<string,unknown>;const args=plan.review.args;
      if(plan.action==='create')return same(String(a.agreementHash),agreementDigest(agreement)!);
      if(plan.action==='approve')return same(String(a.owner),plan.from)&&same(String(a.spender),plan.review.escrow!)&&String(a.value)===String(args[1]);
      if(plan.action==='pledge'||plan.action==='withdraw')return String(a.shares)===String(args[0]);
      if(plan.action==='proposeClaim')return String(a.usd6)===String(args[0])&&same(String(a.evidenceHash),String(args[1]));
      if(plan.action==='lowerClaim')return String(a.usd6)===String(args[0]);
      if(plan.action==='payout')return same(String(a.recipient),agreement.parties[args[0]?'landlord':'tenant']!.wallet.address);
      if(decoded.eventName==='Closed') {
        if(!same(String(a.decisionMaker),plan.from))return false;
        if(plan.action==='closeUnclaimed'||plan.action==='closeUnresolved')return String(a.landlordShares)==='0';
        return BigInt(String(a.landlordShares))<=BigInt(String(args[0]));
      }
      return true;
    }catch{return false;}
  });
  // Zero-valued proposals close directly rather than emitting ClaimProposed.
  const zeroProposal=(plan.action==='proposeClaim'||plan.action==='lowerClaim')&&plan.review.args[0]==='0'&&receipt.logs.some(log=>{try{const d=decodeEventLog({abi:DEPOSIT_ABI,data:log.data,topics:log.topics});const a=d.args as unknown as Record<string,unknown>;return same(log.address,plan.to)&&d.eventName==='Closed'&&String(a.landlordShares)==='0'&&same(String(a.decisionMaker),plan.from);}catch{return false;}});
  requireDeposit(match||zeroProposal,'The receipt lacks the exact expected deposit event.');
}
async function knownDepositTransaction(rpc: DepositRpc, hash: Hex) {
  try { return await rpc.getTransaction({hash}); }
  catch (error) {
    // An RPC outage is not proof that a previously accepted transaction disappeared.
    if (error instanceof TransactionNotFoundError) return null;
    throw error;
  }
}
export async function submitShareDeposit(store:Store,identity:VerifiedIdentity,planId:string,input:{signed?:string;transactionHash?:string},dependencies:Dependencies={}) {
  const rpc=dependencies.rpc??sharedMarketRpc;const now=dependencies.now??Date.now;
  const key=`share-deposit-plan:${planId}`;
  const plan=await store.get<StoredPlan>(key);if(!plan)throw new AccessError('Share-deposit review unavailable.');
  const {agreement,role}=await rental(store,identity,plan.rentalId);
  requireDeposit(plan.subject===identity.subject&&agreement.parties[role]!.wallet.id===plan.walletId,'This review belongs to another wallet.');
  requireDeposit(agreementDigest(agreement)===plan.agreementHash,'The accepted agreement changed.');
  let hash=plan.hash;
  if(input.signed) {
    requireDeposit(/^0x02[0-9a-fA-F]+$/.test(input.signed)&&input.signed.length<=20000,'Invalid signed transaction.');
    const serialized=input.signed as `0x02${string}`;const tx=parseTransaction(serialized);const t=plan.transaction;const signedHash=keccak256(serialized);
    requireDeposit(tx.chainId===46630&&tx.to&&same(tx.to,t.to)&&same(tx.data??'0x',t.data)&&(!tx.value||tx.value===0n)&&tx.nonce===t.nonce&&tx.gas===BigInt(t.gas)&&tx.maxFeePerGas===BigInt(t.maxFeePerGas)&&(tx.maxPriorityFeePerGas??0n)===BigInt(t.maxPriorityFeePerGas)&&(tx.accessList?.length??0)===0,'Signed transaction differs from the exact reviewed plan.');
    requireDeposit(same(await recoverTransactionAddress({serializedTransaction:serialized}),plan.from),'Transaction signer differs from verified party.');
    if(hash)requireDeposit(same(hash,signedHash),'A different transaction is already bound to this plan.');
    // Response loss after a broadcast is recoverable even if the review has since expired.
    const known=plan.confirmed||plan.failed ? null : await knownDepositTransaction(rpc,signedHash);
    if(!plan.confirmed&&!plan.failed&&!known) {
      let current: ShareDepositView | undefined;
      if (['create','approve','pledge'].includes(plan.action)) {
        current=await readShareDeposit(store,identity,plan.rentalId,dependencies);
        const config=await (dependencies.manifest??loadShareDepositManifest)();requireDeposit(config,'Share deposit not deployed yet.');
        const bound=await boundEscrow(agreement,config,rpc);const terms=depositTerms(agreement);
        const safety=await depositSafety(config,bound.escrow??bound.predicted,[terms.tenant,terms.landlord,terms.arbitrator],current.custodyShortfall,rpc);
        requireDeposit(!safety.suspended,'TSLA issuer safety refused inflow.');
      }
      if(!hash) {
        requireDeposit(now()<Date.parse(plan.expiresAt),'Signing review expired. Prepare again.');
        requireOpenAgreement(agreement);
        const view=current??await readShareDeposit(store,identity,plan.rentalId,dependencies);
        requireDeposit(view.actions.includes(plan.action),'Action no longer available.');
      }
      try { await rpc.sendRawTransaction({serializedTransaction:serialized}); }
      catch(error) {
        const accepted=await knownDepositTransaction(rpc,signedHash);
        if(!accepted) {
          await store.update<StoredPlan>(key,p=>p.hash&&same(p.hash,signedHash)&&!p.confirmed&&!p.failed?{...p,hash:undefined}:p);
          const historyKey=`share-deposit-history:${plan.rentalId}`;
          if(await store.get(historyKey))await store.update<ShareDepositView['receipts']>(historyKey,entries=>entries.filter(entry=>!(entry.planId===plan.id&&same(entry.transactionHash,signedHash)&&entry.status==='pending')));
          throw error;
        }
      }
    }
    // Only a successful broadcast or a node-known transaction may create a pending entry.
    await store.update<StoredPlan>(key,p=>{requireDeposit(!p.hash||same(p.hash,signedHash),'Plan already submitted with a different transaction.');return {...p,hash:signedHash};});
    hash=signedHash;
    if(!plan.confirmed&&!plan.failed)await recordDepositReceipt(store,plan,hash,'pending');
  }
  requireDeposit(hash&&(!input.transactionHash||same(input.transactionHash,hash)),'Submit the reviewed signed transaction first.');
  let receipt:TransactionReceipt|null=null;
  try {receipt=await rpc.getTransactionReceipt({hash});}catch(error){if(!(error instanceof TransactionReceiptNotFoundError))throw error;}
  let status: 'pending' | 'confirmed' | 'failed' = plan.confirmed ? 'confirmed' : plan.failed ? 'failed' : 'pending';
  if(receipt) {
    requireDeposit(same(receipt.transactionHash,hash)&&receipt.from&&same(receipt.from,plan.from)&&receipt.to&&same(receipt.to,plan.to),'Receipt does not match the reviewed transaction.');
    if(receipt.status==='reverted') {
      await store.update<StoredPlan>(key,p=>({...p,failed:true}));
      await recordDepositReceipt(store,plan,hash,'failed');
      status='failed';
    } else {
      requireShareReceipt(plan,receipt,hash,agreement);
      if (plan.record) await store.update<Agreement>(`agreement:${plan.rentalId}`,a=>a.records.some(r=>r.id===plan.record!.id)?a:{...a,revision:a.revision+1,records:[...a.records,plan.record!]});
      await store.update<StoredPlan>(key,p=>({...p,confirmed:true}));
      await recordDepositReceipt(store,plan,hash,'confirmed');
      status='confirmed';
    }
  }
  return {planId,transactionHash:hash,status,view:await readShareDeposit(store,identity,plan.rentalId,dependencies)};
}
