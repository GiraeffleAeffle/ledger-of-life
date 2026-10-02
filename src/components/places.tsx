'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { CityCard } from './city';
import { CivicPlaceLenses } from './civic-place-lenses';
import { CityRegionTopics } from './region-topics';
import { CivicDecisionsPanel } from './civic-decisions-panel';
import { useCitySignals } from './use-city-signals';
import type { PlacesResult } from '@/server/places-live';
import { citySlug } from '@/server/city';
import { strausbergSources as strausberg } from '@/data/cities/strausberg';
import { coveredNames, formatCityDate } from './city-coverage';
import './places.css';
import './civic-system.css';
import type { Area } from './areas';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const checked = '26 Sep 2026';
const day = (value: string) => `${formatCityDate(value)} · ${new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
function Link({ url, children }: { url: string; children: React.ReactNode }) {
  return <a href={url} target="_blank" rel="noopener noreferrer">{children} <ArrowUpRight size={12} aria-hidden /></a>;
}
/** Published places and measurements remain separate from causal project outcomes. */
export function PlacesArea({ request, accountId, go }: { request: Request; accountId: string; go: (area: Area) => void }) {
  const [places, setPlaces] = useState<PlacesResult | null>(null);
  const [reason, setReason] = useState('');
  const [exploredCity, setExploredCity] = useState('');
  const [previewRequest, setPreviewRequest] = useState<{ cityId: string } | null>(null);
  const onExplorationCityChange = useCallback((id: string) => { setExploredCity(id); setPlaces(null); }, []);
  const { cityId, result, error, cityDisplayName, city } = useCitySignals(request, exploredCity || undefined);
  useEffect(() => {
    let active = true;
    if (!city) return;
    request<{ places: PlacesResult | null; reason?: string }>(`/api/places${cityId ? `?city=${encodeURIComponent(cityId)}` : ''}`)
      .then(({ places: value, reason: unavailable }) => { if (active) { setPlaces(value); setReason(unavailable ?? ''); } })
      .catch(() => { if (active) { setPlaces(null); setReason('Nearby readings unavailable.'); } });
    return () => { active = false; };
  }, [request, cityId, city]);
  const currentCity = (exploredCity ? coveredNames[exploredCity] || places?.city : cityDisplayName || places?.city) || 'your city';
  const cityKnown = Boolean(city || error);
  const needsCity = cityKnown && !exploredCity && !cityId && !cityDisplayName;
  return <div className="places-area">
    <CityCard request={request} previewCity={exploredCity} onPreviewCity={(id) => setPreviewRequest({ cityId: id })} fallbackSectionIds={needsCity ? ['local-readings', 'community-discovery', 'public-decisions'] : undefined} />
    <CivicPlaceLenses request={request} accountId={accountId} go={go} previewRequest={previewRequest} onExplorationCityChange={onExplorationCityChange} />
    {(city?.name || exploredCity) && <section className="card places-section civic-support"><h2 id="regional-topics">Nearby towns · compare source stages</h2><CityRegionTopics request={request} cityId={exploredCity || cityId || citySlug(city?.name ?? '')} cityName={currentCity} /></section>}
    {cityKnown && !needsCity && <>
    <section className="card places-section civic-support"><h2 id="local-readings">Weather &amp; local environmental readings in {currentCity}</h2>
      {!places && <p>{reason === 'choose' ? 'Choose your city to inspect local public sources.' : reason === 'not_covered' ? 'Public sources for your place are not covered yet.' : reason || 'Checking nearby public sources…'}</p>}
      {places && <div className="places-measures"><div className="places-measure"><h3>Weather in {places.city} · DWD</h3>{places.weather.state === 'available' ? <><strong className="places-value">{places.weather.value.temperature.toFixed(1)} °C</strong><p>{places.weather.value.condition} · station {places.weather.value.station} ({places.weather.value.distanceKm.toFixed(1)} km from city centre) · {day(places.weather.value.timestamp)}{places.weather.stale && ' · last good reading'}</p><Link url={places.weather.value.source.url}>{places.weather.value.source.name}</Link></> : <p>Verified weather reading unavailable; no estimate.</p>}</div>
        <div className="places-measure"><h3>Air sensors near {places.city}</h3>{places.air.state === 'available' ? <><strong>{places.air.value.sensors.length} outdoor sensors within 5 km</strong><ul>{places.air.value.sensors.map((sensor) => <li key={sensor.id}><Link url={sensor.url}>Sensor {sensor.id}</Link> · {sensor.pm25} µg/m³ · {sensor.distanceKm.toFixed(1)} km · {day(sensor.timestamp)}</li>)}</ul><p>{places.air.value.caveat}</p></> : <p>Verified reading unavailable; no estimate.</p>}</div></div>}
      <p className="places-meta">Local observations are context, not measured outcomes of a project.</p>
    </section>
    <section className="card places-section civic-support"><h2 id="community-discovery">Community in {currentCity} · sport places &amp; official directories</h2>
      {!places ? <p>{reason === 'choose' ? 'Choose your city to discover local activities.' : reason || 'Checking local directories…'}</p>
        : <>{places.clubs.state === 'available' ? <div className="places-groups"><p>{places.clubs.value.caveat} <Link url={places.clubs.value.source.licenceUrl}>© OpenStreetMap contributors · ODbL 1.0</Link>.</p>{places.clubs.value.groups.map((group) => <section key={group.type}><h3>{group.type.split(';')[0].replaceAll('_', ' ')} · {group.count}</h3><ul>{group.items.map((item) => <li key={item.id}><Link url={item.url}>{item.name}</Link></li>)}</ul></section>)}</div> : <p>No verified directory reading available.</p>}{places.cityId === 'strausberg' && <div className="places-links">{strausberg.directories.map((item) => <Link key={item.url} url={item.url}>{item.label}</Link>)}</div>}</>}
    </section>
    <section className="card places-section civic-support"><h2 id="public-decisions">Council in {currentCity} · papers, participation &amp; wider portals</h2>
      <CivicDecisionsPanel cityId={exploredCity || cityId} result={result} />
      {(exploredCity || cityId) === 'strausberg' && <div className="places-links"><Link url={strausberg.calendar}>Council calendar</Link><Link url={strausberg.documents}>Document search</Link>{strausberg.hierarchy.map((item) => item.url && <Link key={item.level} url={item.url}>{item.level} · wider portal link</Link>)}</div>}
      {(exploredCity || cityId) === 'strausberg' && <p className="places-meta">Strausberg official links checked {checked}; district, state, Germany and EU are links, not live feeds.</p>}
    </section>
    </>}
  </div>;
}
