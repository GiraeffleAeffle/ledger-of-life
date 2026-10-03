'use client';
import { useEffect, useState } from 'react';
import type { ServiceChargeView } from '@/server/service-charges';
import { Figure, Figures } from './blocks';
import './move-in.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const euroFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const euro = (cents: number) => euroFormat.format(cents / 100);

/** Read-only estimate; only the landlord's example prepayment is editable. */
export function ServiceCharges({ agreementId, request }: { agreementId: string; request: Request }) {
  const [account, setAccount] = useState<ServiceChargeView | null>(null);
  const [prepayment, setPrepayment] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
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
  }, [agreementId, request]);

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
    <section className="service-charge-card" aria-label="Service charges">
      {error && <p role="alert" className="note">{error}</p>}
      {!account && !error && <p className="small-copy">Loading this tenancy’s example account…</p>}
      {account && (
        <div className="prototype-content">
          <p className="small-copy">Prototype · simulated monthly statement, not an invoice or payment.</p>
          <Figures label="Monthly service charges">
            <Figure label="Monthly prepayment" value={euro(account.prepaymentCents)} note="Example value" />
            <Figure label="Estimated monthly share" value={euro(account.estimatedMonthlyCostCents)} />
            <Figure label="Running balance" value={euro(Math.abs(account.balanceCents))} note={account.balanceCents >= 0 ? 'Ahead this month' : 'Behind this month'} tone={account.balanceCents >= 0 ? 'ok' : 'waiting'} />
          </Figures>
          {account.role === 'landlord' && (
            <form className="inline-form" onSubmit={save}>
              <label>Monthly test prepayment (€)<input type="number" min="0" max="1000" step="0.01" required value={prepayment} onChange={(event) => setPrepayment(event.target.value)} /></label>
              <button className="button secondary" disabled={saving}>{saving ? 'Saving…' : 'Set test prepayment'}</button>
            </form>
          )}
          <div>
            <h3>Consumption share</h3>
            {account.handover && <div className="handover-baseline"><h4>Move-in meter baseline · entered by the parties</h4>
              <p className="small-copy">{account.handover.confirmed.tenant && account.handover.confirmed.landlord ? 'Confirmed by both parties.' : 'Not yet confirmed by both parties.'} A single cumulative reading is a starting point, not consumption; no usage or charge is inferred from it.</p>
              <ul>{account.handover.readings.map((row) => <li key={row.meter}>{row.meter}: {row.value} {row.unit} · {row.date}</li>)}</ul>
            </div>}
            {account.consumption.source === 'home_assistant' ? (
              <p>Today: {account.consumption.dailyKwh.toFixed(2)} kWh from your Home Assistant sensor <code>{account.consumption.sensor}</code> (live reading). One day is extrapolated into a simulated monthly cost; it is not a meter statement.</p>
            ) : (
              <p>Example daily consumption (kWh, Mon–Sun): {account.consumption.exampleWeekKwh?.map((value) => value.toFixed(1)).join(' · ')}. The example {account.consumption.dailyKwh.toFixed(1)} kWh/day drives the cost estimate.</p>
            )}
            {account.consumption.solarTodayKwh !== null && <p className="small-copy">Home Assistant solar production today: {account.consumption.solarTodayKwh.toFixed(2)} kWh (live reading, not consumption).</p>}
            {account.consumption.adapterUnavailable && <p className="small-copy">{account.consumption.adapterUnavailableReason ? `${account.consumption.adapterUnavailableReason} Showing the labelled example consumption series instead.` : 'Home Assistant is unavailable; showing the labelled example consumption series instead.'}</p>}
          </div>
          <div>
            <h3>Annual example cost items</h3>
            <ul className="service-items">
              {account.items.map((item) => <li key={item.name}><strong>{item.name}</strong><span>{item.allocation}</span><span>Building {euro(item.annualBuildingCents)} · illustrative share {euro(item.annualShareCents)}/year</span></li>)}
            </ul>
          </div>
          <p className="small-copy">Projected monthly surplus: <strong>{euro(account.projectedReleaseCents)}</strong>. Illustration only; nothing is transferred.</p>
        </div>
      )}
    </section>
  );
}
