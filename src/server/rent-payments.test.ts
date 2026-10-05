import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeAbiParameters, encodeEventTopics, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import manifestJson from '../../contracts/evm/deployments/building-revenue-46630.json' with { type: 'json' };
import { berlinRentMonth, paidRentMonth, splitBuildingRent } from '../domain/rent.ts';
import { cashDepositForm, canonicalDeposit } from '../domain/deposit-form.ts';
import { RENT_TOKEN_ABI } from '../wallets/rent-signing.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { agreementDigest, type Agreement } from './agreements.ts';
import { createListing, applyToListing, chooseApplicant } from './listings.ts';
import { LocalStore } from './store.ts';
import { prepareRent, readRent, submitRent, verifyRentReceipt, type RentPayment, type RentReceipt } from './rent-payments.ts';
import type { BuildingManifest, BuildingRpc } from './building-revenue.ts';
import type { tenancyJourney, TenancyJourney } from './journey.ts';
import { AccountRole, generateKeyPairSigner, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction } from '@solana/kit';
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { houseAddresses, HOUSE_DISCRIMINATORS } from '../finance/solana/house.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { createSolanaOperations } from './solana-operations.ts';
import { solanaRentInstructions } from './rent-payments.ts';
import type { SolanaHouseManifest } from './solana-house-config.ts';
const tenantAccount = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const landlordAddress = '0x2222222222222222222222222222222222222222';
const identity = (subject: string, address: string): VerifiedIdentity => ({ subject,sessionId:subject,expiresAt:Date.now()/1000+3600,passkeyCount:1,wallets:[{id:`evm-${subject}`,chainType:'ethereum',address},{id:`sol-${subject}`,chainType:'solana',address:`solana-${subject}`}] });
const tenant = identity('tenant',tenantAccount.address), landlord = identity('landlord',landlordAddress), arb = identity('arb','0x3333333333333333333333333333333333333333');
function agreement(): Agreement {
  const value: Agreement = { id:'rent-test',network:'solana',depositForm:cashDepositForm(),property:'Berlin flat 4',rentTerms:{buildingId:'demo-neighbourhood-homes',shareBps:2000,rentMonthly:'900000003',landlordWallet:landlordAddress},requiredSecurity:'1800000000',releaseAllowed:true,createdAt:'2026-10-01T00:00:00Z',revision:0,parties:{tenant:{subject:tenant.subject,wallet:tenant.wallets[1]},landlord:{subject:landlord.subject,wallet:landlord.wallets[1]},arbitrator:{subject:arb.subject,wallet:arb.wallets[1]}},accepted:{},invitations:{},records:[] };
  const digest = agreementDigest(value)!; value.accepted = {tenant:{digest,at:value.createdAt},landlord:{digest,at:value.createdAt}}; return value;
}
function harness() {
  const code = '0x6000' as Hex, hash = keccak256(code);
  const manifest: BuildingManifest = { ...manifestJson, distributor:manifestJson.distributor as Hex,payoutToken:manifestJson.payoutToken as Hex,unitToken:manifestJson.unitToken as Hex,runtimeCodeHash:hash,dependencyCodeHashes:{payoutToken:hash,unitToken:hash} };
  let nonce=0, available=false, now=Date.parse('2026-10-02T12:00:00Z'), sendCount=0;
  const receipts = new Map<Hex, RentReceipt>();
  const rpc = {
    getChainId:async()=>46630,getCode:async()=>code,
    readContract:async({functionName}:{functionName:string})=>({payoutToken:manifest.payoutToken,unitToken:manifest.unitToken,rewardDuration:604800n,rewardScale:BigInt(manifest.rewardsSpec.scale),balanceOf:10000000000n}[functionName]),
    getTransactionCount:async()=>nonce,estimateFeesPerGas:async()=>({maxFeePerGas:1000000n,maxPriorityFeePerGas:0n}),estimateGas:async()=>40000n,getBalance:async()=>10n**18n,
    getTransactionReceipt:async({hash}:{hash:Hex})=>{if(available&&receipts.has(hash))return receipts.get(hash)!; const error=new Error('pending');error.name='TransactionReceiptNotFoundError';throw error;},
    sendRawTransaction:async({serializedTransaction}:{serializedTransaction:Hex})=>{sendCount++;return keccak256(serializedTransaction);},
    waitForTransactionReceipt:async({hash}:{hash:Hex})=>{if(!available||!receipts.has(hash))throw new Error('pending');return receipts.get(hash)!;}
  } as unknown as BuildingRpc;
  const readJourney = (async()=>({stage:'living',chain:{phase:'active'}} as TenancyJourney)) as typeof tenancyJourney;
  return { options:{rpc,loadManifest:async()=>manifest,readJourney,now:()=>now},receipts,ready:()=>{available=true;nonce++;},nextMonth:()=>{now=Date.parse('2026-11-02T12:00:00Z');},count:()=>sendCount };
}
function receiptFor(payment: RentPayment, index: number): RentReceipt {
  const step=payment.steps[index];
  return { status:'success' as const,transactionHash:step.hash!,logs:[{address:payment.token as Hex,data:encodeAbiParameters([{type:'uint256'}],[BigInt(step.amountRaw)]),topics:encodeEventTopics({abi:RENT_TOKEN_ABI,eventName:'Transfer',args:{from:payment.tenantWallet as Hex,to:step.recipient as Hex}}) as [Hex,Hex,Hex]}] };
}
async function sign(request: NonNullable<RentPayment['steps'][number]['request']>) {
  const tx=request.transaction;
  return tenantAccount.signTransaction({chainId:46630,type:'eip1559',to:tx.to as Hex,data:tx.data as Hex,value:0n,nonce:tx.nonce as number,gas:BigInt(tx.gasLimit!),maxFeePerGas:BigInt(tx.maxFeePerGas!),maxPriorityFeePerGas:BigInt(tx.maxPriorityFeePerGas!)});
}
test('fixed split floors building share and gives every remaining atom to landlord; Berlin month uses local calendar',()=>{
  for(const amount of ['1','4','5','6','9999999999','10000000000']){const split=splitBuildingRent(amount);assert.equal(BigInt(split.buildingRaw),BigInt(amount)*2000n/10000n);assert.equal(BigInt(split.landlordRaw)+BigInt(split.buildingRaw),BigInt(amount));}
  assert.deepEqual(splitBuildingRent('900000003'),{buildingRaw:'180000000',landlordRaw:'720000003'});
  assert.equal(berlinRentMonth(Date.parse('2026-10-31T23:30:00Z')),'2026-11');
  assert.equal(berlinRentMonth(Date.parse('2026-01-31T23:30:00Z')),'2026-02');
});
test('paid rent summary follows the Berlin month, next due month and viewer role', () => {
  const month = berlinRentMonth(Date.parse('2026-10-31T23:30:00Z'));
  const payment = { month, state: 'confirmed' };
  assert.deepEqual(paidRentMonth({ month, role: 'tenant', payment }), {
    heading: 'Rent for November 2026 paid',
    nextDue: 'Rent for December 2026 can be paid from 1 December 2026, Berlin time.',
  });
  assert.equal(paidRentMonth({ month, role: 'landlord', payment })?.heading, 'Rent for November 2026 received');
  assert.equal(paidRentMonth({ month: '2026-12', role: 'tenant', payment: { month: '2026-12', state: 'confirmed' } })?.nextDue, 'Rent for January 2027 can be paid from 1 January 2027, Berlin time.');
  assert.equal(paidRentMonth({ month, role: 'tenant', payment: { month, state: 'pending' } }), null);
  assert.equal(paidRentMonth({ month, role: 'tenant', payment: null }), null);
  assert.equal(paidRentMonth({ month, role: 'tenant', payment: { month: '2026-10', state: 'confirmed' } }), null);
});
test('publication fixes rent share and binds it only to newly chosen building agreements',async()=>{
  const store=new LocalStore(':memory:');try{
    const listing=await createListing(store,landlord,{title:'Berlin flat 4',requiredSecurity:'1800000000',rentMonthly:'900000000',releaseAllowed:true,buildingHome:true},{});
    assert.equal(listing.buildingRent?.shareBps,2000);
    await assert.rejects(createListing(store,landlord,{title:'Invalid',requiredSecurity:'1800000000',rentMonthly:'900000000',releaseAllowed:true,buildingHome:true,shareBps:1000}),/fixed/);
    await applyToListing(store,tenant,listing.id,{name:'Tenant',message:''});
    const saved=await store.get<{applications:{id:string}[]}>(`listing:${listing.id}`);
    const chosen=await chooseApplicant(store,landlord,listing.id,saved!.applications[0].id);
    const value=await store.get<Agreement>(`agreement:${chosen.agreementId}`);
    assert.deepEqual(value!.rentTerms,{buildingId:'demo-neighbourhood-homes',shareBps:2000,landlordWallet:landlordAddress,rentMonthly:'900000000'});
  }finally{await store.close();}
});
test('legacy v1/v2 agreement digests keep original canonical terms; v3 binds monthly rent and landlord EVM recipient',()=>{
  const value=agreement();delete value.rentTerms;
  const expected=(body:unknown)=>`0x${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
  const base={id:value.id,network:value.network,property:value.property,requiredSecurity:value.requiredSecurity,releaseAllowed:value.releaseAllowed,tenant:value.parties.tenant!.wallet.address,landlord:value.parties.landlord!.wallet.address,arbitrator:value.parties.arbitrator!.wallet.address};
  assert.equal(agreementDigest(value),expected({domain:'rental-agreement-v2',id:base.id,network:base.network,property:base.property,deposit:canonicalDeposit(value.depositForm!),requiredSecurity:base.requiredSecurity,releaseAllowed:base.releaseAllowed,tenant:base.tenant,landlord:base.landlord,arbitrator:base.arbitrator}));
  delete value.depositForm;
  assert.equal(agreementDigest(value),expected({domain:'rental-agreement-v1',id:base.id,network:base.network,property:base.property,asset:'USDC',requiredSecurity:base.requiredSecurity,releaseAllowed:base.releaseAllowed,tenant:base.tenant,landlord:base.landlord,arbitrator:base.arbitrator}));
  const rent=agreement();assert.notEqual(agreementDigest(rent),agreementDigest({...rent,rentTerms:{...rent.rentTerms!,rentMonthly:'900000004'}}));assert.notEqual(agreementDigest(rent),agreementDigest({...rent,rentTerms:{...rent.rentTerms!,landlordWallet:arb.wallets[0].address}}));
});
test('only tenant pays; journal recovers lost responses with identical bytes, completes exact split once, and allows next month',async()=>{
  const store=new LocalStore(':memory:'),h=harness(),value=agreement();try{
    await store.create(`agreement:${value.id}`,value);
    await assert.rejects(prepareRent(store,landlord,value.id,h.options),/Only the tenant/);
    await assert.rejects(readRent(store,arb,value.id,h.options),/only tenant and landlord/);
    await assert.rejects(prepareRent(store,identity('outsider',arb.wallets[0].address),value.id,h.options),/not a verified party/);
    const [first,duplicate]=await Promise.all([prepareRent(store,tenant,value.id,h.options),prepareRent(store,tenant,value.id,h.options)]);
    assert.equal(first!.payment!.id,duplicate!.payment!.id);
    const req=first!.payment!.steps[0].request!,signed=await sign(req);
    await submitRent(store,tenant,value.id,first!.payment!.steps[0].id,signed,h.options);
    const pending=await store.get<RentPayment>(`rent-payment:${value.id}:2026-10`);assert.equal(pending!.steps[0].signed,signed);assert.equal(pending!.steps[0].hash,keccak256(signed));
    const retry=await prepareRent(store,tenant,value.id,h.options);assert.equal(retry!.payment!.steps[0].hash,keccak256(signed));assert.equal(retry!.payment!.steps[0].request,null);
    h.nextMonth();const rollover=await prepareRent(store,tenant,value.id,h.options);assert.equal(rollover!.month,'2026-11');assert.equal(rollover!.payment,null);assert.equal(rollover!.history.length,1);
    h.receipts.set(pending!.steps[0].hash!,receiptFor(pending!,0));h.ready();
    const recovered=await readRent(store,tenant,value.id,h.options);assert.equal(recovered!.history[0].steps[0].state,'confirmed');
    const second=await prepareRent(store,tenant,value.id,h.options),step=second!.history[0].steps[1];
    assert.equal(step.request!.rentTransfer!.month,'2026-10');
    const secondSigned=await sign(step.request!);await submitRent(store,tenant,value.id,step.id,secondSigned,h.options);
    const octoberOptions={...h.options,now:()=>Date.parse('2026-10-02T12:00:00Z')};
    const saved=await store.get<RentPayment>(`rent-payment:${value.id}:2026-10`);h.receipts.set(saved!.steps[1].hash!,receiptFor(saved!,1));h.ready();
    const paid=await readRent(store,landlord,value.id,octoberOptions);assert.equal(paid!.payment!.state,'confirmed');assert.equal(paid!.payment!.landlordRaw,'720000003');assert.equal(paid!.payment!.buildingRaw,'180000000');assert.equal('signed' in paid!.payment!.steps[0],false);
    await assert.rejects(prepareRent(store,tenant,value.id,octoberOptions),/already paid/);
    assert.equal((await store.scan('rent-payment:')).length,1);
    assert.equal((await prepareRent(store,tenant,value.id,h.options))!.month,'2026-11');assert.ok(h.count()>=2);
  }finally{await store.close();}
});
test('preparation failures stop clearly, reverted transfers refresh only after receipt proof, and inactive tenancies cannot sign new rent',async()=>{
  const store=new LocalStore(':memory:'),h=harness(),value=agreement();
  try {
    await store.create(`agreement:${value.id}`,value);
    const estimateGas=h.options.rpc.estimateGas;
    h.options.rpc.estimateGas=async()=>{throw new Error('Gas quote unavailable');};
    const stopped=await prepareRent(store,tenant,value.id,h.options);
    assert.equal(stopped!.payment!.state,'stopped');
    assert.equal(stopped!.payment!.steps[0].request,null);
    assert.equal(stopped!.payment!.error,'Gas quote unavailable');
    h.options.rpc.estimateGas=estimateGas;
    const prepared=await prepareRent(store,tenant,value.id,h.options);
    assert.equal(prepared!.payment!.error,null);
    const step=prepared!.payment!.steps[0],signed=await sign(step.request!);
    const inactiveOptions={...h.options,readJourney:(async()=>({stage:'move-out',chain:{phase:'claim-proposed'}} as TenancyJourney)) as typeof tenancyJourney};
    await assert.rejects(prepareRent(store,tenant,value.id,inactiveOptions),/active tenancy/);
    await assert.rejects(submitRent(store,tenant,value.id,step.id,signed,inactiveOptions),/active tenancy/);
    await submitRent(store,tenant,value.id,step.id,signed,h.options);
    const saved=(await store.get<RentPayment>(`rent-payment:${value.id}:2026-10`))!;
    h.receipts.set(saved.steps[0].hash!,{...receiptFor(saved,0),status:'reverted'});h.ready();
    const reverted=await readRent(store,tenant,value.id,h.options);
    assert.equal(reverted!.payment!.state,'stopped');
    assert.equal(reverted!.payment!.steps[0].retryable,true);
    const retry=await prepareRent(store,tenant,value.id,h.options);
    assert.equal(retry!.payment!.steps[0].state,'prepared');
    assert.equal(retry!.payment!.steps[0].hash,undefined);
    assert.equal(retry!.payment!.steps[0].request!.transaction.nonce,1);
    await assert.rejects(submitRent(store,tenant,value.id,step.id,signed,h.options),/exact wallet, nonce/);
  } finally {await store.close();}
});
test('rent review lasts two minutes, rejects exact-boundary expiry before persistence, and refreshes the same step', async () => {
  const store = new LocalStore(':memory:'), h = harness(), value = agreement();
  try {
    await store.create(`agreement:${value.id}`, value);
    const prepared = (await prepareRent(store, tenant, value.id, h.options))!;
    const step = prepared.payment!.steps[0], request = step.request!;
    const start = h.options.now();
    assert.equal(Date.parse(request.expiresAt) - start, 120_000);
    const before = { ...h.options, now: () => start + 119_999 };
    assert.deepEqual((await prepareRent(store, tenant, value.id, before))!.payment!.steps[0].request, request);
    const expired = { ...h.options, now: () => start + 120_000 };
    await assert.rejects(submitRent(store, tenant, value.id, step.id, await sign(request), expired), /rent review expired/);
    assert.equal((await store.get<RentPayment>(`rent-payment:${value.id}:2026-10`))!.steps[0].signed, undefined);
    assert.equal(h.count(), 0);
    const refreshed = (await prepareRent(store, tenant, value.id, expired))!.payment!.steps[0];
    assert.equal(refreshed.id, step.id);
    assert.equal(Date.parse(refreshed.request!.expiresAt), start + 240_000);
    const signed = await sign(refreshed.request!);
    await submitRent(store, tenant, value.id, step.id, signed, expired);
    assert.equal((await store.get<RentPayment>(`rent-payment:${value.id}:2026-10`))!.steps[0].signed, signed);
  } finally { await store.close(); }
});
test('receipt proof rejects wrong token, recipient, sender, amount, hash and reverted transfers',()=>{
  const payment={tenantWallet:tenantAccount.address,token:manifestJson.payoutToken,steps:[{recipient:landlordAddress,amountRaw:'8000000',hash:`0x${'aa'.repeat(32)}`}]} as RentPayment;
  const step=payment.steps[0],receipt=receiptFor(payment,0);verifyRentReceipt(receipt,payment,step);
  for(const changed of [ {...receipt,transactionHash:`0x${'bb'.repeat(32)}`}, {...receipt,status:'reverted'}, {...receipt,logs:[{...receipt.logs[0],address:landlordAddress}]}, {...receipt,logs:[{...receipt.logs[0],data:encodeAbiParameters([{type:'uint256'}],[8000001n])}]}, {...receipt,logs:[{...receipt.logs[0],topics:encodeEventTopics({abi:RENT_TOKEN_ABI,eventName:'Transfer',args:{from:tenantAccount.address,to:arb.wallets[0].address as Hex}})}]}, {...receipt,logs:[{...receipt.logs[0],topics:encodeEventTopics({abi:RENT_TOKEN_ABI,eventName:'Transfer',args:{from:arb.wallets[0].address as Hex,to:landlordAddress}})}]} ]) assert.throws(()=>verifyRentReceipt(changed as typeof receipt,payment,step),/exact|Transfer/);
});

async function solanaFixture() {
  const owner = await generateKeyPairSigner(), recipient = await generateKeyPairSigner(), payer = await generateKeyPairSigner();
  const programId = 'DuFehTh7HJVxTmBhdJiDxsDrd6xXMnQW35jzLPxBeDfb';
  const house = await houseAddresses('neighbourhood-homes',programId), workshop = await houseAddresses('workshop',programId);
  const manifest: SolanaHouseManifest = { cluster:'devnet',genesisHash:SOLANA_DEVNET_MANIFEST.genesisHash,programId,cashMint:SOLANA_TEST_USDC_MINT,houses:{'neighbourhood-homes':house,workshop} };
  const person = (subject: string, wallet: string): VerifiedIdentity => ({ ...identity(subject,landlordAddress),wallets:[{id:`sol-${subject}`,chainType:'solana',address:wallet}] });
  const tenant = person('sol-tenant',owner.address), landlord = person('sol-landlord',recipient.address), arb = person('sol-arb',payer.address);
  const value = agreement();
  value.id='sol-rent-test';
  value.rentTerms={network:'solana-devnet',rentMonthly:'650000003',shareBps:2000,landlordWallet:recipient.address,house:house.house};
  value.parties={tenant:{subject:tenant.subject,wallet:tenant.wallets[0]},landlord:{subject:landlord.subject,wallet:landlord.wallets[0]},arbitrator:{subject:arb.subject,wallet:arb.wallets[0]}};
  const digest=agreementDigest(value)!;value.accepted={tenant:{digest,at:value.createdAt},landlord:{digest,at:value.createdAt}};
  return { owner,recipient,payer,manifest,house,tenant,landlord,arb,value };
}
test('v4 canonically binds Solana rent network, amount, share, landlord and house; v3 bytes remain unchanged',async()=>{
  const {value}=await solanaFixture(),terms=value.rentTerms!,base=agreementDigest(value);
  const expected=`0x${createHash('sha256').update(JSON.stringify({domain:'rental-agreement-v4',id:value.id,network:value.network,property:value.property,deposit:canonicalDeposit(value.depositForm!),rent:{network:terms.network,rentMonthly:terms.rentMonthly,shareBps:terms.shareBps,landlordWallet:terms.landlordWallet,house:terms.house},requiredSecurity:value.requiredSecurity,releaseAllowed:value.releaseAllowed,tenant:value.parties.tenant!.wallet.address,landlord:value.parties.landlord!.wallet.address,arbitrator:value.parties.arbitrator!.wallet.address})).digest('hex')}`;
  assert.equal(base,expected);
  for(const [field,replacement] of Object.entries({network:'robinhood-testnet',rentMonthly:'650000004',shareBps:1999,landlordWallet:'11111111111111111111111111111111',house:'11111111111111111111111111111111'})) {
    const changed=structuredClone(value);Object.assign(changed.rentTerms!,{[field]:replacement});assert.notEqual(agreementDigest(changed),base,field);
  }
  const legacy=agreement(),rent=legacy.rentTerms!;
  assert.equal(agreementDigest(legacy),`0x${createHash('sha256').update(JSON.stringify({domain:'rental-agreement-v3',id:legacy.id,network:legacy.network,property:legacy.property,deposit:canonicalDeposit(legacy.depositForm!),rent:{buildingId:rent.buildingId,shareBps:rent.shareBps,rentMonthly:rent.rentMonthly,landlordWallet:rent.landlordWallet},requiredSecurity:legacy.requiredSecurity,releaseAllowed:legacy.releaseAllowed,tenant:legacy.parties.tenant!.wallet.address,landlord:legacy.parties.landlord!.wallet.address,arbitrator:legacy.parties.arbitrator!.wallet.address})).digest('hex')}`);
});
test('new building listings use the verified Solana landlord and configured house; unconfigured legacy path stays available',async()=>{
  const f=await solanaFixture(),store=new LocalStore(':memory:');
  try {
    const listing=await createListing(store,f.landlord,{title:'New building flat',requiredSecurity:'1300000000',rentMonthly:'650000000',releaseAllowed:true,buildingHome:true},{SOLANA_HOUSE_MANIFEST:JSON.stringify(f.manifest)});
    assert.deepEqual(listing.buildingRent,{network:'solana-devnet',shareBps:2000,landlordWallet:f.recipient.address,house:f.house.house});
    await applyToListing(store,f.tenant,listing.id,{name:'Tenant',message:''});
    const saved=await store.get<{applications:{id:string}[]}>(`listing:${listing.id}`),chosen=await chooseApplicant(store,f.landlord,listing.id,saved!.applications[0].id),value=await store.get<Agreement>(`agreement:${chosen.agreementId}`);
    assert.deepEqual(value!.rentTerms,{...listing.buildingRent,rentMonthly:'650000000'});
  } finally { await store.close(); }
});
test('Solana rent has exactly memo, sponsored landlord ATA, checked landlord transfer and source-zero house deposit',async()=>{
  const f=await solanaFixture(),tx=await solanaRentInstructions({month:'2026-10',tenant:f.owner.address,landlord:f.recipient.address,sponsor:f.payer.address,mint:f.manifest.cashMint,house:f.house.house,rewardVault:f.house.rewardVault,programId:f.manifest.programId,rentMonthly:'650000003'});
  const [memo,ata,transfer,house]=tx.instructions;
  assert.equal(tx.instructions.length,4);assert.equal(memo.programAddress,MEMO_PROGRAM_ADDRESS);
  assert.equal(new TextDecoder().decode(memo.data),'ledger-of-life rent 2026-10');assert.deepEqual(memo.accounts,[]);
  assert.equal(ata.programAddress,ASSOCIATED_TOKEN_PROGRAM_ADDRESS);assert.deepEqual(Array.from(ata.data!),[1]);
  assert.deepEqual(ata.accounts!.map(row=>row.address),[f.payer.address,tx.landlordAta,f.recipient.address,f.manifest.cashMint,'11111111111111111111111111111111',TOKEN_PROGRAM_ADDRESS]);assert.equal(ata.accounts![0].role,AccountRole.WRITABLE_SIGNER);
  assert.equal(transfer.programAddress,TOKEN_PROGRAM_ADDRESS);assert.deepEqual(transfer.accounts!.map(row=>row.address),[tx.source,f.manifest.cashMint,tx.landlordAta,f.owner.address]);
  assert.equal(transfer.data![0],12);assert.equal(new DataView(Uint8Array.from(transfer.data!).buffer).getBigUint64(1,true),520000003n);assert.equal(transfer.data![9],6);assert.equal(transfer.accounts![3].role,AccountRole.READONLY_SIGNER);
  assert.equal(house.programAddress,f.manifest.programId);assert.deepEqual(house.accounts!.map(row=>row.address),[f.owner.address,f.house.house,tx.source,f.house.rewardVault,TOKEN_PROGRAM_ADDRESS]);
  assert.deepEqual(Array.from(house.data!.slice(0,8)),HOUSE_DISCRIMINATORS.deposit_rewards);assert.equal(new DataView(Uint8Array.from(house.data!).buffer).getBigUint64(8,true),130000000n);assert.equal(house.data![16],0);
  assert.deepEqual(tx.expectedDeltas.map(row=>[row.account,row.owner,row.direction,row.minimumAtomic,row.maximumAtomic]),[[tx.source,f.owner.address,'debit','650000003','650000003'],[tx.landlordAta,f.recipient.address,'credit','520000003','520000003'],[f.house.rewardVault,f.house.house,'credit','130000000','130000000']]);
});
test('Solana rent is one user signature, sponsored, reserved across lost responses, paid once per Berlin month and readable by landlord',async()=>{
  const f=await solanaFixture(),store=new LocalStore(':memory:');let now=Date.parse('2026-10-31T21:59:59Z'),finalized=false,sends=0;
  const gateway={lifetime:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:'200',blockHeight:'100'}),simulate:async()=>({slot:'1',sponsorDebitCeilingLamports:'3000000',networkFeeLamports:'10000'}),broadcast:async(bytes:Uint8Array)=>{sends++;return getBase58Decoder().decode(getTransactionDecoder().decode(bytes).signatures[f.payer.address]!);},reconcile:async(signature:string)=>finalized?{status:'finalized' as const,signature,slot:'1',deltas:[]}:{status:'unknown' as const,reason:'signature-not-observed-do-not-resubmit-new-intent'}};
  const sponsor={address:f.payer.address,sign:async(bytes:Uint8Array)=>new Uint8Array(getTransactionEncoder().encode(await partiallySignTransaction([f.payer.keyPair],getTransactionDecoder().decode(bytes))))};
  const operations=createSolanaOperations({store,gateway,sponsor,config:{cluster:'devnet',genesisHash:f.manifest.genesisHash,maximumSponsorLamports:10_000_000n},now:()=>now});
  const options={houseManifest:f.manifest,solana:{operations,sponsor},now:()=>now,readJourney:(async()=>({stage:'living',chain:{phase:'active'}} as TenancyJourney)) as typeof tenancyJourney};
  try {
    await store.create(`agreement:${f.value.id}`,f.value);
    const [first,duplicate]=await Promise.all([prepareRent(store,f.tenant,f.value.id,options),prepareRent(store,f.tenant,f.value.id,options)]);
    const step=first!.payment!.steps[0],review=step.solanaRequest!;assert.equal(first!.payment!.steps.length,1);assert.equal(step.operationId,duplicate!.payment!.steps[0].operationId);
    const tx=getTransactionDecoder().decode(Buffer.from(review.transactionBase64,'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    assert.equal(message.staticAccounts[0],f.payer.address);assert.equal(message.header.numSignerAccounts,2);assert.equal(message.instructions.length,4);
    const signed=Buffer.from(getTransactionEncoder().encode(await partiallySignTransaction([f.owner.keyPair],tx))).toString('base64');
    await assert.rejects(submitRent(store,f.landlord,f.value.id,step.id,signed,options),/Only the tenant/);
    const opKey=`solana-operation:${step.operationId}`,op=await store.get<{kind:string;review:Record<string,unknown>}>(opKey);
    for (const changed of [{kind:'test-usdc-faucet',review:op!.review},{kind:op!.kind,review:{...op!.review,month:'2026-11'}},{kind:op!.kind,review:{...op!.review,agreementId:'another-tenancy'}},{kind:op!.kind,review:{...op!.review,tenantWallet:f.recipient.address}}]) {
      await store.update<{kind:string;review:Record<string,unknown>}>(opKey,current=>({...current,...changed}));
      await assert.rejects(submitRent(store,f.tenant,f.value.id,step.id,signed,options),/exact tenancy and rent month/);
      await assert.rejects(readRent(store,f.tenant,f.value.id,options),/exact tenancy and rent month/);
    }
    await store.update<{kind:string;review:Record<string,unknown>}>(opKey,current=>({...current,kind:op!.kind,review:op!.review}));assert.equal(sends,0);
    await submitRent(store,f.tenant,f.value.id,step.id,signed,options);
    const pending=await readRent(store,f.tenant,f.value.id,options);assert.equal(pending!.payment!.state,'pending');assert.ok(pending!.payment!.steps[0].signature);assert.equal(pending!.payment!.steps[0].solanaRequest,null);
    assert.equal((await prepareRent(store,f.tenant,f.value.id,options))!.payment!.steps[0].operationId,step.operationId);
    finalized=true;const paid=await readRent(store,f.landlord,f.value.id,options);assert.equal(paid!.payment!.state,'confirmed');assert.equal(paid!.payment!.landlordRaw,'520000003');assert.equal(paid!.payment!.buildingRaw,'130000000');
    await assert.rejects(prepareRent(store,f.tenant,f.value.id,options),/already paid/);
    now=Date.parse('2026-10-31T23:00:00Z');const next=await prepareRent(store,f.tenant,f.value.id,options);assert.equal(next!.month,'2026-11');assert.equal(next!.payment!.month,'2026-11');assert.notEqual(next!.payment!.id,first!.payment!.id);assert.ok(sends>=1);
  } finally {await store.close();}
});

test('Solana rent expiry refreshes unsigned reviews, reserves missing signatures until finalized lifetime and never replaces suspicious receipts',async()=>{
  const f=await solanaFixture(),store=new LocalStore(':memory:');let now=Date.parse('2026-10-04T12:00:00Z'),height='100',receipt:'missing'|'bad'='missing',lookupCount=0,sends=0,short=false;
  const gateway={
    lifetime:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:'200',blockHeight:height}),
    simulate:async()=>{if(short)throw new Error('Exact transaction simulation failed');return{slot:'1',sponsorDebitCeilingLamports:'3000000',networkFeeLamports:'10000'};},
    broadcast:async(bytes:Uint8Array)=>{sends++;return getBase58Decoder().decode(getTransactionDecoder().decode(bytes).signatures[f.payer.address]!);},
    reconcile:async()=>{lookupCount++;return receipt==='bad'?{status:'failed' as const,reason:'receipt-does-not-match-authorized-message'}:{status:'unknown' as const,reason:'signature-not-observed-do-not-resubmit-new-intent'};},
  };
  const sponsor={address:f.payer.address,sign:async(bytes:Uint8Array)=>new Uint8Array(getTransactionEncoder().encode(await partiallySignTransaction([f.payer.keyPair],getTransactionDecoder().decode(bytes))))};
  const operations=createSolanaOperations({store,gateway,sponsor,config:{cluster:'devnet',genesisHash:f.manifest.genesisHash,maximumSponsorLamports:10_000_000n},now:()=>now});
  const options={houseManifest:f.manifest,solana:{operations,sponsor},now:()=>now,readJourney:(async()=>({stage:'living',chain:{phase:'active'}} as TenancyJourney)) as typeof tenancyJourney};
  const signReview=async(review:NonNullable<RentPayment['steps'][number]['solanaRequest']>)=>Buffer.from(getTransactionEncoder().encode(await partiallySignTransaction([f.owner.keyPair],getTransactionDecoder().decode(Buffer.from(review.transactionBase64,'base64'))))).toString('base64');
  try {
    await store.create(`agreement:${f.value.id}`,f.value);
    short=true;const stopped=await prepareRent(store,f.tenant,f.value.id,options);assert.match(stopped!.payment!.error!,/tUSDC balance/);short=false;
    const first=await prepareRent(store,f.tenant,f.value.id,options),step=first!.payment!.steps[0],signed=await signReview(step.solanaRequest!);
    now+=120000;await assert.rejects(submitRent(store,f.tenant,f.value.id,step.id,signed,options),/rent review expired/);assert.equal(sends,0);
    const refreshed=await prepareRent(store,f.tenant,f.value.id,options),fresh=refreshed!.payment!.steps[0];assert.equal(fresh.id,step.id);assert.notEqual(fresh.operationId,step.operationId);assert.equal(fresh.attempt,1);
    const inactive={...options,readJourney:(async()=>({stage:'move-out',chain:{phase:'claim-proposed'}} as TenancyJourney)) as typeof tenancyJourney};
    await assert.rejects(submitRent(store,f.tenant,f.value.id,fresh.id,await signReview(fresh.solanaRequest!),inactive),/active tenancy/);
    await submitRent(store,f.tenant,f.value.id,fresh.id,await signReview(fresh.solanaRequest!),options);
    height='200';const boundary=await prepareRent(store,f.tenant,f.value.id,options);assert.equal(boundary!.payment!.steps[0].operationId,fresh.operationId);assert.equal(boundary!.payment!.state,'pending');
    const before=lookupCount;height='201';const expired=await readRent(store,f.tenant,f.value.id,options);assert.ok(lookupCount>=before+2);assert.equal(expired!.payment!.steps[0].retryable,true);
    height='100';const replacement=await prepareRent(store,f.tenant,f.value.id,options),newStep=replacement!.payment!.steps[0];assert.notEqual(newStep.operationId,fresh.operationId);assert.equal(newStep.attempt,2);
    receipt='bad';await submitRent(store,f.tenant,f.value.id,newStep.id,await signReview(newStep.solanaRequest!),options);
    const suspicious=await prepareRent(store,f.tenant,f.value.id,options);assert.equal(suspicious!.payment!.state,'pending');assert.equal(suspicious!.payment!.steps[0].retryable,false);assert.equal(suspicious!.payment!.steps[0].operationId,newStep.operationId);
  } finally {await store.close();}
});
