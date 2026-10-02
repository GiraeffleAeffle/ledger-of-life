import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, test } from 'node:test';
import { decodeFunctionData, keccak256, parseAbi, parseTransaction, type Hex } from 'viem';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { LocalStore } from './store.ts';
import { createHostInvitation, createHostPairing, ownedConnectorHosts } from './local-ai-hosts.ts';
import { assignNodeSolar, recordNodeCapabilities, recordNodeReading, reviewNodeSolar } from './home-node.ts';
import { buildingIncomeConfig, buildingIncomeJournals, reconcileBuildingIncome } from './building-income.ts';
import { loadBuildingManifest } from './building-revenue.ts';

const environment = { BUILDING_INCOME_PRIVATE_KEY: `0x${'11'.repeat(32)}`, BUILDING_INCOME_SOLAR_TARIFF: '0.08', BUILDING_INCOME_DAILY_CAP: '0.1' };
const mintAbi = parseAbi(['function mint(address to,uint256 amount)']);
const start = Date.parse('2026-10-02T12:00:00Z');
const operator: VerifiedIdentity = { subject: 'operator', sessionId: 'session', expiresAt: 2000000000, wallets: [{ id: 'operator', chainType: 'ethereum', address: '0x3333333333333333333333333333333333333333' }], passkeyCount: 0 };
const originalAllowlist = process.env.LOCAL_AI_HOST_OWNER_WALLETS;
process.env.LOCAL_AI_HOST_OWNER_WALLETS = operator.wallets[0].address;
after(() => { if (originalAllowlist === undefined) delete process.env.LOCAL_AI_HOST_OWNER_WALLETS; else process.env.LOCAL_AI_HOST_OWNER_WALLETS = originalAllowlist; });
async function node(store: LocalStore, subject: string, assigned = true, sampleCount = 3, approved = true) {
  const identity: VerifiedIdentity = { subject, sessionId: 'session', expiresAt: 2000000000, wallets: [{ id: 'wallet', chainType: 'ethereum', address: '0x2222222222222222222222222222222222222222' }], passkeyCount: 0 };
  const invitation = await createHostInvitation(store, identity, {}, start);
  const key = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const { hostId } = await createHostPairing(store, { code: invitation.code, publicKey: key, name: subject }, start);
  const host = (await ownedConnectorHosts(store, identity, start))[0];
  await recordNodeCapabilities(store, host, { gpuModels: [], solarSensors: ['sensor.solar'], validatorIds: [] }, start);
  if (assigned) await assignNodeSolar(store, identity, hostId, true, 2, start);
  for (let index = 0; index < sampleCount; index++) {
    const time = start + (index + 1) * 30000;
    await recordNodeReading(store, host, { powerW: 500, energyTodayKwh: 10 + index * 0.5, timestamp: new Date(time).toISOString(), localDate: '2026-10-02', timezone: 'Europe/Berlin' }, time);
  }
  if (assigned && approved) await reviewNodeSolar(store, operator, hostId, true, start + sampleCount * 30000);
  return host;
}
async function fixture(store: LocalStore) {
  const sent: Hex[] = [];
  let ambiguous = false;
  let signingUnavailable = false;
  const manifest = await loadBuildingManifest();
  assert.ok(manifest?.distributor);
  const client = {
    getChainId: async () => 46630,
    readContract: async ({ functionName }: { functionName: string }) => functionName === 'decimals' ? 6 : 1000000000n,
    getTransactionCount: async () => sent.length,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => { if (signingUnavailable) throw new Error('signing unavailable'); return 60000n; },
    getTransactionReceipt: async () => { const error = new Error('not found'); error.name = 'TransactionReceiptNotFoundError'; throw error; },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const saved = await buildingIncomeJournals(store);
      assert.ok(saved.some(row => row.step.signed === serializedTransaction && row.step.hash === keccak256(serializedTransaction) && row.state === 'pending'));
      sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (ambiguous) throw new Error('lost receipt');
      return { transactionHash: hash, status: 'success' };
    },
  } as unknown as NonNullable<Parameters<typeof reconcileBuildingIncome>[1]>['client'];
  return { sent, setAmbiguous: (value: boolean) => { ambiguous = value; }, setSigningUnavailable: (value: boolean) => { signingUnavailable = value; }, options: { environment, client, now: Date.parse('2026-10-02T23:00:01Z'), loadManifest: async () => manifest, verifyManifest: async () => {} } };
}
test('completed-day income excludes pre-opt-in energy and unassigned nodes, enforces global cap and one mint per node/local day', async () => {
  const store = new LocalStore(':memory:');
  try {
    await node(store, 'first');
    await node(store, 'second');
    await node(store, 'not-assigned', false);
    const f = await fixture(store);
    const result = await reconcileBuildingIncome(store, f.options);
    assert.equal('minted' in result && result.minted, 2);
    const transactions = f.sent.map(bytes => parseTransaction(bytes));
    const amounts = transactions.map(tx => decodeFunctionData({ abi: mintAbi, data: tx.data! }).args[1]);
    assert.deepEqual(amounts.sort((a, b) => Number(a - b)), [20000n, 80000n]);
    assert.ok(transactions.every(tx => tx.chainId === 46630));
    assert.equal((await buildingIncomeJournals(store)).reduce((sum, row) => sum + BigInt(row.amountAtomic), 0n), 100000n);
    await reconcileBuildingIncome(store, f.options);
    assert.equal(f.sent.length, 2);
    const future = await reconcileBuildingIncome(store, { ...f.options, now: start + 86400000 });
    assert.equal('minted' in future && future.minted, 0);
    assert.equal(f.sent.length, 2);
    assert.equal(buildingIncomeConfig({}).configured, false);
    const skipped = await reconcileBuildingIncome(store, { environment: {}, now: start + 86400000 });
    assert.equal(skipped.status, 'unconfigured');
  } finally { await store.close(); }
});
test('an ambiguous broadcast recovers the same signed transaction after readings age, never a replacement mint', async () => {
  const store = new LocalStore(':memory:');
  try {
    await node(store, 'recover');
    const f = await fixture(store);
    f.setAmbiguous(true);
    await assert.rejects(reconcileBuildingIncome(store, f.options), /lost receipt/);
    assert.equal(f.sent.length, 1);
    const first = f.sent[0];
    f.setAmbiguous(false);
    await reconcileBuildingIncome(store, { ...f.options, now: start + 86400000 });
    assert.deepEqual(f.sent, [first, first]);
    const journal = (await buildingIncomeJournals(store))[0];
    assert.equal(journal.state, 'done');
    assert.equal(journal.step.hash, keccak256(first));
    await reconcileBuildingIncome(store, { ...f.options, now: start + 86400000 });
    assert.equal(f.sent.length, 2);
  } finally { await store.close(); }
});
test('unsigned reservations whose measured evidence expires are cancelled and release their nonce lane without a mint', async () => {
  const store = new LocalStore(':memory:');
  try {
    await node(store, 'unsigned');
    const f = await fixture(store);
    f.setSigningUnavailable(true);
    await assert.rejects(reconcileBuildingIncome(store, f.options), /signing unavailable/);
    assert.equal(f.sent.length, 0);
    const reserved = (await buildingIncomeJournals(store))[0];
    assert.equal(reserved.state, 'pending');
    assert.equal(reserved.step.signed, undefined);
    f.setSigningUnavailable(false);
    await reconcileBuildingIncome(store, { ...f.options, now: start + 31 * 86400000 });
    assert.equal(f.sent.length, 0);
    assert.equal((await buildingIncomeJournals(store))[0].state, 'cancelled');
    const lane = await store.get<{ active: string | null }>(`operator-nonce-lane:46630:${buildingIncomeConfig(environment).incomeWallet!.toLowerCase()}`);
    assert.equal(lane!.active, null);
  } finally { await store.close(); }
});
test('local-midnight rollover settles the completed solar day before UTC midnight, using its maximum rather than the new-day reset', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await node(store, 'rollover');
    const f = await fixture(store);
    const midnight = Date.parse('2026-10-02T22:00:30Z');
    await reconcileBuildingIncome(store, { ...f.options, now: midnight });
    assert.equal(f.sent.length, 0); // Not yet one hour past local midnight, and no later-day sample.
    await recordNodeReading(store, host, { powerW: 0, energyTodayKwh: 0, timestamp: new Date(midnight).toISOString(), localDate: '2026-10-03', timezone: 'Europe/Berlin' }, midnight);
    await reconcileBuildingIncome(store, { ...f.options, now: midnight });
    const journal = (await buildingIncomeJournals(store))[0];
    assert.equal(journal.day, '2026-10-02');
    assert.equal(journal.energyKwh, 1);
    assert.equal(journal.amountAtomic, '80000');
    const transaction = parseTransaction(f.sent[0]);
    assert.equal(decodeFunctionData({ abi: mintAbi, data: transaction.data! }).args[1], 80000n);
  } finally { await store.close(); }
});
test('missing end-of-day samples pay a measured lower bound after the one-hour grace; fewer than three fresh observations pay nothing', async () => {
  const store = new LocalStore(':memory:');
  try {
    const enough = await node(store, 'lower-bound');
    await node(store, 'insufficient', true, 2);
    const f = await fixture(store);
    await reconcileBuildingIncome(store, f.options);
    const journals = await buildingIncomeJournals(store);
    assert.equal(journals.length, 1);
    assert.equal(journals[0].hostId, enough.id);
    assert.equal(journals[0].energyKwh, 1);
    assert.equal(journals[0].readingTimestamp, new Date(start + 90000).toISOString());
    assert.equal(journals[0].amountAtomic, '80000');
  } finally { await store.close(); }
});
test('self-attested completed days cannot mint while pending/rejected or after an above-cap anomaly pauses approval', async () => {
  const store = new LocalStore(':memory:');
  try {
    const host = await node(store, 'pending-solar', true, 3, false);
    const f = await fixture(store);
    await reconcileBuildingIncome(store, f.options);
    assert.equal(f.sent.length, 0);
    await reviewNodeSolar(store, operator, host.id, false, start + 90000);
    await reconcileBuildingIncome(store, f.options);
    assert.equal(f.sent.length, 0);
    await reviewNodeSolar(store, operator, host.id, true, start + 90000);
    await recordNodeReading(store, host, { powerW: 1000, energyTodayKwh: 17, timestamp: new Date(start + 120000).toISOString(), localDate: '2026-10-02', timezone: 'Europe/Berlin' }, start + 120000);
    await reconcileBuildingIncome(store, f.options);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(await buildingIncomeJournals(store), []);
  } finally { await store.close(); }
});
