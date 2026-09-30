'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, Loader2 } from 'lucide-react';
import type { CityResult } from '@/server/city';
import { arrivalGuideCityIds, arrivalGuideFor } from '@/data/arrival';
import type { CityCoverage } from '@/server/city-signals';
import { cityIdFor, coveredNames, formatCityDate } from './city-coverage';
import { CITY_CHANGED_EVENT } from './use-city-signals';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;

/** A person's covered city is distinct from a temporary map exploration. */
export function CityCard({ request, onCityChange, fallbackSectionIds }: { request: Request; onCityChange?: () => void; fallbackSectionIds?: readonly string[] }) {
  const [city, setCity] = useState<CityResult | null>(null);
  const [cities, setCities] = useState<CityCoverage['cities']>([]);
  const [snapshot, setSnapshot] = useState('');
  const [draft, setDraft] = useState('');
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    window.addEventListener(CITY_CHANGED_EVENT, changed);
    return () => window.removeEventListener(CITY_CHANGED_EVENT, changed);
  }, []);
  useEffect(() => {
    let active = true;
    request<{ city: CityResult }>('/api/city')
      .then(({ city }) => { if (active) { setCity(city); setError(''); } })
      .catch(() => { if (active) setError('Your city could not be checked. You can still choose a covered city.'); });
    request<CityCoverage>('/api/city-signals/coverage')
      .then((coverage) => { if (active) { setCities(coverage.cities); setSnapshot(coverage.generatedAt); } })
      .catch(() => { if (active) setError('Published city coverage is temporarily unavailable. Try again.'); });
    return () => { active = false; };
  }, [request, revision]);
  async function choose(event: React.FormEvent) {
    event.preventDefault();
    const name = draft === 'another' ? other.trim() : coveredNames[draft];
    if (!name) { setError('Choose a covered city or enter the name of another place.'); return; }
    setBusy(true);
    setError('');
    try {
      const response = await request<{ city: CityResult }>('/api/city', { city: name });
      setCity(response.city);
      onCityChange?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your city could not be saved. Try again.'); }
    finally { setBusy(false); }
  }
  const picker = <form className="city-picker" onSubmit={choose}>
    <label>City <select value={draft} onChange={(event) => setDraft(event.target.value)}>
      <option value="">Select a place…</option>
      {cities.map((item) => <option key={item.id} value={item.id}>{item.name} · {[item.news && 'news', item.events && 'events', item.projects && 'projects', item.councilPapers && 'council papers', item.evidence && 'evidence'].filter(Boolean).join(', ') || 'public places only'}</option>)}
      <option value="another">Another place · not covered yet</option>
    </select></label>
    {draft === 'another' && <label>Place name · not covered unless it matches one of the eight cities <input value={other} onChange={(event) => setOther(event.target.value)} placeholder="Enter your place" />{cityIdFor(other) && <span className="small-copy">We cover this spelling as {coveredNames[cityIdFor(other)!]}.</span>}</label>}
    <button className="secondary-button" disabled={busy || !cities.length}>{busy ? <Loader2 className="spin" size={14} /> : null} Make this my city</button>
    {cities.length > 0 && <p className="small-copy">Eight covered cities · published snapshot {formatCityDate(snapshot)}. Coverage is incomplete; a feed does not guarantee news or events.</p>}
  </form>;
  return <section className="card city-card" id="city-choice" tabIndex={-1}>
    {fallbackSectionIds?.map((id) => <span key={id} id={id} className="city-section-anchor" tabIndex={-1} aria-label="Choose your city" />)}
    <header><Building2 size={18} /> <strong>{city?.name ? `Your city · ${city.name}` : 'Choose your city'}</strong>
      {city?.name && <span className="city-source">{city.source === 'identity' ? 'From your EU wallet' : 'Chosen by you'}</span>}
    </header>
    {city?.name && <p className="small-copy" role="status">{city.cityId ? `Your city is ${city.name}. Published map and city feed are available below${!city.available && city.reason === 'atlas_unavailable' ? '; the separate project atlas is unavailable right now' : ''}.` : `${city.name} is not covered yet. You can choose a covered city instead.`}</p>}
    {city?.cityId && arrivalGuideCityIds.includes(city.cityId) && arrivalGuideFor(city.cityId) && <p><Link href={`/welcome/${encodeURIComponent(city.cityId)}`}>New here? Welcome guide</Link></p>}
    {picker}
    {error && <p role="alert">{error} <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Retry</button></p>}
  </section>;
}
