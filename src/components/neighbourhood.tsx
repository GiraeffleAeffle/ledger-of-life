'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { HomeLocation } from '../domain/home-location';
import type { CityFeedResult, SignalResult } from '../server/city-signals';
import { arrivalGuideCityIds } from '../data/arrival';
import { cityIdFor, displayCityText, formatCityDate } from './city-coverage';
import { listingNeighbourhood } from './neighbourhood-logic';
import { CITY_CHANGED_EVENT } from './use-city-signals';
import { PRECISION_LABELS, REVIEW_LABELS } from './personal-map-relevance';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
export function Neighbourhood({ city, location, request, movingIn = false }: { city: string; location?: HomeLocation; request: Request; movingIn?: boolean }) {
  const [snapshot, setSnapshot] = useState<SignalResult | null>(null);
  const [feed, setFeed] = useState<CityFeedResult | null>(null);
  const [error, setError] = useState('');
  const [chosenCity, setChosenCity] = useState('');
  const [busy, setBusy] = useState(false);
  const cityId = cityIdFor(city);
  useEffect(() => {
    if (!cityId || !location) return;
    let active = true;
    Promise.all([request<SignalResult>(`/api/city-signals?city=${cityId}`), request<CityFeedResult>(`/api/city-feed?city=${cityId}`)])
      .then(([signals, events]) => { if (active) { setSnapshot(signals); setFeed(events); setError(''); } })
      .catch(() => { if (active) setError('Neighbourhood snapshot unavailable. Try reopening Home.'); });
    return () => { active = false; };
  }, [cityId, location, request]);
  const currentSnapshot = snapshot && (snapshot.state === 'covered' ? snapshot.data.catalogue.id === cityId : snapshot.city === cityId) ? snapshot : null;
  const nearby = currentSnapshot && location ? listingNeighbourhood(currentSnapshot, location, feed?.state === 'available' && feed.cityId === cityId ? feed.feed.items : []) : null;
  async function choose() {
    if (!nearby) return;
    setBusy(true);
    try { await request('/api/city', { city: nearby.city.name }); window.dispatchEvent(new Event(CITY_CHANGED_EVENT)); setChosenCity(nearby.city.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'City could not be saved.'); }
    finally { setBusy(false); }
  }
  const title = movingIn ? 'Your new neighbourhood' : 'Around this home';
  if (!location) return movingIn ? <section className="neighbourhood"><h3>{title}</h3><p>No approximate map pin was supplied, so nearby public information cannot be matched. This step is optional.</p><p><Link href="/?area=places" prefetch={false}>Choose your city in Places</Link> · <Link href="/library" prefetch={false}>Ask the public city AI desk</Link> (public compute, free when a host offers it).</p></section> : <p className="small-copy">No approximate map pin supplied; nearby public information cannot be matched.</p>;
  if (!cityId || (currentSnapshot && !nearby)) return <section className="neighbourhood"><h3>{title}</h3><p>This location is not covered by the Places snapshot. No nearby public information is claimed.</p>{movingIn && <p><Link href="/?area=places" prefetch={false}>Choose your city in Places</Link> · <Link href="/library" prefetch={false}>Ask the public city AI desk</Link> · public compute, free when a host offers it. Optional; never blocks tenancy steps.</p>}</section>;
  return <details className="neighbourhood" open={movingIn}><summary>{title}</summary>
    {movingIn && <p className="small-copy">Optional. Nothing here blocks your tenancy or deposit steps.</p>}
    {error && <p className="note" role="alert">{error}</p>}
    {!currentSnapshot && !error && <p>Reading the published city snapshot…</p>}
    {nearby && <>
      <p>Public snapshot for {nearby.city.name} · {formatCityDate(nearby.generatedAt)}. Nearby means within 2 km of the approximate pin, not walking distance. Coverage is incomplete.</p>
      {movingIn && <button type="button" className="button secondary" disabled={busy || chosenCity === cityId} onClick={() => void choose()}>{chosenCity === cityId ? `${nearby.city.name} is now your city` : `Make ${nearby.city.name} my city`}</button>}
      {arrivalGuideCityIds.includes(cityId) && <p><Link href={`/welcome/${cityId}`} prefetch={false}>Open the welcome guide for {nearby.city.name}</Link></p>}
      {movingIn && <p><Link href="/library" prefetch={false}>Ask the city AI desk about the area</Link> · public compute, free when a host offers it. Name the city in your question; this link sends no listing details.</p>}
      {(['projects', 'places'] as const).map((kind) => <div key={kind}><h4>Nearby public {kind}</h4>{nearby[kind].length ? <ul>{nearby[kind].map(({ feature, distance }) => {
        const source = 'sources' in feature.properties ? feature.properties.sources[0] : feature.properties.primarySource;
        return <li key={feature.properties.id}><strong>{displayCityText(feature.properties.title)}</strong> · {(distance / 1000).toFixed(1)} km
          <p className="small-copy">{displayCityText(feature.properties.status || 'Status not established')} · {REVIEW_LABELS[feature.properties.reviewState]} · {PRECISION_LABELS[feature.properties.geometryPrecision]} · as of {formatCityDate(feature.properties.asOf)}{source && <> · <a href={source.url} target="_blank" rel="noopener noreferrer">{source.publisher || 'Published source'}</a></>}</p></li>;
      })}</ul> : <p>No located {kind} within 2 km in this snapshot.</p>}</div>)}
      <h4>Nearby upcoming events</h4>{nearby.events.length ? <ul>{nearby.events.map(({ item, distance }) => <li key={item.id}><a href={item.url} target="_blank" rel="noopener noreferrer">{displayCityText(item.title)}</a> · {(distance / 1000).toFixed(1)} km · {formatCityDate(item.eventStart!)} · {item.publisher}</li>)}</ul> : <p>No upcoming located events within 2 km in this snapshot; unlocated events are not treated as nearby.</p>}
      <h4>What is changing in {nearby.city.name}</h4>{nearby.changing.length ? <ul>{nearby.changing.map((feature) => <li key={feature.properties.id}>{displayCityText(feature.properties.title)} · {displayCityText(feature.properties.status || 'Status not established')} · {REVIEW_LABELS[feature.properties.reviewState]} · as of {formatCityDate(feature.properties.asOf)}</li>)}</ul> : <p>No published change items in this snapshot.</p>}
      <p><Link href="/?area=places" prefetch={false}>Explore the public projects and evidence in Places →</Link></p>
    </>}
  </details>;
}
