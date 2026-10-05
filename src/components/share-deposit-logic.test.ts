import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextShareDepositAction, pendingShareDepositReceipt, requireBoundShareReview, requireBoundSolanaShareReview, formatDepositShares, shareDepositReceiptUrl, shareDepositAmount, shareRefreshIsCurrent, showShareClaim, showTenantFunding, shareFeeBalance, shareReceiptPollDelay } from './share-deposit-logic.ts';
import type { ShareDepositPlan, SolanaShareDepositPlan, ShareDepositView } from '../domain/share-deposit.ts';

test('next action respects server role permissions and timeout priority', () => {
  const view = {deployment:'deployed' as const,state:'AwaitingLock' as const,role:'tenant' as const,needsTopUp:false,actions:['create' as const]};
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

test('a delayed refresh cannot replace a prepared review or preparation error', async () => {
  for (const outcome of ['review', 'error']) {
    let revision = 1;
    const started = revision;
    let finish!: () => void;
    const response = new Promise<void>(resolve => { finish = resolve; });
    let displayed = 'loading';
    const refresh = response.then(() => {
      if (shareRefreshIsCurrent(started, revision)) displayed = 'refreshed';
    });
    revision++;
    displayed = outcome;
    finish();
    await refresh;
    assert.equal(displayed, outcome);
  }
});

test('next actions follow each tenancy state and party without prescribing active approval', () => {
  const base = { deployment: 'deployed' as const, needsTopUp: false };
  const cases: { state: ShareDepositView['state']; role: ShareDepositView['role']; actions: ShareDepositView['actions']; expected: string | null }[] = [
    { state: 'AwaitingLock', role: 'tenant', actions: ['approve', 'pledge'], expected: 'approve' },
    { state: 'AwaitingLock', role: 'landlord', actions: ['create', 'activate'], expected: 'create' },
    { state: 'AwaitingLock', role: 'arbitrator', actions: [], expected: null },
    { state: 'Active', role: 'tenant', actions: ['approve', 'pledge', 'withdraw', 'requestReturn'], expected: null },
    { state: 'Active', role: 'landlord', actions: ['proposeClaim'], expected: 'proposeClaim' },
    { state: 'Active', role: 'arbitrator', actions: [], expected: null },
    { state: 'ClaimPending', role: 'tenant', actions: ['acceptClaim', 'contestClaim'], expected: 'acceptClaim' },
    { state: 'ClaimPending', role: 'landlord', actions: ['lowerClaim'], expected: 'lowerClaim' },
    { state: 'ClaimPending', role: 'arbitrator', actions: [], expected: null },
    { state: 'ClaimContested', role: 'tenant', actions: ['escalateClaim'], expected: 'escalateClaim' },
    { state: 'ClaimContested', role: 'landlord', actions: ['lowerClaim', 'escalateClaim'], expected: 'escalateClaim' },
    { state: 'ClaimContested', role: 'arbitrator', actions: ['resolveClaim'], expected: 'resolveClaim' },
    { state: 'Closed', role: 'tenant', actions: ['payout'], expected: 'payout' },
    { state: 'Closed', role: 'landlord', actions: ['payout'], expected: 'payout' },
    { state: 'Closed', role: 'arbitrator', actions: ['payout'], expected: 'payout' },
  ];
  for (const { expected, ...view } of cases) assert.equal(nextShareDepositAction({ ...base, ...view }), expected, `${view.state}/${view.role}`);
  assert.equal(nextShareDepositAction({ ...base, state: 'Active', role: 'tenant', needsTopUp: true, actions: ['approve', 'pledge'] }), 'approve');
});

test('claim visibility requires a dispute or a closed award, never an empty initial claim', () => {
  const claim = { usd6: '0', shares: '0', evidenceHash: '0x00', price6: '0', sourceTime: 0 };
  for (const state of ['AwaitingLock', 'Active', 'Closed'] as const) assert.equal(showShareClaim({ state, claim, landlordOwed: '0' }), false);
  for (const state of ['ClaimPending', 'ClaimContested'] as const) assert.equal(showShareClaim({ state, claim, landlordOwed: '0' }), true);
  assert.equal(showShareClaim({ state: 'Closed', claim, landlordOwed: '1' }), true);
  assert.equal(showShareClaim({ state: 'ClaimPending', claim: null, landlordOwed: '0' }), false);
});

test('tenant funding advice is not shown to either reviewing party', () => {
  assert.equal(showTenantFunding({ role: 'tenant' }), true);
  assert.equal(showTenantFunding({ role: 'landlord' }), false);
  assert.equal(showTenantFunding({ role: 'arbitrator' }), false);
});

test('fee balance remains usable when token valuation is unavailable', () => {
  const staleValuation = { robinhood: { ok: false, code: 'price_unavailable', value: { ethBalance: '0.00005' } } };
  assert.equal(shareFeeBalance(staleValuation), '0.00005');
  assert.equal(shareFeeBalance({ robinhood: null }), undefined);
});

test('pending receipt retries use five seconds normally and capped error backoff', () => {
  assert.equal(shareReceiptPollDelay(0), 5000);
  assert.equal(shareReceiptPollDelay(1), 10000);
  assert.equal(shareReceiptPollDelay(2), 20000);
  assert.equal(shareReceiptPollDelay(10), 60000);
});

test('Solana share amounts retain all six decimals without floating point loss', () => {
  assert.equal(formatDepositShares('1000001', 6), '1.000001');
  assert.equal(formatDepositShares('0', 6), '0');
  assert.equal(formatDepositShares('18446744073709551615', 6), '18,446,744,073,709.551615');
  assert.equal(shareDepositReceiptUrl('signature', 'solana-devnet'), 'https://explorer.solana.com/tx/signature?cluster=devnet');
  assert.equal(shareDepositReceiptUrl('0x123'), 'https://explorer.testnet.chain.robinhood.com/tx/0x123');
});

test('every Solana review binds accepted terms, program, mint, parties and signer case-sensitively', () => {
  const parties = { tenant: 'TenantAddress', landlord: 'LandlordAddress', arbitrator: 'ArbitratorAddress' };
  const actor = { id: 'tenant-wallet', address: parties.tenant };
  const view = {
    rentalId: 'rental', network: 'solana-devnet', role: 'tenant', escrow: 'EscrowAddress', agreementHash: '0xdigest',
    actions: ['pledge'], form: { network: 'solana-devnet', programId: 'ProgramAddress', mint: 'MintAddress',
      securityUsd6: '1000000', responseWindow: 604800, returnWindow: 604800, arbitrationWindow: 2592000 },
  } as ShareDepositView;
  const plan = {
    rentalId: 'rental', network: 'solana-devnet', action: 'pledge', walletId: actor.id,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    review: { programId: 'ProgramAddress', mint: 'MintAddress', escrow: view.escrow, agreementHash: view.agreementHash,
      securityUsd6: '1000000', responseWindow: 604800, returnWindow: 604800, arbitrationWindow: 2592000,
      actor: actor.address, ...parties },
  } as SolanaShareDepositPlan;
  requireBoundSolanaShareReview(plan, view, parties, actor);
  for (const change of [
    { programId: 'programaddress' }, { mint: 'mintaddress' }, { escrow: 'OtherEscrow' },
    { agreementHash: '0xother' }, { securityUsd6: '2000000' }, { responseWindow: 1 },
    { returnWindow: 1 }, { arbitrationWindow: 1 }, { actor: parties.landlord }, { tenant: 'OtherTenant' },
    { landlord: 'OtherLandlord' }, { arbitrator: 'OtherArbitrator' },
  ]) assert.throws(() => requireBoundSolanaShareReview({ ...plan, review: { ...plan.review, ...change } }, view, parties, actor));
  assert.throws(() => requireBoundSolanaShareReview({ ...plan, rentalId: 'another' }, view, parties, actor));
  assert.throws(() => requireBoundSolanaShareReview({ ...plan, walletId: 'another' }, view, parties, actor));
  assert.throws(() => requireBoundSolanaShareReview(plan, { ...view, actions: [] }, parties, actor));
  assert.throws(() => requireBoundSolanaShareReview({ ...plan, expiresAt: 'invalid' }, view, parties, actor), /expired/);
  assert.throws(() => requireBoundSolanaShareReview({ ...plan, expiresAt: '2020-01-01T00:00:00Z' }, view, parties, actor), /expired/);
});
