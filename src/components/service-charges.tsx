'use client';
import { useEffect, useState } from 'react';
import type { ServiceChargeView } from '@/server/service-charges';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const euroFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const euro = (cents: number) => euroFormat.format(cents / 100);

/** Read-only estimate; only the landlord's example prepayment is editable. */
export function ServiceCharges({ agreementId, request }: { agreementId: string; request: Request }) {
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState<ServiceChargeView | null>(null);
  const [prepayment, setPrepayment] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    request<{ account: ServiceChargeView }>(`/api/service-charges?agreement=${encodeURIComponent(agreementId)}`)
      .then(({ account: next }) => {
        if (!active) return;
        setAccount(next);
        setPrepayment((next.prepaymentCents / 100).toFixed(2));
        setError('');
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Statement unavailable.'); });
    return () => { active = false; };
  }, [open, agreementId, request]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { account: next } = await request<{ account: ServiceChargeView }>('/api/service-charges', {
        action: 'set_prepayment', agreementId, prepaymentCents: Math.round(Number(prepayment) * 100),
      });
      setAccount(next);
      setPrepayment((next.prepaymentCents / 100).toFixed(2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the test prepayment.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="service-charge-card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Service charges · prototype · simulated figures</summary>
      {error && <p role="alert" className="note">{error}</p>}
      {!account && !error && <p className="small-copy">Loading this tenancy’s example account…</p>}
      {account && (
        <div className="prototype-content">
          <p className="small-copy">Illustrative monthly statement, not an invoice or a payment. Annual building totals, allocation keys and shares are examples.</p>
          <dl className="journey-facts">
            <div><dt>Monthly prepayment · editable test value</dt><dd>{euro(account.prepaymentCents)}</dd></div>
            <div><dt>Estimated monthly share</dt><dd>{euro(account.estimatedMonthlyCostCents)}</dd></div>
            <div><dt>Running balance this month</dt><dd>{euro(Math.abs(account.balanceCents))} {account.balanceCents >= 0 ? 'ahead' : 'behind'}</dd></div>
          </dl>
          {account.role === 'landlord' && (
            <form className="inline-form" onSubmit={save}>
              <label>Monthly test prepayment (€)<input type="number" min="0" max="1000" step="0.01" required value={prepayment} onChange={(event) => setPrepayment(event.target.value)} /></label>
              <button className="button secondary" disabled={saving}>{saving ? 'Saving…' : 'Set test prepayment'}</button>
            </form>
          )}
          <div>
            <h3>Consumption share</h3>
            {account.consumption.source === 'home_assistant' ? (
              <p>Today: {account.consumption.dailyKwh.toFixed(2)} kWh from your Home Assistant sensor <code>{account.consumption.sensor}</code> (live reading). One day is extrapolated into a simulated monthly cost; it is not a meter statement.</p>
            ) : (
              <p>Example daily consumption (kWh, Mon–Sun): {account.consumption.exampleWeekKwh?.map((value) => value.toFixed(1)).join(' · ')}. The example {account.consumption.dailyKwh.toFixed(1)} kWh/day drives the cost estimate.</p>
            )}
            {account.consumption.solarTodayKwh !== null && <p className="small-copy">Home Assistant solar production today: {account.consumption.solarTodayKwh.toFixed(2)} kWh (live reading, not consumption).</p>}
            {account.consumption.adapterUnavailable && <p className="small-copy">Home Assistant is unavailable; showing an example consumption series instead.</p>}
          </div>
          <div>
            <h3>Annual example cost items</h3>
            <ul className="service-items">
              {account.items.map((item) => <li key={item.name}><strong>{item.name}</strong><span>{item.allocation}</span><span>Building {euro(item.annualBuildingCents)} · illustrative share {euro(item.annualShareCents)}/year</span></li>)}
            </ul>
          </div>
          <p><strong>Projected monthly surplus release: {euro(account.projectedReleaseCents)}</strong> (illustration only; no transfer or on-chain action). In a future version, prepayments would sit in the same escrow as the deposit.</p>
        </div>
      )}
    </details>
  );
}
