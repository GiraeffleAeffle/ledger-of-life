import test from 'node:test';
import assert from 'node:assert/strict';
import { address, getAddressDecoder, getAddressEncoder, type Instruction } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { solanaShareDepositForm, shareDepositForm } from '../domain/deposit-form.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { SHARES_PROGRAM_ID, SHARES_PRICE_AUTHORITY, SHARES_INITIALIZER, sharesAddresses, requiredCoverShares, type ShareEscrow } from '../finance/solana/shares.ts';
import type { AccountObservation } from '../finance/solana/observations.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { agreementDigest, type Agreement } from './agreements.ts';
import { LocalStore } from './store.ts';
import type { SolanaSharesManifest } from './solana-shares-config.ts';
import type { PrepareSolanaInput, SolanaOperations } from './solana-operations.ts';
import { prepareSolanaShareDeposit, readSolanaShareDeposit, readSolanaShareListingQuote, requireSolanaShareEscrowBinding, solanaShareActionQuote, submitSolanaShareDeposit, type SolanaShareDepositDependencies } from './share-deposit-solana.ts';
import { readShareDeposit } from './share-deposit.ts';
const encoder = getAddressEncoder();
const publicKey = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
function identity(role: 'tenant' | 'landlord' | 'arbitrator', byte: number): VerifiedIdentity {
  return { subject: role, sessionId: role, expiresAt: 2e9, passkeyCount: 1, wallets: [{ id: role, address: publicKey(byte), chainType: 'solana' }] };
}
const people = { tenant: identity('tenant', 1), landlord: identity('landlord', 2), arbitrator: identity('arbitrator', 3) };
function bytes(length: number, discriminator: readonly number[] = []) { const data = new Uint8Array(length); data.set(discriminator); return data; }
function key(data: Uint8Array, offset: number, value: string) { data.set(encoder.encode(address(value)), offset); }
function u64(data: Uint8Array, offset: number, value: bigint) { new DataView(data.buffer).setBigUint64(offset, value, true); }
async function fixture() {
  const config: SolanaSharesManifest = { cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, programId: SHARES_PROGRAM_ID, cashMint: SOLANA_TEST_USDC_MINT, priceAuthority: SHARES_PRICE_AUTHORITY, initializer: SHARES_INITIALIZER, initialPriceUsdE6: '100000000', initialPricePublishedAt: '1790856000', dailyFaucetBudgetAtomic: '50000000', debtExposureCapAtomic: '2000000000', ...await sharesAddresses() };
  const form = solanaShareDepositForm('100000000', config);
  const agreement: Agreement = { id: 'rental', network: 'solana', depositForm: form, property: 'Share test flat', requiredSecurity: form.securityUsd6, releaseAllowed: false, createdAt: '2026-10-04', revision: 0, parties: Object.fromEntries(Object.entries(people).map(([role, identity]) => [role, { subject: identity.subject, wallet: identity.wallets[0] }])), invitations: {}, accepted: {}, records: [] };
  const digest = agreementDigest(agreement)!; agreement.accepted = { tenant: { digest, at: 'now' }, landlord: { digest, at: 'now' } };
  const store = new LocalStore(':memory:'); await store.create('agreement:rental', agreement);
  const state = { exists: true, phase: 1, locked: 1_200_000n, tracked: 1_200_000n, walletShares: 10_000_000n, price: 100_000_000n, now: BigInt(Math.floor(Date.now() / 1000)), publishedAt: BigInt(Math.floor(Date.now() / 1000)), response: 0n, ret: 0n, started: 0n, authorized: false, owed: 0n, claimUsd6: 20_000_000n, claimShares: 200_000n, claimPrice: 100_000_000n, escrowTenant: people.tenant.wallets[0].address, genesis: config.genesisHash, mintAuthority: config.shareMint, programExecutable: true };
  const calls: PrepareSolanaInput[] = [];
  const results = new Map<string, { id: string; state: 'prepared' | 'broadcast' | 'confirmed'; signature?: string }>();
  const operations: SolanaOperations = {
    prepare: async input => { calls.push(input); const id = `plan-${calls.length}`; results.set(id, { id, state: 'prepared' }); return { id, kind: input.kind, walletId: input.walletId, feePayer: SHARES_PRICE_AUTHORITY, transactionBase64: 'dGVzdA==', expiresAt: new Date(Date.now() + 120000).toISOString(), review: input.review }; },
    submit: async ({ id }) => { results.set(id, { id, state: 'confirmed', signature: 'fixture-signature-not-chain-evidence' }); return { ...results.get(id)!, signature: 'fixture-signature-not-chain-evidence' }; },
    reconcile: async ({ id }) => results.get(id)!,
    cancel: async ({ id }) => ({ id, state: 'expired' }),
    get: async () => { throw new Error('Unused mock get'); },
    prepareAsSponsor: async () => { throw new Error('Fresh price must not invoke mirror preparation'); },
    executeAsSponsor: async () => { throw new Error('Fresh price must not invoke mirror signing'); },
  };
  const gateway = { checkedGenesis: async () => state.genesis, multiple: async (keys: readonly string[]) => {
    for (const account of keys) assert.equal(encoder.encode(address(account)).length, 32, 'Snapshot RPC keys must encode to exactly 32 bytes.');
    if (keys.length > 1) assert.equal(keys[4], 'SysvarC1ock11111111111111111111111111111111', 'Use the canonical Solana Clock sysvar for the finalized bank.');
    const mint = bytes(82); new DataView(mint.buffer).setUint32(0, 1, true); key(mint, 4, state.mintAuthority); mint[44] = 6; mint[45] = 1;
    const price = bytes(113, [50,107,127,61,83,36,39,75]); key(price, 8, config.priceAuthority); key(price, 40, config.shareMint); u64(price, 72, state.price); u64(price, 80, state.publishedAt); u64(price, 88, state.publishedAt); u64(price, 96, BigInt(config.initialPriceUsdE6)); u64(price, 104, BigInt(config.initialPricePublishedAt));
    const clock = bytes(40); u64(clock, 0, 123n); u64(clock, 32, state.now);
    const escrow = bytes(308, [31,213,123,187,186,22,218,155]); key(escrow, 8, state.escrowTenant); key(escrow, 40, people.landlord.wallets[0].address); key(escrow, 72, people.arbitrator.wallets[0].address); key(escrow, 104, config.shareMint); escrow.set(Buffer.from(digest.slice(2), 'hex'), 136); u64(escrow, 168, BigInt(form.securityUsd6));
    for (const [offset, value] of [[176, BigInt(form.responseWindow)], [184, BigInt(form.returnWindow)], [192, BigInt(form.arbitrationWindow)], [200, state.response], [208, state.ret], [216, state.started], [226, state.tracked], [234, state.owed], [242, state.claimUsd6], [250, state.claimShares], [290, state.claimPrice], [298, state.publishedAt]] as const) u64(escrow, offset, value);
    escrow[224] = state.authorized ? 1 : 0; escrow[225] = state.phase;
    const token = (owner: string, balance: bigint) => { const data = bytes(165); key(data, 0, config.shareMint); key(data, 32, owner); u64(data, 64, balance); data[108] = 1; return data; };
    const observed: ((AccountObservation & { lamports: string }) | null)[] = keys.map((account, index) => {
      if (keys.length === 1) return { address: account, owner: config.programId, executable: false, data: price, lamports: '1000000' };
      const data = [new Uint8Array(), mint, price, token(people.tenant.wallets[0].address, state.walletShares), clock, escrow, token(keys[5] ?? publicKey(4), state.locked)][index];
      if (index >= 5 && !state.exists) return null;
      return { address: account, owner: index === 0 ? 'BPFLoaderUpgradeab1e11111111111111111111111111' : index === 1 || index === 3 || index === 6 ? TOKEN_PROGRAM_ADDRESS : index === 4 ? 'Sysvar1111111111111111111111111111111111111' : config.programId, executable: index === 0 && state.programExecutable, data, lamports: '1000000' };
    });
    // Derive the wallet owner from the requested ATA for each role, not the caller's subject.
    if (keys.length > 1) {
      for (const identity of Object.values(people)) { const owner = identity.wallets[0].address; const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(config.shareMint), tokenProgram: TOKEN_PROGRAM_ADDRESS }); if (keys[3] === ata) observed[3]!.data = token(owner, state.walletShares); }
    }
    return { slot: '123', accounts: observed };
  } };
  const dependencies: SolanaShareDepositDependencies = { manifest: async () => config, gateway, operations, sponsor: SHARES_PRICE_AUTHORITY };
  return { config, form, agreement, store, state, calls, results, dependencies };
}
function data(ix: Instruction) { return new DataView(ix.data!.buffer, ix.data!.byteOffset, ix.data!.byteLength); }

test('six-decimal cover rounds up, warning is strictly below 125%, stale prices retain exits', async () => {
  const f = await fixture();
  try {
    assert.equal(requiredCoverShares(100_000_000n, 300_000_000n), 500_000n);
    assert.equal(requiredCoverShares(1_000_001n, 300_000_000n), 5001n);
    let view = await readSolanaShareDeposit(f.store, people.tenant, 'rental', f.dependencies);
    assert.equal(view.requiredShares, '1500000'); assert.equal(view.coverBps, 12000); assert.equal(view.needsTopUp, true); assert.equal(view.decimals, 6); assert.ok(!view.actions.includes('approve'));
    f.state.locked = f.state.tracked = 1_250_000n; view = await readSolanaShareDeposit(f.store, people.tenant, 'rental', f.dependencies); assert.equal(view.needsTopUp, false);
    f.state.publishedAt = 1n; view = await readSolanaShareDeposit(f.store, people.tenant, 'rental', f.dependencies); assert.equal(view.requiredShares, null); assert.equal(view.coverBps, null); assert.ok(view.actions.includes('requestReturn')); assert.ok(!view.actions.includes('withdraw'));
  } finally { await f.store.close(); }
});

test('sponsored creation binds digest and parameters; pledging uses one exact transfer without approval', async () => {
  const f = await fixture();
  try {
    f.state.exists = false;
    const plan = await prepareSolanaShareDeposit(f.store, people.landlord, 'rental', 'create', { requestId: 'create-one' }, f.dependencies);
    const call = f.calls.at(-1)!, ix = call.instructions[0]; assert.equal(call.actor, people.landlord.wallets[0].address); assert.equal(ix.programAddress, SHARES_PROGRAM_ID); assert.equal(ix.accounts![0].address, SHARES_PRICE_AUTHORITY);
    assert.equal(Buffer.from(ix.data!.slice(8, 40)).toString('hex'), agreementDigest(f.agreement)!.slice(2)); assert.equal(data(ix).getBigUint64(104, true), 100_000_000n); assert.equal(data(ix).getBigInt64(112, true), 604800n);
    assert.equal(plan.network, 'solana-devnet'); assert.equal(plan.review.programId, f.config.programId);
    f.state.exists = true; f.state.phase = 0; f.state.locked = f.state.tracked = 0n;
    await prepareSolanaShareDeposit(f.store, people.tenant, 'rental', 'pledge', { requestId: 'pledge-one', shares: '1500000' }, f.dependencies);
    const pledge = f.calls.at(-1)!; assert.equal(pledge.instructions.length, 2); assert.equal(data(pledge.instructions[1]).getBigUint64(8, true), 1_500_000n); assert.equal(pledge.expectedDeltas![0].minimumAtomic, '1500000'); assert.equal(pledge.expectedDeltas![1].direction, 'credit');
    await assert.rejects(prepareSolanaShareDeposit(f.store, people.landlord, 'rental', 'pledge', { requestId: 'wrong', shares: '1500000' }, f.dependencies), /Only the tenant/);
    await assert.rejects(prepareSolanaShareDeposit(f.store, people.tenant, 'rental', 'pledge', { requestId: 'too-big', shares: '10000001' }, f.dependencies), /enough test/);
  } finally { await f.store.close(); }
});

test('USD proposal conversion rounds up and caps at custody; lowered claims use stored price', async () => {
  const f = await fixture();
  try {
    const view = await readSolanaShareDeposit(f.store, people.landlord, 'rental', f.dependencies);
    const quote = solanaShareActionQuote('proposeClaim', { usd6: '20000001' }, view); assert.equal(quote.shares, 200001n);
    assert.equal(solanaShareActionQuote('proposeClaim', { usd6: '100000000' }, { ...view, lockedShares: '500000' }).shares, 500000n);
    const plan = await prepareSolanaShareDeposit(f.store, people.landlord, 'rental', 'proposeClaim', { requestId: 'claim-one', usd6: '20000001', evidence: 'Move-out damage inspection record.' }, f.dependencies);
    const ix = f.calls.at(-1)!.instructions.at(-1)!; assert.equal(data(ix).getBigUint64(8, true), 20_000_001n); assert.equal(ix.data!.length, 48); assert.notEqual(Buffer.from(ix.data!.slice(16)).toString('hex'), '0'.repeat(64)); assert.equal(plan.review.shares, '200001');
    const repeated = await prepareSolanaShareDeposit(f.store, people.landlord, 'rental', 'proposeClaim', { requestId: 'claim-one', usd6: '20000001', evidence: 'Move-out damage inspection record.' }, f.dependencies); assert.equal(repeated.id, plan.id); assert.equal(f.calls.length, 1);
    await assert.rejects(prepareSolanaShareDeposit(f.store, people.landlord, 'rental', 'proposeClaim', { requestId: 'claim-one', usd6: '10000000', evidence: 'Move-out damage inspection record.' }, f.dependencies), /already reviews/);
    assert.equal(solanaShareActionQuote('lowerClaim', { usd6: '10000001' }, { ...view, quote: { ...view.quote!, priceUsd6: '200000000' } }).shares, 100000n);
    assert.throws(() => solanaShareActionQuote('proposeClaim', { usd6: '100000001' }, view), /exceeds/);
  } finally { await f.store.close(); }
});

test('claim acceptance is exact bounded shares, contest and award use correct roles and timeout', async () => {
  const f = await fixture();
  try {
    f.state.phase = 2; f.state.response = f.state.now + 100n;
    const plan = await prepareSolanaShareDeposit(f.store, people.tenant, 'rental', 'acceptClaim', { requestId: 'accept-one', maxShares: '200000' }, f.dependencies);
    assert.equal(data(f.calls.at(-1)!.instructions.at(-1)!).getBigUint64(8, true), 200000n); assert.equal(plan.review.shares, '200000');
    await assert.rejects(prepareSolanaShareDeposit(f.store, people.tenant, 'rental', 'acceptClaim', { requestId: 'accept-extra', maxShares: '200001' }, f.dependencies), /exact current/);
    await prepareSolanaShareDeposit(f.store, people.tenant, 'rental', 'contestClaim', { requestId: 'contest-one', evidence: 'I contest this move-out deduction.' }, f.dependencies);
    f.state.phase = 3; f.state.authorized = true; f.state.started = f.state.now;
    await prepareSolanaShareDeposit(f.store, people.arbitrator, 'rental', 'resolveClaim', { requestId: 'award-one', shares: '100000', evidence: 'Neutral arbitration decision reason.' }, f.dependencies);
    assert.equal(data(f.calls.at(-1)!.instructions.at(-1)!).getBigUint64(8, true), 100000n);
    f.state.started = f.state.now - BigInt(f.form.arbitrationWindow);
    const timedOut = await readSolanaShareDeposit(f.store, people.arbitrator, 'rental', f.dependencies); assert.ok(timedOut.actions.includes('closeUnresolved')); assert.ok(!timedOut.actions.includes('resolveClaim')); assert.ok(!timedOut.actions.includes('acceptClaim'));
  } finally { await f.store.close(); }
});

test('fixed-recipient in-kind payout, durable evidence and paid-out state require confirmed signatures', async () => {
  const f = await fixture();
  try {
    f.state.phase = 4; f.state.locked = f.state.tracked = 1_500_000n; f.state.owed = 200_000n;
    const plan = await prepareSolanaShareDeposit(f.store, people.tenant, 'rental', 'payout', { requestId: 'pay-tenant', side: 'tenant' }, f.dependencies);
    assert.equal(plan.review.shares, '1300000'); assert.equal(data(f.calls.at(-1)!.instructions.at(-1)!).getUint8(8), 0);
    assert.equal(f.calls.at(-1)!.expectedDeltas![0].owner, people.tenant.wallets[0].address);
    await assert.rejects(submitSolanaShareDeposit(f.store, people.landlord, plan.id, 'bytes', f.dependencies), /different accepted terms or wallet/);
    const result = await submitSolanaShareDeposit(f.store, people.tenant, plan.id, 'bytes', f.dependencies); assert.equal(result.status, 'confirmed'); assert.equal(result.view.paidOut, false); assert.equal(result.view.receipts[0].action, 'payout');
    f.state.locked = f.state.tracked = f.state.owed = 0n;
    const view = await readSolanaShareDeposit(f.store, people.tenant, 'rental', f.dependencies); assert.equal(view.paidOut, true); assert.equal(view.explorerUrl!.includes('?cluster=devnet'), true);
  } finally { await f.store.close(); }
});

test('deployment, finalized-bank clock, escrow binding and verified wallet failures stop signing', async () => {
  const f = await fixture();
  try {
    const missing = await readSolanaShareDeposit(f.store, people.tenant, 'rental', { ...f.dependencies, manifest: async () => null }); assert.deepEqual(missing.actions, []);
    f.state.genesis = 'wrong'; await assert.rejects(readSolanaShareDeposit(f.store, people.tenant, 'rental', f.dependencies), /genesis/); f.state.genesis = f.config.genesisHash;
    f.state.mintAuthority = f.config.initializer; await assert.rejects(readSolanaShareDeposit(f.store, people.tenant, 'rental', f.dependencies), /mint authority/); f.state.mintAuthority = f.config.shareMint;
    f.state.escrowTenant = people.landlord.wallets[0].address; await assert.rejects(readSolanaShareDeposit(f.store, people.tenant, 'rental', f.dependencies), /accepted parties/); f.state.escrowTenant = people.tenant.wallets[0].address;
    const gateway = f.dependencies.gateway!;
    await assert.rejects(readSolanaShareDeposit(f.store, people.tenant, 'rental', { ...f.dependencies, gateway: { checkedGenesis: gateway.checkedGenesis, multiple: async keys => { const bank = await gateway.multiple(keys); return { ...bank, slot: '124' }; } } }), /clock does not match/);
    await assert.rejects(readSolanaShareDeposit(f.store, people.tenant, 'rental', { ...f.dependencies, gateway: { checkedGenesis: gateway.checkedGenesis, multiple: async keys => { const bank = await gateway.multiple(keys); bank.accounts[0]!.address = publicKey(9); return bank; } } }), /reviewed addresses/);
    await assert.rejects(readSolanaShareDeposit(f.store, { ...people.tenant, wallets: [{ ...people.tenant.wallets[0], chainType: 'ethereum' }] }, 'rental', f.dependencies), /not a verified party/);
    await assert.rejects(readShareDeposit(f.store, people.tenant, 'rental'), /Robinhood/);
    const original = { ...f.agreement, network: 'robinhood' as const, depositForm: shareDepositForm('100000000', '0x' + '4'.repeat(40)) };
    assert.notEqual(agreementDigest(original), agreementDigest(f.agreement));
    assert.throws(() => requireSolanaShareEscrowBinding({ agreementHash: new Uint8Array(32) } as ShareEscrow, f.agreement, f.form), /accepted parties/);
    await f.store.create('listing:quote', { depositForm: f.form, requiredSecurity: f.form.securityUsd6 });
    const quote = await readSolanaShareListingQuote(f.store, people.tenant, 'quote', f.dependencies); assert.equal(quote.requiredShares, '1500000'); assert.equal(quote.decimals, 6);
  } finally { await f.store.close(); }
});

test('return timeout never awards the landlord, and shared journal recovers signed receipts after response loss', async () => {
  const f = await fixture();
  try {
    f.state.ret = f.state.now;
    const landlordView = await readSolanaShareDeposit(f.store, people.landlord, 'rental', f.dependencies);
    assert.ok(landlordView.actions.includes('closeUnclaimed')); assert.ok(!landlordView.actions.includes('proposeClaim'));
    const plan = await prepareSolanaShareDeposit(f.store, people.tenant, 'rental', 'closeUnclaimed', { requestId: 'timeout-one' }, f.dependencies);
    assert.equal(f.calls.at(-1)!.instructions.at(-1)!.data!.length, 8);
    f.results.set(plan.id, { id: plan.id, state: 'confirmed', signature: 'fixture-recovered-signature-not-chain-evidence' });
    f.state.phase = 4; f.state.owed = 0n;
    const recovered = await readSolanaShareDeposit(f.store, people.landlord, 'rental', f.dependencies);
    assert.equal(recovered.receipts[0].transactionHash, 'fixture-recovered-signature-not-chain-evidence');
    assert.equal(recovered.receipts[0].status, 'confirmed'); assert.equal(recovered.landlordOwed, '0');
  } finally { await f.store.close(); }
});
