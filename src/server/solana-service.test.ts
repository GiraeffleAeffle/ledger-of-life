import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  address,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from '@solana/kit';
import { LocalStore } from './store.ts';
import { agreementDigest, type Agreement } from './agreements.ts';
import { createSolanaService, decodeSolanaAction, type SolanaOperation } from './solana-service.ts';
import {
  RpcSolanaGateway,
  EscrowAbsentError,
  solanaConfiguration,
  verifyDeployedProgram,
  type SolanaConfiguration,
  type SolanaGateway,
  type SolanaSnapshot,
} from './solana-rpc.ts';
import { RpcInitializationGateway } from './solana-initialization.ts';
import {
  deriveEscrowAddresses,
  deriveKaminoAddresses,
  derivePayoutAddress,
  SOLANA_DEVNET_MANIFEST,
  SOLANA_IDS,
  SOLANA_MAINNET_MANIFEST,
  SOLANA_TEST_USDC_MINT,
} from '../finance/solana/index.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';

const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
async function fixture() {
  const [tenant, landlord, arbitrator, sponsor] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const store = new LocalStore(':memory:');
  const identity: VerifiedIdentity = {
    subject: 'did:privy:tenant',
    sessionId: 'fresh-session',
    expiresAt: 9999999999,
    wallets: [{ id: 'tenant-wallet', address: tenant.address, chainType: 'solana' }],
    passkeyCount: 1,
  };
  const agreement: Agreement = {
    id: 'agreement_fixture',
    network: 'solana',
    property: 'Fixture apartment',
    requiredSecurity: '3000000000',
    releaseAllowed: true,
    createdAt: new Date(0).toISOString(),
    revision: 0,
    parties: {
      tenant: { subject: identity.subject, wallet: identity.wallets[0] },
      landlord: {
        subject: 'did:privy:landlord',
        wallet: { id: 'landlord-wallet', address: landlord.address, chainType: 'solana' },
      },
      arbitrator: {
        subject: 'did:privy:arbitrator',
        wallet: { id: 'arbitrator-wallet', address: arbitrator.address, chainType: 'solana' },
      },
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
  const leaseId = new Uint8Array(32).fill(1),
    derived = await deriveEscrowAddresses(key(10), tenant.address, leaseId);
  const config: SolanaConfiguration = {
    setupMode: 'joint',
    cluster: 'devnet',
    genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash,
    escrowProgram: key(10),
    programSha256: 'a'.repeat(64),
    depositMint: SOLANA_DEVNET_MANIFEST.deposit.mint,
    reserve: key(11),
    market: key(12),
    receiptMint: key(13),
    liquiditySupply: key(14),
    marketAuthority: key(15),
    oracleAccounts: [],
    maxObservationAgeMs: 15000,
    rpcUrl: 'https://rpc.example',
    agreementId: agreement.id,
    tenancyAddress: derived.tenancy,
    programCodeLength: 1000,
    upgradeAuthority: null,
    maximumSponsorLamports: '100000',
  };
  const snapshot: SolanaSnapshot = {
    genesisHash: config.genesisHash,
    slot: '50',
    cashAtomic: '0',
    receiptsAtomic: '0',
    tenantCashAtomic: '3000000000',
    landlordCashAtomic: '0',
    receiptValueAtomic: '0',
    availableLiquidityAtomic: '10000000000',
    requiresRefresh: false,
    tenancy: {
      address: derived.tenancy,
      leaseId,
      tenant: tenant.address,
      landlord: landlord.address,
      arbitrator: arbitrator.address,
      depositMint: config.depositMint,
      reserve: config.reserve,
      market: config.market,
      receiptMint: config.receiptMint,
      liquiditySupply: config.liquiditySupply,
      marketAuthority: config.marketAuthority,
      tenantDestination: await derivePayoutAddress(tenant.address, config.depositMint),
      landlordDestination: await derivePayoutAddress(landlord.address, config.depositMint),
      policyHash: new Uint8Array(Buffer.from(digest.slice(2), 'hex')),
      releasePermitted: true,
      requiredSecurityAtomic: '3000000000',
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
  const state = {
    now: 100000,
    sponsorCalls: 0,
    simulations: 0,
    sponsorCost: '20000',
    broadcasts: [] as string[],
    ambiguous: false,
    receiptFinal: false,
    receiptReason: 'signature-not-observed-do-not-resubmit-new-intent',
    blockHeight: '100',
    lifetimeUnavailable: false,
  };
  const gateway: SolanaGateway = {
    snapshot: async () => structuredClone(snapshot),
    blockHeight: async () => state.blockHeight,
    lifetime: async () => {
      if (state.lifetimeUnavailable) throw new Error('RPC height unavailable');
      return { blockhash: key(30), lastValidBlockHeight: '150', blockHeight: state.blockHeight };
    },
    simulate: async () => {
      state.simulations++;
      return {
        slot: '50',
        sponsorDebitCeilingLamports: state.sponsorCost,
        networkFeeLamports: '10000',
      };
    },
    broadcast: async (bytes) => {
      const records = await store.scan<{ operations: SolanaOperation[] }>('solana-lane:');
      const saved = records[0].value.operations[0];
      assert.ok(['signed', 'unknown', 'broadcast'].includes(saved.state));
      assert.equal(saved.signedTxBase64, Buffer.from(bytes).toString('base64'));
      assert.ok(saved.signature);
      state.broadcasts.push(Buffer.from(bytes).toString('base64'));
      if (state.ambiguous) throw new Error('timeout after send');
      return saved.signature;
    },
    reconcile: async (signature) =>
      state.receiptFinal
        ? { status: 'finalized', signature, slot: '51', deltas: [] }
        : { status: 'unknown', reason: state.receiptReason },
  };
  const feeSponsor = {
    address: sponsor.address,
    sign: async (bytes: Uint8Array) => {
      state.sponsorCalls++;
      return new Uint8Array(
        getTransactionEncoder().encode(
          await partiallySignTransaction([sponsor.keyPair], getTransactionDecoder().decode(bytes)),
        ),
      );
    },
  };
  const dependencies = {
    store,
    config,
    gateway,
    sponsor: feeSponsor,
    now: () => state.now,
  };
  const service = createSolanaService(dependencies);
  const sign = async (op: { transactionBase64: string }) =>
    Buffer.from(
      getTransactionEncoder().encode(
        await partiallySignTransaction(
          [tenant.keyPair],
          getTransactionDecoder().decode(Buffer.from(op.transactionBase64, 'base64')),
        ),
      ),
    ).toString('base64');
  return {
    store,
    identity,
    agreement,
    config,
    snapshot,
    state,
    gateway,
    dependencies,
    service,
    sign,
    tenant,
    sponsor,
  };
}

test('site test dollars fund cash only and forbid lending earnings even with donated cash', async () => {
  const f = await fixture();
  try {
    f.config.ledgerDepositMint = SOLANA_TEST_USDC_MINT;
    const t = f.snapshot.tenancy;
    t.depositMint = SOLANA_TEST_USDC_MINT;
    t.tenantDestination = await derivePayoutAddress(t.tenant, t.depositMint);
    t.landlordDestination = await derivePayoutAddress(t.landlord, t.depositMint);
    const op = await f.service.prepare(f.identity, 'test_dollars_funding', { kind: 'fund_and_supply' });
    assert.equal(op.action.kind, 'fund');
    assert.equal(op.steps, 1);
    const cash = (await deriveEscrowAddresses(f.config.escrowProgram, t.tenant, t.leaseId)).cash;
    assert.deepEqual(op.expectedDeltas.map((delta) => [delta.account, delta.mint, delta.direction, delta.minimumAtomic]), [
      [t.tenantDestination, SOLANA_TEST_USDC_MINT, 'debit', t.requiredSecurityAtomic],
      [cash, SOLANA_TEST_USDC_MINT, 'credit', t.requiredSecurityAtomic],
    ]);
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    f.state.receiptFinal = true;
    f.snapshot.slot = '51';
    t.nextNonce = '1';
    t.phase = 'active';
    t.accountedIdleAtomic = '3001000000';
    f.snapshot.cashAtomic = t.accountedIdleAtomic;
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'finalized');
    for (const action of [
      { kind: 'supply', amountAtomic: '3000000000' },
      { kind: 'release_earnings', amountAtomic: '1000000' },
    ]) {
      await assert.rejects(f.service.prepare(f.identity, `forbidden_${action.kind}`, action),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'action_not_available');
    }
  } finally {
    await f.store.close();
  }
});

test('an existing Circle tenancy keeps Circle ATAs and fund plus supply after configuration cutover', async () => {
  const f = await fixture();
  try {
    f.config.ledgerDepositMint = SOLANA_TEST_USDC_MINT;
    const view = await f.service.snapshot(f.identity);
    assert.equal(view.tenancy.depositMint, SOLANA_DEVNET_MANIFEST.deposit.mint);
    const op = await f.service.prepare(f.identity, 'legacy_circle_funding', { kind: 'fund_and_supply' });
    assert.equal(op.action.kind, 'fund_and_supply');
    assert.equal(op.steps, 2);
    assert.deepEqual(op.expectedDeltas.map((delta) => [delta.account, delta.mint, delta.direction]), [
      [f.snapshot.tenancy.tenantDestination, SOLANA_DEVNET_MANIFEST.deposit.mint, 'debit'],
      [(await deriveEscrowAddresses(f.config.escrowProgram, f.tenant.address, f.snapshot.tenancy.leaseId)).receipts, f.config.receiptMint, 'credit'],
    ]);
    f.snapshot.tenancy.tenantDestination = await derivePayoutAddress(f.tenant.address, SOLANA_TEST_USDC_MINT);
    await assert.rejects(f.service.snapshot(f.identity),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'tenancy_binding_mismatch');
  } finally {
    await f.store.close();
  }
});

test('RPC uses each tenancy mint while new cash-only initialization retains the Circle reserve', async () => {
  const f = await fixture();
  try {
    f.config.ledgerDepositMint = SOLANA_TEST_USDC_MINT;
    f.config.marketAuthority = (await deriveKaminoAddresses(f.config.reserve, f.config.market)).marketAuthority;
    const t = f.snapshot.tenancy;
    t.marketAuthority = f.config.marketAuthority;
    const derived = await deriveEscrowAddresses(f.config.escrowProgram, t.tenant, t.leaseId);
    const code = new Uint8Array(1000).fill(1);
    f.config.programSha256 = createHash('sha256').update(code).digest('hex');
    const immutableLoader = 'BPFLoader2111111111111111111111111111111111';
    const rows = new Map<string, { owner: string; executable: boolean; lamports: number; data: [string, string] }>();
    const put = (key: string, owner: string, data: Uint8Array, executable = false) =>
      rows.set(key, { owner, executable, lamports: 1_000_000, data: [Buffer.from(data).toString('base64'), 'base64'] });
    const writeKey = (data: Uint8Array, offset: number, key: string) =>
      data.set(getAddressEncoder().encode(address(key)), offset);
    const token = (mint: string, owner: string, amount: bigint) => {
      const data = new Uint8Array(165);
      writeKey(data, 0, mint);
      writeKey(data, 32, owner);
      new DataView(data.buffer).setBigUint64(64, amount, true);
      data[108] = 1;
      return data;
    };
    const mint = (authority?: string) => {
      const data = new Uint8Array(82);
      data[44] = 6;
      data[45] = 1;
      if (authority) {
        new DataView(data.buffer).setUint32(0, 1, true);
        writeKey(data, 4, authority);
      }
      return data;
    };
    const reserve = new Uint8Array(8624);
    reserve.set([43, 242, 204, 202, 26, 247, 59, 127]);
    for (const [offset, key] of [[32, f.config.market], [128, f.config.depositMint], [160, f.config.liquiditySupply], [408, SOLANA_IDS.token], [2560, f.config.receiptMint]] as const)
      writeKey(reserve, offset, key);
    const reserveView = new DataView(reserve.buffer);
    reserveView.setBigUint64(16, 50n, true);
    reserveView.setBigUint64(224, 10_000_000_000n, true);
    reserveView.setBigUint64(272, 6n, true);
    const market = new Uint8Array(4664);
    market.set([246, 114, 50, 98, 72, 157, 28, 120]);
    put(f.config.escrowProgram, immutableLoader, code, true);
    put(SOLANA_IDS.klend, immutableLoader, new Uint8Array(), true);
    put(f.config.reserve, SOLANA_IDS.klend, reserve);
    put(f.config.market, SOLANA_IDS.klend, market);
    put(f.config.liquiditySupply, SOLANA_IDS.token, token(f.config.depositMint, f.config.marketAuthority, 10_000_000_000n));
    put(f.config.receiptMint, SOLANA_IDS.token, mint(f.config.marketAuthority));
    put(SOLANA_TEST_USDC_MINT, SOLANA_IDS.token, mint());
    put(f.config.depositMint, SOLANA_IDS.token, mint());
    const fetcher: typeof fetch = async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      const result = request.method === 'getGenesisHash' ? f.config.genesisHash
        : request.method === 'getMultipleAccounts'
          ? { context: { slot: 50 }, value: request.params[0].map((key: string) => rows.get(key) ?? null) }
          : undefined;
      if (result === undefined) throw new Error('Unexpected RPC method');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    };
    for (const asset of [SOLANA_TEST_USDC_MINT, f.config.depositMint]) {
      t.depositMint = asset;
      t.tenantDestination = await derivePayoutAddress(t.tenant, asset);
      t.landlordDestination = await derivePayoutAddress(t.landlord, asset);
      put(t.tenantDestination, SOLANA_IDS.token, token(asset, t.tenant, 3_000_000_000n));
      put(t.landlordDestination, SOLANA_IDS.token, token(asset, t.landlord, 2_000_000n));
      const data = new Uint8Array(483);
      data.set([251, 53, 106, 214, 69, 170, 131, 234]);
      data.set(t.leaseId, 8);
      let offset = 40;
      for (const key of [t.tenant, t.landlord, t.arbitrator, t.depositMint, t.reserve, t.market, t.receiptMint, t.liquiditySupply, t.marketAuthority, t.tenantDestination, t.landlordDestination]) {
        writeKey(data, offset, key);
        offset += 32;
      }
      data.set(t.policyHash, offset);
      offset += 32;
      data[offset++] = 1;
      const view = new DataView(data.buffer);
      for (const amount of [t.requiredSecurityAtomic, '0', '0', '0', '0', '0', '0']) {
        view.setBigUint64(offset, BigInt(amount), true);
        offset += 8;
      }
      data[offset++] = 0;
      data[offset] = t.bump;
      put(t.address, f.config.escrowProgram, data);
      put(derived.cash, SOLANA_IDS.token, token(asset, t.address, 7_000_000n));
      put(derived.receipts, SOLANA_IDS.token, token(t.receiptMint, t.address, 0n));
      const gateway = new RpcSolanaGateway(f.config, fetcher);
      const observed = await gateway.snapshot();
      assert.equal(observed.tenancy.depositMint, asset);
      assert.equal(observed.cashAtomic, '7000000');
      assert.equal(observed.tenantCashAtomic, '3000000000');
      assert.equal(observed.landlordCashAtomic, '2000000');
      put(derived.cash, SOLANA_IDS.token, token(key(99), t.address, 7_000_000n));
      await assert.rejects(gateway.snapshot(), /finance token account/);
    }
    rows.delete(t.address);
    rows.delete(derived.cash);
    rows.delete(derived.receipts);
    const tenantDestination = await derivePayoutAddress(t.tenant, SOLANA_TEST_USDC_MINT);
    const landlordDestination = await derivePayoutAddress(t.landlord, SOLANA_TEST_USDC_MINT);
    await new RpcInitializationGateway(f.config, fetcher).preflight({
      tenant: t.tenant, landlord: t.landlord, tenantDestination, landlordDestination,
      tenancyAddress: t.address, cashAddress: derived.cash, receiptAddress: derived.receipts,
    });
    // A Circle reserve is still required: the cash-only mint must not loosen its identity pin.
    writeKey(reserve, 128, SOLANA_TEST_USDC_MINT);
    put(f.config.reserve, SOLANA_IDS.klend, reserve);
    await assert.rejects(new RpcInitializationGateway(f.config, fetcher).preflight({
      tenant: t.tenant, landlord: t.landlord, tenantDestination, landlordDestination,
      tenancyAddress: t.address, cashAddress: derived.cash, receiptAddress: derived.receipts,
    }), /Lending account identity mismatch/);
  } finally {
    await f.store.close();
  }
});


test('accepted tenancy rejects a substituted non-ATA payout destination', async () => {
  const f = await fixture();
  try {
    f.snapshot.tenancy.tenantDestination = key(16);
    await assert.rejects(f.service.snapshot(f.identity), (error: unknown) =>
      (error as { code?: string }).code === 'tenancy_binding_mismatch');
    f.snapshot.tenancy.tenantDestination = await derivePayoutAddress(f.tenant.address, f.config.depositMint);
    f.snapshot.tenancy.landlordDestination = key(17);
    await assert.rejects(f.service.prepare(f.identity, 'request_ata_guard', { kind: 'fund' }),
      (error: unknown) => (error as { code?: string }).code === 'tenancy_binding_mismatch');
    assert.equal(f.state.simulations, 0);
  } finally {
    await f.store.close();
  }
});
test('pull settlement records obligations without transfer and payout reviews one exact party credit', async () => {
  const f = await fixture();
  try {
    f.config.escrowVersion = 'pull-v2';
    f.snapshot.tenancy.phase = 'settling';
    f.snapshot.tenancy.nextNonce = '3';
    f.snapshot.tenancy.accountedIdleAtomic = '3000000000';
    f.snapshot.tenancy.approvedClaimAtomic = '120000000';
    const settlement = await f.service.prepare(f.identity, 'request_settle_pull', { kind: 'settle' });
    assert.deepEqual(settlement.expectedDeltas, []);
    assert.equal(settlement.deployment.programSha256, f.config.programSha256);
  } finally {
    await f.store.close();
  }
  const payoutFixture = await fixture();
  try {
    payoutFixture.config.escrowVersion = 'pull-v2';
    payoutFixture.snapshot.tenancy.phase = 'closed';
    payoutFixture.snapshot.tenancy.accountedIdleAtomic = '3000000000';
    payoutFixture.snapshot.tenancy.tenantOwedAtomic = '2880000000';
    payoutFixture.snapshot.tenancy.landlordOwedAtomic = '120000000';
    payoutFixture.snapshot.tenancy.nextNonce = '4';
    const payout = await payoutFixture.service.prepare(payoutFixture.identity, 'request_payout_pull', { kind: 'payout', landlord: true });
    assert.deepEqual(payout.expectedDeltas.map((delta) => [delta.account, delta.direction, delta.minimumAtomic, delta.maximumAtomic]), [
      [(await deriveEscrowAddresses(payoutFixture.config.escrowProgram, payoutFixture.tenant.address, payoutFixture.snapshot.tenancy.leaseId)).cash, 'debit', '120000000', '120000000'],
      [payoutFixture.snapshot.tenancy.landlordDestination, 'credit', '120000000', '120000000'],
    ]);
    payoutFixture.snapshot.tenancy.landlordOwedAtomic = '0';
    await assert.rejects(
      payoutFixture.service.prepare(payoutFixture.identity, 'request_payout_empty', { kind: 'payout', landlord: true }),
      /not available/,
    );
  } finally {
    await payoutFixture.store.close();
  }
});
test('a failed tenant simulation does not stall the landlord, and confirmed failed or expired payouts get fresh attempts', async () => {
  const f = await fixture();
  try {
    f.config.escrowVersion = 'pull-v2';
    f.snapshot.tenancy.phase = 'closed';
    f.snapshot.tenancy.accountedIdleAtomic = '3000000000';
    f.snapshot.tenancy.tenantOwedAtomic = '2880000000';
    f.snapshot.tenancy.landlordOwedAtomic = '120000000';
    f.snapshot.tenancy.nextNonce = '4';
    const simulated: boolean[] = [];
    const originalSimulate = f.gateway.simulate;
    f.gateway.simulate = async (bytes, payer, actor) => {
      const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(bytes).messageBytes);
      const landlord = message.staticAccounts.some((account) => account === f.snapshot.tenancy.landlordDestination);
      simulated.push(landlord);
      if (!landlord) throw new Error('Exact transaction simulation failed');
      return originalSimulate(bytes, payer, actor);
    };
    f.gateway.broadcast = async (bytes) => {
      const records = await f.store.scan<{ operations: SolanaOperation[] }>('solana-lane:');
      const saved = records[0].value.operations.find((op) => op.signedTxBase64 === Buffer.from(bytes).toString('base64'));
      assert.equal(saved?.state, 'signed');
      assert.ok(saved.signature);
      f.state.broadcasts.push(Buffer.from(bytes).toString('base64'));
      return saved.signature;
    };
    const first = await f.service.payout(f.identity);
    assert.equal(first?.action.kind === 'payout' && first.action.landlord, true);
    assert.equal(first?.state, 'broadcast');
    assert.deepEqual(simulated, [false, true]);
    const firstLane = (await f.store.scan<{ payoutAttempts?: { side: string }[]; operations: SolanaOperation[] }>('solana-lane:'))[0].value;
    assert.deepEqual(firstLane.payoutAttempts?.map((attempt) => attempt.side), ['tenant']);
    assert.equal(firstLane.operations.length, 1);
    f.gateway.lifetime = async () => ({
      blockhash: key(31), blockHeight: f.state.blockHeight, lastValidBlockHeight: '150',
    });

    f.gateway.reconcile = async (signature) =>
      signature === first?.signature
        ? { status: 'failed', reason: 'confirmed-on-chain-failure' }
        : { status: 'unknown', reason: 'signature-not-observed-do-not-resubmit-new-intent' };
    const replacement = await f.service.payout(f.identity);
    assert.equal(replacement?.state, 'broadcast');
    assert.equal(replacement?.action.kind === 'payout' && replacement.action.landlord, true);
    assert.notEqual(replacement?.id, first?.id);
    assert.equal((await f.service.get(f.identity, first!.id)).state, 'failed');
    assert.deepEqual(simulated, [false, true, false, true]);

    // Absence alone is ambiguous; an expired finalized block height permits replacement.
    assert.equal((await f.service.payout(f.identity))?.id, replacement?.id);
    f.state.blockHeight = '151';
    f.gateway.lifetime = async () => ({
      blockhash: key(32), blockHeight: f.state.blockHeight, lastValidBlockHeight: '201',
    });
    const afterExpiry = await f.service.payout(f.identity);
    assert.equal((await f.service.get(f.identity, replacement!.id)).state, 'expired');
    assert.equal(afterExpiry?.state, 'broadcast');
    assert.equal(afterExpiry?.action.kind === 'payout' && afterExpiry.action.landlord, true);
    assert.notEqual(afterExpiry?.id, replacement?.id);
    assert.equal(f.state.broadcasts.length, 3);
  } finally {
    await f.store.close();
  }
});
test('bundles sign fixed instruction sequences with net token effects and pull-v2-only settlement', async () => {
  const f = await fixture();
  try {
    const t = f.snapshot.tenancy;
    const cash = (await deriveEscrowAddresses(f.config.escrowProgram, f.tenant.address, t.leaseId)).cash;
    const deposit = await f.service.prepare(f.identity, 'request_bundle_fund', { kind: 'fund_and_supply' });
    assert.equal(deposit.steps, 2);
    // The escrow cash hop cancels out; only the tenant debit and receipt credit remain.
    assert.deepEqual(deposit.expectedDeltas.map((delta) => [delta.account, delta.direction]), [
      [t.tenantDestination, 'debit'],
      [(await deriveEscrowAddresses(f.config.escrowProgram, f.tenant.address, t.leaseId)).receipts, 'credit'],
    ]);
    assert.ok(!deposit.expectedDeltas.some((delta) => delta.account === cash));
    t.phase = 'claim-proposed';
    t.nextNonce = '4';
    await assert.rejects(
      f.service.prepare(f.identity, 'request_bundle_legacy', { kind: 'accept_and_settle' }),
      /not available/,
    );
    f.config.escrowVersion = 'pull-v2';
    t.accountedReceiptsAtomic = '2990000000';
    const settle = await f.service.prepare(f.identity, 'request_bundle_settle', { kind: 'accept_and_settle' });
    assert.equal(settle.steps, 3);
    assert.deepEqual(settle.expectedDeltas.map((delta) => delta.direction), ['debit', 'credit']);
  } finally {
    await f.store.close();
  }
});
test('prepare is idempotent, reserves one nonce and persists exact bytes before broadcast', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    assert.equal(op.nonce, '0');
    assert.equal(op.state, 'prepared');
    assert.equal(f.state.broadcasts.length, 0);
    assert.equal((await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' })).id, op.id);
    await assert.rejects(
      f.service.prepare(f.identity, 'request_0002', { kind: 'fund' }),
      /reserves/,
    );
    const result = await f.service.authorize(f.identity, op.id, await f.sign(op));
    assert.equal(result.state, 'broadcast');
    assert.equal(f.state.sponsorCalls, 1);
    assert.equal(f.state.broadcasts.length, 1);
  } finally {
    await f.store.close();
  }
});
test('an unsigned expired review can be replaced before blockhash expiry', async () => {
  const f = await fixture();
  try {
    const first = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    f.state.now = Date.parse(first.expiresAt);
    // The chain still reports the original blockhash as live. Only the
    // unsigned local review has expired; no sponsor signature can exist.
    const next = await f.service.prepare(f.identity, 'request_0002', { kind: 'fund' });
    assert.notEqual(next.id, first.id);
    assert.equal(next.nonce, first.nonce);
    assert.equal(next.state, 'prepared');
    assert.equal((await f.service.get(f.identity, first.id)).state, 'expired');
    await assert.rejects(
      f.service.authorize(f.identity, first.id, await f.sign(first)),
      /expired/,
    );
    assert.equal(f.state.sponsorCalls, 0);
    assert.equal(f.state.broadcasts.length, 0);
  } finally {
    await f.store.close();
  }
});
test('arbitrary targets, recipients, sources and unsupported actions never enter planning', () => {
  for (const value of [
    { kind: 'fund', source: key(20) },
    { kind: 'settle', recipient: key(20) },
    { kind: 'supply', amountAtomic: '1', program: key(20) },
    { kind: 'swap' },
    { kind: 'release_earnings', amountAtomic: 10 },
  ])
    assert.throws(() => decodeSolanaAction(value, key(16)));
});
test('changed transaction bytes and substituted signatures cannot reach sponsor', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    const raw = Buffer.from(await f.sign(op), 'base64');
    raw[raw.length - 1] ^= 1;
    await assert.rejects(f.service.authorize(f.identity, op.id, raw.toString('base64')), /differs/);
    const signatureChanged = Buffer.from(await f.sign(op), 'base64');
    signatureChanged[66] ^= 1;
    await assert.rejects(
      f.service.authorize(f.identity, op.id, signatureChanged.toString('base64')),
      /signature/,
    );
    assert.equal(f.state.sponsorCalls, 0);
    assert.equal(f.state.broadcasts.length, 0);
  } finally {
    await f.store.close();
  }
});
test('ambiguous broadcast retries exactly the persisted signed bytes without a new signature', async () => {
  const f = await fixture();
  try {
    f.state.ambiguous = true;
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    const signed = await f.sign(op);
    assert.equal((await f.service.authorize(f.identity, op.id, signed)).state, 'unknown');
    const saved = (await f.store.scan<{ operations: SolanaOperation[] }>('solana-lane:'))[0].value
      .operations[0];
    assert.ok(saved.signedTxBase64);
    assert.ok(saved.signature);
    assert.equal((await f.service.authorize(f.identity, op.id, signed)).state, 'unknown');
    assert.equal(f.state.sponsorCalls, 1);
    assert.equal(f.state.broadcasts.length, 2);
    assert.equal(new Set(f.state.broadcasts).size, 1);
    f.state.receiptFinal = true;
    f.snapshot.slot = '51';
    f.snapshot.tenancy.nextNonce = '1';
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'finalized');
    assert.equal((await f.service.authorize(f.identity, op.id, signed)).state, 'finalized');
    assert.equal(f.state.sponsorCalls, 1);
  } finally {
    await f.store.close();
  }
});
test('authenticated retry after a reload sends only persisted bytes without another signature', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    await assert.rejects(f.service.retry(f.identity, op.id), /already signed/);
    assert.equal(f.state.sponsorCalls, 0);
    f.state.ambiguous = true;
    const signed = await f.service.authorize(f.identity, op.id, await f.sign(op));
    assert.equal(signed.state, 'unknown');
    f.state.ambiguous = false;
    const reloaded = createSolanaService(f.dependencies);
    const result = await reloaded.retry(f.identity, op.id);
    assert.equal(result.state, 'broadcast');
    assert.equal(result.signature, signed.signature);
    assert.equal(f.state.broadcasts.length, 2);
    assert.equal(f.state.broadcasts[0], f.state.broadcasts[1]);
    assert.equal(f.state.sponsorCalls, 1);
    assert.equal(f.state.simulations, 2);
  } finally {
    await f.store.close();
  }
});
test('retry rechecks the original actor, current passkey, accepted agreement and deployment', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    f.state.ambiguous = true;
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    const landlord = f.agreement.parties.landlord!;
    const other = { ...f.identity, subject: landlord.subject, wallets: [landlord.wallet] };
    await assert.rejects(f.service.retry(other, op.id), /recorded actor/);
    await assert.rejects(f.service.retry({ ...f.identity, passkeyCount: 0 }, op.id), /passkey/);
    await f.store.update<Agreement>(`agreement:${f.agreement.id}`, (row) => ({
      ...row,
      accepted: {},
    }));
    await assert.rejects(f.service.retry(f.identity, op.id), /must accept/);
    await f.store.update<Agreement>(`agreement:${f.agreement.id}`, () => f.agreement);
    f.snapshot.tenancy.policyHash = new Uint8Array(32);
    await assert.rejects(f.service.retry(f.identity, op.id), /accepted parties and policy/);
    f.gateway.snapshot = async () => {
      throw new Error('Deployment code hash changed');
    };
    await assert.rejects(f.service.retry(f.identity, op.id), /code hash changed/);
    assert.equal(f.state.broadcasts.length, 1);
    assert.equal(f.state.sponsorCalls, 1);
  } finally {
    await f.store.close();
  }
});
test('reconcile rebroadcasts immutable bytes even after review timeout, and any party can check', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    f.state.now += 60_000;
    const landlord = f.agreement.parties.landlord!;
    const result = await f.service.reconcile({ ...f.identity, subject: landlord.subject, wallets: [landlord.wallet] }, op.id);
    assert.equal(result.state, 'broadcast');
    assert.deepEqual(f.state.broadcasts, [f.state.broadcasts[0], f.state.broadcasts[0]]);
    await assert.rejects(f.service.prepare(f.identity, 'request_0002', { kind: 'fund' }), /reserves/);
    assert.equal(f.state.sponsorCalls, 1);
    f.state.receiptFinal = true;
    f.snapshot.slot = '51';
    f.snapshot.tenancy.nextNonce = '1';
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'finalized');
    assert.equal(f.state.broadcasts.length, 2);
    assert.equal(f.state.sponsorCalls, 1);
  } finally {
    await f.store.close();
  }
});

test('finalized blockhash expiry releases an absent signature nonce for a fresh approval', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    f.state.blockHeight = '150';
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'unknown', 'the last valid height itself is not past the lifetime');
    assert.equal(f.state.broadcasts.length, 1);
    f.state.blockHeight = '151';
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'expired');
    f.gateway.lifetime = async () => ({ blockhash: key(31), lastValidBlockHeight: '300', blockHeight: '151' });
    const fresh = await f.service.prepare(f.identity, 'request_0002', { kind: 'fund' });
    assert.equal(fresh.nonce, op.nonce);
    assert.notEqual(fresh.id, op.id);
    assert.notEqual(fresh.transactionBase64, op.transactionBase64);
    assert.equal(f.state.sponsorCalls, 1);
    assert.equal(f.state.broadcasts.length, 1);
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'expired');
  } finally {
    await f.store.close();
  }
});

test('a signature that lands between the absence lookup and the height read is never expired', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    f.state.blockHeight = '151';
    const lookup = f.gateway.reconcile;
    let lookups = 0;
    f.gateway.reconcile = async (...args) => {
      lookups++;
      if (lookups === 2) f.state.receiptFinal = true;
      return lookup(...args);
    };
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'unknown');
    assert.equal(lookups, 2, 'expiry needs a fresh lookup after the finalized height read');
    f.gateway.lifetime = async () => ({ blockhash: key(31), lastValidBlockHeight: '300', blockHeight: '151' });
    await assert.rejects(f.service.prepare(f.identity, 'request_0002', { kind: 'fund' }), /reserves/);
    f.snapshot.slot = '51';
    f.snapshot.tenancy.nextNonce = '1';
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'finalized');
    assert.equal(f.state.sponsorCalls, 1);
    assert.equal(f.state.broadcasts.length, 1);
  } finally {
    await f.store.close();
  }
});

test('failed or ambiguous lookup and unavailable finalized heights keep the nonce reserved', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    f.state.blockHeight = '151';
    const lookup = f.gateway.reconcile;
    f.gateway.reconcile = async () => { throw new Error('RPC disconnected'); };
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'unknown');
    f.gateway.reconcile = lookup;
    f.state.receiptReason = 'receipt-unavailable';
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'unknown');
    f.state.receiptReason = 'signature-not-observed-do-not-resubmit-new-intent';
    f.state.lifetimeUnavailable = true;
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'unknown');
    f.state.lifetimeUnavailable = false;
    f.gateway.lifetime = async () => ({ blockhash: key(31), lastValidBlockHeight: '300', blockHeight: '151' });
    await assert.rejects(f.service.prepare(f.identity, 'request_0002', { kind: 'fund' }), /reserves/);
    assert.equal(f.state.broadcasts.length, 1);
    assert.equal(f.state.sponsorCalls, 1);
  } finally {
    await f.store.close();
  }
});
test('retry preserves unknown when receipt evidence is incomplete or the tenancy nonce changed', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    f.state.ambiguous = true;
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    for (const reason of [
      'rpc-evidence-unavailable',
      'receipt-unavailable',
      'awaiting-finalized-tenancy-state',
    ]) {
      f.state.receiptReason = reason;
      const result = await f.service.retry(f.identity, op.id);
      assert.equal(result.state, 'unknown');
      assert.equal(result.lastError, reason);
    }
    f.state.receiptReason = 'signature-not-observed-do-not-resubmit-new-intent';
    f.snapshot.tenancy.nextNonce = '1';
    assert.match((await f.service.retry(f.identity, op.id)).lastError!, /nonce changed/);
    f.gateway.reconcile = async () => {
      throw new Error('RPC disconnected');
    };
    assert.match(
      (await f.service.retry(f.identity, op.id)).lastError!,
      /Receipt evidence is unavailable/,
    );
    assert.equal(f.state.broadcasts.length, 1);
    assert.equal(f.state.sponsorCalls, 1);
  } finally {
    await f.store.close();
  }
});
test('retry returns a finalized recorded receipt without another broadcast', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    f.state.ambiguous = true;
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    f.state.receiptFinal = true;
    f.snapshot.slot = '51';
    f.snapshot.tenancy.nextNonce = '1';
    assert.equal((await f.service.retry(f.identity, op.id)).state, 'finalized');
    assert.equal((await f.service.retry(f.identity, op.id)).state, 'finalized');
    assert.equal(f.state.broadcasts.length, 1);
    assert.equal(f.state.sponsorCalls, 1);
  } finally {
    await f.store.close();
  }
});
test('passkey and accepted policy are checked before every authorization', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    await assert.rejects(f.service.authorize({ ...f.identity, passkeyCount: 0 }, op.id, await f.sign(op)), /passkey/);
    assert.equal(f.state.sponsorCalls, 0);
    f.snapshot.tenancy.policyHash = new Uint8Array(32);
    await assert.rejects(f.service.snapshot(f.identity), /accepted parties and policy/);
  } finally {
    await f.store.close();
  }
});
test('claim approval waits for its finalized tenancy nonce and approved state', async () => {
  const f = await fixture();
  try {
    f.snapshot.tenancy.phase = 'claim-proposed';
    f.snapshot.tenancy.claimAtomic = '120000000';
    const op = await f.service.prepare(f.identity, 'claim_response_01', {
      kind: 'respond_to_claim',
      accept: true,
    });
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    f.state.receiptFinal = true;
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'unknown');
    f.snapshot.slot = '51';
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'unknown');
    f.snapshot.tenancy.nextNonce = '1';
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'unknown');
    f.snapshot.tenancy.phase = 'settling';
    f.snapshot.tenancy.approvedClaimAtomic = '120000000';
    assert.equal((await f.service.reconcile(f.identity, op.id)).state, 'finalized');
    assert.equal(f.state.sponsorCalls, 1);
  } finally {
    await f.store.close();
  }
});
test('the sponsor cannot replace an already verified actor signature', async () => {
  const f = await fixture();
  try {
    const service = createSolanaService({
      ...f.dependencies,
      sponsor: {
        address: f.sponsor.address,
        sign: async (bytes) => {
          const signed = await f.dependencies.sponsor.sign(bytes);
          signed[66] ^= 1;
          return signed;
        },
      },
    });
    const op = await service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    await assert.rejects(
      service.authorize(f.identity, op.id, await f.sign(op)),
      /actor signature changed/,
    );
    assert.equal(f.state.broadcasts.length, 0);
    assert.equal((await service.get(f.identity, op.id)).state, 'prepared');
  } finally {
    await f.store.close();
  }
});
test('expired or consumed nonce plans fail before adding a sponsor signature', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    const signed = await f.sign(op);
    f.state.now += 60_000;
    await assert.rejects(f.service.authorize(f.identity, op.id, signed), /expired/);
    f.state.now = 100000;
    f.snapshot.tenancy.nextNonce = '1';
    await assert.rejects(f.service.authorize(f.identity, op.id, signed), /changed/);
    assert.equal(f.state.sponsorCalls, 0);
  } finally {
    await f.store.close();
  }
});
test('both prepare and fresh authorization reject sponsor fee plus rent beyond the ceiling', async () => {
  const f = await fixture();
  try {
    f.state.sponsorCost = '100001';
    await assert.rejects(
      f.service.prepare(f.identity, 'request_0001', { kind: 'fund' }),
      /fee and rent/,
    );
    f.state.sponsorCost = '20000';
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    f.state.sponsorCost = '100001';
    await assert.rejects(f.service.authorize(f.identity, op.id, await f.sign(op)), /fee and rent/);
    assert.equal(f.state.sponsorCalls, 0);
  } finally {
    await f.store.close();
  }
});
test('a failed durable signed-write prevents broadcast', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    const original = f.store.update.bind(f.store);
    f.store.update = async (key, change) =>
      original(key, (value) => {
        const result = change(value);
        if (JSON.stringify(result).includes('"state":"signed"'))
          throw new Error('disk unavailable');
        return result;
      });
    await assert.rejects(
      f.service.authorize(f.identity, op.id, await f.sign(op)),
      /disk unavailable/,
    );
    assert.equal(f.state.broadcasts.length, 0);
  } finally {
    await f.store.close();
  }
});
test('configuration rejects mainnet, wrong genesis, wrong mint and missing deployment information', async () => {
  const f = await fixture();
  try {
    const environment = {
      SOLANA_RPC_URL: f.config.rpcUrl,
      SOLANA_DEPLOYMENT_MANIFEST: JSON.stringify(f.config),
    };
    assert.ok(solanaConfiguration(environment));
    assert.equal(solanaConfiguration({
      ...environment,
      SOLANA_DEPLOYMENT_MANIFEST: JSON.stringify({ ...f.config, setupMode: 'staged' }),
    })?.setupMode, 'staged');
    for (const changed of [
      { ...f.config, cluster: 'mainnet-beta' },
      { ...f.config, genesisHash: SOLANA_MAINNET_MANIFEST.genesisHash },
      { ...f.config, depositMint: SOLANA_MAINNET_MANIFEST.deposit.mint },
      { ...f.config, programCodeLength: undefined },
      { ...f.config, setupMode: 'unreviewed' },
      { ...f.config, setupMode: 'staged', escrowProgram: 'BiwaGavQUsSsg48UPpRAGWoXSiUnzgvdDs7rd8WizvPD' },
    ])
      assert.throws(() =>
        solanaConfiguration({
          ...environment,
          SOLANA_DEPLOYMENT_MANIFEST: JSON.stringify(changed),
        }),
      );
    assert.throws(
      () =>
        createSolanaService({
          ...f.dependencies,
          config: { ...f.config, genesisHash: SOLANA_MAINNET_MANIFEST.genesisHash },
        }),
      /Mainnet/,
    );
    assert.equal(solanaConfiguration({}), null);
    const methods: string[] = [];
    const wrongNetwork = new RpcSolanaGateway(f.config, (async (_url, options) => {
      methods.push(JSON.parse(String(options?.body)).method);
      return Response.json({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_MANIFEST.genesisHash });
    }) as typeof fetch);
    await assert.rejects(wrongNetwork.snapshot(), /genesis mismatch/);
    assert.deepEqual(methods, ['getGenesisHash']);
    const undeployed = new RpcSolanaGateway(f.config, (async (_url, options) => {
      const method = JSON.parse(String(options?.body)).method;
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result:
          method === 'getGenesisHash'
            ? f.config.genesisHash
            : { context: { slot: 50 }, value: [null, null] },
      });
    }) as typeof fetch);
    await assert.rejects(undeployed.snapshot(), (error) => error instanceof Error && !(error instanceof EscrowAbsentError));
  } finally {
    await f.store.close();
  }
});
test('program code hash, loader, length and upgrade authority are verified', async () => {
  const f = await fixture();
  try {
    const code = new Uint8Array(1000).fill(1);
    const config = { ...f.config, programSha256: createHash('sha256').update(code).digest('hex') };
    const immutable = {
      address: config.escrowProgram,
      owner: 'BPFLoader2111111111111111111111111111111111',
      executable: true,
      data: code,
    };
    assert.doesNotThrow(() => verifyDeployedProgram(config, immutable));
    assert.throws(
      () => verifyDeployedProgram({ ...config, programSha256: 'b'.repeat(64) }, immutable),
      /hash/,
    );
    assert.throws(
      () => verifyDeployedProgram(config, { ...immutable, owner: SOLANA_IDS.token }),
      /loader/,
    );
    const programDataAddress = key(25),
      programBytes = new Uint8Array(36);
    new DataView(programBytes.buffer).setUint32(0, 2, true);
    programBytes.set(getAddressEncoder().encode(programDataAddress), 4);
    const program = {
      address: config.escrowProgram,
      owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
      executable: true,
      data: programBytes,
    };
    const data = new Uint8Array(45 + 1000);
    new DataView(data.buffer).setUint32(0, 3, true);
    data[12] = 1;
    data.set(getAddressEncoder().encode(f.sponsor.address), 13);
    data.set(code, 45);
    const programData = {
      address: programDataAddress,
      owner: program.owner,
      executable: false,
      data,
    };
    assert.doesNotThrow(() =>
      verifyDeployedProgram(
        { ...config, upgradeAuthority: f.sponsor.address },
        program,
        programData,
      ),
    );
    assert.throws(() => verifyDeployedProgram(config, program, programData), /authority/);
  } finally {
    await f.store.close();
  }
});
test('RPC simulation atomically applies sponsor rent debit and fee without cross-bank reads', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    const payer = f.sponsor.address;
    const bytes = new Uint8Array(Buffer.from(op.transactionBase64, 'base64'));
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(bytes).messageBytes);
    let bank = 50, rentDebit = 100000, completeEvidence = true;
    const calls: string[] = [];
    const fetcher = (async (_url: unknown, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body));
      calls.push(body.method);
      assert.equal(body.method, 'simulateTransaction');
      const result = { context: { slot: bank }, value: {
        err: null,
        accounts: body.params[1].accounts.addresses.map((key: string) => ({
          owner: SOLANA_IDS.system, lamports: key === payer ? 1000000000 - rentDebit : 1000000000,
          executable: false, data: ['', 'base64'],
        })),
        preBalances: completeEvidence ? message.staticAccounts.map(() => 1000000000) : undefined,
        postBalances: message.staticAccounts.map(key => key === payer ? 1000000000 - rentDebit : 1000000000),
        preTokenBalances: [], postTokenBalances: [], fee: 10000,
      } };
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    }) as typeof fetch;
    const gateway = new RpcSolanaGateway(f.config, fetcher);
    await assert.rejects(gateway.simulate(bytes, payer, f.tenant.address), /fee and rent/);
    rentDebit = 0;
    assert.equal((await gateway.simulate(bytes, payer, f.tenant.address)).sponsorDebitCeilingLamports, '10000');
    bank = 51;
    assert.equal((await gateway.simulate(bytes, payer, f.tenant.address)).slot, '51');
    completeEvidence = false;
    await assert.rejects(gateway.simulate(bytes, payer, f.tenant.address), /Atomic simulation native balances unavailable/);
    assert.deepEqual(calls, Array(4).fill('simulateTransaction'));
  } finally { await f.store.close(); }
});

for (const kind of ['fund', 'fund_and_supply'] as const) {
  test(`cancellation blocks ${kind} preparation and authorization of an earlier review`, async () => {
    const f = await fixture();
    try {
      const op = await f.service.prepare(f.identity, 'request_cancelled_1', { kind });
      const signed = await f.sign(op);
      await f.store.update<Agreement>(`agreement:${f.agreement.id}`, (row) => ({
        ...row,
        cancelled: { by: 'landlord', at: new Date(f.state.now).toISOString() },
      }));
      const cancelled = { code: 'agreement_cancelled' };
      await assert.rejects(f.service.prepare(f.identity, 'request_cancelled_2', { kind }), cancelled);
      await assert.rejects(f.service.prepare(f.identity, 'request_cancelled_1', { kind }), cancelled);
      await assert.rejects(f.service.authorize(f.identity, op.id, signed), cancelled);
      await assert.rejects(f.service.retry(f.identity, op.id), cancelled);
      assert.equal(f.state.sponsorCalls, 0);
      assert.deepEqual(f.state.broadcasts, []);
    } finally {
      await f.store.close();
    }
  });

  test(`cancellation blocks ${kind} retry of persisted signed bytes without another send`, async () => {
    const f = await fixture();
    try {
      f.state.ambiguous = true;
      const op = await f.service.prepare(f.identity, 'request_cancelled_1', { kind });
      const actorSigned = await f.sign(op);
      const sent = await f.service.authorize(f.identity, op.id, actorSigned);
      assert.equal(sent.state, 'unknown');
      await f.store.update<Agreement>(`agreement:${f.agreement.id}`, (row) => ({
        ...row,
        cancelled: { by: 'tenant', at: new Date(f.state.now).toISOString() },
      }));
      const reloaded = createSolanaService(f.dependencies);
      await assert.rejects(reloaded.retry(f.identity, op.id), { code: 'agreement_cancelled' });
      await assert.rejects(reloaded.authorize(f.identity, op.id, actorSigned), { code: 'agreement_cancelled' });
      assert.equal(f.state.sponsorCalls, 1);
      assert.equal(f.state.broadcasts.length, 1);
      f.state.receiptFinal = true;
      f.snapshot.slot = '51';
      f.snapshot.tenancy.nextNonce = kind === 'fund_and_supply' ? '2' : '1';
      if (kind === 'fund_and_supply') {
        f.snapshot.tenancy.phase = 'active';
        f.snapshot.tenancy.accountedReceiptsAtomic = '3000000000';
      }
      assert.equal((await reloaded.reconcile(f.identity, op.id)).state, 'finalized');
    } finally {
      await f.store.close();
    }
  });

  test(`cancellation during sponsor signing prevents ${kind} broadcast`, async () => {
    const f = await fixture();
    try {
      const op = await f.service.prepare(f.identity, 'request_cancelled_1', { kind });
      const sponsorSign = f.dependencies.sponsor.sign;
      f.dependencies.sponsor.sign = async (bytes) => {
        const signed = await sponsorSign(bytes);
        await f.store.update<Agreement>(`agreement:${f.agreement.id}`, (row) => ({
          ...row,
          cancelled: { by: 'landlord', at: new Date(f.state.now).toISOString() },
        }));
        return signed;
      };
      await assert.rejects(
        f.service.authorize(f.identity, op.id, await f.sign(op)),
        { code: 'agreement_cancelled' },
      );
      assert.equal(f.state.sponsorCalls, 1);
      assert.deepEqual(f.state.broadcasts, []);
      await assert.rejects(f.service.retry(f.identity, op.id), { code: 'agreement_cancelled' });
      assert.deepEqual(f.state.broadcasts, []);
    } finally {
      await f.store.close();
    }
  });
}
