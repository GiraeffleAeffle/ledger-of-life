import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { civicOutcomeEvidence } from './civic-outcome-evidence.ts';

test('every researched case dependency exists in the published city snapshot', async () => {
  for (const item of civicOutcomeEvidence) {
    if (!item.signalIds.length) continue;
    const snapshot = JSON.parse(await readFile(new URL(`../../stadtstack-data/out/cities/${item.cityId}/signals.geojson`, import.meta.url), 'utf8'));
    const ids = new Set(snapshot.features.map((feature: { properties: { id: string } }) => feature.properties.id));
    for (const id of item.signalIds) assert.ok(ids.has(id), `${item.id}: published snapshot missing ${id}`);
  }
});

test('city cash-outlay categories reconcile without masquerading as actual spending', () => {
  const budget = civicOutcomeEvidence.find((item) => item.id === 'strausberg-investment-budget-2025-2026')!;
  assert.deepEqual(budget.signalIds, []);
  for (const plan of budget.budgetPlan!) assert.equal(plan.administrative + plan.investment + plan.financing, plan.total);
  assert.deepEqual(budget.budgetPlan!.map((plan) => [plan.year, plan.total, plan.investment]), [[2025, 83708074, 17941270], [2026, 78540189, 12609320]]);
});
