import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, test } from 'node:test';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { LocalStore } from './store.ts';
import { createHostInvitation, createHostPairing, ownedConnectorHosts } from './local-ai-hosts.ts';
import { assignNodeSolar, HOME_NODE_PREFIX, myHomeNodes, nodeLocalDay, operatorHomeNodes, recordNodeCapabilities, recordNodeReading, reviewNodeSolar, type NodeRecord } from './home-node.ts';
import { reconcileBuildingIncome } from './building-income.ts';
const owner: VerifiedIdentity = { subject: 'node-owner', sessionId: 'session', expiresAt: 2000000000, wallets: [{ id: 'wallet', chainType: 'ethereum', address: '0x1111111111111111111111111111111111111111' }], passkeyCount: 0 };
const originalAllowlist = process.env.LOCAL_AI_HOST_OWNER_WALLETS;
const operator: VerifiedIdentity = { ...owner, subject: 'operator', wallets: [{ id: 'operator', chainType: 'ethereum', address: '0x3333333333333333333333333333333333333333' }] };
process.env.LOCAL_AI_HOST_OWNER_WALLETS = operator.wallets[0].address;
after(() => { if (originalAllowlist === undefined) delete process.env.LOCAL_AI_HOST_OWNER_WALLETS; else process.env.LOCAL_AI_HOST_OWNER_WALLETS = originalAllowlist; });
async function paired(store: LocalStore, now: number) {
  const invite = await createHostInvitation(store, owner, {}, now);
  const keys = generateKeyPairSync('ed25519');
  const { hostId } = await createHostPairing(store, { code: invite.code, publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), name: 'Solar node' }, now);
  return (await ownedConnectorHosts(store, owner, now)).find(host => host.id === hostId)!;
}
test('private node readings enforce time, monotonic daily energy, rate bounds, day rollover and owner isolation', async () => {
  const store = new LocalStore(':memory:');
  try {
    const now = Date.parse('2026-10-02T23:59:00Z');
    const host = await paired(store, now);
    await recordNodeCapabilities(store, host, { gpuModels: [], solarSensors: ['sensor.solar'], validatorIds: ['validator-public-id'] }, now);
    await recordNodeReading(store, host, { powerW: 1250, energyTodayKwh: 8, timestamp: new Date(now).toISOString() }, now);
    await assert.rejects(recordNodeReading(store, host, { powerW: 100, energyTodayKwh: 9, timestamp: new Date(now + 1000).toISOString() }, now + 1000), /30 seconds/);
    await assert.rejects(recordNodeReading(store, host, { powerW: 100, energyTodayKwh: 7, timestamp: new Date(now + 30000).toISOString() }, now + 30000), /must not decrease/);
    await assert.rejects(recordNodeReading(store, host, { powerW: NaN, energyTodayKwh: 9, timestamp: new Date(now + 30000).toISOString() }, now + 30000), /finite/);
    await assert.rejects(recordNodeReading(store, host, { powerW: 100, energyTodayKwh: 9, timestamp: new Date(now - 300001).toISOString() }, now), /fresh/);
    await recordNodeReading(store, host, { powerW: null, energyTodayKwh: 0.1, timestamp: new Date(now + 60000).toISOString() }, now + 60000);
    const devices = await myHomeNodes(store, owner, now + 60000);
    assert.deepEqual(devices.devices[0].dailyTotals.map(row => [row.day, row.energyKwh]), [['2026-10-02', 8], ['2026-10-03', 0.1]]);
    const foreign = { ...owner, subject: 'other' };
    assert.deepEqual((await myHomeNodes(store, foreign, now)).devices, []);
    await assert.rejects(assignNodeSolar(store, foreign, host.id, true, 2, now), /Only the node owner/);
    await assert.rejects(recordNodeCapabilities(store, host, { gpuModels: [], solarSensors: [], validatorIds: Array(17).fill('validator') }, now + 30000), /bounded/);
    const aged = now + 31 * 86400000;
    assert.equal((await myHomeNodes(store, owner, aged)).devices[0].latestReading, null);
    await reconcileBuildingIncome(store, { environment: {}, now: aged });
    const persisted = await store.get<NodeRecord>(HOME_NODE_PREFIX + host.id);
    assert.equal(persisted!.latestReading, null);
    assert.deepEqual(persisted!.dailyTotals, []);
  } finally { await store.close(); }
});
test('solar assignment uses the first post-opt-in reading as its conservative baseline and is idempotent', async () => {
  const store = new LocalStore(':memory:');
  try {
    const now = Date.parse('2026-10-02T12:00:00Z');
    const host = await paired(store, now);
    await recordNodeReading(store, host, { powerW: 500, energyTodayKwh: 4, timestamp: new Date(now).toISOString() }, now);
    await assignNodeSolar(store, owner, host.id, true, 2, now + 1000);
    await recordNodeReading(store, host, { powerW: 500, energyTodayKwh: 5, timestamp: new Date(now + 60000).toISOString() }, now + 60000);
    await recordNodeReading(store, host, { powerW: 500, energyTodayKwh: 6, timestamp: new Date(now + 120000).toISOString() }, now + 120000);
    await assignNodeSolar(store, owner, host.id, true, 2, now + 130000);
    assert.equal((await store.get<NodeRecord>(HOME_NODE_PREFIX + host.id))!.baselineKwh, 5);
    assert.equal((await store.get<NodeRecord>(HOME_NODE_PREFIX + host.id))!.assignedAt, new Date(now + 1000).toISOString());
    await assignNodeSolar(store, owner, host.id, false, null, now + 140000);
    assert.equal((await myHomeNodes(store, owner, now + 140000)).devices[0].assignSolarToBuilding, false);
  } finally { await store.close(); }
});
test('device earnings isolate each owned host and expose only successfully settled payment receipts', async () => {
  const store = new LocalStore(':memory:');
  try {
    const now = Date.parse('2026-10-02T12:00:00Z');
    const first = await paired(store, now);
    const second = await paired(store, now);
    const records = [
      { hostId: first.id, state: 'settled', success: true, amount: '1300', hash: '0x' + 'a'.repeat(64) },
      { hostId: second.id, state: 'settled', success: true, amount: '1700', hash: '0x' + 'b'.repeat(64) },
      { hostId: first.id, state: 'pending', success: false, amount: '900', hash: '0x' + 'c'.repeat(64) },
      { hostId: 'foreign-host', state: 'settled', success: true, amount: '7000', hash: '0x' + 'd'.repeat(64) },
    ];
    for (const [index, record] of records.entries()) await store.create(`local-ai:request:${index}`, {
      completedAt: new Date(now).toISOString(), request: {
        host: { id: record.hostId }, review: { asset: '0x1111111111111111111111111111111111111111' },
        payment: { state: record.state, amountAtomic: record.amount, receipt: { success: record.success, transaction: record.hash } },
      },
    });
    const view = await myHomeNodes(store, owner, now);
    const firstIncome = view.devices.find(device => device.hostId === first.id)!.earnings;
    const secondIncome = view.devices.find(device => device.hostId === second.id)!.earnings;
    assert.equal(firstIncome.settledAnswers, 1);
    assert.equal(firstIncome.amountAtomic, '1300');
    assert.deepEqual(firstIncome.receipts, [{ txHash: records[0].hash, amountAtomic: '1300', settledAt: new Date(now).toISOString() }]);
    assert.equal(secondIncome.amountAtomic, '1700');
    assert.equal(secondIncome.receipts[0].txHash, records[1].hash);
  } finally { await store.close(); }
});
test('completed local-day boundary follows Berlin daylight-saving changes rather than a fixed UTC offset', () => {
  assert.deepEqual(nodeLocalDay('2026-03-29T00:30:00Z', 'Europe/Berlin'), { localDate: '2026-03-29', endAt: Date.parse('2026-03-29T22:00:00Z') });
  assert.deepEqual(nodeLocalDay('2026-10-25T00:30:00Z', 'Europe/Berlin'), { localDate: '2026-10-25', endAt: Date.parse('2026-10-25T23:00:00Z') });
});
test('solar enrollment requires an operator, capacity changes revoke approval, and anomalous production pauses for review', async () => {
  const store = new LocalStore(':memory:');
  try {
    const now = Date.parse('2026-10-02T12:00:00Z');
    const host = await paired(store, now);
    const pending = await assignNodeSolar(store, owner, host.id, true, 1, now);
    assert.equal(pending.solarAssignmentState, 'pending');
    await assert.rejects(reviewNodeSolar(store, owner, host.id, true, now), /Only an operator/);
    await reviewNodeSolar(store, operator, host.id, true, now);
    assert.equal((await myHomeNodes(store, owner, now)).devices[0].solarAssignmentState, 'approved');
    await recordNodeReading(store, host, { powerW: 1000, energyTodayKwh: 8.1, timestamp: new Date(now + 30000).toISOString() }, now + 30000);
    const paused = (await myHomeNodes(store, owner, now + 30000)).devices[0];
    assert.equal(paused.solarAssignmentState, 'paused');
    assert.equal(paused.solarAnomaly!.ceilingKwh, 8);
    await assert.rejects(reviewNodeSolar(store, operator, host.id, true, now + 30000), /exceeds the declared/);
    await reviewNodeSolar(store, operator, host.id, false, now + 30000);
    assert.equal((await myHomeNodes(store, owner, now)).devices[0].solarAssignmentState, 'rejected');
    await assignNodeSolar(store, owner, host.id, true, 2, now + 40000);
    assert.equal((await myHomeNodes(store, owner, now)).devices[0].solarAssignmentState, 'pending');
    await reviewNodeSolar(store, operator, host.id, true, now + 40000);
    assert.equal((await myHomeNodes(store, owner, now)).devices[0].solarAnomaly, null);
    await assignNodeSolar(store, owner, host.id, true, 1000, now + 50000);
    await reviewNodeSolar(store, operator, host.id, true, now + 50000);
    await recordNodeReading(store, host, { powerW: 1000, energyTodayKwh: 101, timestamp: new Date(now + 60000).toISOString() }, now + 60000);
    assert.equal((await myHomeNodes(store, owner, now)).devices[0].solarAnomaly!.ceilingKwh, 100);
    await assert.rejects(reviewNodeSolar(store, operator, host.id, true, now + 60000), /exceeds the declared/);
    const moderation = await operatorHomeNodes(store, operator, now);
    assert.equal(moderation.devices[0].solarAssignmentState, 'paused');
    assert.equal('capabilities' in moderation.devices[0], false);
    assert.equal('latestReading' in moderation.devices[0], false);
    const rejected = await reviewNodeSolar(store, operator, host.id, false, now + 60000);
    for (const payload of [moderation.devices[0], rejected]) {
      assert.equal('solarAnomaly' in payload, false);
      assert.equal('dailyTotals' in payload, false);
      assert.equal(payload.aboveCeiling, true);
      assert.equal(payload.pausedForReview, true);
      assert.equal(Object.values(payload).includes(101), false);
      assert.equal(Object.values(payload).includes('2026-10-02'), false);
      assert.equal(Object.values(payload).includes(new Date(now + 60000).toISOString()), false);
      assert.deepEqual(Object.entries(payload).filter(([, value]) => typeof value === 'number').map(([key]) => key).sort(), ['dailyProductionCeilingKwh', 'peakCapacityKwp']);
    }
  } finally { await store.close(); }
});
