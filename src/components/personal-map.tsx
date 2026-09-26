'use client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { GeoJSONSourceSpecification, Map as LibreMap, Marker } from 'maplibre-gl';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Coordinate, Signal, SignalKind } from '../server/city-signals';
import { displayStatus, matchPersonalRings, type MatchedSignal, type PersonalPins } from './personal-map-relevance';
import { CITY_CHANGED_EVENT, PINS_CHANGED_EVENT, pinsKey, useCitySignals, type AuthorizedRequest } from './use-city-signals';

const kinds: { id: SignalKind; label: string; color: string }[] = [
  { id: 'planning', label: 'Planning', color: '#7750ac' },
  { id: 'construction', label: 'Construction', color: '#bd662c' },
  { id: 'roadworks', label: 'Roadworks', color: '#be3938' },
  { id: 'council_paper', label: 'Council papers', color: '#315d9c' },
  { id: 'council_meeting', label: 'Council meetings', color: '#5273b0' },
  { id: 'budget', label: 'Budget', color: '#2c8063' },
  { id: 'consultation', label: 'Consultations', color: '#b15288' },
  { id: 'place', label: 'Places', color: '#6b873b' },
];
const signalColors: ExpressionSpecification = ['match', ['get', 'kind'],
  'planning', '#7750ac', 'construction', '#bd662c', 'roadworks', '#be3938',
  'council_paper', '#315d9c', 'council_meeting', '#5273b0', 'budget', '#2c8063',
  'consultation', '#b15288', 'place', '#6b873b', '#677c79'];
const layers = ['signals-fill', 'signals-line', 'signals-points'];
const noSignals: Signal[] = [];
function subscribePins(update: () => void) {
  window.addEventListener(PINS_CHANGED_EVENT, update);
  window.addEventListener('storage', update);
  return () => { window.removeEventListener(PINS_CHANGED_EVENT, update); window.removeEventListener('storage', update); };
}
function parsePins(raw: string): PersonalPins {
  try {
    const value = JSON.parse(raw || '{}') as PersonalPins;
    const valid = (p?: Coordinate) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
    return { home: valid(value.home) ? value.home : undefined, work: valid(value.work) ? value.work : undefined };
  } catch { return {}; }
}
function usePersonalPins(cityId: string): PersonalPins {
  const raw = useSyncExternalStore(subscribePins, () => cityId ? localStorage.getItem(pinsKey(cityId)) ?? '' : '', () => '');
  return useMemo(() => parsePins(raw), [raw]);
}
const localPins = (cityId: string): PersonalPins => parsePins(localStorage.getItem(pinsKey(cityId)) ?? '');
const date = (value: string | null) => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB') : 'not established';

function SignalMeta({ feature, compact = false }: { feature: Signal; compact?: boolean }) {
  const { reviewState, geometryPrecision, asOf, sources, extraction } = feature.properties;
  if (compact) return <p className="personal-source-meta">Source: {sources[0]?.publisher || 'not supplied'}{sources.length > 1 && ` + ${sources.length - 1} more`} · as of {date(asOf)} · {reviewState}{reviewState === 'candidate' ? ' (not yet reviewed)' : reviewState === 'auto_checked' ? ' (not human-reviewed)' : ''} · {geometryPrecision}{extraction.method === 'llm' && ` · faithfulness ${extraction.faithfulness?.score ?? 'not scored'}`}</p>;
  return <div className="personal-source-meta">
    <p>As of {date(asOf)} · review: <strong>{reviewState}{reviewState === 'candidate' ? ' · not yet reviewed' : reviewState === 'auto_checked' ? ' · automated check only, not human-reviewed' : ''}</strong> · location precision: <strong>{geometryPrecision}</strong></p>
    {extraction.method === 'llm' && <p>LLM extraction{extraction.model ? ` (${extraction.model})` : ''} · faithfulness: {extraction.faithfulness ? `${extraction.faithfulness.score} (threshold ${extraction.faithfulness.threshold}; ${extraction.faithfulness.evaluator}: ${extraction.faithfulness.reason})` : 'not scored'}. A score is not a human fact check.</p>}
    {sources.map((source) => <p key={`${source.url}:${source.locator}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.publisher}</a> · {source.publisher} · {source.locator} · retrieved {date(source.retrievedAt)} · {source.licence} ({source.reuse})</p>)}
    {!sources.length && <p>No source supplied; do not treat this as verified.</p>}
  </div>;
}
function SignalPanel({ item, close, panelRef }: { item: MatchedSignal; close: () => void; panelRef: React.RefObject<HTMLElement | null> }) {
  const { title, statement, kind, status, nextStep, unknowns, startDate, endDate } = item.feature.properties;
  return <aside ref={panelRef} className="personal-feature-panel" aria-label="Selected city item">
    <button type="button" className="personal-close" onClick={close} aria-label="Close item">×</button>
    <span className="eyebrow">{kind.replaceAll('_', ' ')}</span><h3>{title}</h3>
    <p>{statement}</p><p><strong>Current display state:</strong> {displayStatus(item.feature)}</p>
    {displayStatus(item.feature) !== status && <p className="personal-source-meta">Original source status (as of {date(item.feature.properties.asOf)}): {status || 'not established'}</p>}
    <p><strong>Dates:</strong> {date(startDate)} – {date(endDate)}</p>
    <p><strong>Next:</strong> {nextStep || 'Not established'}</p>
    {unknowns.length > 0 && <p><strong>Still unknown:</strong> {unknowns.join('; ')}</p>}
    <p className="personal-meaning"><strong>What this means for you:</strong> {item.explanation}</p>
    <SignalMeta feature={item.feature} />
  </aside>;
}

function Ring({ title, items, empty, open }: { title: string; items: MatchedSignal[]; empty: string; open: (item: MatchedSignal) => void }) {
  return <section className="personal-ring"><h3>{title} <span>{items.length}</span></h3>
    {items.length ? <ul>{items.map((item) => <li key={item.feature.properties.id}>
      <button type="button" onClick={() => open(item)}><strong>{item.feature.properties.title}</strong><span>{item.explanation}</span></button>
      <SignalMeta feature={item.feature} compact />
    </li>)}</ul> : <p>{empty}</p>}
  </section>;
}

/** Public city data enters the browser; home/work never enter an API request or tile URL. */
export function PersonalMap({ request }: { request: AuthorizedRequest }) {
  const [explorationCity, setExplorationCity] = useState('');
  const { cityId, result, error } = useCitySignals(request, explorationCity || undefined);
  const pins = usePersonalPins(cityId);
  const [placing, setPlacing] = useState<'home' | 'work' | null>(null);
  const placingRef = useRef(placing);
  useEffect(() => { placingRef.current = placing; }, [placing]);
  const [enabled, setEnabled] = useState<SignalKind[]>(kinds.map((item) => item.id));
  const [categorySelection, setCategorySelection] = useState<{ cityId: string; values: string[] | null }>({ cityId: '', values: null });
  const [selected, setSelected] = useState<MatchedSignal | null>(null);
  const [positionError, setPositionError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const map = useRef<LibreMap | null>(null);
  const markerInstances = useRef<Marker[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const signals = result?.state === 'covered' ? result.data.signals.features : noSignals;
  const rings = useMemo(() => matchPersonalRings(signals, pins), [signals, pins]);
  const availableCategories = useMemo(() => [...new Set(signals.filter((feature) => feature.properties.kind === 'place').map((feature) => feature.properties.category))].sort(), [signals]);
  const categories = categorySelection.cityId === cityId ? categorySelection.values : null;
  useEffect(() => {
    if (selected && window.matchMedia('(max-width: 680px)').matches) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selected]);

  function savePin(which: 'home' | 'work', point?: Coordinate) {
    const next = { ...pins, [which]: point };
    if (next.home || next.work) localStorage.setItem(pinsKey(cityId), JSON.stringify(next));
    else localStorage.removeItem(pinsKey(cityId));
    window.dispatchEvent(new Event(PINS_CHANGED_EVENT));
    setPlacing(null);
    setPositionError('');
  }
  const saveRef = useRef(savePin);
  useEffect(() => { saveRef.current = savePin; });

  useEffect(() => {
    if (!container.current || result?.state !== 'covered') return;
    let disposed = false;
    const city = result.data.catalogue;
    import('maplibre-gl').then(({ default: maplibre }) => {
      if (disposed || !container.current) return;
      const instance = new maplibre.Map({ container: container.current, style: 'https://tiles.openfreemap.org/styles/liberty', center: city.center, zoom: 12, attributionControl: false });
      map.current = instance;
      instance.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
      instance.addControl(new maplibre.AttributionControl({ compact: false }), 'bottom-right');
      instance.on('load', () => {
        if (disposed) return;
        instance.addSource('city-signals', { type: 'geojson', data: result.data.signals as unknown as GeoJSONSourceSpecification['data'] });
        instance.addLayer({ id: 'signals-fill', type: 'fill', source: 'city-signals', filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']], paint: { 'fill-color': signalColors, 'fill-opacity': 0.3 } });
        instance.addLayer({ id: 'signals-line', type: 'line', source: 'city-signals', filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']], paint: { 'line-color': signalColors, 'line-width': 3 } });
        instance.addLayer({ id: 'signals-points', type: 'circle', source: 'city-signals', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': signalColors, 'circle-radius': 8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
        setMapReady(true);
      });
      instance.on('click', (event) => {
        if (placingRef.current) { saveRef.current(placingRef.current, [event.lngLat.lng, event.lngLat.lat]); return; }
        const clicked = instance.queryRenderedFeatures(event.point, { layers: layers.filter((id) => Boolean(instance.getLayer(id))) })[0];
        const feature = result.data.signals.features.find((item) => item.properties.id === clicked?.properties?.id);
        if (feature) setSelected({ feature, distanceMetres: null, explanation: matchPersonalRings([feature], localPins(city.id)).city[0].explanation });
      });
    }).catch(() => { if (!disposed) setPositionError('Map tiles could not load; use the city lists below.'); });
    return () => { disposed = true; map.current?.remove(); map.current = null; markerInstances.current = []; setMapReady(false); };
  }, [result]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    for (const id of layers) {
      if (!instance.getLayer(id)) continue;
      instance.setFilter(id, ['all', ['in', ['get', 'kind'], ['literal', enabled]], ['any', ['!=', ['get', 'kind'], 'place'], ['in', ['get', 'category'], ['literal', categories ?? availableCategories]]]]);
    }
  }, [result, mapReady, enabled, categories, availableCategories]);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    markerInstances.current.forEach((marker) => marker.remove());
    markerInstances.current = [];
    import('maplibre-gl').then(({ default: maplibre }) => {
      if (map.current !== instance) return;
      for (const [which, color] of [['home', '#28583e'], ['work', '#315d9c']] as const) {
        const point = pins[which];
        if (point) markerInstances.current.push(new maplibre.Marker({ color }).setLngLat(point).setPopup(new maplibre.Popup().setText(`My ${which} · only on this device`)).addTo(instance));
      }
    });
    return () => { markerInstances.current.forEach((marker) => marker.remove()); markerInstances.current = []; };
  }, [pins, result, mapReady]);

  function geolocate(which: 'home' | 'work') {
    setPositionError('');
    if (!navigator.geolocation) { setPositionError('Browser location is unavailable. Click the map instead.'); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => savePin(which, [coords.longitude, coords.latitude]),
      () => setPositionError('Location permission denied or unavailable. Click the map instead.'),
      { enableHighAccuracy: false, timeout: 12000 },
    );
  }
  return <section className="card personal-map-section" aria-label="Personal city map">
    <div className="personal-heading"><div><span className="eyebrow">YOUR PRIVATE PERSONAL MAP</span><h2>What affects me where I live, in my city, and on my way to work</h2></div><span className="places-level">PUBLIC CITY DATA · PRIVATE PINS</span></div>
    {error && <p role="alert">{error} The map needs published city signals; other Places sections still work.</p>}
    {!result && !error && <p>Reading city-wide public signals…</p>}
    {result?.state === 'not_covered' && <div className="personal-uncovered"><p>{cityId ? `${cityId} is not covered yet.` : 'Choose a city to explore public signals.'} Explore a covered city without changing your chosen city:</p>
      {result.coveredCities.length ? <select aria-label="Explore covered city" value={explorationCity} onChange={(event) => setExplorationCity(event.target.value)}><option value="">Choose covered city</option>{result.coveredCities.map((city) => <option key={city.id} value={city.id}>{city.name}, {city.state}</option>)}</select> : <p>No city has published signals yet.</p>}
    </div>}
    {result?.state === 'covered' && <>
      {explorationCity && <button type="button" className="secondary-button" onClick={() => setExplorationCity('')}>Back to my city</button>}
      <p>Exploring {result.data.catalogue.name} · catalogue generated {date(result.data.generatedAt)} · {signals.length} public items (not necessarily a complete city inventory) · {result.data.changes.added.length} added / {result.data.changes.changed.length} changed / {result.data.changes.removed.length} removed since previous run.</p>
      <div className="personal-pin-controls">{(['home', 'work'] as const).map((which) => <div key={which}>
        <strong>My {which}</strong> · {pins[which] ? 'pin set' : 'not set'}
        <button type="button" className="secondary-button" aria-pressed={placing === which} onClick={() => setPlacing(placing === which ? null : which)}>{placing === which ? 'Cancel placing' : `Set my ${which} · click map`}</button>
        <button type="button" className="secondary-button" onClick={() => geolocate(which)}>Use browser location for {which}</button>
        {pins[which] && <button type="button" className="secondary-button" onClick={() => savePin(which)}>Remove {which}</button>}
      </div>)}</div>
      <p className="personal-privacy">Home and work stored only on this device (localStorage) · remove with the buttons above. Nothing about them is sent to our server; no address geocoding or route service. The map is not recentered on your pins.</p>
      {placing && <p role="status">Click anywhere on the map to mark your {placing} (no address search).</p>}
      {positionError && <p role="alert">{positionError}</p>}
      <div className="personal-map-layout"><div><div className="personal-map-canvas" ref={container} aria-label={`Map of ${result.data.catalogue.name}`} />
        <p className="personal-tile-note">Map tile requests reveal the viewed map area to OpenFreeMap; they never contain saved pin coordinates. Self-hosted tiles could reduce this exposure later. © OpenStreetMap contributors / OpenFreeMap.</p>
        <div className="personal-legend" aria-label="Map layers">{kinds.map(({ id, label, color }) => <label key={id}><input type="checkbox" checked={enabled.includes(id)} onChange={() => setEnabled((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} /><i style={{ background: color }} />{label}</label>)}</div>
        {availableCategories.length > 1 && <div className="personal-legend" aria-label="Place categories">Places by category: {availableCategories.map((category) => <label key={category}><input type="checkbox" checked={categories === null || categories.includes(category)} onChange={() => setCategorySelection({ cityId, values: (categories ?? availableCategories).includes(category) ? (categories ?? availableCategories).filter((item) => item !== category) : [...(categories ?? availableCategories), category] })} />{category}</label>)}</div>}
      </div>{selected && selected.feature.properties.cityId === cityId && <SignalPanel item={selected} close={() => setSelected(null)} panelRef={panelRef} />}</div>
      <p className="personal-corridor">Near home: within 1 km straight-line (walkable-neighbourhood scale, not a walking route). Way to work: approximate 400 m corridor around the straight line home→work; no routing or travel-time prediction. The city list contains all public items; citywide items without geometry appear there, not as invented map pins.</p>
      {!pins.home && <p>Set my home to see nearby items; the city view is available below without a pin.</p>}
      <div className={`personal-rings${pins.home ? '' : ' city-only'}`}>{pins.home && <Ring title="Near my home" items={rings.home} empty="No mapped public items within 1 km." open={setSelected} />}
        {pins.home && <Ring title="On my way to work" items={rings.commute} empty={pins.work ? 'No mapped public items in the approximate corridor.' : 'Set my work to see the approximate corridor.'} open={setSelected} />}
        <Ring title="In my city" items={rings.city} empty="No public signals for this city yet." open={setSelected} /></div>
    </>}
  </section>;
}

export function NearYouCard({ request, go }: { request: AuthorizedRequest; go: () => void }) {
  const { cityId, result, error } = useCitySignals(request);
  const pins = usePersonalPins(cityId);
  const features = result?.state === 'covered' ? result.data.signals.features : noSignals;
  const rings = useMemo(() => matchPersonalRings(features, pins), [features, pins]);
  const top = pins.home ? [...rings.home, ...rings.commute.filter((item) => !rings.home.some((near) => near.feature.properties.id === item.feature.properties.id)), ...rings.city.filter((item) => !rings.home.some((near) => near.feature.properties.id === item.feature.properties.id))].slice(0, 2) : rings.city.slice(0, 2);
  return <section className="card overview-tile personal-overview"><span className="eyebrow">NEAR YOU / IN YOUR CITY</span>
    {result?.state === 'covered' ? <><strong className="overview-figure small">{result.data.catalogue.name}</strong><span className="small-copy">{pins.home ? `${rings.home.length} near home · ${pins.work ? `${rings.commute.length} on your way · ` : ''}` : 'Set home in Places · '}{rings.city.length} in city</span>
      {top.map((item) => <span className="small-copy" key={item.feature.properties.id}><strong>{item.feature.properties.title}</strong> · {item.distanceMetres !== null ? `${Math.round(item.distanceMetres)} m nearby` : item.feature.geometry ? 'in your city' : 'citywide'} · {item.feature.properties.kind.replaceAll('_', ' ')} · {displayStatus(item.feature)} · {item.feature.properties.reviewState}{item.feature.properties.reviewState === 'candidate' ? ' (not yet reviewed)' : item.feature.properties.reviewState === 'auto_checked' ? ' (not human-reviewed)' : ''} · {item.feature.properties.geometryPrecision} · as of {date(item.feature.properties.asOf)} · source: {item.feature.properties.sources[0]?.publisher || 'not supplied'}{item.feature.properties.sources.length > 1 && ` + ${item.feature.properties.sources.length - 1} more`}{item.feature.properties.extraction.method === 'llm' && ` · LLM faithfulness: ${item.feature.properties.extraction.faithfulness?.score ?? 'not scored'}`}</span>)}
      <span className="small-copy">Sources and details in Places · generated {date(result.data.generatedAt)}</span></> : <span className="small-copy">{error || (result?.state === 'not_covered' ? 'Your city is not covered yet; explore a covered city in Places.' : 'Reading public city data…')}</span>}
    <button type="button" className="text-button" onClick={go}>Open personal map in Places →</button>
  </section>;
}

export { CITY_CHANGED_EVENT };
