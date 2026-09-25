import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from '@solana/kit';
import { LocalStore } from './store.ts';
import { agreementDigest, type Agreement } from './agreements.ts';
import { createSolanaService, decodeSolanaAction, type SolanaOperation } from './solana-service.ts';
import {
  RpcSolanaGateway,
  solanaConfiguration,
  verifyDeployedProgram,
  type SolanaConfiguration,
  type SolanaGateway,
  type SolanaSnapshot,
} from './solana-rpc.ts';
import {
  deriveEscrowAddresses,
  derivePayoutAddress,
  SOLANA_DEVNET_MANIFEST,
  SOLANA_IDS,
  SOLANA_MAINNET_MANIFEST,
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
    backupLoginLinked: true,
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
    recoveryCalls: 0,
    recoveryAllowed: true,
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
    recoveryGate: async () => {
      state.recoveryCalls++;
      if (!state.recoveryAllowed) throw new Error('recovery required');
      return {
        wallet: identity.wallets[0],
        proof: {
          subject: identity.subject,
          walletIds: ['tenant-wallet'],
          checkedAt: new Date(0).toISOString(),
        },
      };
    },
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
    assert.equal(f.state.recoveryCalls, 4);
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
test('retry rechecks the original actor, current recovery, accepted agreement and deployment', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    f.state.ambiguous = true;
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    const landlord = f.agreement.parties.landlord!;
    const other = { ...f.identity, subject: landlord.subject, wallets: [landlord.wallet] };
    await assert.rejects(f.service.retry(other, op.id), /recorded actor/);
    f.state.recoveryAllowed = false;
    await assert.rejects(f.service.retry(f.identity, op.id), /recovery/);
    f.state.recoveryAllowed = true;
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
test('expired retry reviews, expired blockhashes and unknown heights never free the nonce or resend', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    f.state.ambiguous = true;
    await f.service.authorize(f.identity, op.id, await f.sign(op));
    f.state.now += 60_000;
    let result = await f.service.retry(f.identity, op.id);
    assert.equal(result.state, 'unknown');
    assert.match(result.lastError!, /review expired/);
    f.state.now = 100000;
    f.state.blockHeight = '151';
    result = await f.service.retry(f.identity, op.id);
    assert.equal(result.state, 'unknown');
    assert.match(result.lastError!, /blockhash lifetime ended/);
    f.state.blockHeight = '100';
    f.state.lifetimeUnavailable = true;
    result = await f.service.retry(f.identity, op.id);
    assert.equal(result.state, 'unknown');
    assert.match(result.lastError!, /Block-height evidence is unavailable/);
    f.state.lifetimeUnavailable = false;
    await assert.rejects(
      f.service.prepare(f.identity, 'request_0002', { kind: 'fund' }),
      /reserves/,
    );
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
test('recovery, accepted policy and original wallet bindings are checked before every authorization', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    f.state.recoveryAllowed = false;
    await assert.rejects(f.service.authorize(f.identity, op.id, await f.sign(op)), /recovery/);
    assert.equal(f.state.sponsorCalls, 0);
    f.state.recoveryAllowed = true;
    f.snapshot.tenancy.policyHash = new Uint8Array(32);
    await assert.rejects(f.service.snapshot(f.identity), /accepted parties and policy/);
    const withoutRecovery = createSolanaService({ ...f.dependencies, recoveryGate: undefined });
    await assert.rejects(withoutRecovery.snapshot(f.identity), /existing wallets/);
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
    await assert.rejects(undeployed.snapshot(), /not deployed and initialized/);
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
test('RPC simulation applies sponsor rent debit and fee together and refuses changed banks', async () => {
  const f = await fixture();
  try {
    const op = await f.service.prepare(f.identity, 'request_0001', { kind: 'fund' });
    const payer = f.sponsor.address;
    let bank = 50;
    let simulatedSlots: number[] = [];
    let rentDebit = 100000;
    const fetcher = (async (_url: unknown, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body));
      let result: unknown;
      if (body.method === 'getMultipleAccounts')
        result = {
          context: { slot: 50 },
          value: body.params[0].map(() => ({
            owner: SOLANA_IDS.system,
            lamports: 1000000000,
            executable: false,
            data: ['', 'base64'],
          })),
        };
      else if (body.method === 'simulateTransaction')
        result = {
          context: { slot: simulatedSlots.shift() ?? bank },
          value: {
            err: null,
            accounts: body.params[1].accounts.addresses.map((key: string) => ({
              owner: SOLANA_IDS.system,
              lamports: key === payer ? 1000000000 - rentDebit : 1000000000,
              executable: false,
              data: ['', 'base64'],
            })),
          },
        };
      else if (body.method === 'getFeeForMessage') result = { context: { slot: 50 }, value: 10000 };
      else throw new Error('Unexpected RPC method');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    }) as typeof fetch;
    const gateway = new RpcSolanaGateway(f.config, fetcher);
    const bytes = new Uint8Array(Buffer.from(op.transactionBase64, 'base64'));
    await assert.rejects(gateway.simulate(bytes, payer, f.tenant.address), /fee and rent/);
    rentDebit = 0;
    assert.equal(
      (await gateway.simulate(bytes, payer, f.tenant.address)).sponsorDebitCeilingLamports,
      '10000',
    );
    bank = 51;
    await assert.rejects(gateway.simulate(bytes, payer, f.tenant.address), /bank changed/);
    bank = 50;
    simulatedSlots = [51, 50];
    assert.equal(
      (await gateway.simulate(bytes, payer, f.tenant.address)).sponsorDebitCeilingLamports,
      '10000',
    );
    assert.deepEqual(simulatedSlots, []);
  } finally {
    await f.store.close();
  }
});
