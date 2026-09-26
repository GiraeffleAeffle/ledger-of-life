'use client';
import { useEffect, useState } from 'react';
import type { CityResult } from '@/server/city';
import { STRAUSBERG_INVESTMENT_LEADS } from '@/data/local-investments';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;

/** Research leads, never offers; opening this card does not connect to a broker. */
export function LocalInvestments({ request }: { request: Request }) {
  const [open, setOpen] = useState(false);
  const [city, setCity] = useState<CityResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    request<{ city: CityResult }>('/api/city')
      .then((value) => { if (active) { setCity(value.city); setError(''); } })
      .catch(() => { if (active) setError('Your city could not be loaded.'); });
    return () => { active = false; };
  }, [open, request]);
  const cityName = city?.available ? city.name : city?.name;
  return (
    <details className="card local-investments" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Invest in your own city · illustration</summary>
      <div className="prototype-content">
        <p><strong>To explore, not verified offers. No investment is possible in this app.</strong> Current share availability and membership terms have not been checked.</p>
        <div>
          <h3>Four ways this could work</h3>
          <ul className="service-items">
            <li><strong>Cooperative shares</strong><span>Housing or energy cooperatives; membership and terms are decided by each cooperative. No tokens needed.</span></li>
            <li><strong>Electronic shares</strong><span>Germany’s eWpG has allowed electronic shares since 1 January 2024; a crypto securities register needs a BaFin-licensed operator.</span></li>
            <li><strong>Crowdfunding</strong><span>EU ECSPR: up to €5 million per project owner in 12 months through a licensed platform.</span></li>
            <li><strong>Tokenized real estate</strong><span>Tokens cannot carry a German land-register title; they could represent shares or bonds in a property company instead.</span></li>
          </ul>
        </div>
        <div>
          <h3>Local starting points</h3>
          {error && <p role="alert">{error}</p>}
          {!city && !error && <p>Checking your city…</p>}
          {city && (!cityName ? <p>Choose a city in Places to see researched leads.</p> : cityName.trim().toLocaleLowerCase('de-DE') !== 'strausberg' ? <p>{cityName}: not researched yet.</p> : (
            <ul className="service-items">
              {STRAUSBERG_INVESTMENT_LEADS.map((lead) => <li key={lead.url}><a href={lead.url} target="_blank" rel="noreferrer">{lead.name}</a><span>{lead.kind} · current membership and shares not verified</span></li>)}
            </ul>
          ))}
        </div>
        {cityName?.trim().toLocaleLowerCase('de-DE') === 'strausberg' && <p className="small-copy">Provider websites linked above; listed as research candidates on 26 September 2026. No prospectus, current membership opening or offer was verified.</p>}
      </div>
    </details>
  );
}
