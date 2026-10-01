import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositHoldings } from './deposit-holdings.ts';
import type { TenancyJourney } from '../server/journey.ts';
import type { ShareDepositView } from '../domain/share-deposit.ts';
const share = {lockedShares:'2000000000000000000',landlordOwed:'0',quote:{priceUsd6:'250000000',fresh:true}} as ShareDepositView;
const shares = {role:'tenant' as const,chain:null,shareDeposit:share};
const cash = {role:'tenant' as const,chain:{phase:'active',escrowAtomic:'3000000',lendingValueAtomic:'0',approvedClaimAtomic:'0'} as NonNullable<TenancyJourney['chain']>};

test('a share-only tenant has no Solana cash deposit amount or cash-yield home count', () => {
  const result=depositHoldings([shares]);
  assert.equal(result.locked,500);
  assert.equal(result.cashLocked,0);
  assert.equal(result.cashTenantCount,0);
  assert.deepEqual(result.cashEntitled,[]);
});
test('mixed deposits count TSLA in locked net worth once, never in the cash tile', () => {
  const result=depositHoldings([shares,cash]);
  assert.equal(result.locked,503);
  assert.equal(result.cashLocked,3);
  assert.equal(result.cashTenantCount,1);
  assert.equal(result.cashEntitled[0].t,cash);
});
test('share payouts preserve landlord priority up to actual custody and exclude stale prices', () => {
  const burned={...share,landlordOwed:'3000000000000000000'};
  assert.equal(depositHoldings([{...shares,shareDeposit:burned}]).locked,0);
  assert.equal(depositHoldings([{...shares,role:'landlord',shareDeposit:burned}]).locked,500);
  assert.equal(depositHoldings([{...shares,role:'arbitrator'}]).locked,0);
  assert.equal(depositHoldings([{...shares,shareDeposit:{...share,quote:null}}]).locked,0);
});
