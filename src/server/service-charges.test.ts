import test from 'node:test';
import assert from 'node:assert/strict';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { createAgreement, inviteToAgreement, joinAgreement } from './agreements.ts';
import { readHomeEnergy } from './adapters.ts';
import { readServiceCharges, saveServiceChargePrepayment } from './service-charges.ts';
import { LocalStore } from './store.ts';

const person = (subject: string): VerifiedIdentity => ({
  subject, sessionId: `session-${subject}`, expiresAt: Date.now() / 1000 + 3600,
  passkeyCount: 1,
  wallets: [{ id: `wallet-${subject}`, address: `address-${subject}`, chainType: 'solana' }],
});

test('parties see one shared example prepayment; only the recorded landlord changes it', async () => {
  const store = new LocalStore(':memory:');
  try {
    const landlord = person('landlord'), tenant = person('tenant'), outsider = person('outsider');
    const agreement = await createAgreement(store, landlord, {
      network: 'solana', property: 'Example home', requiredSecurity: '1000000000', releaseAllowed: true,
    });
    const invitation = await inviteToAgreement(store, agreement.id, landlord, 'tenant');
    await joinAgreement(store, agreement.id, tenant, 'tenant', invitation.token);
    const initial = await readServiceCharges(store, tenant, agreement.id);
    assert.equal(initial.prepaymentCents, 15000);
    assert.equal(initial.consumption.source, 'example');
    assert.equal(initial.consumption.exampleWeekKwh?.length, 7);
    assert.equal(initial.balanceCents, initial.prepaymentCents - initial.estimatedMonthlyCostCents);
    assert.equal(initial.projectedReleaseCents, Math.max(0, initial.balanceCents));
    await assert.rejects(() => readServiceCharges(store, outsider, agreement.id), /not a verified party/);
    await assert.rejects(() => saveServiceChargePrepayment(store, tenant, agreement.id, 30000), /landlord/);
    await assert.rejects(() => saveServiceChargePrepayment(store, outsider, agreement.id, 30000), /not a verified party/);
    for (const value of [-1, 100001, 1.5, Number.NaN])
      await assert.rejects(() => saveServiceChargePrepayment(store, landlord, agreement.id, value), /between €0 and €1,000/);
    await saveServiceChargePrepayment(store, landlord, agreement.id, 5000);
    const updated = await readServiceCharges(store, tenant, agreement.id);
    assert.equal(updated.prepaymentCents, 5000);
    assert.ok(updated.balanceCents < 0);
    assert.equal(updated.projectedReleaseCents, 0);

    await store.create(`adapters:${tenant.subject}`, { homeAssistant: { url: 'http://localhost:8123', token: 'test-token-long-enough', pricePerKwh: 0.3 } });
    const live = await readServiceCharges(store, tenant, agreement.id, async () => ({ consumptionTodayKwh: 8, consumptionEntity: 'sensor.home_consumption_today', solarTodayKwh: 2 }));
    assert.equal(live.consumption.source, 'home_assistant');
    assert.equal(live.consumption.sensor, 'sensor.home_consumption_today');
    assert.equal(live.consumption.exampleWeekKwh, null);
    assert.ok(live.estimatedMonthlyCostCents > updated.estimatedMonthlyCostCents);
    const solarOnly = await readServiceCharges(store, tenant, agreement.id, async () => ({ consumptionTodayKwh: null, consumptionEntity: null, solarTodayKwh: 2 }));
    assert.equal(solarOnly.consumption.source, 'example');
    assert.equal(solarOnly.consumption.solarTodayKwh, 2);
  } finally {
    await store.close();
  }
});

test('Home Assistant daily consumption excludes lifetime counters and distinguishes solar production', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json([
    { entity_id: 'sensor.home_consumption_total', state: '25000', attributes: { device_class: 'energy', unit_of_measurement: 'kWh' } },
    { entity_id: 'sensor.home_consumption_today', state: '7500', attributes: { device_class: 'energy', unit_of_measurement: 'Wh' } },
    { entity_id: 'sensor.solar_today', state: '2.4', attributes: { device_class: 'energy', unit_of_measurement: 'kWh' } },
  ]);
  try {
    const reading = await readHomeEnergy({ url: 'http://localhost:8123', token: 'test-token-long-enough', pricePerKwh: 0.3 });
    assert.equal(reading.consumptionTodayKwh, 7.5);
    assert.equal(reading.consumptionEntity, 'sensor.home_consumption_today');
    assert.equal(reading.solarTodayKwh, 2.4);
  } finally {
    globalThis.fetch = original;
  }
});
