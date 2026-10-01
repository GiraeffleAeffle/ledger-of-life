import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { cashDepositForm, shareDepositForm } from '../domain/deposit-form.ts';
import type { ShareDepositAction } from '../domain/share-deposit.ts';
import { agreementDigest, inviteToAgreement, joinAgreement, type Agreement } from './agreements.ts';
import { LocalStore } from './store.ts';
import { applyToListing, chooseApplicant, createListing, type Listing } from './listings.ts';
import { boundEscrow, DEPOSIT_ABI, depositTerms, type DepositRpc, type ShareDepositManifest } from './share-deposit-chain.ts';
import { prepareShareDeposit, readShareDeposit, readShareListingQuote, requireShareActionRole, shareActions, submitShareDeposit } from './share-deposit.ts';
import { readCollateralSafety, type SharedMarketManifest } from './shared-market.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { advanceTenancyJourney, tenancyJourney } from './journey.ts';
import type { solanaServicesFor } from './solana-tenancies.ts';
import { errorResponse } from './http.ts';
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`);
const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const person = (subject:string, wallet:string):VerifiedIdentity => ({ subject, sessionId:subject, expiresAt:2e9, passkeyCount:1, wallets:[{ id:subject,address:wallet,chainType:'ethereum' }] });
const tenant=person('tenant',account.address),landlord=person('landlord',address('2')),arbitrator=person('arbitrator',address('3'));
const code='0x60006000' as Hex, codeHash=keccak256(code),escrow=address('6');
const config:ShareDepositManifest={chainId:46630,status:'deployed',factory:address('4'),implementation:address('5'),factoryCodeHash:codeHash,implementationCodeHash:codeHash,stock:address('7'),oracle:address('8'),dependencyCodeHashes:{stock:codeHash,oracle:codeHash},collateralIssuer:{beacon:address('9'),implementation:address('a'),registry:address('b'),codeHashes:{beacon:codeHash,implementation:codeHash,registry:codeHash}}};
function fixture() {
  const form={...shareDepositForm('100000000',config.factory),stock:config.stock,oracle:config.oracle};
  const agreement:Agreement={id:'rental',network:'robinhood',depositForm:form,property:'Test flat',requiredSecurity:'100000000',releaseAllowed:false,createdAt:'2026-09-01',revision:0,parties:{tenant:{subject:tenant.subject,wallet:tenant.wallets[0]},landlord:{subject:landlord.subject,wallet:landlord.wallets[0]},arbitrator:{subject:arbitrator.subject,wallet:arbitrator.wallets[0]}},invitations:{},accepted:{},records:[]};
  const hash=agreementDigest(agreement)!;agreement.accepted={tenant:{digest:hash,at:'now'},landlord:{digest:hash,at:'now'}};
  const state={phase:1,balance:12n*10n**17n,fresh:true,paused:false,blocked:false,source:1790856000n,price:100000000n,quoteReadFails:false,response:0n,ret:0n,started:0n,authorized:false,allowance:10n**18n,exists:true,mismatch:'',receipt:null as TransactionReceipt|null,broadcasts:0,broadcastError:'',known:false,estimateFails:false,estimates:0};
  const terms=depositTerms(agreement);
  const reads:string[]=[];
  const rpc={getChainId:async()=>46630,getStorageAt:async()=>`0x${'0'.repeat(24)}${config.collateralIssuer.beacon.slice(2)}`,getCode:async({address:a}:{address:string})=>a.toLowerCase()===escrow.toLowerCase()?`0x363d3d373d3d3d363d73${config.implementation!.slice(2)}5af43d82803e903d91602b57fd5bf3`:code,
    readContract:async({address:a,functionName:name,args=[]}:{address:string;functionName:string;args?:unknown[]})=>{
      reads.push(`${name}:${args.join(',')}`);
      if(name===state.mismatch)return 999n;
      if(name==='implementation')return a.toLowerCase()===config.factory!.toLowerCase()?config.implementation:config.collateralIssuer.implementation;
      if(name==='escrowFor')return state.exists?escrow:address('0');if(name==='predict')return escrow;
      if(name==='balanceOf')return String(args[0]).toLowerCase()===escrow.toLowerCase()?state.balance:10n**19n;
      if((name==='latest'||name==='latestPrice')&&state.quoteReadFails)throw new Error('oracle offline');
      if(name==='latest')return [1n,state.price,state.source,10n**18n,state.source+60n];if(name==='latestPrice')return [state.price,state.source];
      if(name==='quote')return [state.quoteReadFails?0n:state.price,state.quoteReadFails?0n:state.source,state.fresh];if(name==='state')return state.phase;
      if(name==='claim')return {usd6:20000000n,shares:2n*10n**17n,evidenceHash:`0x${'a'.repeat(64)}`,price6:100000000n,sourceTime:state.source};
      if(name==='responseDeadline')return state.response;if(name==='returnDeadline')return state.ret;if(name==='arbitrationStartedAt')return state.started;if(name==='arbitrationAuthorized')return state.authorized;
      if(name==='landlordOwed')return 0n;if(name==='custodyShortfall'||name==='collateralShortfall')return false;if(name==='allowance')return state.allowance;
      if(name==='paused')return state.paused;if(name==='isBlocked')return state.blocked;if(name==='ACCESS_CONTROLLED_REGISTRY')return config.collateralIssuer.registry;
      return ({...terms,factory:config.factory,stock:config.stock,oracle:config.oracle,fixedChainId:46630n,INITIAL_RATIO_BPS:15000n,TOP_UP_RATIO_BPS:12500n} as Record<string,unknown>)[name];
    },estimateFeesPerGas:async()=>({maxFeePerGas:1n,maxPriorityFeePerGas:0n}),getTransactionCount:async()=>0,estimateGas:async()=>{state.estimates++;if(state.estimateFails)throw new Error('InvalidState');return 100000n;},sendRawTransaction:async()=>{state.broadcasts++;if(state.broadcastError)throw new Error(state.broadcastError);return `0x${'d'.repeat(64)}`;},getTransactionReceipt:async()=>state.receipt,getTransaction:async()=>state.known?{hash:`0x${'d'.repeat(64)}`}:null,
  } as unknown as DepositRpc;
  const store=new LocalStore(':memory:');const dependencies={rpc,manifest:async()=>config,now:()=>1790856000000};
  return {agreement,state,rpc,store,dependencies,reads};
}
test('v1 digest remains byte identical; v2 commits every discriminated form term',()=>{
  const {agreement,store}=fixture();void store.close();delete agreement.depositForm;
  const expected=`0x${createHash('sha256').update(JSON.stringify({domain:'rental-agreement-v1',id:agreement.id,network:agreement.network,property:agreement.property,asset:'USDG',requiredSecurity:agreement.requiredSecurity,releaseAllowed:false,tenant:tenant.wallets[0].address,landlord:landlord.wallets[0].address,arbitrator:arbitrator.wallets[0].address})).digest('hex')}`;
  assert.equal(agreementDigest(agreement),expected);
  agreement.depositForm=cashDepositForm('robinhood');assert.notEqual(agreementDigest(agreement),expected);
  agreement.depositForm=shareDepositForm(agreement.requiredSecurity,config.factory);const first=agreementDigest(agreement);
  for(const change of [{arbitrationWindow:3601},{returnWindow:3601},{responseWindow:3601},{factory:address('c')},{securityUsd6:'99999999'},{stock:address('d')},{oracle:address('e')},{initialRatioBps:15001}])assert.notEqual(agreementDigest({...agreement,depositForm:{...agreement.depositForm,...change} as typeof agreement.depositForm}),first);
});
test('share form rejects amount/window/network choice and binds matching applicant/arbitrator wallets',async()=>{
  assert.throws(()=>shareDepositForm('999999',config.factory),/between 1/);assert.throws(()=>shareDepositForm('1000000',config.factory,{responseWindow:3599}),/whole seconds/);
  const store=new LocalStore(':memory:');const input={title:'Test home',rentMonthly:'1000000',requiredSecurity:'1000000',releaseAllowed:false,depositForm:'shares'};
  await assert.rejects(createListing(store,landlord,{...input,depositForm:'bonds'}),/cash or shares/);
  const listing=await createListing(store,landlord,input);assert.equal(listing.depositForm?.kind,'shares');
  const wrong={...tenant,wallets:[{...tenant.wallets[0],chainType:'solana' as const}]};await assert.rejects(applyToListing(store,wrong,listing.id,{name:'Tenant',message:'Please consider my application'}),/verified personal wallet/);
  await applyToListing(store,tenant,listing.id,{name:'Tenant',message:'Please consider my application'});const row=(await store.get<Listing>(`listing:${listing.id}`))!;await chooseApplicant(store,landlord,listing.id,row.applications[0].id);
  const invite=await inviteToAgreement(store,row.agreementId??`listing-${listing.id}`,landlord,'arbitrator');await assert.rejects(joinAgreement(store,`listing-${listing.id}`,{...arbitrator,wallets:[{...arbitrator.wallets[0],chainType:'solana'}]},'arbitrator',invite.token),/verified personal wallet/);
  await store.close();
});
test('every action has exact role authorization',()=>{
  const roles=['tenant','landlord','arbitrator'] as const;
  const restricted:Partial<Record<ShareDepositAction,typeof roles[number]>>={create:'landlord',approve:'tenant',pledge:'tenant',withdraw:'tenant',proposeClaim:'landlord',acceptClaim:'tenant',contestClaim:'tenant',lowerClaim:'landlord',resolveClaim:'arbitrator',requestReturn:'tenant'};
  for(const action of ['create','approve','pledge','activate','withdraw','proposeClaim','acceptClaim','contestClaim','lowerClaim','escalateClaim','resolveClaim','requestReturn','closeUnclaimed','closeUnresolved','payout'] as ShareDepositAction[])for(const role of roles){if(restricted[action]&&restricted[action]!==role)assert.throws(()=>requireShareActionRole(action,role),/Only the/);else requireShareActionRole(action,role);}
});
test('full escrow readback and issuer pause refuse inflow but not price-free return',async()=>{
  const f=fixture();await f.store.create('agreement:rental',f.agreement);
  for(const name of ['tenant','landlord','arbitrator','depositValue','agreementHash','responseWindow','returnWindow','arbitrationWindow','factory','stock','oracle','fixedChainId','INITIAL_RATIO_BPS','TOP_UP_RATIO_BPS']){f.state.mismatch=name;await assert.rejects(boundEscrow(f.agreement,config,f.rpc),/differs/);}f.state.mismatch='';
  f.state.paused=true;await assert.rejects(prepareShareDeposit(f.store,tenant,'rental','approve',{shares:'1000000000000000000'},f.dependencies),/issuer safety refused/);
  const exit=await prepareShareDeposit(f.store,tenant,'rental','requestReturn',{},f.dependencies);assert.equal(exit.review.functionName,'requestReturn');await f.store.close();
});
test('view distinguishes stale price from shortfall and enforces timeout boundaries without silence consent',async()=>{
  const f=fixture();await f.store.create('agreement:rental',f.agreement);let view=await readShareDeposit(f.store,tenant,'rental',f.dependencies);assert.equal(view.coverBps,12000);assert.equal(view.needsTopUp,true);assert.equal(view.requiredShares,'1500000000000000000');
  f.state.fresh=false;view=await readShareDeposit(f.store,tenant,'rental',f.dependencies);assert.equal(view.coverBps,null);assert.equal(view.requiredShares,null);assert.equal(view.needsTopUp,false);assert.ok(view.actions.includes('requestReturn'));
  f.state.phase=2;f.state.response=1790856000n;f.state.authorized=true;f.state.started=1790856000n-BigInt(f.agreement.depositForm!.kind==='shares'?f.agreement.depositForm!.arbitrationWindow:0);
  view=await readShareDeposit(f.store,tenant,'rental',f.dependencies);assert.ok(view.actions.includes('closeUnresolved'));assert.ok(!view.actions.includes('acceptClaim'));assert.ok(!shareActions({...view,role:'arbitrator'},true,1790856000).includes('resolveClaim'));
  f.state.phase=1;f.state.ret=1790856000n;view=await readShareDeposit(f.store,landlord,'rental',f.dependencies);assert.ok(view.actions.includes('closeUnclaimed'));assert.ok(!view.actions.includes('proposeClaim'));await f.store.close();
});
test('pool issuer safety default remains pool-scoped while deposit checks every participant',async()=>{
  const f=fixture();const pool=address('c');const market={...config,pool} as unknown as SharedMarketManifest;
  assert.equal((await readCollateralSafety(market,f.rpc)).suspended,false);assert.ok(f.reads.includes(`isBlocked:${pool}`));assert.ok(f.reads.includes('collateralShortfall:'));
  f.reads.length=0;await readCollateralSafety(market,f.rpc,{custody:escrow,participants:[tenant.wallets[0].address as Hex,landlord.wallets[0].address as Hex],shortfall:false});assert.ok(!f.reads.includes('collateralShortfall:'));assert.ok(f.reads.includes(`isBlocked:${escrow}`));assert.ok(f.reads.includes(`isBlocked:${tenant.wallets[0].address}`));await f.store.close();
});
test('durable signed plan rejects altered calldata; receipts require exact amount and recipient',async()=>{
  const f=fixture();f.state.phase=0;await f.store.create('agreement:rental',f.agreement);
  const plan=await prepareShareDeposit(f.store,tenant,'rental','withdraw',{shares:'100000000000000000'},f.dependencies);
  const t=plan.transaction;const sign=async(data:Hex)=>account.signTransaction({chainId:t.chainId,to:t.to as Hex,data,value:0n,nonce:t.nonce,gas:BigInt(t.gas),maxFeePerGas:BigInt(t.maxFeePerGas),maxPriorityFeePerGas:BigInt(t.maxPriorityFeePerGas)});
  await assert.rejects(submitShareDeposit(f.store,tenant,plan.id,{signed:await sign('0x')},f.dependencies),/exact reviewed plan/);assert.equal(f.state.broadcasts,0);
  const signed=await sign(t.data as Hex);const hash=keccak256(signed);
  const receipt=(amount:bigint)=>({transactionHash:hash,status:'success',from:account.address,to:escrow,logs:[{address:escrow,topics:encodeEventTopics({abi:DEPOSIT_ABI,eventName:'Withdrawn'}),data:encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'}],[amount,100000000n,f.state.source])}]} as unknown as TransactionReceipt);
  f.state.receipt=receipt(1n);await assert.rejects(submitShareDeposit(f.store,tenant,plan.id,{signed},f.dependencies),/exact expected deposit event/);
  f.state.receipt=receipt(100000000000000000n);const result=await submitShareDeposit(f.store,tenant,plan.id,{transactionHash:hash},f.dependencies);assert.equal(result.status,'confirmed');assert.equal((await f.store.get<{confirmed:boolean}>(`share-deposit-plan:${plan.id}`))!.confirmed,true);
  await assert.rejects(submitShareDeposit(f.store,landlord,plan.id,{transactionHash:hash},f.dependencies),/another wallet/);await f.store.close();
});

test('undeployed and stale listing quote cannot offer funded application or signing',async()=>{
  const f=fixture();await f.store.create('agreement:rental',f.agreement);
  const disabled=await readShareDeposit(f.store,tenant,'rental',{...f.dependencies,manifest:async()=>null});
  assert.equal(disabled.deployment,'not_deployed');assert.deepEqual(disabled.actions,[]);assert.equal(disabled.quote,null);assert.equal(disabled.requiredShares,null);
  await f.store.create('listing:quote',{depositForm:f.agreement.depositForm,requiredSecurity:f.agreement.requiredSecurity});
  const quote=await readShareListingQuote(f.store,tenant,'quote',f.dependencies);assert.equal(quote.walletAddress,account.address);assert.equal(quote.requiredShares,'1500000000000000000');
  f.state.source=1n;assert.equal((await readShareListingQuote(f.store,tenant,'quote',f.dependencies)).requiredShares,null);await f.store.close();
});

test('Closed empty custody is not paid until a matched payout receipt survives reload',async()=>{
  const f=fixture();f.state.phase=4;f.state.balance=0n;await f.store.create('agreement:rental',f.agreement);
  let view=await readShareDeposit(f.store,tenant,'rental',f.dependencies);assert.equal(view.paidOut,false);assert.ok(view.actions.includes('payout'));
  const plan=await prepareShareDeposit(f.store,tenant,'rental','payout',{side:'tenant'},f.dependencies);
  const t=plan.transaction;const signed=await account.signTransaction({chainId:t.chainId,to:t.to as Hex,data:t.data as Hex,value:0n,nonce:t.nonce,gas:BigInt(t.gas),maxFeePerGas:BigInt(t.maxFeePerGas),maxPriorityFeePerGas:BigInt(t.maxPriorityFeePerGas)});
  const hash=keccak256(signed);
  f.state.receipt={transactionHash:hash,status:'success',from:account.address,to:escrow,logs:[{address:escrow,topics:encodeEventTopics({abi:DEPOSIT_ABI,eventName:'Paid',args:{recipient:account.address}}),data:encodeAbiParameters([{type:'uint256'}],[0n])}]} as unknown as TransactionReceipt;
  await submitShareDeposit(f.store,tenant,plan.id,{signed},f.dependencies);
  view=await readShareDeposit(f.store,landlord,'rental',f.dependencies);assert.equal(view.paidOut,true);assert.equal(view.receipts[0].status,'confirmed');assert.ok(!view.actions.includes('payout'));await f.store.close();
});

test('move-out evidence remains private to durable review until its exact event confirms',async()=>{
  const f=fixture();await f.store.create('agreement:rental',f.agreement);
  const plan=await prepareShareDeposit(f.store,landlord,'rental','proposeClaim',{usd6:'1000000',evidence:'Move-out inspection records a broken cupboard.'},f.dependencies);
  assert.deepEqual((await f.store.get<Agreement>('agreement:rental'))!.records,[]);
  const hash=`0x${'f'.repeat(64)}` as Hex;await f.store.update<Record<string,unknown>>(`share-deposit-plan:${plan.id}`,p=>({...p,hash}));
  const receipt=(evidence:Hex)=>({transactionHash:hash,status:'success',from:landlord.wallets[0].address,to:escrow,logs:[{address:escrow,topics:encodeEventTopics({abi:DEPOSIT_ABI,eventName:'ClaimProposed'}),data:encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'bytes32'},{type:'uint256'},{type:'uint256'}],[1000000n,10000000000000000n,evidence,100000000n,f.state.source])}]} as unknown as TransactionReceipt);
  f.state.receipt=receipt(`0x${'0'.repeat(64)}`);await assert.rejects(submitShareDeposit(f.store,landlord,plan.id,{transactionHash:hash},f.dependencies),/exact expected deposit event/);assert.deepEqual((await f.store.get<Agreement>('agreement:rental'))!.records,[]);
  f.state.receipt=receipt(plan.review.args[1] as Hex);await submitShareDeposit(f.store,landlord,plan.id,{transactionHash:hash},f.dependencies);await submitShareDeposit(f.store,landlord,plan.id,{transactionHash:hash},f.dependencies);
  const saved=(await f.store.get<Agreement>('agreement:rental'))!.records;assert.equal(saved.length,1);assert.equal(saved[0].body,'Move-out inspection records a broken cupboard.');assert.equal(agreementDigest((await f.store.get<Agreement>('agreement:rental'))!),agreementDigest(f.agreement));await f.store.close();
});

test('advance never authorizes Solana sponsor effects for share tenancies; cash retains setup funding',async()=>{
  const f=fixture();f.state.exists=false;await f.store.create('agreement:rental',f.agreement);
  const forbidden:typeof solanaServicesFor=async()=>{throw new Error('Shares must never use Solana services');};
  const accounts=async()=>{await f.store.create('sponsor-account-created',true);return 'created' as const;};
  const shareRead:typeof tenancyJourney=(store,identity,agreement)=>tenancyJourney(store,identity,agreement,forbidden,(s,i,id)=>readShareDeposit(s,i,id,f.dependencies));
  const shares=await advanceTenancyJourney(f.store,landlord,f.agreement,{read:shareRead,accounts,services:forbidden});
  assert.equal(shares.journey.next.kind,'create_space');assert.equal(await f.store.get('sponsor-account-created'),null);
  const cash={...f.agreement,network:'solana' as const,depositForm:cashDepositForm(),parties:Object.fromEntries(Object.entries(f.agreement.parties).map(([r,p])=>[r,{...p,wallet:{...p.wallet,chainType:'solana' as const}}]))};
  const digest=agreementDigest(cash)!;cash.accepted={landlord:{digest,at:'now'},tenant:{digest,at:'now'}};
  const cashIdentity={...landlord,wallets:[cash.parties.landlord!.wallet]};
  const cashServices=(async()=>({initialization:{status:async()=>({initialization:null})}})) as unknown as typeof solanaServicesFor;
  const cashRead:typeof tenancyJourney=(store,identity,agreement)=>tenancyJourney(store,identity,agreement,cashServices);
  const advanced=await advanceTenancyJourney(f.store,cashIdentity,cash,{read:cashRead,accounts,services:cashServices});
  assert.equal(advanced.journey.next.kind,'create_space');assert.equal(await f.store.get('sponsor-account-created'),true);await f.store.close();
});

test('a reserved pending inflow never bypasses changed issuer safety on rebroadcast',async()=>{
  const f=fixture();await f.store.create('agreement:rental',f.agreement);
  const plan=await prepareShareDeposit(f.store,tenant,'rental','approve',{shares:'1000000000000000000'},f.dependencies);
  const t=plan.transaction;const signed=await account.signTransaction({chainId:t.chainId,to:t.to as Hex,data:t.data as Hex,value:0n,nonce:t.nonce,gas:BigInt(t.gas),maxFeePerGas:BigInt(t.maxFeePerGas),maxPriorityFeePerGas:BigInt(t.maxPriorityFeePerGas)});
  assert.equal((await submitShareDeposit(f.store,tenant,plan.id,{signed},f.dependencies)).status,'pending');assert.equal(f.state.broadcasts,1);
  f.state.paused=true;await assert.rejects(submitShareDeposit(f.store,tenant,plan.id,{signed},f.dependencies),/issuer safety refused/);assert.equal(f.state.broadcasts,1);await f.store.close();
});

test('nonce-too-low broadcast never binds an unaccepted hash or leaves pending history',async()=>{
  const f=fixture();f.state.phase=0;await f.store.create('agreement:rental',f.agreement);
  const plan=await prepareShareDeposit(f.store,tenant,'rental','withdraw',{shares:'100000000000000000'},f.dependencies);
  const t=plan.transaction;const signed=await account.signTransaction({chainId:t.chainId,to:t.to as Hex,data:t.data as Hex,value:0n,nonce:t.nonce,gas:BigInt(t.gas),maxFeePerGas:BigInt(t.maxFeePerGas),maxPriorityFeePerGas:BigInt(t.maxPriorityFeePerGas)});
  f.state.broadcastError='nonce too low';
  await assert.rejects(submitShareDeposit(f.store,tenant,plan.id,{signed},f.dependencies),/nonce too low/);
  assert.equal((await f.store.get<{hash?:string}>(`share-deposit-plan:${plan.id}`))!.hash,undefined);
  assert.deepEqual((await readShareDeposit(f.store,tenant,'rental',f.dependencies)).receipts,[]);
  assert.ok((await readShareDeposit(f.store,tenant,'rental',f.dependencies)).actions.includes('withdraw'));
  f.state.broadcastError='';await submitShareDeposit(f.store,tenant,plan.id,{signed},f.dependencies);
  f.state.broadcastError='nonce too low';await assert.rejects(submitShareDeposit(f.store,tenant,plan.id,{signed},f.dependencies),/nonce too low/);
  assert.equal((await f.store.get<{hash?:string}>(`share-deposit-plan:${plan.id}`))!.hash,undefined);
  assert.deepEqual((await readShareDeposit(f.store,tenant,'rental',f.dependencies)).receipts,[]);await f.store.close();
});

test('a reverted exact receipt becomes terminal failed, leaves evidence untouched and reopens actions',async()=>{
  const f=fixture();f.state.phase=0;await f.store.create('agreement:rental',f.agreement);
  const plan=await prepareShareDeposit(f.store,tenant,'rental','withdraw',{shares:'100000000000000000'},f.dependencies);
  const t=plan.transaction;const signed=await account.signTransaction({chainId:t.chainId,to:t.to as Hex,data:t.data as Hex,value:0n,nonce:t.nonce,gas:BigInt(t.gas),maxFeePerGas:BigInt(t.maxFeePerGas),maxPriorityFeePerGas:BigInt(t.maxPriorityFeePerGas)});
  const hash=keccak256(signed);f.state.receipt={transactionHash:hash,status:'reverted',from:account.address,to:escrow,logs:[]} as unknown as TransactionReceipt;
  const result=await submitShareDeposit(f.store,tenant,plan.id,{signed},f.dependencies);
  assert.equal(result.status,'failed');assert.equal(result.view.receipts[0].status,'failed');assert.ok(result.view.actions.includes('withdraw'));assert.equal(result.view.paidOut,false);
  assert.deepEqual((await f.store.get<Agreement>('agreement:rental'))!.records,[]);
  const repeated=await submitShareDeposit(f.store,tenant,plan.id,{signed},f.dependencies);assert.equal(repeated.status,'failed');assert.equal(f.state.broadcasts,1);
  await prepareShareDeposit(f.store,tenant,'rental','withdraw',{shares:'100000000000000000'},f.dependencies);await f.store.close();
});

test('withdraw review bounds preserve exact 150% and malformed or refused amounts use 400/409',async()=>{
  const f=fixture();f.state.balance=2n*10n**18n;await f.store.create('agreement:rental',f.agreement);
  const view=await readShareDeposit(f.store,tenant,'rental',f.dependencies);assert.equal(view.maximumWithdrawShares,'500000000000000000');
  const zero=await prepareShareDeposit(f.store,tenant,'rental','withdraw',{shares:'0'},f.dependencies).catch(error=>errorResponse(error));assert.ok(zero instanceof Response);assert.equal(zero.status,400);
  const tooMuch=await prepareShareDeposit(f.store,tenant,'rental','withdraw',{shares:'500000000000000001'},f.dependencies).catch(error=>errorResponse(error));assert.ok(tooMuch instanceof Response);assert.equal(tooMuch.status,409);assert.equal(f.state.estimates,0);
  await prepareShareDeposit(f.store,tenant,'rental','withdraw',{shares:'500000000000000000'},f.dependencies);
  f.state.fresh=false;assert.equal((await readShareDeposit(f.store,tenant,'rental',f.dependencies)).maximumWithdrawShares,null);
  f.state.phase=0;assert.equal((await readShareDeposit(f.store,tenant,'rental',f.dependencies)).maximumWithdrawShares,'2000000000000000000');
  await prepareShareDeposit(f.store,tenant,'rental','withdraw',{shares:'2000000000000000000'},f.dependencies);
  f.state.estimateFails=true;
  const refused=await prepareShareDeposit(f.store,tenant,'rental','withdraw',{shares:'1'},f.dependencies).catch(error=>errorResponse(error));
  assert.ok(refused instanceof Response);assert.equal(refused.status,409);assert.match((await refused.json()).error,/refuse withdraw/);await f.store.close();
});

test('acceptClaim refuses a reviewed maximum below current fixed shares before estimation',async()=>{
  const f=fixture();f.state.phase=2;await f.store.create('agreement:rental',f.agreement);
  const refused=await prepareShareDeposit(f.store,tenant,'rental','acceptClaim',{maxShares:'199999999999999999'},f.dependencies).catch(error=>errorResponse(error));
  assert.ok(refused instanceof Response);assert.equal(refused.status,409);assert.equal(f.state.estimates,0);
  await prepareShareDeposit(f.store,tenant,'rental','acceptClaim',{maxShares:'200000000000000000'},f.dependencies);await f.store.close();
});

test('failed/zero oracle observations return null, not a factual zero price or epoch date',async()=>{
  const f=fixture();await f.store.create('agreement:rental',f.agreement);await f.store.create('listing:quote',{depositForm:f.agreement.depositForm,requiredSecurity:f.agreement.requiredSecurity});
  for(const condition of ['rpcFailure','zeroPrice','zeroSource'] as const) {
    f.state.quoteReadFails=condition==='rpcFailure';f.state.price=condition==='zeroPrice'?0n:100000000n;f.state.source=condition==='zeroSource'?0n:1790856000n;
    const view=await readShareDeposit(f.store,tenant,'rental',f.dependencies);assert.equal(view.quote,null);assert.equal(view.coverBps,null);assert.equal(view.requiredShares,null);assert.ok(view.actions.includes('requestReturn'));
    const listing=await readShareListingQuote(f.store,tenant,'quote',f.dependencies);assert.equal(listing.quote,null);assert.equal(listing.requiredShares,null);
  }
  await f.store.close();
});

test('a node-known broadcast survives response loss and expired review without a second send',async()=>{
  const f=fixture();f.state.phase=0;await f.store.create('agreement:rental',f.agreement);
  const plan=await prepareShareDeposit(f.store,tenant,'rental','withdraw',{shares:'100000000000000000'},f.dependencies);
  const t=plan.transaction;const signed=await account.signTransaction({chainId:t.chainId,to:t.to as Hex,data:t.data as Hex,value:0n,nonce:t.nonce,gas:BigInt(t.gas),maxFeePerGas:BigInt(t.maxFeePerGas),maxPriorityFeePerGas:BigInt(t.maxPriorityFeePerGas)});
  f.rpc.sendRawTransaction=async()=>{f.state.broadcasts++;f.state.known=true;throw new Error('Broadcast response lost');};
  const first=await submitShareDeposit(f.store,tenant,plan.id,{signed},f.dependencies);
  assert.equal(first.status,'pending');assert.equal(first.transactionHash,keccak256(signed));assert.equal(first.view.receipts[0].status,'pending');
  const again=await submitShareDeposit(f.store,tenant,plan.id,{signed},{...f.dependencies,now:()=>f.dependencies.now()+300000});
  assert.equal(again.status,'pending');assert.equal(f.state.broadcasts,1);await f.store.close();
});
