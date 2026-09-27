'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Building2, Loader2 } from 'lucide-react';
import type { CityResult } from '@/server/city';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;

/** City selection and an optional atlas link; the published city map owns the signal list. */
export function CityCard({ request, onCityChange }: { request: Request; onCityChange?: () => void }) {
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
      onCityChange?.();
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
        <p className="small-copy">{city.reason === 'choose' ? 'Choose a city for published news, events and map signals.' : city.reason}</p>
        {picker}
        {error && <span className="identity-error">{error}</span>}
        {city.name && <p className="small-copy">The published city feed and map may still be available below even if the separate project atlas is not.</p>}
      </section>
    );

  return <section className="city-card">
    <header><Building2 size={18} /> <strong>Your city · {city.name}</strong>
      <span className="city-source">{city.source === 'identity' ? 'City from your EU wallet' : 'City you chose'}</span>
    </header>
    <p className="small-copy">Published city news, events and map signals are below. The older Stadtstack project atlas is a separate source.</p>
    <p className="small-copy"><a href={city.portalUrl} target="_blank" rel="noopener noreferrer">Open the project atlas <ArrowUpRight size={12} aria-hidden /></a></p>
    {city.source === 'chosen' && picker}
    {error && <span className="identity-error">{error}</span>}
  </section>;
}
