import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createSolanaInitializationService, leaseIdForAgreement } from './solana-initialization.ts';
import { getAddressDecoder } from '@solana/kit';
import { SOLANA_DEVNET_MANIFEST, deriveEscrowAddresses, derivePayoutAddress } from '../finance/solana/index.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { acceptAgreement, agreementDigest, createAgreement, inviteToAgreement, joinAgreement, type Agreement } from './agreements.ts';
import { applyToListing, chooseApplicant, createListing, listListings, type Listing } from './listings.ts';
import { tenancyJourney } from './journey.ts';
import { createSolanaService, type SolanaOperation } from './solana-service.ts';
import { EscrowAbsentError, type SolanaConfiguration, type SolanaGateway, type SolanaSnapshot } from './solana-rpc.ts';
import type { solanaServicesFor } from './solana-tenancies.ts';
import { LocalStore } from './store.ts';
import { cancelAgreement } from './tenancy-cancellation.ts';

const addressFor = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const person = (role: string, byte: number): VerifiedIdentity => ({
  subject: role, sessionId: role, expiresAt: 9999999999, passkeyCount: 1,
  wallets: [{ id: `wallet-${role}`, address: addressFor(byte), chainType: 'solana' }],
});
async function fixture(accepted = true) {
  const store = new LocalStore(':memory:');
  const landlord = person('landlord', 1), tenant = person('tenant', 2), arbitrator = person('arbitrator', 3);
  const listing = await createListing(store, landlord, {
    title: 'A test home', rentMonthly: '1000000', requiredSecurity: '10000000', releaseAllowed: false,
  });
  await applyToListing(store, tenant, listing.id, { name: 'Tenant', message: 'I would like to rent this home.' });
  const applications = (await listListings(store, landlord))[0].applications!;
  const chosen = await chooseApplicant(store, landlord, listing.id, applications[0].id);
  const id = chosen.agreementId!;
  const invitation = await inviteToAgreement(store, id, landlord, 'arbitrator');
  if (accepted) {
    const joined = await joinAgreement(store, id, arbitrator, 'arbitrator', invitation.token);
    await acceptAgreement(store, id, tenant, joined.digest!);
    await acceptAgreement(store, id, landlord, joined.digest!);
  }
  const agreement = (await store.get<Agreement>(`agreement:${id}`))!;
  const config: SolanaConfiguration = {
    cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, setupMode: 'staged', escrowVersion: 'pull-v2',
    escrowProgram: addressFor(10), programSha256: 'a'.repeat(64), maxObservationAgeMs: 15000,
    depositMint: SOLANA_DEVNET_MANIFEST.deposit.mint, reserve: addressFor(11),
    market: addressFor(12), receiptMint: addressFor(13), liquiditySupply: addressFor(14), marketAuthority: addressFor(15),
    oracleAccounts: [], rpcUrl: 'https://rpc.invalid', agreementId: id, tenancyAddress: addressFor(8),
    programCodeLength: 1000, upgradeAuthority: null, maximumSponsorLamports: '10000000',
  };
  config.tenancyAddress = (await deriveEscrowAddresses(config.escrowProgram, tenant.wallets[0].address, leaseIdForAgreement(config, id))).tenancy;
  const snapshot: SolanaSnapshot = {
    genesisHash: config.genesisHash, slot: '50', cashAtomic: '0', receiptsAtomic: '0',
    tenantCashAtomic: '10000000', landlordCashAtomic: '0', receiptValueAtomic: '0', availableLiquidityAtomic: '0', requiresRefresh: false,
    tenancy: {
      address: config.tenancyAddress, leaseId: new Uint8Array(32), tenant: tenant.wallets[0].address,
      landlord: landlord.wallets[0].address, arbitrator: arbitrator.wallets[0].address,
      depositMint: config.depositMint, reserve: config.reserve, market: config.market, receiptMint: config.receiptMint,
      liquiditySupply: config.liquiditySupply, marketAuthority: config.marketAuthority,
      tenantDestination: await derivePayoutAddress(tenant.wallets[0].address, config.depositMint),
      landlordDestination: await derivePayoutAddress(landlord.wallets[0].address, config.depositMint),
      policyHash: new Uint8Array(Buffer.from((agreementDigest(agreement) ?? '0x' + '0'.repeat(64)).slice(2), 'hex')),
      releasePermitted: false, requiredSecurityAtomic: agreement.requiredSecurity,
      accountedIdleAtomic: '0', accountedReceiptsAtomic: '0', releasedEarningsAtomic: '0', nextNonce: '0',
      claimAtomic: '0', approvedClaimAtomic: '0', phase: 'awaiting-funding', tenantOwedAtomic: '0', landlordOwedAtomic: '0', bump: 1,
    },
  };
  const state = { exists: false, reads: 0 };
  const gateway: SolanaGateway = {
    async snapshot() { state.reads++; if (!state.exists) throw new EscrowAbsentError(); return snapshot; },
    async lifetime() { throw new Error('Cancellation must not prepare a transaction'); },
    async simulate() { throw new Error('Cancellation must not simulate'); },
    async broadcast() { throw new Error('Cancellation must not broadcast'); },
    async reconcile() { throw new Error('Cancellation must not reconcile'); },
  };
  const sponsor = { address: addressFor(4), async sign(): Promise<Uint8Array> { throw new Error('Cancellation must not sign'); } };
  const service = createSolanaService({ store, config, gateway, sponsor });
  const initialization = createSolanaInitializationService({
    store, config, gateway: { ...gateway, async preflight() { throw new Error('Cancellation must not initialize'); } },
    sponsor,
  });
  const recordKey = initialization.recordKey;
  const resolve: typeof solanaServicesFor = async () => ({ config, service, initialization });
  const laneKey = `solana-lane:${createHash('sha256').update(config.genesisHash + ':' + config.tenancyAddress).digest('hex')}`;
  return { store, landlord, tenant, arbitrator, listing, agreement, invitation, snapshot, state, recordKey, resolve, laneKey };
}

test('either party can cancel an uninitialized tenancy, closing its listing and invitation', async () => {
  const f = await fixture(false);
  try {
    const next = await cancelAgreement(f.store, f.agreement.id, f.tenant, f.resolve);
    assert.equal(next.cancelled?.by, 'tenant');
    assert.equal(next.revision, f.agreement.revision + 1);
    assert.match(next.records.at(-1)!.body, /Cancelled by the tenant.*Nothing was locked/);
    assert.equal((await f.store.get<Listing>(`listing:${f.listing.id}`))!.status, 'closed');
    const publicHome = (await listListings(f.store, null)).find((listing) => listing.id === f.listing.id)!;
    assert.equal(publicHome.status, 'closed');
    assert.equal(publicHome.agreementId, null, 'the public grid sees availability, not the private tenancy');
    await assert.rejects(joinAgreement(f.store, f.agreement.id, f.arbitrator, 'arbitrator', f.invitation.token), /cancelled/);
    await assert.rejects(acceptAgreement(f.store, f.agreement.id, f.tenant, 'unused'), /cancelled/);
    await assert.rejects(cancelAgreement(f.store, f.agreement.id, f.landlord, f.resolve), /cancelled/);
    const cancelled = (await f.store.get<Agreement>(`agreement:${f.agreement.id}`))!;
    const journey = await tenancyJourney(f.store, f.landlord, cancelled, f.resolve);
    assert.equal(journey.next.kind, 'cancelled');
    assert.equal(journey.cancellable, false);
    assert.match(journey.next.detail, /tenant.*Nothing was locked/);
    assert.ok(f.state.reads > 0, 'chain absence is observed on the server');
  } finally { await f.store.close(); }
});

test('awaiting-funding cancellation is terminal for every party, but direct on-chain funding restores settlement', async () => {
  const f = await fixture();
  try {
    f.state.exists = true;
    await f.store.create(f.recordKey, { state: 'finalized', setupMode: 'staged', agreementId: f.agreement.id, signatures: {}, signedTxBase64: null });
    await cancelAgreement(f.store, f.agreement.id, f.landlord, f.resolve);
    const next = (await f.store.get<Agreement>(`agreement:${f.agreement.id}`))!;
    for (const identity of [f.landlord, f.tenant, f.arbitrator])
      assert.equal((await tenancyJourney(f.store, identity, next, f.resolve)).next.kind, 'cancelled');
    f.snapshot.tenancy.phase = 'active';
    f.snapshot.tenancy.accountedIdleAtomic = f.agreement.requiredSecurity;
    const recovered = await tenancyJourney(f.store, f.landlord, next, f.resolve);
    assert.equal(recovered.stage, 'living');
    assert.equal(recovered.next.kind, 'propose_claim');
    assert.equal(recovered.cancellable, false);
  } finally { await f.store.close(); }
});

for (const initState of ['signed', 'broadcast', 'unknown']) {
  test(`cancellation refuses initialization ${initState}`, async () => {
    const f = await fixture();
    try {
      await f.store.create(f.recordKey, { state: initState, agreementId: f.agreement.id, signatures: {}, signedTxBase64: null });
      await assert.rejects(cancelAgreement(f.store, f.agreement.id, f.landlord, f.resolve), /initialization is still confirming/);
      assert.equal((await f.store.get<Agreement>(`agreement:${f.agreement.id}`))!.cancelled, undefined);
    } finally { await f.store.close(); }
  });
}
for (const operationState of ['signed', 'broadcast', 'unknown']) {
  test(`cancellation refuses funding ${operationState} even when the other party submitted it`, async () => {
    const f = await fixture();
    try {
      f.state.exists = true;
      await f.store.create(f.laneKey, { operations: [{ state: operationState, action: { kind: 'fund' }, walletId: f.tenant.wallets[0].id } as SolanaOperation] });
      await assert.rejects(cancelAgreement(f.store, f.agreement.id, f.landlord, f.resolve), /funding operation is in flight/);
    } finally { await f.store.close(); }
  });
}
for (const phase of ['active', 'claim-proposed', 'disputed', 'closed'] as const) {
  test(`cancellation refuses funded phase ${phase}`, async () => {
    const f = await fixture();
    try {
      f.state.exists = true; f.snapshot.tenancy.phase = phase;
      await assert.rejects(cancelAgreement(f.store, f.agreement.id, f.tenant, f.resolve), /deposit has been secured/);
    } finally { await f.store.close(); }
  });
}

test('arbitrators and unverified wallets cannot cancel, and chain read failures do not cancel', async () => {
  const f = await fixture();
  try {
    await assert.rejects(cancelAgreement(f.store, f.agreement.id, f.arbitrator, f.resolve), /Only the landlord or tenant/);
    await assert.rejects(cancelAgreement(f.store, f.agreement.id, { ...f.tenant, wallets: f.landlord.wallets }, f.resolve), /not a verified party/);
    await assert.rejects(cancelAgreement(f.store, f.agreement.id, f.landlord, async () => { throw new Error('RPC unavailable'); }), /RPC unavailable/);
    assert.equal((await f.store.get<Agreement>(`agreement:${f.agreement.id}`))!.cancelled, undefined);
  } finally { await f.store.close(); }
});

test('the landlord can cancel while the tenant invitation is still pending', async () => {
  const store = new LocalStore(':memory:');
  const landlord = person('landlord', 1);
  try {
    const agreement = await createAgreement(store, landlord, {
      network: 'solana', property: 'An unchosen home', requiredSecurity: '10000000', releaseAllowed: false,
    });
    const invitation = await inviteToAgreement(store, agreement.id, landlord, 'tenant');
    const cancelled = await cancelAgreement(store, agreement.id, landlord);
    assert.equal(cancelled.cancelled?.by, 'landlord');
    await assert.rejects(joinAgreement(store, agreement.id, person('tenant', 2), 'tenant', invitation.token), /cancelled/);
  } finally { await store.close(); }
});
