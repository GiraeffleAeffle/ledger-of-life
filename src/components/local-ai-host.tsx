'use client';
import { useState } from 'react';
import type { LocalAiServiceStatus, LocalAiUsageSummary } from '../server/local-ai-types';
import { DEFAULT_HOST_SCENARIO, hostEconomics, type HostScenario } from './local-ai-economics';
import { MoreRow } from './blocks';

const euros = (value: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' }).format(value);
const fields: { key: keyof HostScenario; label: string; min: number; max?: number; step: number }[] = [
  { key: 'hardwareEuro', label: 'Hardware allocation (€)', min: 0, step: 50 },
  { key: 'amortizationMonths', label: 'Spread hardware over (months)', min: 1, step: 1 },
  { key: 'averageWatts', label: 'Average whole-host power (W)', min: 0, step: 10 },
  { key: 'hoursPerDay', label: 'Online hours / day', min: 0, max: 24, step: 1 },
  { key: 'electricityEuroPerKwh', label: 'Electricity (€ / kWh)', min: 0, step: 0.01 },
  { key: 'otherMonthlyEuro', label: 'Other monthly costs (€)', min: 0, step: 1 },
  { key: 'priceEuroPerAnswer', label: 'Assumed price / paid answer (€)', min: 0, step: 0.01 },
  { key: 'paidAnswersPerDay', label: 'Paid answers / day', min: 0, step: 1 },
  { key: 'freeAnswersPerDay', label: 'Free answers / day', min: 0, step: 1 },
];

export function LocalAiHost({ usage, error, service }: {
  usage: LocalAiUsageSummary | null; error: string; service: LocalAiServiceStatus | null;
}) {
  const [inputs, setInputs] = useState<HostScenario>(DEFAULT_HOST_SCENARIO);
  if (!service?.hosts?.some((host) => host.own && host.state === 'active')) return null;
  const plan = hostEconomics(inputs, usage?.meanWallMs ?? null);
  return <MoreRow title="Could your hardware pay its way?" meta={plan ? `${euros(plan.marginEuro)} illustrative monthly margin` : 'Edit your assumptions'}>
      <div className="local-ai-section-title"><h3>Could the hardware pay its way?</h3><p>Euro prices are assumptions, not a conversion of the receipt ledger.</p></div>
      {error && <p className="local-ai-alert" role="status">Observed usage unavailable: {error}. The calculation below uses your assumptions without measured request capacity.</p>}
      <div className="local-ai-plan-layout">
        <div className="local-ai-assumptions">{fields.map(({ key, label, ...limits }) => <label key={key}>{label}<input type="number" {...limits} value={Number.isFinite(inputs[key]) ? inputs[key] : ''} onChange={(event) => { const value = event.currentTarget.valueAsNumber; setInputs((current) => ({ ...current, [key]: value })); }} /></label>)}</div>
        <div className="local-ai-plan-result" aria-live="polite">
          {plan ? <><span>Illustrative 30-day operating margin</span><strong className={plan.marginEuro < 0 ? 'negative' : ''}>{euros(plan.marginEuro)}</strong>
            <dl><div><dt>Gross service income</dt><dd>{euros(plan.grossEuro)}</dd></div><div><dt>Electricity · {plan.electricityKwh.toFixed(1)} kWh</dt><dd>−{euros(plan.electricityEuro)}</dd></div><div><dt>Hardware allocation</dt><dd>−{euros(plan.hardwareEuro)}</dd></div><div><dt>Other entered costs</dt><dd>−{euros(inputs.otherMonthlyEuro)}</dd></div></dl>
            <p>{plan.breakEvenPaidAnswersPerDay === null ? 'Free access needs a host budget; there is no paid break-even at a zero price.' : `${plan.breakEvenPaidAnswersPerDay.toLocaleString()} paid answers a day to cover these costs.`}</p>
            {plan.computeHoursPerDay !== null ? <p className={plan.exceedsObservedCapacity ? 'local-ai-capacity-warning' : ''}>{plan.computeHoursPerDay.toFixed(2)} compute hours/day at the observed mean request time.{plan.exceedsObservedCapacity ? ' This exceeds the entered online hours.' : ''}</p> : <p>Run an answer to add a measured inference-time capacity check.</p>}
            {plan.allocatedCostEuroPerAnswer !== null && <small>{euros(plan.allocatedCostEuroPerAnswer)} allocated cost per paid or free answer at this demand.</small>}
          </> : <p>Enter finite, non-negative assumptions, at least one month, whole answer counts, and no more than 24 online hours a day.</p>}
        </div>
      </div>
      <details className="local-ai-method"><summary>What the calculation includes</summary><p>Power is a whole-host assumption, not a GPU power measurement. Electricity covers all online hours, including idle time. Hardware is allocated over the entered months. Add hosting, financing, maintenance and transaction costs to other monthly costs; tax is not calculated.</p><p>Observed request time depends on model, prompt length, output and cold starts. The capacity check excludes wallet review, payment settlement and queue overhead. It is an upper-bound compute check, not a prediction of customers or continuous throughput. Free answers use the same node without a payment.</p></details>
    </MoreRow>;
}
