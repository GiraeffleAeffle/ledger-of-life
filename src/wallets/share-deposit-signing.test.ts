import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, type Address, type Hex } from 'viem';
import manifest from '../../contracts/evm/deployments/share-deposit-46630.json' with { type: 'json' };
import { DEPOSIT_STOCK, SHARE_DEPOSIT_ABI, SHARE_FACTORY_ABI, SHARE_APPROVE_ABI, validateShareDepositTransaction, type ShareDepositSigningReview } from './share-deposit-signing.ts';
import { validateEvmSigningRequest } from './signing-policy.ts';
const tenant = '0x1111111111111111111111111111111111111111' as const;
const landlord = '0x2222222222222222222222222222222222222222' as const;
const arbitrator = '0x3333333333333333333333333333333333333333' as const;
const foreign = '0x4444444444444444444444444444444444444444' as const;
const factory = String(manifest.factory);
const terms = {tenant,landlord,arbitrator,depositValue:1000000n,agreementHash:`0x${'ab'.repeat(32)}` as Hex,responseWindow:604800n,returnWindow:604800n,arbitrationWindow:2592000n};
const jsonTerms = {...terms,depositValue:'1000000',responseWindow:'604800',returnWindow:'604800',arbitrationWindow:'2592000'};
const escrow = getContractAddress({opcode:'CREATE2',from:factory as Address,salt:keccak256(encodeAbiParameters(SHARE_FACTORY_ABI[0].inputs,[terms])),bytecodeHash:keccak256(`0x3d602d80600a3d3981f3363d3d373d3d3d363d73${String(manifest.implementation).slice(2)}5af43d82803e903d91602b57fd5bf3`)});
const review: ShareDepositSigningReview = {factory,escrow,stock:DEPOSIT_STOCK,functionName:'pledge',args:['1000000000000000000'],terms:jsonTerms,role:'tenant',approvalShares:null,priceUsd6:'1000000'};
const transaction = {chainId:46630,to:escrow,value:'0x0',data:encodeFunctionData({abi:SHARE_DEPOSIT_ABI,functionName:'pledge',args:[10n**18n]})};

test('reviewed pledge binds CREATE2 escrow, terms, party, amount, network and native value', () => {
  validateShareDepositTransaction(transaction,review,tenant);
  assert.throws(()=>validateShareDepositTransaction({...transaction,to:foreign},review,tenant),/bound/);
  assert.throws(()=>validateShareDepositTransaction({...transaction,to:foreign},{...review,escrow:foreign},tenant),/CREATE2/);
  assert.throws(()=>validateShareDepositTransaction(transaction,{...review,terms:{...jsonTerms,returnWindow:'605000'}},tenant),/CREATE2/);
  assert.throws(()=>validateShareDepositTransaction(transaction,review,landlord),/matching deposit party/);
  assert.throws(()=>validateShareDepositTransaction(transaction,{...review,role:'landlord'},landlord),/matching deposit party/);
  assert.throws(()=>validateShareDepositTransaction({...transaction,chainId:4663},review,tenant),/46630/);
  assert.throws(()=>validateShareDepositTransaction({...transaction,value:'1'},review,tenant),/zero/);
  assert.throws(()=>validateShareDepositTransaction({...transaction,data:encodeFunctionData({abi:SHARE_DEPOSIT_ABI,functionName:'pledge',args:[2n*10n**18n]})},review,tenant),/exact reviewed/);
  assert.throws(()=>validateShareDepositTransaction(transaction,{...review,factory:foreign},tenant),/pinned/);
  assert.throws(()=>validateShareDepositTransaction(transaction,{...review,functionName:'initialize'},tenant),/not allowed/);
});
test('approval rejects foreign spenders, near-max allowances and amounts above the reviewed USD cap', () => {
  const approval = {...review,functionName:'approve',args:[escrow,'7'],approvalShares:'7'};
  const tx = {...transaction,to:DEPOSIT_STOCK,data:encodeFunctionData({abi:SHARE_APPROVE_ABI,functionName:'approve',args:[escrow,7n]})};
  validateShareDepositTransaction(tx,approval,tenant);
  assert.throws(()=>validateShareDepositTransaction(tx,{...approval,args:[foreign,'7']},tenant),/exact finite/);
  for(const excessive of [(1n<<256n)-1n,(1n<<256n)-2n,15000n*10n**18n+1n]) {
    const amount=excessive.toString();
    assert.throws(()=>validateShareDepositTransaction({...tx,data:encodeFunctionData({abi:SHARE_APPROVE_ABI,functionName:'approve',args:[escrow,excessive]})},{...approval,args:[escrow,amount],approvalShares:amount},tenant),/exact finite/);
  }
  assert.throws(()=>validateShareDepositTransaction(tx,{...approval,approvalShares:'8'},tenant),/exact finite/);
  assert.throws(()=>validateShareDepositTransaction(tx,approval,arbitrator),/matching deposit party/);
});
test('factory creation requires the landlord and exactly the CREATE2 terms', () => {
  const creation:ShareDepositSigningReview={...review,functionName:'create',args:[jsonTerms],role:'landlord'};
  const tx={...transaction,to:factory,data:encodeFunctionData({abi:SHARE_FACTORY_ABI,functionName:'create',args:[terms]})};
  validateShareDepositTransaction(tx,creation,landlord);
  assert.throws(()=>validateShareDepositTransaction(tx,creation,tenant),/matching deposit party/);
  assert.throws(()=>validateShareDepositTransaction({...tx,to:foreign},creation,landlord),/bound/);
  assert.throws(()=>validateShareDepositTransaction(tx,{...creation,args:[{...jsonTerms,arbitrationWindow:'604800'}]},landlord),/accepted terms/);
});
test('permissionless exits still require one of the three bound signing accounts', () => {
  const exit={...review,functionName:'closeUnresolved',args:[],role:'arbitrator' as const};
  const tx={...transaction,data:encodeFunctionData({abi:SHARE_DEPOSIT_ABI,functionName:'closeUnresolved'})};
  validateShareDepositTransaction(tx,exit,arbitrator);
  assert.throws(()=>validateShareDepositTransaction(tx,exit,foreign),/matching deposit party/);
});
test('wallet signing cannot use the share namespace without an independently bound review', () => {
  const wallet={id:'verified',address:tenant,chainType:'ethereum' as const,connected:true};
  const request={walletId:wallet.id,operationId:'share-deposit:plan:0',description:'Pledge reviewed test TSLA',expiresAt:new Date(Date.now()+60000).toISOString(),transaction:{...transaction,chainId:46630 as const}};
  assert.throws(()=>validateEvmSigningRequest(request,wallet),/bound share deposit/);
  validateEvmSigningRequest({...request,shareDeposit:review},wallet);
  assert.throws(()=>validateEvmSigningRequest({...request,operationId:'market-1',shareDeposit:review},wallet),/require a share deposit operation/);
});
