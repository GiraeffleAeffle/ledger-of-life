'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { HomeLocation } from '../domain/home-location';
import type { CityFeedResult, SignalResult } from '../server/city-signals';
import { homeCityId, displayCityText, formatCityDate } from './city-coverage';
import { listingNeighbourhood } from './neighbourhood-logic';
import { PRECISION_LABELS, REVIEW_LABELS } from './personal-map-relevance';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
export function Neighbourhood({ city, location, request, movingIn = false }: { city: string; location?: HomeLocation; request: Request; movingIn?: boolean }) {
  const [snapshot, setSnapshot] = useState<SignalResult | null>(null);
  const [feed, setFeed] = useState<CityFeedResult | null>(null);
  const [error, setError] = useState('');
  const cityId = homeCityId(city);
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
  const title = movingIn ? 'Your new neighbourhood' : 'Around this home';
  if (!location) return <section className="neighbourhood"><h3>{title}</h3><p>No approximate home pin was supplied; nearby public information cannot be matched.</p><Link href="/?area=places">Change city in Places</Link></section>;
  if (!cityId || (currentSnapshot && !nearby)) return <section className="neighbourhood"><h3>{title}</h3><p>No published city data for {city} yet.</p><Link href="/?area=places">Explore Places</Link></section>;
  return <section className="neighbourhood"><h3>{title}</h3>
    {movingIn && <p className="small-copy">Optional. Nothing here blocks your tenancy or deposit steps.</p>}
    {error && <p className="note" role="alert">{error}</p>}
    {!currentSnapshot && !error && <p>Reading the published city snapshot…</p>}
    {nearby && <>
      <p>Public snapshot for {nearby.city.name} · {formatCityDate(nearby.generatedAt)}. Nearby means within 1 km of the approximate pin, not walking distance. Coverage is incomplete.</p>
      {movingIn && <p><Link href={`/library?city=${cityId}`} prefetch={false}>Ask the city AI desk about the area</Link> · public compute, free when a host offers it. The link carries only the city name; no listing details.</p>}
      {(['projects', 'places'] as const).map((kind) => <div key={kind}><h4>Nearby public {kind}</h4>{nearby[kind].length ? <ul>{nearby[kind].map(({ feature, distance }) => {
        const source = 'sources' in feature.properties ? feature.properties.sources[0] : feature.properties.primarySource;
        return <li key={feature.properties.id}><strong>{displayCityText(feature.properties.title)}</strong> · {(distance / 1000).toFixed(1)} km
          <p className="small-copy">{displayCityText(feature.properties.status || 'Status not established')} · {REVIEW_LABELS[feature.properties.reviewState]} · {PRECISION_LABELS[feature.properties.geometryPrecision]} · as of {formatCityDate(feature.properties.asOf)}{source && <> · <a href={source.url} target="_blank" rel="noopener noreferrer">{source.publisher || 'Published source'}</a></>}</p></li>;
      })}</ul> : <p>No located {kind} within 1 km in this snapshot.</p>}</div>)}
      <h4>Nearby upcoming events</h4>{nearby.events.length ? <ul>{nearby.events.map(({ item, distance }) => <li key={item.id}><a href={item.url} target="_blank" rel="noopener noreferrer">{displayCityText(item.title)}</a> · {(distance / 1000).toFixed(1)} km · {formatCityDate(item.eventStart!)} · {item.publisher}</li>)}</ul> : <p>No upcoming located events within 1 km in this snapshot; unlocated events are not treated as nearby.</p>}
      <h4>What is changing in {nearby.city.name}</h4>{nearby.changing.length ? <ul>{nearby.changing.map((feature) => <li key={feature.properties.id}>{displayCityText(feature.properties.title)} · {displayCityText(feature.properties.status || 'Status not established')} · {REVIEW_LABELS[feature.properties.reviewState]} · as of {formatCityDate(feature.properties.asOf)}</li>)}</ul> : <p>No published change items in this snapshot.</p>}
      <p><Link href="/?area=places" prefetch={false}>Explore the public projects and evidence in Places →</Link></p>
    </>}
  </section>;
}
