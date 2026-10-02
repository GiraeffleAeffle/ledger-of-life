import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGRI_PV_EXAMPLE } from '../data/local-investments.ts';
import { AGRI_PV_INPUT_BOUNDS, simulateAgriPv, type AgriPvInputs } from './agri-pv-simulation.ts';

const defaults = AGRI_PV_EXAMPLE.defaults;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('default illustration matches independently hand-calculated annual income and ticket allocation', () => {
  const result = simulateAgriPv(defaults);
  close(result.electricityRevenueEuro, 287_400); // 6,000,000 × €0.0479
  close(result.cropRevenueEuro, 16_000); // 8 × €2,000
  close(result.operatingCostsEuro, 60_680); // €303,400 × 20%
  close(result.netIncomeEuro, 242_720);
  close(result.ticketFraction, 1 / 16_000); // €250 / €4,000,000
  close(result.ticketElectricityEuro, 17.9625);
  close(result.ticketCropEuro, 1);
  close(result.ticketCostsEuro, 3.7925);
  close(result.ticketNetEuro, 15.17);
  close(result.simpleRatioPercent, 6.068);
});

test('all ticket amounts scale linearly without changing project income or the simple ratio', () => {
  const baseline = simulateAgriPv(defaults);
  const larger = simulateAgriPv({ ...defaults, ticketEuro: 1_000 });
  for (const key of ['ticketElectricityEuro', 'ticketCropEuro', 'ticketCostsEuro', 'ticketNetEuro', 'ticketFraction'] as const) close(larger[key], baseline[key] * 4);
  close(larger.netIncomeEuro, baseline.netIncomeEuro);
  close(larger.simpleRatioPercent, baseline.simpleRatioPercent);
});

test('each input rejects non-finite, negative and out-of-bound values', () => {
  for (const key of Object.keys(AGRI_PV_INPUT_BOUNDS) as (keyof AgriPvInputs)[]) {
    const [min, max] = AGRI_PV_INPUT_BOUNDS[key];
    for (const invalid of [NaN, Infinity, -Infinity, -1, min - 1, max + 1]) {
      assert.throws(() => simulateAgriPv({ ...defaults, [key]: invalid }), RangeError, `${key}: ${invalid}`);
    }
  }
  assert.throws(() => simulateAgriPv({ ...defaults, investmentEuro: 0 }), RangeError);
  assert.throws(() => simulateAgriPv({ ...defaults, ticketEuro: defaults.investmentEuro + 1 }), /Ticket cannot exceed/);
});

test('zero production removes electricity income but preserves the crop stream', () => {
  const result = simulateAgriPv({ ...defaults, annualProductionKWh: 0 });
  assert.equal(result.electricityRevenueEuro, 0);
  assert.equal(result.ticketElectricityEuro, 0);
  close(result.cropRevenueEuro, 16_000);
  close(result.ticketNetEuro, 0.8);
});

test('zero ticket and full operating costs stay finite and do not imply a payout', () => {
  const noTicket = simulateAgriPv({ ...defaults, ticketEuro: 0 });
  assert.equal(noTicket.ticketNetEuro, 0);
  assert.equal(noTicket.simpleRatioPercent, 0);
  const allCosts = simulateAgriPv({ ...defaults, operatingCostPercent: 100 });
  assert.equal(allCosts.netIncomeEuro, 0);
  assert.equal(allCosts.ticketNetEuro, 0);
  assert.equal(allCosts.simpleRatioPercent, 0);
  assert.ok(Object.values(noTicket).every(Number.isFinite));
});
