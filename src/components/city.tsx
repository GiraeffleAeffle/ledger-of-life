'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, Loader2 } from 'lucide-react';
import type { CityResult } from '@/server/city';
import { arrivalGuideCityIds, arrivalGuideFor } from '@/data/arrival';
import type { CityCoverage } from '@/server/city-signals';
import { cityIdFor, coveredNames, formatCityDate } from './city-coverage';
import { CITY_CHANGED_EVENT, readPersonCity, citySourceLabel } from './use-city-signals';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;

/** A person's covered city is distinct from a temporary map exploration. */
export function CityCard({ request, onCityChange, onPreviewCity, previewCity, fallbackSectionIds }: { request: Request; onCityChange?: () => void; onPreviewCity?: (id: string) => void; previewCity?: string; fallbackSectionIds?: readonly string[] }) {
  const [city, setCity] = useState<CityResult | null>(null);
  const [cities, setCities] = useState<CityCoverage['cities']>([]);
  const [snapshot, setSnapshot] = useState('');
  const [draft, setDraft] = useState('');
  const [changing, setChanging] = useState(false);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [nearest, setNearest] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    window.addEventListener(CITY_CHANGED_EVENT, changed);
    return () => window.removeEventListener(CITY_CHANGED_EVENT, changed);
  }, []);
  useEffect(() => {
    let active = true;
    readPersonCity(request)
      .then((city) => { if (active) { setCity(city); setDraft(city.cityId ?? ''); setError(''); } })
      .catch(() => { if (active) setError('Your city could not be checked. You can still choose a covered city.'); });
    request<CityCoverage>('/api/city-signals/coverage')
      .then((coverage) => { if (active) { setCities(coverage.cities); setSnapshot(coverage.generatedAt); } })
      .catch(() => { if (active) setError('Published city coverage is temporarily unavailable. Try again.'); });
    return () => { active = false; };
  }, [request, revision]);
  useEffect(() => {
    if (!city?.name || city.cityId) return;
    let active = true;
    request<{ nearest: { id: string; name: string } | null }>('/api/places/nearest')
      .then(({ nearest }) => { if (active) setNearest(nearest); })
      .catch(() => { if (active) setNearest(null); });
    return () => { active = false; };
  }, [request, city]);
  async function choose(event: React.FormEvent) {
    event.preventDefault();
    const name = draft === 'another' ? other.trim() : coveredNames[draft];
    if (!name) { setError('Choose a covered city or enter the name of another place.'); return; }
    setBusy(true);
    setError('');
    try {
      const response = await request<{ city: CityResult }>('/api/city', { city: name });
      setCity(response.city);
      setChanging(false);
      window.dispatchEvent(new Event(CITY_CHANGED_EVENT));
      onCityChange?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your city could not be saved. Try again.'); }
    finally { setBusy(false); }
  }
  const draftId = draft === 'another' ? cityIdFor(other) : draft;
  const draftName = draftId ? coveredNames[draftId] : '';
  const guideCity = previewCity || city?.cityId;
  const picker = <form className="city-picker" onSubmit={choose}>
    <label>City <select value={draft} onChange={(event) => setDraft(event.target.value)}>
      <option value="">Select a place…</option>
      {cities.map((item) => <option key={item.id} value={item.id}>{item.name} · {[item.news && 'news', item.events && 'events', item.projects && 'projects', item.councilPapers && 'council papers', item.evidence && 'evidence'].filter(Boolean).join(', ') || 'public places only'}</option>)}
      <option value="another">Another place · not covered yet</option>
    </select></label>
    {draft === 'another' && <label>Place name · not covered unless it matches one of the eight cities <input value={other} onChange={(event) => setOther(event.target.value)} placeholder="Enter your place" />{cityIdFor(other) && <span className="small-copy">We cover this spelling as {coveredNames[cityIdFor(other)!]}.</span>}</label>}
    <div className="city-picker-actions">
      {onPreviewCity && <button type="button" className="secondary-button" disabled={busy || !draftId || !draftName} onClick={() => { if (draftId) onPreviewCity(draftId); }}>Preview {draftName || 'a city'} — don’t save</button>}
      <button className="button primary" disabled={busy || !cities.length || !(draft === 'another' ? other.trim() : draft)}>{busy ? <Loader2 className="spin" size={14} /> : null} Make this my city</button>
    </div>
    {cities.length > 0 && <p className="small-copy">{cities.length} covered cities · published coverage {formatCityDate(snapshot)}. Refreshed only when the collector runs; coverage is incomplete.</p>}
  </form>;
  return <section className="card city-card" id="city-choice" tabIndex={-1}>
    {fallbackSectionIds?.map((id) => <span key={id} id={id} className="city-section-anchor" tabIndex={-1} aria-label="Your city" />)}
    <header><Building2 size={18} /> <strong>{city?.name ? `Your city · ${city.name}` : city ? 'Choose your city' : 'Your city'}</strong>
      {city?.name && <span className="city-source">{citySourceLabel(city.source)}</span>}
    </header>
    {!city && !error ? <p aria-busy="true" style={{ minHeight: 80 }}>Checking your city…</p> : null}
    {city?.name && <p className="small-copy">{city.source === 'home' && city.home?.title ? `${city.home.title}${!city.cityId ? ' · ' : ''}` : null}{!city.cityId ? `${city.name} · not covered yet.` : null}</p>}
    {!city?.cityId && city?.name && nearest && onPreviewCity && <button type="button" className="secondary-button" onClick={() => onPreviewCity(nearest.id)}>Preview the nearest covered city · {nearest.name}</button>}
    {previewCity && onPreviewCity && <button type="button" className="text-button" onClick={() => onPreviewCity('')}>Back to my city</button>}
    {city?.name && <button type="button" className="text-button" onClick={() => setChanging(!changing)}>{changing ? 'Cancel' : 'Change city'}</button>}
    {city?.source === 'chosen' && city.home && <button type="button" className="text-button" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await request('/api/city', { city: null }); window.dispatchEvent(new Event(CITY_CHANGED_EVENT)); onCityChange?.(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Your home city could not be restored.'); }
      finally { setBusy(false); }
    }}>Use my home city</button>}
    {(changing || (city && !city.name) || (!city && error)) && picker}
    <div className="city-settled"><h3>Get settled</h3>
      {guideCity && arrivalGuideCityIds.includes(guideCity) && arrivalGuideFor(guideCity)
        ? <Link href={`/welcome/${encodeURIComponent(guideCity)}`}>Read the {coveredNames[guideCity]} welcome guide — no account needed</Link>
        : <p className="small-copy">{guideCity || city?.name ? 'No welcome guide for this city yet.' : 'Choose or preview a city to see whether a welcome guide is available.'}</p>}
    </div>
    {error && <p role="alert">{error} <button type="button" className="text-button" onClick={() => window.dispatchEvent(new Event(CITY_CHANGED_EVENT))}>Retry</button></p>}
  </section>;
}
