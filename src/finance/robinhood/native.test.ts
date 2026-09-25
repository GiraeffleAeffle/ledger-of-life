import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { rentalEscrowAbi } from './abi.ts';
import { atomic, robinhoodMainnet } from './manifest.ts';
import { planEscrowCall } from './plan.ts';
import { reconcileReceipt } from './reconcile.ts';
import { stockExposure, stockValueFromAdjustedFeed, type EscrowSnapshot } from './read.ts';
import { quoteStockTrade, type StockRouteConfig, type StockTradeRequest } from './zeroEx.ts';
import { prepareSignedOperation, encodeSignedOperation } from './relay.ts';

const tenant: Address = '0x0000000000000000000000000000000000000101';
const landlord: Address = '0x0000000000000000000000000000000000000102';
const arbitrator: Address = '0x0000000000000000000000000000000000000103';
const escrow: Address = '0x0000000000000000000000000000000000000111';
const now = 1_800_000_000n;
const snapshot: EscrowSnapshot = {
  status: 'available',
  address: escrow,
  chainId: 4663,
  blockNumber: '100',
  blockHash: `0x${'1'.repeat(64)}`,
  observedAt: now.toString(),
  state: 2,
  nonce: '4',
  asset: robinhoodMainnet.asset.address,
  vault: robinhoodMainnet.vault,
  tenant,
  landlord,
  arbitrator,
  personalWallet: tenant,
  agreementHash: `0x${'a'.repeat(64)}`,
  securityRequirement: '3000000000',
  fundingReserve: '10000',
  earningsReleaseAllowed: true,
  tenantAccepted: true,
  landlordAccepted: true,
  arbitratedDecision: false,
  trackedShares: '3000000000000000000000',
  totalSupplied: '3000000000',
  totalRedeemed: '0',
  releasedEarnings: '0',
  securityValue: '3010000000',
  releasableEarnings: '10000000',
  claimAmount: '120000000',
  approvedLandlordAmount: '0',
  minimumSettlementAssets: '0',
  settledLandlordAmount: '0',
  settledTenantAmount: '0',
  cashWithdrawalStatus: 'requires-exact-call-simulation',
};

test('atomic units reject floats, negative, exponent and overflowing inputs', () => {
  for (const value of ['1.0', '-1', '1e6', '00', '', (1n << 256n).toString()])
    assert.throws(() => atomic(value));
  assert.equal(atomic('3000000000'), 3_000_000_000n);
});
test('native earnings plan binds signer, chain, escrow, amount, nonce and deadline', () => {
  const plan = planEscrowCall(
    robinhoodMainnet,
    snapshot,
    { kind: 'releaseEarnings', assets: '10000000', maxSharesBurned: '10000000000000000000' },
    tenant,
    (now + 120n).toString(),
    now,
  );
  const call = decodeFunctionData({ abi: rentalEscrowAbi, data: plan.data });
  assert.equal(plan.to, escrow);
  assert.equal(plan.requiredSigner, tenant);
  assert.equal(plan.chainId, 4663);
  assert.equal(call.functionName, 'releaseEarnings');
  assert.deepEqual(call.args, [10_000_000n, 10_000_000_000_000_000_000n, 4n, now + 120n]);
  assert.equal(plan.expectedEvent, 'EarningsReleased');
});
test('landlord cannot prepare tenant earnings release and over-harvest is rejected', () => {
  const intent = {
    kind: 'releaseEarnings' as const,
    assets: '10000000',
    maxSharesBurned: '10000000000000000000',
  };
  assert.throws(() =>
    planEscrowCall(robinhoodMainnet, snapshot, intent, landlord, (now + 120n).toString(), now),
  );
  assert.throws(() =>
    planEscrowCall(
      robinhoodMainnet,
      snapshot,
      { ...intent, assets: '10000001' },
      tenant,
      (now + 120n).toString(),
      now,
    ),
  );
});
test('network substitution, stale valuation and expired authorization are rejected', () => {
  assert.throws(() =>
    planEscrowCall(
      robinhoodMainnet,
      { ...snapshot, chainId: 1 },
      { kind: 'fund' },
      tenant,
      (now + 120n).toString(),
      now,
    ),
  );
  assert.throws(() =>
    planEscrowCall(
      robinhoodMainnet,
      { ...snapshot, observedAt: (now - 61n).toString() },
      { kind: 'fund' },
      tenant,
      (now + 120n).toString(),
      now,
    ),
  );
  assert.throws(() =>
    planEscrowCall(robinhoodMainnet, snapshot, { kind: 'fund' }, tenant, now.toString(), now),
  );
});
test('arbitration is assigned and capped by the requested claim', () => {
  const intent = {
    kind: 'resolveClaim' as const,
    landlordAssets: '120000001',
    minimumAssets: '3000000000',
  };
  assert.throws(() =>
    planEscrowCall(robinhoodMainnet, snapshot, intent, arbitrator, (now + 120n).toString(), now),
  );
  assert.throws(() =>
    planEscrowCall(
      robinhoodMainnet,
      snapshot,
      { ...intent, landlordAssets: '120000000' },
      landlord,
      (now + 120n).toString(),
      now,
    ),
  );
});
test('stock display and already-adjusted price do not multiply distributions twice', () => {
  assert.equal(stockExposure(2n * 10n ** 18n, 11n * 10n ** 17n), 22n * 10n ** 17n);
  assert.equal(stockValueFromAdjustedFeed(2n * 10n ** 18n, 110n * 10n ** 8n, 8), 220n * 10n ** 18n);
});

const hash = `0x${'2'.repeat(64)}` as Hex;
function receiptClient(
  options: {
    changedData?: boolean;
    wrongNonce?: boolean;
    head?: bigint;
    fail?: boolean;
    reorg?: boolean;
  } = {},
): PublicClient {
  const plan = planEscrowCall(
    robinhoodMainnet,
    snapshot,
    { kind: 'fund' },
    tenant,
    (now + 120n).toString(),
    now,
  );
  return {
    getChainId: async () => 4663,
    getTransactionReceipt: async () => {
      if (options.fail) throw new Error('RPC unavailable');
      return {
        status: 'success',
        blockNumber: 100n,
        blockHash: snapshot.blockHash,
        logs: [
          {
            address: escrow,
            data: encodeAbiParameters([{ type: 'uint256' }], [3_000_000_000n]),
            topics: encodeEventTopics({
              abi: rentalEscrowAbi,
              eventName: 'Funded',
              args: { operationNonce: options.wrongNonce ? 9n : 4n },
            }),
          },
        ],
      };
    },
    getTransaction: async () => ({
      to: escrow,
      from: tenant,
      input: options.changedData ? '0x1234' : plan.data,
      value: 0n,
    }),
    getBlock: async () => ({ hash: options.reorg ? hash : snapshot.blockHash }),
    getBlockNumber: async () => options.head ?? 102n,
  } as unknown as PublicClient;
}
test('receipt needs exact calldata, canonical block, escrow event and operation nonce', async () => {
  const plan = planEscrowCall(
    robinhoodMainnet,
    snapshot,
    { kind: 'fund' },
    tenant,
    (now + 120n).toString(),
    now,
  );
  const result = await reconcileReceipt(receiptClient(), plan, hash);
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') assert.equal(result.amounts.assets, '3000000000');
  assert.equal(
    (await reconcileReceipt(receiptClient({ changedData: true }), plan, hash)).status,
    'unverified',
  );
  assert.equal(
    (await reconcileReceipt(receiptClient({ wrongNonce: true }), plan, hash)).status,
    'unverified',
  );
  assert.equal(
    (await reconcileReceipt(receiptClient({ reorg: true }), plan, hash)).status,
    'pending',
  );
});
test('RPC outages and insufficient confirmations never mark financial effects complete', async () => {
  const plan = planEscrowCall(
    robinhoodMainnet,
    snapshot,
    { kind: 'fund' },
    tenant,
    (now + 120n).toString(),
    now,
  );
  assert.equal(
    (await reconcileReceipt(receiptClient({ fail: true }), plan, hash)).status,
    'unavailable',
  );
  assert.equal(
    (await reconcileReceipt(receiptClient({ head: 100n }), plan, hash)).status,
    'confirming',
  );
});

const config: StockRouteConfig = {
  apiKey: 'test-only',
  rwaAccessEnabled: true,
  allowedTransactionTargets: [arbitrator],
  allowedAllowanceTargets: [landlord],
  enabledStocks: [robinhoodMainnet.stock!],
};
const request: StockTradeRequest = {
  side: 'buy',
  personalWallet: tenant,
  stock: robinhoodMainnet.stock!,
  sellAmount: '10000000',
  slippageBps: 50,
  eligibility: { verified: true, customerId: 'fixture-user', expiresAt: 2_000_000_000_000 },
};
const quoteResponse = {
  liquidityAvailable: true,
  sellToken: robinhoodMainnet.asset.address,
  buyToken: request.stock,
  sellAmount: '10000000',
  buyAmount: '20000000000000000',
  minBuyAmount: '19900000000000000',
  blockNumber: '100',
  allowanceTarget: landlord,
  issues: { allowance: { actual: '0', spender: landlord }, simulationIncomplete: false },
  fees: { zeroExFee: null },
  transaction: { to: arbitrator, data: '0x1234567890abcdef', value: '0', gas: '200000' },
};
const respond = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

test('missing provider access disables quotes without making a network request', async () => {
  let called = false;
  const result = await quoteStockTrade({ ...config, apiKey: undefined }, request, (async () => {
    called = true;
    throw new Error();
  }) as typeof fetch);
  assert.equal(result.status, 'unavailable');
  assert.equal(called, false);
});
test('quote validates personal trade metadata and returns only bounded approval', async () => {
  const result = await quoteStockTrade(config, request, respond(quoteResponse), 1_900_000_000_000);
  assert.equal(result.status, 'quote');
  if (result.status === 'quote') {
    assert.equal(result.approval?.amount, '10000000');
    assert.equal(result.taker, tenant);
  }
});
test('quote rejects substituted token, amount, spender, native value and simulation failure', async () => {
  for (const response of [
    { ...quoteResponse, buyToken: tenant },
    { ...quoteResponse, sellAmount: '10000001' },
    { ...quoteResponse, allowanceTarget: tenant },
    { ...quoteResponse, minBuyAmount: '1' },
    { ...quoteResponse, chainId: 1 },
    { ...quoteResponse, transaction: { ...quoteResponse.transaction, value: '1' } },
    { ...quoteResponse, issues: { simulationIncomplete: true } },
  ])
    assert.equal(
      (await quoteStockTrade(config, request, respond(response), 1_900_000_000_000)).status,
      'unavailable',
    );
});
test('eligibility and reviewed route metadata are required separately from an API key', async () => {
  assert.equal(
    (
      await quoteStockTrade(
        config,
        { ...request, eligibility: { ...request.eligibility, verified: false } },
        respond(quoteResponse),
      )
    ).status,
    'unavailable',
  );
  assert.equal(
    (
      await quoteStockTrade(
        { ...config, allowedTransactionTargets: [] },
        request,
        respond(quoteResponse),
      )
    ).status,
    'unavailable',
  );
});

test('relay schema binds every argument and has no arbitrary target or value', () => {
  const prepared = prepareSignedOperation(
    robinhoodMainnet,
    snapshot,
    { kind: 'releaseEarnings', assets: '10000000', maxSharesBurned: '10000000000000000000' },
    tenant,
    (now + 120n).toString(),
    now,
  );
  assert.equal(prepared.typedData.domain.verifyingContract, escrow);
  assert.equal(prepared.typedData.domain.chainId, 4663);
  assert.equal(prepared.typedData.primaryType, 'EscrowAction');
  assert.deepEqual(prepared.action, {
    signer: tenant,
    kind: 3,
    amount: 10_000_000n,
    limit: 10n * 10n ** 18n,
    evidence: `0x${'0'.repeat(64)}`,
    expectedNonce: 4n,
    deadline: now + 120n,
  });
  const changed = prepareSignedOperation(
    robinhoodMainnet,
    snapshot,
    { kind: 'releaseEarnings', assets: '9999999', maxSharesBurned: '10000000000000000000' },
    tenant,
    (now + 120n).toString(),
    now,
  );
  assert.notEqual(prepared.digest, changed.digest);
  const encoded = encodeSignedOperation(prepared, `0x${'0'.repeat(130)}`);
  const decoded = decodeFunctionData({ abi: rentalEscrowAbi, data: encoded.data });
  assert.equal(decoded.functionName, 'executeSigned');
  assert.equal(encoded.relayAuthorization?.digest, prepared.digest);
});

test('a relayed receipt needs both the signature proof event and exact authorized native effect', async () => {
  const prepared = prepareSignedOperation(
    robinhoodMainnet,
    snapshot,
    { kind: 'fund' },
    tenant,
    (now + 120n).toString(),
    now,
  );
  const plan = encodeSignedOperation(prepared, `0x${'0'.repeat(130)}`);
  const base = receiptClient();
  const receipt = await base.getTransactionReceipt({ hash });
  const signedLog = {
    address: escrow,
    data: '0x',
    topics: encodeEventTopics({
      abi: rentalEscrowAbi,
      eventName: 'SignedOperationExecuted',
      args: { signer: tenant, digest: prepared.digest, operationNonce: 4n },
    }),
  };
  const client = {
    ...base,
    getTransaction: async () => ({ to: escrow, from: arbitrator, input: plan.data, value: 0n }),
    getTransactionReceipt: async () => ({ ...receipt, logs: [...receipt.logs, signedLog] }),
  } as unknown as PublicClient;
  assert.equal((await reconcileReceipt(client, plan, hash)).status, 'completed');
  const missingProof = {
    ...client,
    getTransactionReceipt: async () => receipt,
  } as unknown as PublicClient;
  assert.equal((await reconcileReceipt(missingProof, plan, hash)).status, 'unverified');
});
