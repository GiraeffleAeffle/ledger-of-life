'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Building2, Loader2, Megaphone } from 'lucide-react';
import type { CityResult } from '@/server/city';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const date = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('de-DE');

/** What is happening in the person's city, read from the Stadtstack project atlas. */
export function CityCard({ request }: { request: Request }) {
  const [city, setCity] = useState<CityResult | null>(null);
  const [draft, setDraft] = useState('Strausberg');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    request<{ city: CityResult }>('/api/city').then((r) => active && setCity(r.city)).catch(() => {});
    return () => { active = false; };
  }, [request]);

  async function choose(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setCity((await request<{ city: CityResult }>('/api/city', { city: draft })).city);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!city) return <section className="city-card"><Loader2 className="spin" size={16} /></section>;
  const picker = (
    <form className="city-picker" onSubmit={choose}>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Your city" />
      <button className="secondary-button" disabled={busy}>{busy ? <Loader2 className="spin" size={14} /> : null} Show my city</button>
    </form>
  );

  if (!city.available)
    return (
      <section className="city-card">
        <header><Building2 size={18} /> <strong>Your city</strong></header>
        <p className="small-copy">{city.reason === 'choose' ? 'Share your city from the EU wallet above, or pick one. News and decisions come from the Stadtstack project atlas.' : city.reason}</p>
        {picker}
        {error && <span className="identity-error">{error}</span>}
      </section>
    );

  return (
    <section className="city-card">
      <header>
        <Building2 size={18} /> <strong>What is changing in {city.name}</strong>
        <span className="city-source">{city.source === 'identity' ? 'City from your EU wallet' : 'City you chose'}</span>
      </header>
      {city.openConsultations.length > 0 && (
        <div className="city-open">
          <span className="eyebrow"><Megaphone size={12} /> YOU CAN STILL HAVE A SAY</span>
          {city.openConsultations.map((c) => (
            <a key={c.id} href={c.url} target="_blank" rel="noreferrer" className="city-row">
              <span><strong>{c.title}</strong>{c.place ? ` · ${c.place}` : ''}</span>
              <span>until {date(c.until)} <ArrowUpRight size={13} /></span>
            </a>
          ))}
        </div>
      )}
      <div className="city-recent">
        <span className="eyebrow">LATEST CHANGES</span>
        {city.recent.map((p) => (
          <div key={p.id} className="city-row"><span><strong>{p.title}</strong> · {p.status}</span><span>{date(p.latest)}</span></div>
        ))}
      </div>
      <p className="small-copy">
        {city.projectCount} projects from the Stadtstack project atlas · research as of {date(city.asOf)} ·{' '}
        {city.reviewState === 'pending_review' ? 'not yet reviewed by the city' : city.reviewState}
        {city.fullInventory ? '' : ' · not a complete list of municipal projects'}.{' '}
        <a href={city.portalUrl} target="_blank" rel="noreferrer">Open the atlas <ArrowUpRight size={12} /></a>
      </p>
      {city.source === 'chosen' && picker}
    </section>
  );
}
