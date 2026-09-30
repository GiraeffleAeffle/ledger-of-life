import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostEconomics, DEFAULT_HOST_SCENARIO } from './local-ai-economics.ts';

test('host scenario converts watts and milliseconds, charges for idle online hours, and separates gross from margin', () => {
  const result = hostEconomics(DEFAULT_HOST_SCENARIO, 6000)!;
  assert.equal(result.electricityKwh, 60);
  assert.equal(result.electricityEuro, 18);
  assert.equal(result.grossEuro, 30);
  assert.ok(Math.abs(result.marginEuro - (30 - 18 - 1000 / 36 - 10)) < 1e-9);
  assert.equal(result.computeHoursPerDay, 0.25);
  assert.equal(result.breakEvenPaidAnswersPerDay, 186);
});

test('free access has a real host budget but no revenue and no invented break-even price', () => {
  const result = hostEconomics({ ...DEFAULT_HOST_SCENARIO, paidAnswersPerDay: 0, priceEuroPerAnswer: 0 }, null)!;
  assert.equal(result.grossEuro, 0);
  assert.equal(result.marginEuro, -result.costsEuro);
  assert.equal(result.breakEvenPaidAnswersPerDay, null);
  assert.equal(result.computeHoursPerDay, null);
  assert.equal(result.exceedsObservedCapacity, null);
  assert.equal(result.allocatedCostEuroPerAnswer, result.costsEuro / 1500);
});

test('capacity constraint and invalid assumptions do not become a zero-cost success', () => {
  assert.equal(hostEconomics({ ...DEFAULT_HOST_SCENARIO, hoursPerDay: 0 }, 6000)?.exceedsObservedCapacity, true);
  assert.equal(hostEconomics({ ...DEFAULT_HOST_SCENARIO, hoursPerDay: 25 }, 6000), null);
  assert.equal(hostEconomics({ ...DEFAULT_HOST_SCENARIO, amortizationMonths: 0 }, 6000), null);
  assert.equal(hostEconomics({ ...DEFAULT_HOST_SCENARIO, averageWatts: Number.NaN }, 6000), null);
  assert.equal(hostEconomics({ ...DEFAULT_HOST_SCENARIO, paidAnswersPerDay: 0.5 }, 6000), null);
  assert.equal(hostEconomics({ ...DEFAULT_HOST_SCENARIO, paidAnswersPerDay: 0, freeAnswersPerDay: 0 }, null)?.allocatedCostEuroPerAnswer, null);
});
