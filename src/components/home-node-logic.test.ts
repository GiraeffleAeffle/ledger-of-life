import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atomicDollars, installCommand, pairingStatus, readingFresh, shellQuote, solarSummary, solarAssignmentPayload, solarApprovalAllowed, operatorSolarApprovalAllowed, type SolarAssignmentFields } from './home-node-logic.ts';

test('host earnings retain fractional receipts and precision beyond Number safe integers', () => {
  assert.equal(atomicDollars('1'), '0.000001 tUSDG');
  assert.equal(atomicDollars('1080000'), '1.08 tUSDG');
  assert.equal(atomicDollars('9007199254740993000001'), '9007199254740993.000001 tUSDG');
  assert.equal(atomicDollars('0'), '0 tUSDG');
  assert.equal(atomicDollars('-1'), 'Unavailable');
});
test('stale and invalid solar timestamps never appear live; accepted skew and freshness boundaries match protocol', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  assert.equal(readingFresh('2026-10-02T11:45:00Z', now), true);
  assert.equal(readingFresh('2026-10-02T11:44:59Z', now), false);
  assert.equal(readingFresh('2026-10-02T12:05:00Z', now), true);
  assert.equal(readingFresh('2026-10-02T12:05:01Z', now), false);
  assert.equal(readingFresh('invalid', now), false);
});
test('download command is unavailable without a valid checksum and safely quotes shell input', () => {
  assert.equal(installCommand('https://ledger.example', ''), null);
  assert.equal(installCommand('https://ledger.example', '0'.repeat(63)), null);
  assert.equal(installCommand('https://ledger.example', `${'0'.repeat(63)};`), null);
  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
});
test('pairing progresses only for a new non-revoked node, then waits for capabilities', () => {
  const existing = { hostId: 'old', name: 'Existing', state: 'active', capabilities: null };
  const paired = { hostId: 'new', name: 'New node', state: 'active', capabilities: null };
  const expires = '2026-10-02T12:10:00Z';
  const now = Date.parse('2026-10-02T12:00:00Z');
  assert.match(pairingStatus([existing], ['old'], expires, now), /Waiting for your node to pair/);
  assert.match(pairingStatus([existing, paired], ['old'], expires, now), /paired.*first capability report/);
  assert.match(pairingStatus([{ ...paired, capabilities: { gpuModels: ['llama'], solarSensors: [], validatorIds: [] } }], ['old'], expires, now), /connected and reporting/);
  assert.match(pairingStatus([{ ...paired, state: 'revoked' }], ['old'], expires, now), /Waiting for your node to pair/);
  assert.match(pairingStatus([existing], ['old'], expires, Date.parse(expires)), /expired/);
});
test('yesterday’s energy and stale power never masquerade as today’s live solar', () => {
  const reading = { powerW: 42, energyTodayKwh: 4, timestamp: '2026-10-01T22:00:00Z' };
  assert.equal(solarSummary(reading, Date.parse('2026-10-02T12:00:00Z')), '42 W at last reading · 4 kWh on 2026-10-01 (UTC)');
  assert.equal(solarSummary({ ...reading, timestamp: '2026-10-02T11:59:00Z' }, Date.parse('2026-10-02T12:00:00Z')), '42 W now · 4 kWh today (UTC)');
});
test('solar day follows the reporting node’s timezone across UTC midnight boundaries', () => {
  const reading = { powerW: 42, energyTodayKwh: 4, timestamp: '2026-10-01T22:05:00Z', localDate: '2026-10-02', timezone: 'Europe/Berlin' };
  assert.equal(solarSummary(reading, Date.parse('2026-10-01T22:06:00Z')), '42 W now · 4 kWh today (Europe/Berlin)');
  assert.equal(solarSummary(reading, Date.parse('2026-10-02T22:06:00Z')), '42 W at last reading · 4 kWh on 2026-10-02 (Europe/Berlin)');
});
test('solar opt-in requires bounded declared capacity but opting out never depends on a declaration', () => {
  for (const capacity of ['', '0', '-1', 'Infinity', 'NaN', '1000.1']) assert.equal(solarAssignmentPayload('host', true, capacity), null);
  assert.deepEqual(solarAssignmentPayload('host', true, '0.5'), { hostId: 'host', assignSolarToBuilding: true, peakCapacityKwp: 0.5 });
  assert.deepEqual(solarAssignmentPayload('host', true, '1000'), { hostId: 'host', assignSolarToBuilding: true, peakCapacityKwp: 1000 });
  assert.deepEqual(solarAssignmentPayload('host', false, ''), { hostId: 'host', assignSolarToBuilding: false });
});
test('operator approval remains blocked above either the capacity ceiling or absolute daily ceiling', () => {
  const assignment: SolarAssignmentFields = { solarAssignmentState: 'paused', peakCapacityKwp: 5, dailyProductionCeilingKwh: 40, solarAnomaly: { day: '2026-10-02', energyKwh: 41, ceilingKwh: 40, detectedAt: '2026-10-02T12:00:00Z' } };
  assert.equal(solarApprovalAllowed(assignment), false);
  assert.equal(solarApprovalAllowed({ ...assignment, dailyProductionCeilingKwh: 48 }), true);
  assert.equal(solarApprovalAllowed({ ...assignment, peakCapacityKwp: 1000, dailyProductionCeilingKwh: 8000, solarAnomaly: { ...assignment.solarAnomaly!, energyKwh: 101 } }), false);
  assert.equal(solarApprovalAllowed({ ...assignment, peakCapacityKwp: null, solarAnomaly: null }), false);
});
test('redacted operator approval fails closed but permits corrected capacity to clear a historical pause', () => {
  const review = { peakCapacityKwp: 5, aboveCeiling: true, pausedForReview: true };
  assert.equal(operatorSolarApprovalAllowed(review), false);
  assert.equal(operatorSolarApprovalAllowed({ ...review, aboveCeiling: false }), true);
  assert.equal(operatorSolarApprovalAllowed({ ...review, aboveCeiling: false, pausedForReview: false }), true);
  assert.equal(operatorSolarApprovalAllowed({ peakCapacityKwp: 5, pausedForReview: true }), false);
  assert.equal(operatorSolarApprovalAllowed({ peakCapacityKwp: 5, aboveCeiling: false }), false);
  assert.equal(operatorSolarApprovalAllowed({ ...review, peakCapacityKwp: null, aboveCeiling: false }), false);
});
