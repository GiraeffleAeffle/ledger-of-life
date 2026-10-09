'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import type { CityResult } from '@/server/city';
import { arrivalGuideCityIds, arrivalGuideFor } from '@/data/arrival';
import type { CityCoverage } from '@/server/city-signals';
import { cityIdFor, coveredNames, formatCityDate } from './city-coverage';
import { CITY_CHANGED_EVENT, readPersonCity } from './use-city-signals';
import type { PlacesResult } from '@/server/places-live';
import { MoreRow } from './blocks';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;

/** A person's covered city is distinct from a temporary map exploration. */
export function CityCard({ request, onCityChange, onPreviewCity, previewCity, readings }: { request: Request; onCityChange?: () => void; onPreviewCity?: (id: string) => void; previewCity?: string; readings?: PlacesResult | null }) {
  const [city, setCity] = useState<CityResult | null>(null);
  const [cities, setCities] = useState<CityCoverage['cities']>([]);
  const [snapshot, setSnapshot] = useState('');
  const [draft, setDraft] = useState('');
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
      {onPreviewCity && <button type="button" className="secondary-button" disabled={busy || !draftId || !draftName} onClick={(event) => { if (draftId) { onPreviewCity(draftId); const row = event.currentTarget.closest('details'); if (row) row.open = false; } }}>Preview {draftName || 'a city'} — don’t save</button>}
      <button className="button primary" disabled={busy || !cities.length || !(draft === 'another' ? other.trim() : draft)}>{busy ? <Loader2 className="spin" size={14} /> : null} Make this my city</button>
    </div>
    {cities.length > 0 && <p className="small-copy">{cities.length} covered cities · published coverage {formatCityDate(snapshot)}. Refreshed only when the collector runs; coverage is incomplete.</p>}
  </form>;
  return <section className="city-card" aria-label="Your city">
    <header><h2>{previewCity ? coveredNames[previewCity] || previewCity : !city ? 'Your city' : city.name || 'Choose your city'}</h2>
      {guideCity && arrivalGuideCityIds.includes(guideCity) && arrivalGuideFor(guideCity) && <Link className="city-guide-link" href={`/welcome/${encodeURIComponent(guideCity)}`}>Get settled ↗</Link>}
      {readings && <span className="city-reading-chip">{readings.weather.state === 'available' ? `${readings.weather.value.temperature.toFixed(1)} °C · ${readings.weather.value.condition}${readings.weather.stale ? ' · last reading' : ''}` : 'Weather unavailable'}</span>}
    </header>
    {city?.name && !city.cityId && !previewCity && <p className="small-copy">{city.name} · not covered yet.</p>}
    {!city?.cityId && city?.name && nearest && onPreviewCity && <button type="button" className="secondary-button" onClick={() => onPreviewCity(nearest.id)}>Preview the nearest covered city · {nearest.name}</button>}
    {previewCity && onPreviewCity && <button type="button" className="text-button" onClick={() => onPreviewCity('')}>Back to my city</button>}
    <MoreRow id="city-choice" title="Change city" meta={previewCity ? 'Preview only · your city is unchanged' : !city ? error ? 'City could not be checked' : 'Checking…' : !city.name ? 'No city chosen' : city.source === 'home' ? 'From your home' : city.source === 'identity' ? 'From your EU wallet' : 'Chosen by you'} defaultOpen={Boolean(city && !city.name)}>
    {city?.source === 'chosen' && city.home && <button type="button" className="text-button" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await request('/api/city', { city: null }); window.dispatchEvent(new Event(CITY_CHANGED_EVENT)); onCityChange?.(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Your home city could not be restored.'); }
      finally { setBusy(false); }
    }}>Use my home city</button>}
    {picker}
    </MoreRow>
    {error && <p role="alert">{error} <button type="button" className="text-button" onClick={() => window.dispatchEvent(new Event(CITY_CHANGED_EVENT))}>Retry</button></p>}
  </section>;
}
