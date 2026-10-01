import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextShareDepositAction, pendingShareDepositReceipt, requireBoundShareReview, shareDepositAmount } from './share-deposit-logic.ts';
import type { ShareDepositPlan, ShareDepositView } from '../domain/share-deposit.ts';

test('next action respects server role permissions and timeout priority', () => {
  const view = {deployment:'deployed' as const,state:'AwaitingLock' as const,needsTopUp:false,actions:['create' as const]};
  assert.equal(nextShareDepositAction(view),'create');
  assert.equal(nextShareDepositAction({...view,actions:['approve','pledge','withdraw']}),'approve');
  assert.equal(nextShareDepositAction({...view,state:'ClaimPending',actions:['acceptClaim','contestClaim']}),'acceptClaim');
  assert.equal(nextShareDepositAction({...view,state:'ClaimContested',actions:['resolveClaim']}),'resolveClaim');
  assert.equal(nextShareDepositAction({...view,state:'ClaimContested',actions:['resolveClaim','closeUnresolved']}),'closeUnresolved');
  assert.equal(nextShareDepositAction({...view,deployment:'not_deployed'}),null);
  assert.equal(nextShareDepositAction({...view,actions:[]}),null);
});
test('review binding rejects another rental, factory, token or escrow', () => {
  const view={rentalId:'rental-a',escrow:'0x111',form:{factory:'0x222',stock:'0x333'}} as ShareDepositView;
  const plan={rentalId:'rental-a',action:'pledge',review:{factory:'0x222',stock:'0x333',escrow:'0x111'}} as ShareDepositPlan;
  requireBoundShareReview(plan,view);
  for(const changed of [{...plan,rentalId:'rental-b'},{...plan,review:{...plan.review,escrow:'0x444'}},{...plan,review:{...plan.review,stock:'0x444'}},{...plan,review:{...plan.review,factory:'0x444'}}]) assert.throws(()=>requireBoundShareReview(changed,view),/accepted deposit/);
});
test('reviewed deposit amounts never round excess precision or accept signed amounts', () => {
  assert.equal(shareDepositAmount('1.000000000000000001',18),'1000000000000000001');
  assert.equal(shareDepositAmount('0',6),'0');
  assert.throws(()=>shareDepositAmount('1.0000001',6),/no rounding/);
  assert.throws(()=>shareDepositAmount('0.0000000000000000001',18),/no rounding/);
  assert.throws(()=>shareDepositAmount('-1',18),/nonnegative/);
  assert.throws(()=>shareDepositAmount('1e2',6),/nonnegative/);
});
test('creation review rejects a different agreement digest or fixed deadline window', () => {
  const view = {rentalId:'rental-a',agreementHash:'0xabc',form:{factory:'0x222',stock:'0x333',securityUsd6:'1000000',responseWindow:604800,returnWindow:604800,arbitrationWindow:2592000}} as ShareDepositView;
  const terms = {agreementHash:'0xabc',depositValue:'1000000',responseWindow:'604800',returnWindow:'604800',arbitrationWindow:'2592000'};
  const plan = {rentalId:'rental-a',action:'create',review:{factory:'0x222',stock:'0x333',escrow:'0x111',args:[terms]}} as ShareDepositPlan;
  requireBoundShareReview(plan,view);
  assert.throws(()=>requireBoundShareReview({...plan,review:{...plan.review,args:[{...terms,agreementHash:'0xdef'}]}},view),/accepted security/);
  assert.throws(()=>requireBoundShareReview({...plan,review:{...plan.review,args:[{...terms,arbitrationWindow:'604800'}]}},view),/windows/);
});
test('failed and foreign pending receipts never block the current wallet after reload', () => {
  const failed={planId:'failed-plan',walletId:'mine',transactionHash:'0x1',action:'withdraw' as const,status:'failed' as const};
  const foreign={planId:'other-plan',walletId:'other',transactionHash:'0x2',action:'payout' as const,status:'pending' as const};
  assert.equal(pendingShareDepositReceipt([failed,foreign],['mine']),null);
  const active={planId:'active-plan',walletId:'mine',transactionHash:'0x3',action:'pledge' as const,status:'pending' as const};
  assert.equal(pendingShareDepositReceipt([failed,foreign,active],['mine'])?.planId,'active-plan');
  assert.equal(pendingShareDepositReceipt([{...active,status:'failed'}],['mine']),null);
  assert.equal(pendingShareDepositReceipt([{...active,status:'confirmed'}],['mine']),null);
});
