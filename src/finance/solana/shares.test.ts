import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AccountRole, address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import * as s from './shares.ts';
import { SOLANA_IDS, SOLANA_TEST_USDC_MINT } from './manifest.ts';
const owner = s.SHARES_PRICE_AUTHORITY, payer = 'HEZ9ERxb1W9WfBjUGE6A4jFZU3jUMJRSM1kyERgac38G';
const hash = Uint8Array.from({ length: 32 }, (_, i) => i);
const lending = { payer, owner, cashAccount: SOLANA_TEST_USDC_MINT, shareAccount: s.SHARES_PROGRAM_ID };
const escrow = { authority: owner, landlord: payer, agreementHash: hash, shareAccount: s.SHARES_PROGRAM_ID };
function discriminator(prefix: string, name: string) { return new Uint8Array(createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8)); }
function le(n: bigint, length = 8) { let value = BigInt.asUintN(length * 8, n); const out = new Uint8Array(length); for (let i = 0; i < length; i++) { out[i] = Number(value & 255n); value >>= 8n; } return out; }
function account(name: string, length: number) { const out = new Uint8Array(length); out.set(discriminator('account', name)); return out; }

test('program PDAs match the exact seed namespaces', async () => {
  const a = await s.sharesAddresses(), encode = getAddressEncoder();
  const derive = async (seed: string, ...keys: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: address(s.SHARES_PROGRAM_ID), seeds: [new TextEncoder().encode(seed), ...keys] }))[0];
  assert.equal(a.shareMint, await derive('share_mint'));
  assert.equal(a.price, await derive('price', new Uint8Array(encode.encode(a.shareMint))));
  assert.equal(a.pool, await derive('pool', new Uint8Array(encode.encode(a.shareMint))));
  assert.equal(a.cashVault, await derive('pool_cash', new Uint8Array(encode.encode(a.pool))));
  assert.equal(a.collateralVault, await derive('pool_collateral', new Uint8Array(encode.encode(a.pool))));
  assert.equal(a.faucetBudget, await derive('faucet_budget', new Uint8Array(encode.encode(a.shareMint))));
  const e = await s.shareEscrowAddresses(payer, hash);
  assert.equal(e.escrow, await derive('escrow', new Uint8Array(encode.encode(address(payer))), hash));
  assert.notEqual(e.escrow, (await s.shareEscrowAddresses(owner, hash)).escrow);
  await assert.rejects(s.shareEscrowAddresses(owner, new Uint8Array(31)));
});

test('initialization, faucet and price binary encodings and metas', async () => {
  const a = await s.sharesAddresses();
  const init = await s.initializeSharesInstruction({ payer, priceUsdE6: 300_000_000n, publishedAt: -1n });
  assert.deepEqual(init.data, Uint8Array.from([...discriminator('global', 'initialize_shares'), ...le(300_000_000n), ...le(-1n)]));
  assert.deepEqual(init.accounts?.map(m => m.role), [3,1,1,1,0,0,0]);
  assert.equal(init.accounts?.[1].address, a.shareMint);
  const faucet = await s.faucetInstruction({ payer, owner, issuer: owner, destination: lending.shareAccount });
  assert.deepEqual(faucet.data, discriminator('global', 'faucet'));
  assert.deepEqual(faucet.accounts?.map(m => m.role), [3,2,2,1,1,1,1,0,0]);
  assert.equal(faucet.accounts?.[2].address, s.SHARES_PRICE_AUTHORITY);
  assert.equal(faucet.accounts?.[4].address, await s.faucetCooldownAddress(a.shareMint, owner));
  assert.equal(faucet.accounts?.[6].address, a.faucetBudget);
  await assert.rejects(s.faucetInstruction({ payer, owner, issuer: payer, destination: lending.shareAccount }), /issuer/);
  await assert.rejects(s.initializeSharesInstruction({ payer: owner, priceUsdE6: 1n, publishedAt: 1n }), /initializer/);
  await assert.rejects(s.initializePoolInstruction({ payer: owner }), /initializer/);
  const price = await s.setPriceInstruction({ authority: owner, priceUsdE6: 42n, publishedAt: 7n });
  assert.deepEqual(price.data, Uint8Array.from([...discriminator('global', 'set_price'), ...le(42n), ...le(7n)]));
  assert.deepEqual(price.accounts?.map(m => m.role), [2,1,0]);
  await assert.rejects(s.setPriceInstruction({ authority: payer, priceUsdE6: 42n, publishedAt: 7n }));
  const pool = await s.initializePoolInstruction({ payer });
  assert.deepEqual(pool.data, discriminator('global', 'initialize_pool'));
  assert.deepEqual(pool.accounts?.map(m => m.role), [3,0,0,1,1,1,0,0,0]);
  assert.equal(pool.accounts?.[2].address, SOLANA_TEST_USDC_MINT);
  const accrue = await s.accrueInstruction();
  assert.deepEqual(accrue.data, discriminator('global', 'accrue'));
  assert.deepEqual(accrue.accounts, [{ address: a.pool, role: AccountRole.WRITABLE }]);
});

test('every lending instruction uses correct widths, account order and signer separation', async () => {
  const actions: s.LendingAction[] = [
    ...(['lend','withdraw_lending','deposit_collateral','withdraw_collateral','borrow'] as const).map(kind => ({ kind, amount: 23n })),
    { kind: 'redeem_lending', shares: (1n << 100n) + 9n }, { kind: 'repay', maxAmount: 23n }, { kind: 'liquidate', maxRepay: 23n }, { kind: 'realize_bad_debt' },
  ];
  const a = await s.sharesAddresses();
  for (const action of actions) {
    const i = await s.buildLendingInstruction({ ...lending, action });
    const args = action.kind === 'realize_bad_debt' ? [] : action.kind === 'redeem_lending' ? [...le(action.shares as bigint, 16)] : [...le(23n)];
    assert.deepEqual(i.data, Uint8Array.from([...discriminator('global', action.kind), ...args]));
    assert.equal(i.programAddress, s.SHARES_PROGRAM_ID);
    assert.deepEqual(i.accounts?.map(m => m.role), [3,2,1,1,0,1,1,1,1,0,0,0]);
    assert.deepEqual(i.accounts?.map(m => m.address), [payer, owner, a.pool, await s.loanPositionAddress(a.pool, owner), owner, lending.cashAccount, lending.shareAccount, a.cashVault, a.collateralVault, a.price, SOLANA_IDS.token, SOLANA_IDS.system]);
  }
  const liquidation = await s.liquidateInstruction({ ...lending, borrower: payer, maxRepay: 3n });
  assert.equal(liquidation.accounts?.[3].address, await s.loanPositionAddress(a.pool, payer));
  assert.equal(liquidation.accounts?.[4].address, payer);
  await assert.rejects(s.borrowInstruction({ ...lending, borrower: payer, amount: 1n }));
  for (const amount of [-1n, 1n << 64n, '1.1', '01']) await assert.rejects(s.lendInstruction({ ...lending, amount }));
  await assert.rejects(s.redeemLendingInstruction({ ...lending, shares: 1n << 128n }));
});

test('every escrow action has exact Borsh args and account constraints', async () => {
  const init = await s.initializeShareEscrowInstruction({ payer, landlord: payer, tenant: owner, arbitrator: s.SHARES_PROGRAM_ID, agreementHash: hash, depositValue: 9n, responseWindow: 10n, returnWindow: 11n, arbitrationWindow: 12n });
  const encode = getAddressEncoder();
  assert.deepEqual(init.data, Uint8Array.from([...discriminator('global','initialize_escrow'), ...hash, ...encode.encode(address(owner)), ...encode.encode(address(s.SHARES_PROGRAM_ID)), ...le(9n), ...le(10n), ...le(11n), ...le(12n)]));
  assert.deepEqual(init.accounts?.map(m => m.role), [3,2,0,1,1,0,0,0]);
  const actions: s.ShareEscrowAction[] = [
    { kind:'pledge', amount:23n }, { kind:'withdraw', amount:23n }, { kind:'propose_claim', usd6:23n, evidenceHash:hash }, { kind:'accept_claim', maxShares:23n }, { kind:'lower_claim', usd6:23n }, { kind:'resolve_claim', shares:23n }, { kind:'payout', toLandlord:true },
    ...(['activate','contest_claim','escalate_claim','request_return','close_unclaimed','close_unresolved'] as const).map(kind => ({ kind })),
  ];
  const a = await s.sharesAddresses(), e = await s.shareEscrowAddresses(payer, hash);
  for (const action of actions) {
    const i = await s.buildShareEscrowInstruction({ ...escrow, action });
    const args = action.kind === 'payout' ? [1] : action.kind === 'propose_claim' ? [...le(23n), ...hash] : 'amount' in action || 'usd6' in action || 'shares' in action || 'maxShares' in action ? [...le(23n)] : [];
    assert.deepEqual(i.data, Uint8Array.from([...discriminator('global',action.kind), ...args]));
    assert.deepEqual(i.accounts?.map(m => m.role), [2,1,0,1,1,0,0]);
    assert.deepEqual(i.accounts?.map(m => m.address), [owner,e.escrow,a.shareMint,e.vault,escrow.shareAccount,a.price,SOLANA_IDS.token]);
  }
  const payout = await s.payoutInstruction({ ...escrow, toLandlord:false });
  assert.equal(payout.data?.[8], 0);
  await assert.rejects(s.proposeClaimInstruction({ ...escrow, usd6:1n, evidenceHash:new Uint8Array(33) }));
});

test('all decoders reject malformed length/discriminator and preserve signed/u128 fields', () => {
  const decoders = [['Price',113,s.decodePrice],['Pool',161,s.decodePool],['LoanPosition',129,s.decodeLoanPosition],['FaucetCooldown',49,s.decodeFaucetCooldown],['FaucetBudget',73,s.decodeFaucetBudget],['Escrow',308,s.decodeShareEscrow]] as const;
  for (const [name,size,decode] of decoders) {
    const b = account(name,size);
    assert.doesNotThrow(() => decode(b));
    assert.throws(() => decode(b.subarray(0,size-1)));
    assert.throws(() => decode(new Uint8Array(size+1)));
    b[0] ^= 1; assert.throws(() => decode(b));
  }
  const loan = account('LoanPosition',129); loan.set(le((1n << 100n)+7n,16),72); loan.set(le(-19n,16),88);
  assert.equal(s.decodeLoanPosition(loan).balance,(1n << 100n)+7n);
  assert.equal(s.decodeLoanPosition(loan).netContributed,-19n);
  const price = account('Price',113); price.set(le(-2n),80); assert.equal(s.decodePrice(price).publishedAt,-2n);
  const e = account('Escrow',308); e[224]=2; assert.throws(() => s.decodeShareEscrow(e)); e[224]=1; e[225]=5; assert.throws(() => s.decodeShareEscrow(e));
  e[225]=4; assert.equal(s.decodeShareEscrow(e).state,'closed');
});

const pool: s.SharesPool = { shareMint:s.SHARES_PROGRAM_ID,cashMint:SOLANA_TEST_USDC_MINT,cash:1_000_000n,totalSupply:0n,totalBorrowAssets:0n,totalBorrowShares:0n,totalCollateral:0n,lastAccrual:0n,interestRemainder:0n,debtExposureCap:s.DEBT_EXPOSURE_CAP,bump:1 };
const position: s.LoanPosition = { pool:s.SHARES_PROGRAM_ID,owner,balance:0n,netContributed:0n,collateral:5_000_000n,borrowShares:0n,bump:1 };
const price: s.SharesPrice = { authority:owner,shareMint:s.SHARES_PROGRAM_ID,priceUsdE6:300_000_000n,publishedAt:1n,copiedAt:1n,initialPriceUsdE6:300_000_000n,initialPublishedAt:1n,bump:1 };
test('six-decimal share cover, price windows and five-share daily faucet', () => {
  assert.equal(s.shareValue(5_000_000n,300_000_000n),1_500_000_000n);
  assert.equal(s.claimShares(100_000_000n,300_000_000n),333_334n);
  assert.equal(s.quoteClaimShares(100_000_000n,300_000_000n,300_000n),300_000n);
  assert.equal(s.lowerClaimShares(100_000_000n,300_000_000n,333_334n),333_333n);
  assert.equal(s.requiredCoverShares(100_000_001n,300_000_000n),500_001n);
  assert.equal(s.priceMaxAge(2n*86_400n),74n*3600n); // Saturday
  assert.equal(s.priceMaxAge(4n*86_400n+43_199n),74n*3600n);
  assert.equal(s.priceMaxAge(4n*86_400n+43_200n),26n*3600n);
  assert.equal(s.isPriceFresh(price,26n*3600n+1n),true);
  assert.equal(s.isPriceFresh(price,26n*3600n+2n),false);
  assert.equal(s.isPriceFresh({ ...price,publishedAt:2n },1n),false);
  assert.equal(s.FAUCET_AMOUNT,5_000_000n);
  assert.equal(s.faucetAvailableAt({ owner,lastClaim:7n,bump:1 }),86_407n);
  assert.equal(s.faucetAvailableAt(null),0n);
  assert.throws(() => s.requiredCoverShares(1n,0n));
});
test('pool shares, debt roundings and compounding match EVM integer math', () => {
  const empty = { ...pool,cash:0n };
  assert.equal(s.previewDeposit(empty,1_000_000n,0n),10n**18n);
  assert.equal(s.previewWithdraw({ ...pool,totalSupply:2n },1n,0n),(10n**12n+2n+1_000_000n)/1_000_001n);
  assert.equal(s.previewRedeem(empty,10n**18n,0n),1_000_000n);
  const debtPool = { ...pool,totalBorrowAssets:3n,totalBorrowShares:2n };
  assert.equal(s.borrowerDebt(debtPool,1n,0n),2n);
  assert.deepEqual(s.previewRepay(debtPool,1n,2n,0n),{ shares:1n,assets:2n,removed:1n });
  assert.equal(s.previewBorrow(empty,2n,0n),2n*10n**12n);
  assert.equal(s.compoundedGrowth(0n),0n);
  const year = s.pendingDebt({ ...pool,totalBorrowAssets:1_000_000n },365n*86_400n);
  assert.equal(year.assets,1_051_271n);
  assert.equal(s.pendingDebt({ ...pool,totalBorrowAssets:0n,interestRemainder:9n },0n).remainder,0n);
  assert.throws(() => s.pendingDebt(pool,-1n));
  assert.equal(s.quoteBorrowPosition(pool,position,price,1n).borrowable,900_000n);
  assert.equal(s.maxWithdraw(pool,{ ...position,balance:10n**18n },0n),1_000_000n);
  assert.throws(() => s.previewLiquidation(pool,position,1n,price,1n));
});

test('liquidation honors close factor, bonus, dust exhaustion and stale price', () => {
  const p = { ...pool, totalBorrowAssets: 900_000_000n, totalBorrowShares: 900_000_000n * s.SHARE_VIRTUAL_OFFSET };
  const borrower = { ...position, collateral: 3_000_000n, borrowShares: p.totalBorrowShares };
  const q = s.previewLiquidation(p, borrower, 900_000_000n, price, 1n);
  assert.equal(q.assets, 450_000_000n);
  assert.equal(q.seized, 1_650_000n);
  assert.equal(q.realizesBadDebt, false);
  const dust = s.previewLiquidation(p, { ...borrower, collateral: 1n }, 900_000_000n, { ...price, priceUsdE6: 1n }, 1n);
  assert.equal(dust.assets, 0n);
  assert.equal(dust.seized, 1n);
  assert.equal(dust.realizesBadDebt, true);
  assert.throws(() => s.previewLiquidation(p, borrower, 1n, { ...price, publishedAt: 0n }, 1n));
  assert.equal(s.quoteLendingMarket(p, price, 1n).borrowAprBps, 500n);
  assert.equal(s.quoteLendingMarket(p, price, 1n).effectiveBorrowApyBps, 513n);
  const e = s.decodeShareEscrow(account('Escrow', 308));
  assert.equal(s.quoteShareCover({ ...e, depositValue: 100_000_000n, trackedBalance: 400_000n }, price, 1n).belowTopUpThreshold, true);
  assert.equal(s.quoteShareCover({ ...e, depositValue: 100_000_000n, trackedBalance: 500_000n }, price, 1n).topUpShares, 0n);
});

test('lenders may credit another receiver without authorizing that receiver to spend the source', async () => {
  const a = await s.sharesAddresses();
  const i = await s.lendInstruction({ ...lending, receiver: payer, amount: 1n });
  assert.equal(i.accounts?.[3].address, await s.loanPositionAddress(a.pool, payer));
  assert.equal(i.accounts?.[4].address, payer);
  assert.equal(i.accounts?.[1].address, owner);
  await assert.rejects(s.borrowInstruction({ ...lending, receiver: payer, amount: 1n }), /receiver/);
  await assert.rejects(s.lendInstruction({ ...lending, receiver: payer, borrower: owner, amount: 1n }), /one position/);
});

test('global issuance and interest-inclusive exposure caps match manifest initialization', () => {
  const budget: s.FaucetBudget = { shareMint: pool.shareMint, day: 0n, mintedToday: 50_000_000n, totalMinted: 50_000_000n, dailyLimit: s.DAILY_FAUCET_BUDGET, bump: 1 };
  const manifest: s.SharesInitialization = { shareMint: pool.shareMint, cashMint: pool.cashMint, priceAuthority: owner, initialPriceUsdE6: '300000000', initialPricePublishedAt: '1', dailyFaucetBudgetAtomic: '50000000', debtExposureCapAtomic: '2000000000' };
  assert.doesNotThrow(() => s.verifySharesInitialization(manifest, price, pool, budget));
  assert.throws(() => s.verifySharesInitialization({ ...manifest, initialPriceUsdE6: '1' }, price, pool, budget), /initial price/);
  assert.throws(() => s.verifySharesInitialization(manifest, price, { ...pool, debtExposureCap: 2000000001n }, budget), /exposure/);
  assert.throws(() => s.verifySharesInitialization(manifest, price, pool, { ...budget, dailyLimit: 50000001n }), /issuance/);
  assert.equal(s.faucetBudgetRemaining(budget, 0n), 0n);
  assert.equal(s.faucetBudgetRemaining(budget, 86400n), 50000000n);
  const saturated = { ...pool, cash: 8_000_000_000n, totalBorrowAssets: s.DEBT_EXPOSURE_CAP, totalBorrowShares: 1n };
  assert.equal(s.quoteBorrowPosition(saturated, { ...position, collateral: 50_000_000n }, price, 1n).borrowable, 0n);
  assert.equal(s.quoteBorrowPosition(saturated, { ...position, collateral: 50_000_000n }, price, 86400n).borrowable, 0n);
  const limited = { ...saturated, lastAccrual: 1n, totalBorrowAssets: s.DEBT_EXPOSURE_CAP - 1_000_000n };
  assert.equal(s.quoteBorrowPosition(limited, { ...position, collateral: 50_000_000n }, price, 1n).borrowable, 1_000_000n);
});
