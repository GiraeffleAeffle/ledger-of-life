import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  address,
  generateKeyPairSigner,
  getAddressDecoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from '@solana/kit';
import { LocalStore } from './store.ts';
import { agreementDigest, type Agreement } from './agreements.ts';
import {
  createSolanaInitializationService,
  leaseIdForAgreement,
  payoutTokenAccount,
  type InitializationGateway,
  type SolanaInitialization,
} from './solana-initialization.ts';
import type { SolanaConfiguration, SolanaSnapshot } from './solana-rpc.ts';
import { deriveEscrowAddresses, ledgerDepositMint, SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/index.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';

const addressFor = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
async function fixture(setupMode: 'joint' | 'staged' = 'joint', depositMint?: string) {
  const [tenant, landlord, arbitrator, sponsor] = await Promise.all(
    Array.from({ length: 4 }, () => generateKeyPairSigner()),
  );
  const store = new LocalStore(':memory:');
  const identity = (role: string, signer: typeof tenant): VerifiedIdentity => ({
    subject: `did:privy:${role}`,
    sessionId: `${role}-session`,
    expiresAt: 9999999999,
    wallets: [{ id: `${role}-wallet`, address: signer.address, chainType: 'solana' }],
    passkeyCount: 1,
    backupLoginLinked: true,
  });
  const identities = {
    tenant: identity('tenant', tenant),
    landlord: identity('landlord', landlord),
    arbitrator: identity('arbitrator', arbitrator),
  };
  const agreement: Agreement = {
    id: 'one-accepted-demo',
    network: 'solana',
    property: 'A reviewed test apartment',
    requiredSecurity: '10000000',
    releaseAllowed: true,
    createdAt: new Date(0).toISOString(),
    revision: 0,
    parties: {
      tenant: { subject: identities.tenant.subject, wallet: identities.tenant.wallets[0] },
      landlord: { subject: identities.landlord.subject, wallet: identities.landlord.wallets[0] },
      arbitrator: { subject: identities.arbitrator.subject, wallet: identities.arbitrator.wallets[0] },
    },
    invitations: {},
    accepted: {},
    records: [],
  };
  const digest = agreementDigest(agreement)!;
  agreement.accepted = {
    tenant: { digest, at: new Date(0).toISOString() },
    landlord: { digest, at: new Date(0).toISOString() },
  };
  await store.create(`agreement:${agreement.id}`, agreement);
  const config = {
    setupMode,
    cluster: 'devnet',
    genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash,
    escrowProgram: addressFor(10),
    programSha256: 'a'.repeat(64),
    depositMint: SOLANA_DEVNET_MANIFEST.deposit.mint,
    ledgerDepositMint: depositMint,
    market: addressFor(11),
    reserve: addressFor(12),
    receiptMint: addressFor(13),
    liquiditySupply: addressFor(14),
    marketAuthority: addressFor(15),
    oracleAccounts: [],
    maxObservationAgeMs: 15000,
    rpcUrl: 'https://rpc.example',
    agreementId: agreement.id,
    programCodeLength: 1000,
    upgradeAuthority: null,
    maximumSponsorLamports: '10000000',
    tenancyAddress: addressFor(16),
  } satisfies SolanaConfiguration;
  const leaseId = leaseIdForAgreement(config, agreement.id);
  const derived = await deriveEscrowAddresses(config.escrowProgram, tenant.address, leaseId);
  config.tenancyAddress = derived.tenancy;
  const [tenantDestination, landlordDestination] = await Promise.all([
    payoutTokenAccount(config, tenant.address),
    payoutTokenAccount(config, landlord.address),
  ]);
  const snapshot: SolanaSnapshot = {
    genesisHash: config.genesisHash,
    slot: '101',
    cashAtomic: '0',
    receiptsAtomic: '0',
    tenantCashAtomic: '10000000',
    landlordCashAtomic: '0',
    receiptValueAtomic: '0',
    availableLiquidityAtomic: '10000000',
    requiresRefresh: false,
    tenancy: {
      address: derived.tenancy,
      leaseId,
      tenant: tenant.address,
      landlord: landlord.address,
      arbitrator: arbitrator.address,
      depositMint: ledgerDepositMint(config),
      reserve: config.reserve,
      market: config.market,
      receiptMint: config.receiptMint,
      liquiditySupply: config.liquiditySupply,
      marketAuthority: config.marketAuthority,
      tenantDestination,
      landlordDestination,
      policyHash: new Uint8Array(Buffer.from(digest.slice(2), 'hex')),
      releasePermitted: true,
      requiredSecurityAtomic: agreement.requiredSecurity,
      accountedIdleAtomic: '0',
      accountedReceiptsAtomic: '0',
      releasedEarningsAtomic: '0',
      nextNonce: '0',
      claimAtomic: '0',
      approvedClaimAtomic: '0',
      phase: 'awaiting-funding',
      tenantOwedAtomic: '0',
      landlordOwedAtomic: '0',
      bump: derived.bump,
    },
  };
  const state = { now: 100000, blockHeight: '100', lastValidBlockHeight: '300', blockhash: addressFor(30), sponsorCost: '8500000', final: false, accountExists: false, sent: [] as string[], preflights: 0 };
  const gateway: InitializationGateway = {
    preflight: async (input) => {
      state.preflights++;
      if (state.accountExists) throw new Error('Tenancy already exists');
      assert.equal(input.tenancyAddress, derived.tenancy);
      assert.equal(input.tenantDestination, tenantDestination);
      assert.equal(input.landlordDestination, landlordDestination);
    },
    lifetime: async () => ({ blockhash: state.blockhash, lastValidBlockHeight: state.lastValidBlockHeight, blockHeight: state.blockHeight }),
    simulate: async () => ({ slot: '100', sponsorDebitCeilingLamports: state.sponsorCost, networkFeeLamports: '15000' }),
    broadcast: async (bytes) => {
      const recordId = createHash('sha256')
        .update(`${config.genesisHash}:${config.tenancyAddress}`)
        .digest('hex');
      const record = await store.get<SolanaInitialization>(`solana-initialization:${recordId}`);
      assert.equal(record?.signedTxBase64, Buffer.from(bytes).toString('base64'));
      assert.equal(record?.state, 'signed');
      state.sent.push(Buffer.from(bytes).toString('base64'));
      assert.ok(record.signature);
      return record.signature;
    },
    reconcile: async (signature) => state.final
      ? { status: 'finalized', signature, slot: '101', deltas: [] }
      : { status: 'unknown', reason: 'signature-not-observed-do-not-resubmit-new-intent' },
    snapshot: async () => structuredClone(snapshot),
  };
  const feeSponsor = {
    address: sponsor.address,
    sign: async (bytes: Uint8Array) =>
      new Uint8Array(getTransactionEncoder().encode(
        await partiallySignTransaction([sponsor.keyPair], getTransactionDecoder().decode(bytes)),
      )),
  };
  const recoveryGate = async () => ({ wallet: identities.tenant.wallets[0], proof: null });
  const service = createSolanaInitializationService({
    store, config, gateway, sponsor: feeSponsor, now: () => state.now,
    recoveryGate: recoveryGate as never,
  });
  const sign = async (encoded: string, actor: typeof tenant) =>
    Buffer.from(getTransactionEncoder().encode(
      await partiallySignTransaction(
        [actor.keyPair],
        getTransactionDecoder().decode(Buffer.from(encoded, 'base64')),
      ),
    )).toString('base64');
  return { store, config, state, service, identities, tenant, landlord, arbitrator, sign, snapshot };
}

test('new site-dollar initialization uses its own mint and canonical payout accounts', async () => {
  const f = await fixture('staged', SOLANA_TEST_USDC_MINT);
  try {
    const plan = await f.service.prepare(f.identities.landlord);
    assert.equal(plan.depositMint, SOLANA_TEST_USDC_MINT);
    assert.equal(plan.tenantDestination, f.snapshot.tenancy.tenantDestination);
    const transaction = getTransactionDecoder().decode(Buffer.from(plan.transactionBase64, 'base64'));
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    assert.ok(message.staticAccounts.includes(address(SOLANA_TEST_USDC_MINT)));
    assert.ok(!message.staticAccounts.includes(address(SOLANA_DEVNET_MANIFEST.deposit.mint)));
    const submitted = await f.service.sign(f.identities.landlord, await f.sign(plan.transactionBase64, f.landlord));
    assert.equal(submitted.state, 'broadcast');
    f.state.final = true;
    assert.equal((await f.service.reconcile(f.identities.landlord)).state, 'finalized');
  } finally {
    await f.store.close();
  }
});

test('a pending Circle initialization reconciles after new deposits switch to site dollars', async () => {
  const f = await fixture('staged');
  try {
    const plan = await f.service.prepare(f.identities.landlord);
    await f.service.sign(f.identities.landlord, await f.sign(plan.transactionBase64, f.landlord));
    f.config.ledgerDepositMint = SOLANA_TEST_USDC_MINT;
    f.state.final = true;
    const result = await f.service.reconcile(f.identities.landlord);
    assert.equal(result.state, 'finalized');
    assert.equal(result.depositMint, SOLANA_DEVNET_MANIFEST.deposit.mint);
  } finally {
    await f.store.close();
  }
});


test('separate recovered wallets sign one accepted agreement; sponsor persists before send', async () => {
  const f = await fixture();
  const plan = await f.service.prepare(f.identities.tenant);
  assert.equal(plan.policyHash, agreementDigest((await f.store.get<Agreement>('agreement:one-accepted-demo'))!)!.slice(2));
  assert.equal(plan.tenancyAddress, f.config.tenancyAddress);
  assert.deepEqual(plan.signedRoles, []);
  const same = await f.service.prepare(f.identities.landlord);
  assert.equal(same.messageSha256, plan.messageSha256);
  const first = await f.service.sign(f.identities.tenant, await f.sign(plan.transactionBase64, f.tenant));
  assert.deepEqual(first.signedRoles, ['tenant']);
  assert.equal(f.state.sent.length, 0);
  const second = await f.service.sign(f.identities.landlord, await f.sign(plan.transactionBase64, f.landlord));
  assert.deepEqual(second.signedRoles, ['tenant', 'landlord']);
  assert.equal(second.state, 'broadcast');
  assert.equal(f.state.sent.length, 1);
  f.state.final = true;
  const final = await f.service.reconcile(f.identities.arbitrator);
  assert.equal(final.state, 'finalized');
  assert.equal(final.signature, second.signature);
  await f.store.close();
});

test('staged setup needs only the landlord; the tenant remains the sole funding signer', async () => {
  const f = await fixture('staged');
  await assert.rejects(f.service.prepare(f.identities.tenant), /Only the landlord/);
  const plan = await f.service.prepare(f.identities.landlord);
  assert.equal(plan.setupMode, 'staged');
  const tx = getTransactionDecoder().decode(Buffer.from(plan.transactionBase64, 'base64'));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.deepEqual([...Buffer.from(compiled.instructions[1].data!).subarray(0, 8)], [168, 74, 32, 26, 236, 97, 244, 1]);
  assert.ok(Object.hasOwn(tx.signatures, f.landlord.address));
  assert.equal(tx.signatures[f.tenant.address], undefined);
  const sent = await f.service.sign(f.identities.landlord, await f.sign(plan.transactionBase64, f.landlord));
  assert.deepEqual(sent.signedRoles, ['landlord']);
  assert.equal(sent.state, 'broadcast');
  assert.equal(f.state.sent.length, 1);
  f.state.final = true;
  const final = await f.service.reconcile(f.identities.tenant);
  assert.equal(final.state, 'finalized');
  assert.equal(f.snapshot.tenancy.phase, 'awaiting-funding');
  assert.equal(f.snapshot.cashAtomic, '0');
  await f.store.close();
});

test('finalized setup remains finalized after funding and claim transitions, but not changed terms', async () => {
  for (const phase of ['active', 'claim-proposed', 'disputed', 'settling', 'closed'] as const) {
    const f = await fixture('staged');
    try {
      const plan = await f.service.prepare(f.identities.landlord);
      await f.service.sign(f.identities.landlord, await f.sign(plan.transactionBase64, f.landlord));
      f.state.final = true;
      f.snapshot.tenancy.phase = phase;
      assert.equal((await f.service.reconcile(f.identities.tenant)).state, 'finalized');
    } finally {
      await f.store.close();
    }
  }
  const f = await fixture('staged');
  try {
    const plan = await f.service.prepare(f.identities.landlord);
    await f.service.sign(f.identities.landlord, await f.sign(plan.transactionBase64, f.landlord));
    f.state.final = true;
    f.snapshot.tenancy.phase = 'active';
    f.snapshot.tenancy.tenantDestination = addressFor(22);
    assert.equal((await f.service.reconcile(f.identities.tenant)).state, 'unknown');
  } finally {
    await f.store.close();
  }
});
test('changed message, wrong signer and expired blockhash cannot authorize setup', async () => {
  const f = await fixture();
  const plan = await f.service.prepare(f.identities.tenant);
  const wrong = await f.sign(plan.transactionBase64, f.landlord);
  await assert.rejects(f.service.sign(f.identities.tenant, wrong), /signature did not verify/);
  const modified = Buffer.from(plan.transactionBase64, 'base64');
  modified[modified.length - 1] ^= 1;
  const changed = modified.toString('base64');
  await assert.rejects(f.service.sign(f.identities.tenant, changed), /message differs/);
  f.state.blockHeight = '300';
  await assert.rejects(
    f.service.sign(f.identities.tenant, await f.sign(plan.transactionBase64, f.tenant)),
    /Refresh the initialization/,
  );
  await f.store.close();
});

test('sponsor rent ceiling fails before signature collection', async () => {
  const f = await fixture();
  f.state.sponsorCost = '10000001';
  await assert.rejects(f.service.prepare(f.identities.tenant), /sponsor limit/);
  assert.equal((await f.service.status(f.identities.tenant)).initialization, null);
  await f.store.close();
});


test('expired unobserved setup can be replaced only after final block height and absence check', async () => {
  const f = await fixture();
  const first = await f.service.prepare(f.identities.landlord);
  await f.service.sign(f.identities.landlord, await f.sign(first.transactionBase64, f.landlord));
  const broadcast = await f.service.sign(f.identities.tenant, await f.sign(first.transactionBase64, f.tenant));
  assert.equal(broadcast.state, 'broadcast');
  const unknown = await f.service.reconcile(f.identities.landlord);
  assert.equal(unknown.state, 'unknown');
  const initialPreflights = f.state.preflights;

  const stillLive = await f.service.prepare(f.identities.landlord);
  assert.equal(stillLive.messageSha256, first.messageSha256);
  assert.equal(f.state.preflights, initialPreflights);

  f.state.blockHeight = '301';
  f.state.blockhash = addressFor(31);
  f.state.lastValidBlockHeight = '500';
  f.state.accountExists = true;
  await assert.rejects(f.service.prepare(f.identities.landlord), /Tenancy already exists/);
  assert.equal((await f.service.status(f.identities.tenant)).initialization?.signature, broadcast.signature);

  f.state.accountExists = false;
  const fresh = await f.service.prepare(f.identities.landlord);
  assert.equal(fresh.state, 'prepared');
  assert.notEqual(fresh.messageSha256, first.messageSha256);
  assert.deepEqual(fresh.signedRoles, []);
  assert.equal(fresh.signature, null);
  assert.equal(f.state.preflights, initialPreflights + 2);
  await f.store.close();
});
