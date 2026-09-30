import assert from 'node:assert/strict';
import test from 'node:test';
import { scenarioAllocation, type ScenarioInputs } from './civic-system.ts';

const example: ScenarioInputs = {
  capital: 120_000, wagesPercent: 50, suppliersPercent: 25, externalPercent: 25,
  costPerJobYear: 60_000, localReceipts: 2_000, redistribution: 1_000, serviceCosts: 4_000,
};

test('moving a full allocation between wages and local suppliers conserves capital and job-years respond', () => {
  const original = scenarioAllocation(example);
  const shifted = scenarioAllocation({ ...example, wagesPercent: 40, suppliersPercent: 35 });
  for (const result of [original, shifted]) {
    assert.equal(result.wages + result.suppliers + result.external + result.reserve, example.capital);
    assert.equal(result.reserve, 0, 'a fully allocated budget has no hidden remainder');
  }
  assert.equal(original.jobYears, 1);
  assert.equal(shifted.jobYears, 0.8);
  assert.equal(shifted.netLocal, original.netLocal, 'reallocating capital cannot directly generate taxes');
});

test('external leakage consumes reserve, while independent service costs can reverse local balance', () => {
  const input = { ...example, wagesPercent: 40, suppliersPercent: 20, externalPercent: 10 };
  const baseline = scenarioAllocation(input);
  const leak = scenarioAllocation({ ...input, externalPercent: 40 });
  assert.equal(leak.external - baseline.external, 36_000);
  assert.equal(leak.reserve, 0);
  assert.equal(leak.jobYears, baseline.jobYears, 'external purchasing does not imply new jobs');
  assert.equal(leak.netLocal, -1_000);
  assert.equal(scenarioAllocation({ ...input, capital: 240_000 }).netLocal, -1_000);
  assert.equal(scenarioAllocation({ ...input, serviceCosts: 1_000 }).netLocal, 2_000);
});
