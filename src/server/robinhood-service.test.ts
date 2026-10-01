import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  encodeEventTopics,
  getAddress,
  keccak256,
  parseTransaction,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { rentalEscrowAbi } from '../finance/robinhood/abi.ts';
import { assertRentalEscrowRuntime } from '../finance/robinhood/deployment.ts';
import { robinhoodMainnet } from '../finance/robinhood/manifest.ts';
import { prepareSignedOperation } from '../finance/robinhood/relay.ts';
import type { EscrowSnapshot } from '../finance/robinhood/read.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { LocalStore, type Store } from './store.ts';
import { requireWalletAccess } from './wallet-access.ts';
import { agreementDigest, type Agreement } from './agreements.ts';
import {
  assertSponsoredTransaction,
  createRobinhoodService,
  decodeEscrowIntent,
  loadRobinhoodConfig,
  observeConfiguredEscrow,
  reconcileRobinhoodOperations,
  RobinhoodServiceError,
  verifiedRobinhoodIdentity,
  type RobinhoodOperation,
  type RobinhoodServerConfig,
} from './robinhood-service.ts';

// Generated/public local fixture keys only; these never fund or control a live account.
const key = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const tenant = privateKeyToAccount(key(11));
const landlord = privateKeyToAccount(key(12));
const arbitrator = privateKeyToAccount(key(13));
const sponsor = privateKeyToAccount(key(14));
const stranger = privateKeyToAccount(key(15));
const escrow = getAddress('0x1111111111111111111111111111111111111111');
const zeroHash = `0x${'0'.repeat(64)}` as Hex;
const blockHash = `0x${'1'.repeat(64)}` as Hex;
const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const operationKey = (value: string) => `native:robinhood:operation:${value}`;
const now = 1000000n;
const identity: VerifiedIdentity = {
  subject: 'did:privy:tenant',
  sessionId: 'local-session',
  expiresAt: Number(now + 1000n),
  wallets: [{ id: 'wallet_tenant_1', address: tenant.address, chainType: 'ethereum' }],
  passkeyCount: 1,
};
function profile(address: Address, subject: string): VerifiedIdentity {
  return {
    ...identity,
    subject,
    wallets: [{ id: 'wallet_other_1', address, chainType: 'ethereum' }],
  };
}
function configuration(sendEnabled = true): RobinhoodServerConfig {
  return {
    manifest: robinhoodMainnet,
    escrow,
    deploymentCodeHash: zeroHash,
    sendEnabled,
    sponsor: { privateKey: key(14), maxGas: 500000n, maxFeePerGas: 100n, maxTotalFee: 50000000n },
    confirmations: 3n,
    agreementId: null,
  };
}
function snapshot(): EscrowSnapshot {
  return {
    status: 'available',
    address: escrow,
    chainId: 4663,
    blockNumber: '99',
    blockHash,
    observedAt: now.toString(),
    state: 0,
    nonce: '0',
    asset: robinhoodMainnet.asset.address,
    vault: robinhoodMainnet.vault,
    tenant: tenant.address,
    landlord: landlord.address,
    arbitrator: arbitrator.address,
    personalWallet: tenant.address,
    agreementHash: blockHash,
    securityRequirement: '3000000000',
    fundingReserve: '10000',
    tenantAccepted: false,
    landlordAccepted: false,
    arbitratedDecision: false,
    earningsReleaseAllowed: true,
    trackedShares: '0',
    totalSupplied: '0',
    totalRedeemed: '0',
    releasedEarnings: '0',
    securityValue: '0',
    releasableEarnings: '0',
    claimAmount: '0',
    approvedLandlordAmount: '0',
    minimumSettlementAssets: '0',
    settledLandlordAmount: '0',
    settledTenantAmount: '0',
    cashWithdrawalStatus: 'requires-exact-call-simulation',
  };
}

function fixture(store: Store = new LocalStore(':memory:'), config = configuration()) {
  const observed = snapshot();
  const effects = {
    broadcasts: [] as Hex[],
    nonceReads: 0,
    simulations: 0,
    observations: 0,
  };
  const controls = {
    allowance: 3000010000n,
    estimate: 100000n,
    fee: 2n,
    failBroadcast: false,
    receipt: false,
    changedInput: false,
    reverted: false,
    confirmations: 3n,
    simulationFailure: false,
    previewUnavailable: false,
    receiptUnavailable: false,
    time: now,
    idle: 3000000000n,
    depositPreview: 3000000000000000000000n,
    redeemPreview: 3000000000n,
    redeemLoss: 0n,
  };
  let latestRaw: Hex | undefined;
  const client = {
    getChainId: async () => 4663,
    call: async () => {
      effects.simulations++;
      if (controls.simulationFailure) throw new Error('Native simulation reverted');
      return { data: '0x' };
    },
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'allowance') return controls.allowance;
      if (functionName === 'balanceOf') return controls.idle;
      if (functionName === 'previewDeposit') {
        if (controls.previewUnavailable) throw new Error('RPC failed');
        return BigInt(args?.[0] as bigint) * 1000000000000n;
      }
      if (functionName === 'previewWithdraw') return 10000000000000000000n;
      if (functionName === 'previewRedeem') {
        if (controls.previewUnavailable) throw new Error('RPC failed');
        const shares = BigInt(args?.[0] as bigint);
        return (shares === 1000000000000000000000n ? 1000000000n : shares / 1000000000000n) -
          controls.redeemLoss;
      }
      if (functionName === 'fixedChainId') return 4663n;
      const value = observed[functionName as keyof EscrowSnapshot];
      if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
      return value;
    },
    getCode: async () => '0x6000',
    getBlock: async () => ({ number: 99n, hash: blockHash, timestamp: now }),
    estimateGas: async () => controls.estimate,
    estimateFeesPerGas: async () => ({ maxFeePerGas: controls.fee, maxPriorityFeePerGas: 1n }),
    getTransactionCount: async () => {
      effects.nonceReads++;
      return 7;
    },
    getBalance: async () => 10n ** 18n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const rows = await store.scan<RobinhoodOperation>('native:robinhood:operation:');
      const record = rows.find((row) => row.value.rawTransaction === serializedTransaction)?.value;
      assert.ok(record, 'raw bytes must already be durable before broadcast');
      assert.equal(record.transactionHash, keccak256(serializedTransaction));
      assert.ok(record.relayPlan);
      effects.broadcasts.push(serializedTransaction);
      latestRaw = serializedTransaction;
      if (controls.failBroadcast) throw new Error('RPC accepted bytes but HTTP response was lost');
      return keccak256(serializedTransaction);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (controls.receiptUnavailable) throw new Error('Receipt RPC unavailable');
      if (!controls.receipt) {
        const error = new Error('Not found');
        error.name = 'TransactionReceiptNotFoundError';
        throw error;
      }
      const records = await store.scan<RobinhoodOperation>('native:robinhood:operation:');
      const record = records.find((row) => row.value.transactionHash === hash)!.value;
      const financial = encodeEventTopics({
        abi: rentalEscrowAbi,
        eventName: 'AgreementAccepted',
        args: { party: tenant.address, operationNonce: BigInt(record.action.expectedNonce) },
      });
      const signed = encodeEventTopics({
        abi: rentalEscrowAbi,
        eventName: 'SignedOperationExecuted',
        args: {
          signer: tenant.address,
          digest: record.digest,
          operationNonce: BigInt(record.action.expectedNonce),
        },
      });
      return {
        status: controls.reverted ? 'reverted' : 'success',
        blockNumber: 99n,
        blockHash,
        logs: [
          { address: escrow, data: '0x', topics: financial },
          { address: escrow, data: '0x', topics: signed },
        ],
      };
    },
    getTransaction: async () => {
      const tx = parseTransaction(latestRaw!);
      return {
        to: tx.to,
        from: sponsor.address,
        input: controls.changedInput ? '0x1234' : tx.data,
        value: tx.value ?? 0n,
      };
    },
    getBlockNumber: async () => 98n + controls.confirmations,
  } as unknown as PublicClient;
  const dependencies = {
    store,
    client,
    config,
    now: () => controls.time,
    observe: async () => {
      effects.observations++;
      return { ...observed };
    },
    requireAccess: requireWalletAccess,
  };
  const service = createRobinhoodService(dependencies);
  async function plan(n = 1) {
    return service.plan(identity, {
      operationId: id(n),
      walletId: identity.wallets[0].id,
      intent: { kind: 'acceptAgreement' },
    });
  }
  async function sign(n = 1) {
    const record = (await store.get<RobinhoodOperation>(operationKey(id(n))))!;
    const prepared = prepareSignedOperation(
      config.manifest,
      record.snapshot,
      record.intent,
      tenant.address,
      record.action.deadline,
      now,
    );
    return tenant.signTypedData(prepared.typedData);
  }
  async function bindAgreement() {
    const agreement: Agreement = {
      id: id(90),
      network: 'robinhood',
      property: 'Local fixture apartment',
      requiredSecurity: '3000000000',
      releaseAllowed: true,
      createdAt: new Date(Number(now) * 1000).toISOString(),
      revision: 0,
      parties: {
        tenant: { subject: identity.subject, wallet: identity.wallets[0] },
        landlord: {
          subject: 'did:privy:landlord',
          wallet: { id: 'wallet_landlord_1', address: landlord.address, chainType: 'ethereum' },
        },
        arbitrator: {
          subject: 'did:privy:arbitrator',
          wallet: { id: 'wallet_arbitrator_1', address: arbitrator.address, chainType: 'ethereum' },
        },
      },
      invitations: {},
      accepted: {},
      records: [],
    };
    const digest = agreementDigest(agreement)!;
    agreement.accepted = {
      tenant: { digest, at: agreement.createdAt },
      landlord: { digest, at: agreement.createdAt },
    };
    config.agreementId = agreement.id;
    observed.agreementHash = digest;
    await store.create(`agreement:${agreement.id}`, agreement);
    return agreement;
  }
  return {
    store,
    config,
    client,
    service,
    dependencies,
    observed,
    effects,
    controls,
    plan,
    sign,
    bindAgreement,
  };
}

test('strict native intent decoder rejects recipient, chain, calldata, numbers and unsupported actions', () => {
  for (const input of [
    { kind: 'fund', recipient: stranger.address },
    { kind: 'fund', chainId: 4663 },
    { kind: 'execute', target: stranger.address, calldata: '0x' },
    { kind: 'supply', assets: 1000, minShares: '1' },
    { kind: 'supply', assets: '1e3', minShares: '1' },
    { kind: 'releaseEarnings', assets: '-1', maxSharesBurned: '1' },
    { kind: 'proposeClaim', assets: '0', evidenceHash: '0x1234' },
  ])
    assert.throws(() => decodeEscrowIntent(input));
  assert.deepEqual(
    decodeEscrowIntent({ kind: 'supply', assets: '10000000', minShares: '9990000000000000000' }),
    { kind: 'supply', assets: '10000000', minShares: '9990000000000000000' },
  );
});

test('reads and plans bind current provider wallets to actual immutable parties and action roles', async () => {
  const f = fixture();
  assert.equal((await f.service.observation(identity)).partyWallets[0].role, 'tenant');
  const outsider = profile(stranger.address, 'did:privy:stranger');
  await assert.rejects(() => f.service.observation(outsider), /not an assigned party/);
  await assert.rejects(
    () =>
      f.service.plan(outsider, {
        operationId: id(1),
        walletId: outsider.wallets[0].id,
        intent: { kind: 'acceptAgreement' },
      }),
    /not an assigned party/,
  );
  await assert.rejects(
    () =>
      f.service.plan(identity, {
        operationId: id(2),
        walletId: identity.wallets[0].id,
        intent: { kind: 'proposeClaim', assets: '120000000', evidenceHash: blockHash },
      }),
    /Signer is not authorized/,
  );
  await f.plan();
  await assert.rejects(
    () => f.service.status({ ...identity, subject: 'did:privy:other' }, id(1)),
    /another verified account/,
  );
  await assert.rejects(
    () =>
      f.service.status(
        { ...identity, wallets: [{ ...identity.wallets[0], address: stranger.address }] },
        id(1),
      ),
    /another verified account/,
  );
  await f.store.close();
});


test('funding requires existing exact allowance and never submits an approval on behalf of a user', async () => {
  const f = fixture();
  await f.bindAgreement();
  // Security alone is insufficient; the tenant-owned rounding reserve must be approved too.
  f.controls.allowance = 3000000000n;
  await assert.rejects(
    () =>
      f.service.plan(identity, {
        operationId: id(1),
        walletId: identity.wallets[0].id,
        intent: { kind: 'fund' },
      }),
    (error) => {
      assert.ok(error instanceof RobinhoodServiceError);
      assert.equal(error.code, 'funding_approval_required');
      const details = error.details as {
        amount: string;
        spender: string;
        approval: { to: string; value: string };
      };
      assert.equal(details.amount, '3000010000');
      assert.equal(details.spender, escrow);
      assert.equal(details.approval.to, robinhoodMainnet.asset.address);
      assert.equal(details.approval.value, '0');
      return true;
    },
  );
  assert.equal(f.effects.broadcasts.length, 0);
  assert.equal(f.effects.simulations, 0);
  f.controls.allowance = 3000010000n;
  assert.equal(
    (
      await f.service.plan(identity, {
        operationId: id(1),
        walletId: identity.wallets[0].id,
        intent: { kind: 'fund' },
      })
    ).state,
    'planned',
  );
  await f.store.close();
});

test('funding binds both accepted agreement digests, current tenant identity, amounts, policy and personal recipient', async () => {
  const f = fixture();
  const request = {
    operationId: id(1),
    walletId: identity.wallets[0].id,
    intent: { kind: 'fund' },
  };
  await assert.rejects(() => f.service.plan(identity, request), /recorded tenancy agreement/);
  const agreement = await f.bindAgreement();
  await f.store.update<Agreement>(`agreement:${agreement.id}`, (record) => ({
    ...record,
    accepted: { tenant: record.accepted.tenant },
  }));
  await assert.rejects(() => f.service.plan(identity, request), /must accept the same/);
  await f.store.update<Agreement>(`agreement:${agreement.id}`, () => agreement);
  f.observed.personalWallet = stranger.address;
  await assert.rejects(() => f.service.plan(identity, request), /must match the recorded/);
  f.observed.personalWallet = tenant.address;
  f.observed.securityRequirement = '1';
  await assert.rejects(() => f.service.plan(identity, request), /must match the recorded/);
  f.observed.securityRequirement = '3000000000';
  f.observed.earningsReleaseAllowed = false;
  await assert.rejects(() => f.service.plan(identity, request), /must match the recorded/);
  f.observed.earningsReleaseAllowed = true;
  assert.equal((await f.service.plan(identity, request)).state, 'planned');
  await f.store.close();
});

test('supply hint preserves exact security at the rounding boundary and fails closed one unit short', async () => {
  const f = fixture();
  f.observed.state = 2;
  f.controls.redeemLoss = 0n;
  let result = await f.service.observation(identity);
  assert.equal(result.planningHints.supply?.assets, '3000000000');
  f.controls.redeemLoss = 1n;
  result = await f.service.observation(identity);
  assert.equal(result.planningHints.supply, null);
  await f.store.close();
});
test('read-only planning hints use atomic previews with 2 bps bounds and preserve unavailable evidence', async () => {
  const f = fixture();
  f.observed.state = 2;
  f.controls.redeemPreview = 3000000000n;
  f.observed.releasableEarnings = '10000000';
  f.observed.trackedShares = '3000000000000000000000';
  const result = await f.service.observation(identity);
  assert.deepEqual(result.planningHints.supply, {
    kind: 'supply',
    assets: '3000000000',
    minShares: '2999400000000000000000',
  });
  assert.deepEqual(result.planningHints.releaseEarnings, {
    kind: 'releaseEarnings',
    assets: '10000000',
    maxSharesBurned: '10002000000000000000',
  });
  f.controls.previewUnavailable = true;
  const unavailable = await f.service.observation(identity);
  assert.equal(unavailable.planningHints.supply, null);
  assert.equal(unavailable.planningHints.status, 'partially_unavailable');
  assert.equal(f.effects.broadcasts.length, 0);
  await f.store.close();
});

test('settlement hint bounds only vault redemption and preserves the total settlement floor', async () => {
  const f = fixture();
  f.observed.state = 5;
  f.observed.securityValue = '3000000000';
  f.observed.minimumSettlementAssets = '3000000000';
  f.observed.trackedShares = '1000000000000000000000';
  const observed = await f.service.observation(identity);
  assert.deepEqual(observed.planningHints.settle, {
    kind: 'settle',
    minRedeemedAssets: '999800000',
  });
  assert.equal(observed.snapshot.minimumSettlementAssets, '3000000000');
  const planned = await f.service.plan(identity, {
    operationId: id(1),
    walletId: identity.wallets[0].id,
    intent: observed.planningHints.settle,
  });
  assert.equal(planned.action.limit, '999800000');
  assert.equal(f.observed.minimumSettlementAssets, '3000000000');
  f.controls.previewUnavailable = true;
  const unavailable = await f.service.observation(identity);
  assert.equal(unavailable.planningHints.settle, null);
  assert.equal(unavailable.planningHints.status, 'partially_unavailable');
  f.observed.trackedShares = '0';
  const idleOnly = await f.service.observation(identity);
  assert.deepEqual(idleOnly.planningHints.settle, { kind: 'settle', minRedeemedAssets: '0' });
  assert.equal(idleOnly.snapshot.minimumSettlementAssets, '3000000000');
  await f.store.close();
});

test('operation UUID binds exact terms and returns the original durable plan on retry', async () => {
  const f = fixture();
  const original = await f.plan();
  const retry = await f.plan();
  assert.deepEqual(retry, original);
  assert.equal(f.effects.observations, 1);
  await assert.rejects(
    () =>
      f.service.plan(identity, {
        operationId: id(1),
        walletId: identity.wallets[0].id,
        intent: { kind: 'fund' },
      }),
    /different terms/,
  );
  await assert.rejects(
    () =>
      f.service.plan(identity, {
        operationId: id(1),
        walletId: identity.wallets[0].id,
        intent: { kind: 'fund' },
        chainId: 1,
      }),
    /Unexpected/,
  );
  await f.store.close();
});

test('disabled sending accepts no broadcast even with a valid reviewed signature', async () => {
  const f = fixture(undefined, configuration(false));
  await f.plan();
  await assert.rejects(
    () => f.service.authorize(identity, id(1), { signature: '0x' }),
    /signature/,
  );
  const signature = await f.sign();
  await assert.rejects(() => f.service.authorize(identity, id(1), { signature }), /disabled/);
  assert.equal(f.effects.broadcasts.length, 0);
  assert.equal(f.effects.nonceReads, 0);
  assert.equal((await f.service.status(identity, id(1))).state, 'planned');
  await f.store.close();
});

test('authorization rejects tampered signatures, extra destinations and changed on-chain nonces', async () => {
  const f = fixture();
  await f.plan();
  const signature = await f.sign();
  await assert.rejects(
    () => f.service.authorize(identity, id(1), { signature, recipient: stranger.address }),
    /Unexpected/,
  );
  const record = (await f.store.get<RobinhoodOperation>(operationKey(id(1))))!;
  const prepared = prepareSignedOperation(
    f.config.manifest,
    record.snapshot,
    record.intent,
    tenant.address,
    record.action.deadline,
    now,
  );
  const wrongSignature = await stranger.signTypedData(prepared.typedData);
  await assert.rejects(
    () => f.service.authorize(identity, id(1), { signature: wrongSignature }),
    /does not authorize/,
  );
  f.observed.nonce = '1';
  await assert.rejects(() => f.service.authorize(identity, id(1), { signature }), /escrow changed/);
  assert.equal(f.effects.broadcasts.length, 0);
  await f.store.close();
});

test('raw transaction and hash survive ambiguous broadcast and restart; retry reuses identical bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'robinhood-service-'));
  const filename = join(directory, 'records.sqlite');
  let store = new LocalStore(filename);
  try {
    const f = fixture(store);
    await f.plan();
    const signature = await f.sign();
    f.controls.failBroadcast = true;
    const uncertain = await f.service.authorize(identity, id(1), { signature });
    assert.equal(uncertain.state, 'broadcast_unknown');
    const persisted = (await store.get<RobinhoodOperation>(operationKey(id(1))))!;
    assert.ok(persisted.rawTransaction);
    assert.equal(persisted.transactionHash, uncertain.transactionHash);
    assert.equal('rawTransaction' in uncertain, false);
    assert.equal('signature' in uncertain, false);
    await store.close();
    store = new LocalStore(filename);
    const second = fixture(store);
    second.controls.failBroadcast = false;
    const retried = await second.service.retry(identity, id(1), {});
    assert.equal(retried.state, 'submitted');
    assert.equal(second.effects.nonceReads, 0);
    assert.deepEqual(second.effects.broadcasts, f.effects.broadcasts);
    const after = (await store.get<RobinhoodOperation>(operationKey(id(1))))!;
    assert.equal(after.broadcastAttempts, 2);
    assert.equal(after.rawTransaction, persisted.rawTransaction);
    assert.deepEqual(await store.scan('workspace:'), []);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent duplicate authorizations persist and broadcast only one unique signed envelope', async () => {
  const f = fixture();
  await f.plan();
  const signature = await f.sign();
  const results = await Promise.allSettled([
    f.service.authorize(identity, id(1), { signature }),
    f.service.authorize(identity, id(1), { signature }),
  ]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  for (const result of results)
    if (result.status === 'rejected') assert.equal(result.reason.code, 'operation_preparing');
  assert.equal(new Set(f.effects.broadcasts).size, 1);
  assert.equal((await f.store.scan('native:robinhood:operation:')).length, 1);
  await f.store.close();
});

test('retry requires a saved envelope and rejects client signatures, hashes and new terms', async () => {
  const f = fixture();
  await f.plan();
  await assert.rejects(() => f.service.retry(identity, id(1), {}), /no saved signed transaction/);
  for (const input of [
    { signature: '0x' },
    { transactionHash: blockHash },
    { nonce: '8' },
    { recipient: stranger.address },
  ]) {
    await assert.rejects(() => f.service.retry(identity, id(1), input), /Unexpected/);
  }
  assert.equal(f.effects.nonceReads, 0);
  assert.equal(f.effects.broadcasts.length, 0);
  await f.store.close();
});

test('retry rechecks account access, current party, deployment and explicit send enablement', async () => {
  const f = fixture();
  await f.plan();
  f.controls.failBroadcast = true;
  await f.service.authorize(identity, id(1), { signature: await f.sign() });
  await assert.rejects(
    () => f.service.retry({ ...identity, subject: 'did:privy:other' }, id(1), {}),
    /another verified account/,
  );
  await assert.rejects(() => f.service.retry({ ...identity, passkeyCount: 0 }, id(1), {}), /passkey/);
  f.config.sendEnabled = false;
  await assert.rejects(() => f.service.retry(identity, id(1), {}), /disabled/);
  f.config.sendEnabled = true;
  f.observed.tenant = stranger.address;
  await assert.rejects(() => f.service.retry(identity, id(1), {}), /not an assigned party/);
  f.observed.tenant = tenant.address;
  const verifyRuntime = createRobinhoodService({ ...f.dependencies, observe: undefined });
  await assert.rejects(() => verifyRuntime.retry(identity, id(1), {}), /code does not match/);
  assert.equal(f.effects.broadcasts.length, 1);
  assert.equal(f.effects.nonceReads, 1);
  await f.store.close();
});

test('retry first reconciles completed or confirming receipts without rebroadcast or signing', async () => {
  const f = fixture();
  await f.plan();
  await f.service.authorize(identity, id(1), { signature: await f.sign() });
  f.controls.receipt = true;
  f.controls.confirmations = 1n;
  assert.equal((await f.service.retry(identity, id(1), {})).state, 'confirming');
  f.controls.confirmations = 3n;
  assert.equal((await f.service.retry(identity, id(1), {})).state, 'completed');
  assert.equal(f.effects.broadcasts.length, 1);
  assert.equal(f.effects.nonceReads, 1);
  await f.store.close();
});

test('retry preserves expired, unavailable and changed-nonce transactions without replacement sends', async () => {
  for (const reason of ['expired', 'unavailable', 'nonce'] as const) {
    const f = fixture();
    await f.plan();
    f.controls.failBroadcast = true;
    await f.service.authorize(identity, id(1), { signature: await f.sign() });
    const original = (await f.store.get<RobinhoodOperation>(operationKey(id(1))))!;
    if (reason === 'expired') f.controls.time += 301n;
    if (reason === 'unavailable') f.controls.receiptUnavailable = true;
    if (reason === 'nonce') f.observed.nonce = '1';
    const expected =
      reason === 'expired'
        ? 'expired_saved_transaction'
        : reason === 'unavailable'
          ? 'observation_unavailable'
          : 'nonce_changed';
    await assert.rejects(
      () => f.service.retry(identity, id(1), {}),
      (error) => error instanceof RobinhoodServiceError && error.code === expected,
    );
    const retained = (await f.store.get<RobinhoodOperation>(operationKey(id(1))))!;
    assert.equal(retained.rawTransaction, original.rawTransaction);
    assert.equal(retained.transactionHash, original.transactionHash);
    assert.equal(retained.state, 'broadcast_unknown');
    assert.equal(f.effects.broadcasts.length, 1);
    assert.equal(f.effects.nonceReads, 1);
    const reservation = await f.store.get<{ operationId: string }>(
      `native:robinhood:sponsor:4663:${sponsor.address.toLowerCase()}`,
    );
    assert.equal(reservation?.operationId, id(1));
    await f.store.close();
  }
});

test('retry cannot substitute a stored transaction recipient or silently switch the gas sponsor', async () => {
  const f = fixture();
  await f.plan();
  f.controls.failBroadcast = true;
  await f.service.authorize(identity, id(1), { signature: await f.sign() });
  const original = (await f.store.get<RobinhoodOperation>(operationKey(id(1))))!;
  f.config.sponsor!.privateKey = key(15);
  await assert.rejects(() => f.service.retry(identity, id(1), {}), /configured sponsor/);
  f.config.sponsor!.privateKey = key(14);
  const altered = await sponsor.signTransaction({
    type: 'eip1559',
    chainId: 4663,
    to: stranger.address,
    data: original.relayPlan!.data,
    value: 0n,
    nonce: original.sponsorNonce!,
    gas: 120000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });
  await f.store.update<RobinhoodOperation>(operationKey(id(1)), (current) => ({
    ...current,
    rawTransaction: altered,
    transactionHash: keccak256(altered),
  }));
  await assert.rejects(() => f.service.retry(identity, id(1), {}), /exact-call or fee/);
  assert.equal(f.effects.broadcasts.length, 1);
  assert.equal(f.effects.nonceReads, 1);
  await f.store.close();
});

test('a crash between sponsor persistence and operation persistence resumes the same signed envelope', async () => {
  const database = new LocalStore(':memory:');
  let fail = true;
  const store: Store = {
    get: database.get.bind(database),
    create: database.create.bind(database),
    scan: database.scan.bind(database),
    close: database.close.bind(database),
    update: (key, change) =>
      database.update(key, (current) => {
        const next = change(current);
        if (
          fail &&
          key.startsWith('native:robinhood:operation:') &&
          (next as RobinhoodOperation).rawTransaction
        )
          throw new Error('Interruption before operation record persisted');
        return next;
      }),
  };
  const f = fixture(store);
  await f.plan();
  const signature = await f.sign();
  await assert.rejects(() => f.service.authorize(identity, id(1), { signature }), /Interruption/);
  assert.equal(f.effects.broadcasts.length, 0);
  const reservation = await store.get<{ prepared: { rawTransaction: Hex } }>(
    `native:robinhood:sponsor:4663:${sponsor.address.toLowerCase()}`,
  );
  assert.ok(reservation?.prepared.rawTransaction);
  fail = false;
  const resumed = await f.service.retry(identity, id(1), {});
  assert.equal(resumed.state, 'submitted');
  assert.equal(f.effects.nonceReads, 1);
  assert.equal(f.effects.broadcasts[0], reservation.prepared.rawTransaction);
  await store.close();
});

test('an expired preparation lease is fenced before another request can broadcast', async () => {
  const f = fixture();
  await f.plan();
  const signature = await f.sign();
  let begin!: () => void;
  let finish!: (gas: bigint) => void;
  const entered = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const suspended = new Promise<bigint>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  f.client.estimateGas = (async () => {
    calls++;
    if (calls === 1) {
      begin();
      return suspended;
    }
    return 100000n;
  }) as PublicClient['estimateGas'];
  const first = f.service.authorize(identity, id(1), { signature });
  const rejected = assert.rejects(first, /preparation expired/);
  await entered;
  f.controls.time += 61n;
  f.observed.observedAt = f.controls.time.toString();
  const second = await f.service.authorize(identity, id(1), { signature });
  assert.equal(second.state, 'submitted');
  finish(100000n);
  await rejected;
  assert.equal(f.effects.broadcasts.length, 1);
  await f.store.close();
});

test('one sponsor nonce reservation prevents a second pending operation until confirmed reconciliation', async () => {
  const f = fixture();
  await f.plan(1);
  await f.plan(2);
  await f.service.authorize(identity, id(1), { signature: await f.sign(1) });
  const signature = await f.sign(2);
  await assert.rejects(
    () => f.service.authorize(identity, id(2), { signature }),
    /Another native operation/,
  );
  f.controls.receipt = true;
  assert.equal((await f.service.reconcile(identity, id(1))).state, 'completed');
  const reservation = await f.store.get<{ operationId: string | null }>(
    `native:robinhood:sponsor:4663:${sponsor.address.toLowerCase()}`,
  );
  assert.equal(reservation?.operationId, null);
  await f.store.close();
});

test('worker reconciles only exact canonical native receipt evidence, never sends or books demo finance', async () => {
  const f = fixture();
  await f.plan();
  await f.service.authorize(identity, id(1), { signature: await f.sign() });
  f.controls.receipt = true;
  f.controls.confirmations = 1n;
  const confirming = await reconcileRobinhoodOperations(f.store, f.client, f.config);
  assert.equal(confirming.results[0].state, 'confirming');
  f.controls.confirmations = 3n;
  const completed = await reconcileRobinhoodOperations(f.store, f.client, f.config);
  assert.equal(completed.results[0].state, 'completed');
  assert.equal(f.effects.broadcasts.length, 1);
  const status = await f.service.status(identity, id(1));
  assert.equal(status.evidence, 'confirmed-native-receipt');
  assert.equal(status.reconciliation?.status, 'completed');
  assert.deepEqual(await f.store.scan('workspace:'), []);
  await f.store.close();
});

test('a delayed pending RPC result cannot overwrite a newer confirmed observation', async () => {
  const f = fixture();
  await f.plan();
  await f.service.authorize(identity, id(1), { signature: await f.sign() });
  let entered!: () => void;
  let fail!: (error: Error) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delayed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const original = f.client.getTransactionReceipt;
  let reads = 0;
  f.client.getTransactionReceipt = (async (args) => {
    reads++;
    if (reads === 1) {
      entered();
      return delayed;
    }
    return original(args);
  }) as PublicClient['getTransactionReceipt'];
  const early = f.service.reconcile(identity, id(1));
  await started;
  f.controls.receipt = true;
  assert.equal((await f.service.reconcile(identity, id(1))).state, 'completed');
  const missing = new Error('Earlier request saw no receipt');
  missing.name = 'TransactionReceiptNotFoundError';
  fail(missing);
  assert.equal((await early).state, 'completed');
  assert.equal((await f.service.status(identity, id(1))).state, 'completed');
  await f.store.close();
});

test('foreign calldata never reconciles and an unconfirmed revert retains the sponsor reservation', async () => {
  const f = fixture();
  await f.plan();
  await f.service.authorize(identity, id(1), { signature: await f.sign() });
  f.controls.receipt = true;
  f.controls.changedInput = true;
  assert.equal((await f.service.reconcile(identity, id(1))).state, 'unverified');
  f.controls.changedInput = false;
  f.controls.reverted = true;
  f.controls.confirmations = 1n;
  assert.notEqual((await f.service.reconcile(identity, id(1))).state, 'reverted');
  const reservation = `native:robinhood:sponsor:4663:${sponsor.address.toLowerCase()}`;
  assert.equal((await f.store.get<{ operationId: string }>(reservation))!.operationId, id(1));
  f.controls.confirmations = 3n;
  assert.equal((await f.service.reconcile(identity, id(1))).state, 'reverted');
  assert.equal((await f.store.get<{ operationId: string | null }>(reservation))!.operationId, null);
  await f.store.close();
});

test('gas and total-fee limits fail before persistence or broadcast of a signed transaction', async () => {
  for (const change of ['gas', 'fee', 'total'] as const) {
    const f = fixture();
    await f.plan();
    if (change === 'gas') f.controls.estimate = 500001n;
    if (change === 'fee') f.controls.fee = 101n;
    if (change === 'total') f.config.sponsor!.maxTotalFee = 1n;
    const signature = await f.sign();
    await assert.rejects(
      () => f.service.authorize(identity, id(1), { signature }),
      /exceeds configured limits/,
    );
    assert.equal(
      (await f.store.get<RobinhoodOperation>(operationKey(id(1))))!.rawTransaction,
      undefined,
    );
    const reservation = await f.store.get<{ operationId: string | null }>(
      `native:robinhood:sponsor:4663:${sponsor.address.toLowerCase()}`,
    );
    assert.equal(
      reservation?.operationId,
      null,
      'failed preparation must release only its own fenced reservation',
    );
    assert.equal(f.effects.broadcasts.length, 0);
    await f.store.close();
  }
});

test('signed sponsor envelope cannot change recipient, ETH value, calldata, chain or configured fee limits', async () => {
  const f = fixture();
  await f.plan();
  await f.service.authorize(identity, id(1), { signature: await f.sign() });
  const record = (await f.store.get<RobinhoodOperation>(operationKey(id(1))))!;
  const base = {
    type: 'eip1559' as const,
    chainId: 4663,
    to: escrow,
    data: record.relayPlan!.data,
    value: 0n,
    nonce: 7,
    gas: 120000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  };
  for (const change of [
    { to: stranger.address },
    { value: 1n },
    { data: '0x1234' as Hex },
    { chainId: 1 },
    { maxFeePerGas: 101n },
  ]) {
    const raw = await sponsor.signTransaction({ ...base, ...change });
    await assert.rejects(
      () => assertSponsoredTransaction(raw, record.relayPlan!, sponsor.address, f.config.sponsor!),
      /exact-call or fee/,
    );
  }
  await f.store.close();
});

test('runtime verification rejects spoof getter contracts even when the operator supplies their exact hash', async () => {
  const code = '0x6000' as Hex;
  assert.throws(() => assertRentalEscrowRuntime(code, keccak256(code)), /code does not match/);
  const f = fixture();
  f.config.deploymentCodeHash = keccak256(code);
  await assert.rejects(() => observeConfiguredEscrow(f.client, f.config), /code does not match/);
  await f.store.close();
});

test('runtime configuration defaults to disabled and requires explicit bounded sponsor settings', () => {
  const env = {
    ROBINHOOD_RPC_URL: 'https://rpc.example.test',
    ROBINHOOD_ESCROW_ADDRESS: escrow,
    ROBINHOOD_ESCROW_CODE_HASH: blockHash,
  };
  assert.equal(loadRobinhoodConfig(env).sendEnabled, false);
  assert.equal(loadRobinhoodConfig(env).sponsor, null);
  assert.throws(
    () => loadRobinhoodConfig({ ...env, ROBINHOOD_SEND_ENABLED: '1' }),
    /explicit bounded/,
  );
  const enabled = {
    ...env,
    ROBINHOOD_SEND_ENABLED: '1',
    ROBINHOOD_SPONSOR_PRIVATE_KEY: key(14),
    ROBINHOOD_SPONSOR_MAX_GAS: '500000',
    ROBINHOOD_SPONSOR_MAX_FEE_WEI: '100',
    ROBINHOOD_SPONSOR_MAX_TOTAL_FEE_WEI: '50000000',
  };
  assert.ok(loadRobinhoodConfig(enabled).sponsor);
  for (const delta of [
    { ROBINHOOD_SPONSOR_MAX_GAS: '2000001' },
    { ROBINHOOD_SPONSOR_MAX_FEE_WEI: '100000000001' },
    { ROBINHOOD_SPONSOR_MAX_TOTAL_FEE_WEI: '100000000000000001' },
  ])
    assert.throws(() => loadRobinhoodConfig({ ...enabled, ...delta }));
  assert.throws(() =>
    loadRobinhoodConfig({ ...env, ROBINHOOD_RPC_URL: 'http://not-local.example' }),
  );
});

test('missing authentication cannot reach provider verification or a configured finance service', async () => {
  await assert.rejects(
    () => verifiedRobinhoodIdentity(new Request('https://example.test/api/finance/robinhood')),
    (error) => error instanceof RobinhoodServiceError && error.status === 401,
  );
});
