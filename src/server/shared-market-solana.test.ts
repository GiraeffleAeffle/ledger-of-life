import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { address, getAddressEncoder, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransaction, getCompiledTransactionMessageDecoder, blockhash } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token-2022';
import { SOLANA_IDS, SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { SHARES_PROGRAM_ID, SHARES_PRICE_AUTHORITY, SHARES_INITIALIZER, sharesAddresses, loanPositionAddress, faucetCooldownAddress, type SharesPrice, type SharesPool, type LoanPosition, type FaucetBudget } from '../finance/solana/shares.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { SolanaSharesManifest } from './solana-shares-config.ts';
import type { PrepareSolanaInput, ExecuteSponsorInput, SolanaOperationResult, PreparedSolanaOperation, SolanaOperations } from './solana-operations.ts';
import { LocalStore } from './store.ts';
import { readSolanaMarketSnapshot, readSolanaSharedMarket, prepareSolanaMarketAction, submitSolanaMarketAction, cancelSolanaMarketAction, readSolanaSharesFaucet, prepareSolanaSharesFaucet, submitSolanaSharesFaucet, reconcileSolanaSharesFaucet, cancelSolanaSharesFaucet, readSolanaUnhealthyLoans, type SolanaMarketGateway } from './shared-market-solana.ts';

const NOW = BigInt(Date.parse('2026-10-05T12:00:00Z') / 1000);
const owner = SHARES_INITIALIZER, borrower = 'DuFehTh7HJVxTmBhdJiDxsDrd6xXMnQW35jzLPxBeDfb';
const identity: VerifiedIdentity = { subject: 'did:privy:solana-lending-unit', sessionId: 'test-session', expiresAt: Number(NOW) + 3600, passkeyCount: 1, wallets: [{ id: 'personal-solana', address: owner, chainType: 'solana' }] };
const enc = getAddressEncoder();
const key = (value: string) => new Uint8Array(enc.encode(address(value)));
const le = (value: bigint, size = 8, signed = false) => { const b = Buffer.alloc(size); let n = signed ? BigInt.asUintN(size * 8, value) : value; for (let i = 0; i < size; i++) { b[i] = Number(n & 255n); n >>= 8n; } return b; };
const disc = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
function priceBytes(p: SharesPrice) { return Buffer.concat([disc('Price'), key(p.authority), key(p.shareMint), le(p.priceUsdE6), le(p.publishedAt, 8, true), le(p.copiedAt, 8, true), le(p.initialPriceUsdE6), le(p.initialPublishedAt, 8, true), Buffer.from([p.bump])]); }
function poolBytes(p: SharesPool) { return Buffer.concat([disc('Pool'), key(p.shareMint), key(p.cashMint), le(p.cash), le(p.totalSupply, 16), le(p.totalBorrowAssets), le(p.totalBorrowShares, 16), le(p.totalCollateral), le(p.lastAccrual, 8, true), le(p.interestRemainder, 16), le(p.debtExposureCap), Buffer.from([p.bump])]); }
function positionBytes(p: LoanPosition) { return Buffer.concat([disc('LoanPosition'), key(p.pool), key(p.owner), le(p.balance, 16), le(p.netContributed, 16, true), le(p.collateral), le(p.borrowShares, 16), Buffer.from([p.bump])]); }
function budgetBytes(b: FaucetBudget) { return Buffer.concat([disc('FaucetBudget'), key(b.shareMint), le(b.day, 8, true), le(b.mintedToday), le(b.totalMinted), le(b.dailyLimit), Buffer.from([b.bump])]); }
function tokenBytes(mint: string, authority: string, amount: bigint) { const b = Buffer.alloc(165); b.set(key(mint)); b.set(key(authority), 32); b.set(le(amount), 64); b[108] = 1; return b; }
function mintBytes(authority: string) { const b = Buffer.alloc(82); b.writeUInt32LE(1); b.set(key(authority), 4); b.set(le(50_000_000n), 36); b[44] = 6; b[45] = 1; return b; }
async function fixture() {
  const store = new LocalStore(':memory:'), addresses = await sharesAddresses();
  const manifest: SolanaSharesManifest = { cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, programId: SHARES_PROGRAM_ID, cashMint: SOLANA_TEST_USDC_MINT, priceAuthority: SHARES_PRICE_AUTHORITY, initializer: SHARES_INITIALIZER, initialPriceUsdE6: '100000000', initialPricePublishedAt: (NOW - 200000n).toString(), dailyFaucetBudgetAtomic: '50000000', debtExposureCapAtomic: '2000000000', ...addresses };
  const [cashAccount] = await findAssociatedTokenPda({ owner: address(owner), mint: address(manifest.cashMint), tokenProgram: address(SOLANA_IDS.token) });
  const [shareAccount] = await findAssociatedTokenPda({ owner: address(owner), mint: address(manifest.shareMint), tokenProgram: address(SOLANA_IDS.token) });
  const ownPosition = await loanPositionAddress(manifest.pool, owner), targetPosition = await loanPositionAddress(manifest.pool, borrower), cooldown = await faucetCooldownAddress(manifest.shareMint, owner);
  let price: SharesPrice = { authority: SHARES_PRICE_AUTHORITY, shareMint: manifest.shareMint, priceUsdE6: 100_000_000n, publishedAt: NOW, copiedAt: NOW - 4000n, initialPriceUsdE6: 100_000_000n, initialPublishedAt: NOW - 200000n, bump: 1 };
  let pool: SharesPool = { shareMint: manifest.shareMint, cashMint: manifest.cashMint, cash: 1_000_000_000n, totalSupply: 1000n * 10n ** 18n, totalBorrowAssets: 50_000_000n, totalBorrowShares: 50_000_000n * 10n ** 12n, totalCollateral: 4_000_000n, lastAccrual: NOW, interestRemainder: 0n, debtExposureCap: 2_000_000_000n, bump: 1 };
  let position: LoanPosition = { pool: manifest.pool, owner, balance: 500n * 10n ** 18n, netContributed: 500_000_000n, collateral: 2_000_000n, borrowShares: pool.totalBorrowShares, bump: 1 };
  let target: LoanPosition = { ...position, owner: borrower, balance: 0n, netContributed: 0n };
  let budget: FaucetBudget = { shareMint: manifest.shareMint, day: NOW / 86400n, mintedToday: 0n, totalMinted: 50_000_000n, dailyLimit: 50_000_000n, bump: 1 };
  let now = Number(NOW) * 1000, clock = NOW, genesis = manifest.genesisHash, custody = pool.cash, programOwner = 'BPFLoaderUpgradeab1e11111111111111111111111';
  const override = new Map<string, { owner: string; executable: boolean; data: Uint8Array } | null>();
  const calls: PrepareSolanaInput[] = [], executions: ExecuteSponsorInput[] = [], submitted: string[] = [];
  const ops = new Map<string, PreparedSolanaOperation & SolanaOperationResult & { actor: string; subject: string }>();
  let state: SolanaOperationResult['state'] = 'prepared', hold: Promise<void> | null = null, mintCopy = true;
  const prepareReached = Promise.withResolvers<void>();
  const operations: SolanaOperations = {
    prepare: async input => { calls.push(input); prepareReached.resolve(); if (hold) await hold; const id = `operation-${calls.length}`; const prepared = { id, kind: input.kind, walletId: input.walletId, feePayer: SHARES_PRICE_AUTHORITY, transactionBase64: Buffer.from([1, 2, 3]).toString('base64'), expiresAt: new Date(now + 120000).toISOString(), review: input.review, state: 'prepared' as const, actor: String(input.actor), subject: input.identity.subject }; ops.set(id, prepared); return prepared; },
    get: async (id, subject) => { const p = ops.get(id); if (!p || (subject && (p.subject !== subject.subject || !subject.wallets.some(w => w.id === p.walletId && w.address === p.actor)))) throw new Error('operation_owner'); return p; },
    submit: async input => { const p = ops.get(input.id); assert.ok(p); if (p.state === 'expired') throw new Error('expired'); submitted.push(input.id); p.state = state === 'prepared' ? 'confirmed' : state; p.signature = `devnet-signature-${input.id}`; return { id: input.id, state: p.state, signature: p.signature }; },
    reconcile: async input => { const p = ops.get(input.id); assert.ok(p); if (p.state === 'prepared' && now >= Date.parse(p.expiresAt)) p.state = 'expired'; return { id: input.id, state: p.state, ...(p.signature ? { signature: p.signature } : {}) }; },
    cancel: async input => { const p = ops.get(input.id); assert.ok(p); if (p.state !== 'prepared') throw new Error('signed-cannot-cancel'); p.state = 'expired'; return { id: input.id, state: 'expired' }; },
    executeAsSponsor: async input => {
      executions.push(input); const data = input.instructions[0].data!;
      if (mintCopy) price = { ...price, priceUsdE6: Buffer.from(data).readBigUInt64LE(8), publishedAt: Buffer.from(data).readBigInt64LE(16), copiedAt: clock };
      const result = { id: 'mirror-operation', state: mintCopy ? 'confirmed' as const : 'broadcast' as const, signature: 'mirror-devnet-signature' };
      ops.set(result.id, { ...result, kind: input.kind, walletId: 'sponsor', actor: SHARES_PRICE_AUTHORITY, subject: 'server:sponsor', feePayer: SHARES_PRICE_AUTHORITY, transactionBase64: '', expiresAt: new Date(now + 120000).toISOString(), review: input.review });
      return result;
    },
  };
  const gateway: SolanaMarketGateway = {
    checkedGenesis: async () => genesis,
    multiple: async keys => ({ slot: '100', accounts: keys.map(account => {
      if (override.has(account)) { const row = override.get(account); return row ? { ...row, address: account, lamports: '1000000' } : null; }
      let row: { owner: string; executable: boolean; data: Uint8Array } | null = null;
      if (account === manifest.programId) row = { owner: programOwner, executable: true, data: Buffer.alloc(36) };
      else if (account === manifest.pool) row = { owner: manifest.programId, executable: false, data: poolBytes(pool) };
      else if (account === manifest.price) row = { owner: manifest.programId, executable: false, data: priceBytes(price) };
      else if (account === manifest.faucetBudget) row = { owner: manifest.programId, executable: false, data: budgetBytes(budget) };
      else if (account === manifest.cashMint || account === manifest.shareMint) row = { owner: SOLANA_IDS.token, executable: false, data: mintBytes(account === manifest.shareMint ? manifest.shareMint : owner) };
      else if (account === manifest.cashVault) row = { owner: SOLANA_IDS.token, executable: false, data: tokenBytes(manifest.cashMint, manifest.pool, custody) };
      else if (account === manifest.collateralVault) row = { owner: SOLANA_IDS.token, executable: false, data: tokenBytes(manifest.shareMint, manifest.pool, pool.totalCollateral) };
      else if (account === cashAccount || account === shareAccount) row = { owner: SOLANA_IDS.token, executable: false, data: tokenBytes(account === cashAccount ? manifest.cashMint : manifest.shareMint, owner, account === cashAccount ? 500_000_000n : 5_000_000n) };
      else if (account === ownPosition) row = { owner: manifest.programId, executable: false, data: positionBytes(position) };
      else if (account === targetPosition) row = { owner: manifest.programId, executable: false, data: positionBytes(target) };
      else if (account === 'SysvarC1ock11111111111111111111111111111111') { const data = Buffer.alloc(40); data.set(le(100n)); data.set(le(clock, 8, true), 32); row = { owner: 'Sysvar1111111111111111111111111111111111111', executable: false, data }; }
      return row ? { ...row, address: account, lamports: '1000000' } : null;
    }) }),
    rpc: async method => { assert.equal(method, 'getProgramAccounts'); return [{ pubkey: targetPosition }, { pubkey: ownPosition }]; },
  };
  const options = { manifest, gateway, operations, sponsorAddress: SHARES_PRICE_AUTHORITY, now: () => now, environment: {}, mirror: { readMirror: async () => ({ priceUsdE6: 110_000_000n, publishedAt: clock - 60n, sourceLabel: 'fresh deployed Robinhood mirror' }), now: () => Number(clock) } };
  return { store, options, manifest, gateway, operations, calls, executions, submitted, ops, override, cashAccount, shareAccount, ownPosition, targetPosition, cooldown, prepareReached: prepareReached.promise, get price() { return price; }, set price(value: SharesPrice) { price = value; }, get pool() { return pool; }, set pool(value: SharesPool) { pool = value; }, get position() { return position; }, set position(value: LoanPosition) { position = value; }, get target() { return target; }, set target(value: LoanPosition) { target = value; }, get budget() { return budget; }, set budget(value: FaucetBudget) { budget = value; }, set now(value: number) { now = value; clock = BigInt(Math.floor(value / 1000)); }, set genesis(value: string) { genesis = value; }, set custody(value: bigint) { custody = value; }, set state(value: SolanaOperationResult['state']) { state = value; }, set hold(value: Promise<void> | null) { hold = value; }, set mintCopy(value: boolean) { mintCopy = value; }, set programOwner(value: string) { programOwner = value; } };
}

test('finalized six-decimal market view separates wallets, principal, interest and cash-limited exits', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const view = await readSolanaSharedMarket(f.store, identity, f.options);
  assert.equal(view.network, 'solana-devnet'); assert.equal(view.shareDecimals, 6); assert.equal(view.cashSymbol, 'tUSDC'); assert.equal(view.sharesRaw, '5000000'); assert.equal(view.walletValueAtomic, '500000000'); assert.equal(view.loan.debtAtomic, '50000000'); assert.equal(view.pool.debtExposureCapAtomic, '2000000000'); assert.equal(view.observedSlot, '100');
  f.price = { ...f.price, publishedAt: NOW - 200000n };
  const stale = await readSolanaSharedMarket(f.store, identity, f.options);
  assert.equal(stale.price.stale, true); assert.equal(stale.priceAtomic, null); assert.equal(stale.walletValueAtomic, null); assert.equal(stale.loan.availableAtomic, '0'); assert.equal(stale.canRefreshPrice, true);
});
test('missing ATAs and positions are zero but wrong mints, state owners, custody, authority and clock fail closed', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  f.override.set(f.cashAccount, null); f.override.set(f.shareAccount, null); f.override.set(f.ownPosition, null);
  const zero = await readSolanaMarketSnapshot(f.manifest, owner, f.gateway); assert.equal(zero.walletCash, 0n); assert.equal(zero.walletShares, 0n); assert.equal(zero.position, null);
  f.override.clear(); f.override.set(f.cashAccount, { owner: SOLANA_IDS.token, executable: false, data: tokenBytes(f.manifest.shareMint, owner, 1n) });
  await assert.rejects(readSolanaMarketSnapshot(f.manifest, owner, f.gateway), /mint/); f.override.clear();
  f.price = { ...f.price, authority: owner }; await assert.rejects(readSolanaMarketSnapshot(f.manifest, owner, f.gateway), /identities/); f.price = { ...f.price, authority: SHARES_PRICE_AUTHORITY };
  f.custody = 0n; await assert.rejects(readSolanaMarketSnapshot(f.manifest, owner, f.gateway), /custody/); f.custody = f.pool.cash;
  f.override.set(f.manifest.pool, { owner, executable: false, data: poolBytes(f.pool) }); await assert.rejects(readSolanaMarketSnapshot(f.manifest, owner, f.gateway), /wrong owner/); f.override.clear();
  f.genesis = 'wrong'; await assert.rejects(readSolanaMarketSnapshot(f.manifest, owner, f.gateway), /genesis/);
});
for (const [operation, quantity] of [['lend','10000000'],['unlend','10000000'],['borrow','10000000'],['repay','10000000'],['deposit_collateral','1000000'],['withdraw_collateral','1000000']] as const) {
  test(`${operation} composes classic ATAs and exact reviewed signer/token amounts`, async t => {
    const f = await fixture(); t.after(() => f.store.close());
    const prepared = await prepareSolanaMarketAction(f.store, identity, { operation, quantity, requestId: operation }, f.options);
    assert.equal(prepared.network, 'solana-devnet'); assert.equal(f.executions.length, 0); const call = f.calls[0]; assert.equal(call.instructions.length, 3); assert.equal(call.actor, owner); assert.equal(call.walletId, 'personal-solana'); assert.equal(call.review.amountAtomic, quantity); assert.equal(call.review.account, owner);
    const action = call.instructions[2]; assert.equal(action.programAddress, SHARES_PROGRAM_ID); assert.equal(Buffer.from(action.data!).readBigUInt64LE(8).toString(), quantity); assert.equal(action.accounts?.[0].address, SHARES_PRICE_AUTHORITY); assert.equal(action.accounts?.[1].address, owner); assert.equal(action.accounts?.[4].address, owner); assert.equal(action.accounts?.[5].address, f.cashAccount); assert.equal(action.accounts?.[6].address, f.shareAccount);
    const message = setTransactionMessageFeePayer(address(SHARES_PRICE_AUTHORITY), createTransactionMessage({ version: 0 }));
    const lifetimeMessage = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 200n }, message);
    const compiled = getCompiledTransactionMessageDecoder().decode(compileTransaction(appendTransactionMessageInstructions(call.instructions, lifetimeMessage)).messageBytes); assert.equal(compiled.staticAccounts[0], SHARES_PRICE_AUTHORITY); assert.equal(compiled.header.numSignerAccounts, 2); assert.ok(compiled.staticAccounts.slice(0,2).includes(address(owner)));
    if (operation === 'repay') { assert.equal(call.review.amountIsMaximum, true); assert.equal(call.expectedDeltas?.[0].maximumAtomic, quantity); } else assert.equal(call.review.amountIsMaximum, false);
    await submitSolanaMarketAction(f.store, identity, prepared.id, 'unit-signed-bytes', f.options); assert.deepEqual(f.submitted, [prepared.id]);
  });
}
test('amount, account, cash, collateral, utilization and exposure limits are checked before user review', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  for (const quantity of ['0','01','-1','1.1',(1n << 64n).toString()]) await assert.rejects(prepareSolanaMarketAction(f.store, identity, { operation: 'lend', quantity }, f.options), /amount|token limit/);
  await assert.rejects(prepareSolanaMarketAction(f.store, identity, { operation: 'lend', quantity: '500000001' }, f.options), /more site/);
  await assert.rejects(prepareSolanaMarketAction(f.store, identity, { operation: 'borrow', quantity: '999999' }, f.options), /at least/);
  await assert.rejects(prepareSolanaMarketAction(f.store, identity, { operation: 'borrow', quantity: '50000001' }, f.options), /exceeds/);
  await assert.rejects(prepareSolanaMarketAction(f.store, identity, { operation: 'deposit_collateral', quantity: '5000001' }, f.options), /enough/);
  await assert.rejects(prepareSolanaMarketAction(f.store, identity, { operation: 'withdraw_collateral', quantity: '1100000' }, f.options), /fifty percent/);
  await assert.rejects(prepareSolanaMarketAction(f.store, { ...identity, wallets: [] }, { operation: 'lend', quantity: '1' }, f.options), /verified personal/);
  assert.equal(f.calls.length, 0);
});
test('stale price-sensitive prepare copies a fresh bounded mirror before producing the user review', async t => {
  const f = await fixture(); t.after(() => f.store.close()); f.price = { ...f.price, publishedAt: NOW - 200000n };
  const prepared = await prepareSolanaMarketAction(f.store, identity, { operation: 'borrow', quantity: '10000000', requestId: 'after-copy' }, f.options);
  assert.equal(f.executions.length, 1); assert.equal(f.executions[0].kind, 'shares-price-mirror'); assert.equal(f.calls.length, 1); assert.equal(prepared.review.priceUsdE6, '110000000'); assert.equal(f.calls[0].instructions[2].accounts?.[9].address, f.manifest.price);
});
test('unavailable, out-of-band and pending mirror never yield signable borrowing reviews', async t => {
  for (const mode of ['missing','out-of-band','pending'] as const) {
    const f = await fixture(); t.after(() => f.store.close()); f.price = { ...f.price, publishedAt: NOW - 200000n };
    if (mode === 'missing') f.options.mirror.readMirror = async () => { throw new Error('unreachable'); };
    if (mode === 'out-of-band') f.options.mirror.readMirror = async () => ({ priceUsdE6: 121000000n, publishedAt: NOW - 60n, sourceLabel: 'test source' });
    if (mode === 'pending') f.mintCopy = false;
    await assert.rejects(prepareSolanaMarketAction(f.store, identity, { operation: 'borrow', quantity: '1000000' }, f.options), /fresh mirrored/); assert.equal(f.calls.length, 0);
  }
});
test('repay and debt-free collateral return stay available without a fresh price', async t => {
  const f = await fixture(); t.after(() => f.store.close()); f.price = { ...f.price, publishedAt: NOW - 200000n };
  const repayment = await prepareSolanaMarketAction(f.store, identity, { operation: 'repay', quantity: '10000000', requestId: 'repay-stale' }, f.options); assert.equal(f.executions.length, 0); await cancelSolanaMarketAction(f.store, identity, repayment.id, f.options);
  f.position = { ...f.position, borrowShares: 0n };
  await prepareSolanaMarketAction(f.store, identity, { operation: 'withdraw_collateral', quantity: '2000000', requestId: 'return-stale' }, f.options); assert.equal(f.executions.length, 0);
});
test('public liquidation is paged and targets the observed borrower, never the liquidator position', async t => {
  const f = await fixture(); t.after(() => f.store.close()); f.price = { ...f.price, priceUsdE6: 20000000n }; f.position = { ...f.position, borrowShares: 0n };
  const page = await readSolanaUnhealthyLoans(f.store, identity, '0', 20, f.options); assert.equal(page.scanned, 2); assert.equal(page.loans.length, 1); assert.equal(page.loans[0].borrower, borrower);
  const plan = await prepareSolanaMarketAction(f.store, identity, { operation: 'liquidate', quantity: '10000000', borrower, requestId: 'liquidate-borrower' }, f.options);
  assert.equal(plan.review.borrower, borrower); assert.equal(f.calls[0].instructions[2].accounts?.[3].address, f.targetPosition); assert.equal(f.calls[0].instructions[2].accounts?.[4].address, borrower); assert.equal(plan.review.maximumDebitAtomic, '10000000'); assert.equal(plan.review.amountIsMaximum, true);
});
test('same request restores exact review; another intent must wait or cancel; cross-domain IDs are refused', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const first = await prepareSolanaMarketAction(f.store, identity, { operation: 'lend', quantity: '1000000', requestId: 'idempotent' }, f.options);
  const second = await prepareSolanaMarketAction(f.store, identity, { operation: 'lend', quantity: '1000000', requestId: 'idempotent' }, f.options); assert.equal(second.id, first.id); assert.equal(f.calls.length, 1);
  await assert.rejects(prepareSolanaMarketAction(f.store, identity, { operation: 'borrow', quantity: '1000000', requestId: 'idempotent' }, f.options), /different/);
  await assert.rejects(prepareSolanaMarketAction(f.store, identity, { operation: 'lend', quantity: '1000000', requestId: 'other' }, f.options), /Finish or cancel/);
  f.ops.get(first.id)!.kind = 'solana-shares:faucet'; await assert.rejects(submitSolanaMarketAction(f.store, identity, first.id, 'signed', f.options), /kind mismatch/); assert.equal(f.submitted.length, 0);
});
test('faucet requires user plus issuer and exact five-share credit; confirmation charges verified account for 24 hours', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const plan = await prepareSolanaSharesFaucet(f.store, identity, { requestId: 'first-claim' }, f.options);
  const call = f.calls[0], instruction = call.instructions[1]; assert.equal(call.kind, 'solana-shares:faucet'); assert.equal(call.instructions.length, 2); assert.equal(call.review.amountAtomic, '5000000'); assert.equal(instruction.accounts?.[0].address, SHARES_PRICE_AUTHORITY); assert.equal(instruction.accounts?.[1].address, owner); assert.equal(instruction.accounts?.[2].address, SHARES_PRICE_AUTHORITY); assert.equal(instruction.accounts?.[6].address, f.manifest.faucetBudget); assert.equal(call.expectedDeltas?.[0].minimumAtomic, '5000000');
  const existing = await prepareSolanaSharesFaucet(f.store, identity, { requestId: 'duplicate-tab' }, f.options); assert.equal(existing.id, plan.id); assert.equal(f.calls.length, 1);
  await submitSolanaSharesFaucet(f.store, identity, plan.id, 'signed-by-owner', f.options);
  const status = await readSolanaSharesFaucet(f.store, identity, f.options); assert.equal(status.availableAt, Number(NOW) + 86400); assert.equal(status.receipts.length, 1); assert.equal(status.receipts[0].state, 'confirmed');
  await assert.rejects(prepareSolanaSharesFaucet(f.store, identity, { requestId: 'too-soon' }, f.options), /one claim per verified/);
  await reconcileSolanaSharesFaucet(f.store, identity, plan.id, f.options); assert.equal((await readSolanaSharesFaucet(f.store, identity, f.options)).availableAt, status.availableAt);
});
test('faucet account limit cannot be bypassed by changing wallet or sponsor', async t => {
  const f = await fixture(); t.after(() => f.store.close()); const p = await prepareSolanaSharesFaucet(f.store, identity, { requestId: 'claim' }, f.options); await submitSolanaSharesFaucet(f.store, identity, p.id, 'signed', f.options);
  const otherIdentity = { ...identity, wallets: [{ id: 'new-personal-wallet', address: borrower, chainType: 'solana' as const }] };
  await assert.rejects(prepareSolanaSharesFaucet(f.store, otherIdentity, { requestId: 'rotate' }, f.options), /operation_owner|original|one claim/);
  await assert.rejects(prepareSolanaSharesFaucet(f.store, identity, { requestId: 'wrong-sponsor' }, { ...f.options, sponsorAddress: owner }), /hosted issuer/);
});
test('faucet global daily budget and wallet cooldown refuse preparation before any sponsor review', async t => {
  const f = await fixture(); t.after(() => f.store.close()); f.budget = { ...f.budget, mintedToday: 50000000n };
  await assert.rejects(prepareSolanaSharesFaucet(f.store, identity, { requestId: 'exhausted' }, f.options), /global fifty/); assert.equal(f.calls.length, 0);
  f.budget = { ...f.budget, mintedToday: 0n }; f.override.set(f.cooldown, { owner: f.manifest.programId, executable: false, data: Buffer.concat([disc('FaucetCooldown'), key(owner), le(NOW - 100n, 8, true), Buffer.from([1])]) });
  await assert.rejects(prepareSolanaSharesFaucet(f.store, identity, { requestId: 'wallet-cooldown' }, f.options), /on-chain/); assert.equal(f.calls.length, 0);
});
test('cancelled or expired unsigned faucet reviews release only after durable terminal state; pending signed claims do not', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const first = await prepareSolanaSharesFaucet(f.store, identity, { requestId: 'cancel' }, f.options); await cancelSolanaSharesFaucet(f.store, identity, first.id, f.options);
  const next = await prepareSolanaSharesFaucet(f.store, identity, { requestId: 'second' }, f.options); assert.notEqual(next.id, first.id);
  f.state = 'broadcast'; await submitSolanaSharesFaucet(f.store, identity, next.id, 'signed', f.options); f.now = Number(NOW + 2n * 86400n) * 1000;
  const pending = await prepareSolanaSharesFaucet(f.store, identity, { requestId: 'cannot-replace-pending' }, f.options); assert.equal(pending.id, next.id); assert.equal(pending.state, 'broadcast'); assert.equal(f.calls.length, 2);
});
test('simultaneous faucet preparations use one atomic account reservation', async t => {
  const f = await fixture(); t.after(() => f.store.close()); const gate = Promise.withResolvers<void>(); f.hold = gate.promise;
  const first = prepareSolanaSharesFaucet(f.store, identity, { requestId: 'concurrent-one' }, f.options);
  try {
    await f.prepareReached; assert.equal(f.calls.length, 1);
    await assert.rejects(prepareSolanaSharesFaucet(f.store, identity, { requestId: 'concurrent-two' }, f.options), /already being prepared/);
  } finally { gate.resolve(); await first; }
  assert.equal(f.calls.length, 1);
});

test('a verified account can change wallets only after its confirmed faucet cooldown', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const claim = await prepareSolanaSharesFaucet(f.store, identity, { requestId: 'original-wallet' }, f.options);
  await submitSolanaSharesFaucet(f.store, identity, claim.id, 'signed', f.options);
  const changed = { ...identity, wallets: [{ id: 'new-personal-wallet', address: borrower, chainType: 'solana' as const }] };
  await assert.rejects(prepareSolanaSharesFaucet(f.store, changed, { requestId: 'too-soon' }, f.options), /one claim per verified/);
  f.now = Number(NOW + 86401n) * 1000;
  const next = await prepareSolanaSharesFaucet(f.store, changed, { requestId: 'after-account-cooldown' }, f.options);
  assert.equal(next.walletId, 'new-personal-wallet');
  assert.equal(f.calls.at(-1)?.instructions[1].accounts?.[1].address, borrower);
});
