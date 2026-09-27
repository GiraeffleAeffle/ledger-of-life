'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, GeoJSONSourceSpecification, Map as LibreMap, Marker } from 'maplibre-gl';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Coordinate, CityFeature, Signal, SignalKind } from '../server/city-signals';
import { displayStatus, interestOptions, matchPersonalRings, PRECISION_LABELS, REVIEW_LABELS, type MatchedSignal } from './personal-map-relevance';
import { CITY_CHANGED_EVENT, PINS_CHANGED_EVENT, pinsKey, useCitySignals, type AuthorizedRequest } from './use-city-signals';
import { parsePins, saveInterests, useInterests, usePersonalPins } from './personal-map-preferences';

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
const pointLayer = (kind: SignalKind) => `signals-${kind}-point`;
const clusterLayer = (kind: SignalKind) => `signals-${kind}-cluster`;
const countLayer = (kind: SignalKind) => `signals-${kind}-count`;
const layers = ['signals-fill', 'signals-line', 'signals-boundary', ...kinds.flatMap(({ id }) => [pointLayer(id), clusterLayer(id), countLayer(id)])];
const noSignals: CityFeature[] = [];
const emptyCategories: string[] = [];
const date = (value: string | null) => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB') : 'not established';

function SignalMeta({ feature, compact = false }: { feature: CityFeature; compact?: boolean }) {
  const { reviewState, geometryPrecision, asOf } = feature.properties;
  const source = 'sources' in feature.properties ? feature.properties.sources[0] : feature.properties.primarySource;
  const count = 'sources' in feature.properties ? feature.properties.sources.length : feature.properties.sourceCount;
  if (compact) return <p className="personal-source-meta">Source: {source?.publisher || 'not supplied'}{count > 1 && ` + ${count - 1} more`} · as of {date(asOf)} · {REVIEW_LABELS[reviewState]} · {PRECISION_LABELS[geometryPrecision]}</p>;
  if (!('sources' in feature.properties)) return null;
  const { sources, extraction } = feature.properties;
  return <div className="personal-source-meta">
    <p>As of {date(asOf)} · review: <strong>{REVIEW_LABELS[reviewState]}{reviewState === 'auto_checked' ? ' · automated source check, not human-reviewed' : ''}</strong> · location: <strong>{PRECISION_LABELS[geometryPrecision]}</strong></p>
    {extraction.method === 'llm' && <p>LLM extraction{extraction.model ? ` (${extraction.model})` : ''} · faithfulness: {extraction.faithfulness ? `${extraction.faithfulness.score} (threshold ${extraction.faithfulness.threshold}; ${extraction.faithfulness.evaluator}: ${extraction.faithfulness.reason})` : 'not scored'}. A score is not a human fact check.</p>}
    {sources.map((source) => <p key={`${source.url}:${source.locator}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.publisher}</a> · {source.publisher} · {source.locator} · retrieved {date(source.retrievedAt)} · {source.licence} ({source.reuse})</p>)}
    {!sources.length && <p>No source supplied; do not treat this as verified.</p>}
  </div>;
}
function SignalPanel({ item, close }: { item: MatchedSignal & { feature: Signal }; close: () => void }) {
  const { title, statement, kind, status, nextStep, unknowns, startDate, endDate } = item.feature.properties;
  return <aside className="personal-feature-panel" aria-label="Selected city item">
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
  const [shown, setShown] = useState(10);
  return <section className="personal-ring"><h3>{title} <span>{items.length}</span></h3>
    {items.length ? <><ul>{items.slice(0, shown).map((item) => <li key={item.feature.properties.id}>
      <button type="button" onClick={() => open(item)}><strong>{item.feature.properties.title}</strong><span>{item.explanation}</span></button>
      <SignalMeta feature={item.feature} compact />
    </li>)}</ul>{items.length > shown && <button type="button" className="secondary-button personal-show-more" onClick={() => setShown((value) => value + 10)}>Show more ({items.length - shown} remaining)</button>}</> : <p>{empty}</p>}
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
  const [categorySelection, setCategorySelection] = useState<{ cityId: string; values: string[] }>({ cityId: '', values: [] });
  const interests = useInterests();
  const [selected, setSelected] = useState<MatchedSignal | null>(null);
  const [detail, setDetail] = useState<{ cityId: string; id: string; feature?: Signal; error?: string } | null>(null);
  const detailRevision = useRef(0);
  const [positionError, setPositionError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const markerInstances = useRef<Marker[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [polygonRevision, setPolygonRevision] = useState(0);
  const appliedCategories = useRef<{ cityId: string; values: string[]; signals: CityFeature[] } | null>(null);
  const signals = result?.state === 'covered' ? result.data.signals.features : noSignals;
  const availableCategories = useMemo(() => [...new Set(signals.filter((feature) => feature.properties.kind === 'place').map((feature) => feature.properties.category))].sort(), [signals]);
  const categories = categorySelection.cityId === cityId ? categorySelection.values : emptyCategories;
  const rings = useMemo(() => matchPersonalRings(signals, pins, undefined, interests, categories), [signals, pins, interests, categories]);
  useEffect(() => {
    if (selected && window.matchMedia('(max-width: 680px)').matches) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selected]);
  function changeExplorationCity(id: string) {
    setPlacing(null);
    setSelected(null);
    setDetail(null);
    detailRevision.current++;
    setExplorationCity(id);
  }
  useEffect(() => {
    const clear = () => { setSelected(null); setDetail(null); detailRevision.current++; };
    window.addEventListener(CITY_CHANGED_EVENT, clear);
    return () => window.removeEventListener(CITY_CHANGED_EVENT, clear);
  }, []);

  function openFeature(item: MatchedSignal) {
    setSelected(item);
    const id = item.feature.properties.id;
    const revision = ++detailRevision.current;
    if ('sources' in item.feature.properties) {
      setDetail({ cityId, id, feature: item.feature as Signal });
      return;
    }
    setDetail({ cityId, id });
    request<{ feature: Signal }>(`/api/city-signals?city=${encodeURIComponent(cityId)}&id=${encodeURIComponent(id)}`)
      .then(({ feature }) => { if (detailRevision.current === revision) setDetail({ cityId, id, feature }); })
      .catch(() => { if (detailRevision.current === revision) setDetail({ cityId, id, error: 'Full source record unavailable. Please try again.' }); });
  }
  const openRef = useRef(openFeature);
  useEffect(() => { openRef.current = openFeature; });

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
    delete container.current.dataset.signalRendered;
    let disposed = false;
    const city = result.data.catalogue;
    const features = result.data.signals.features;
    const byId = new Map(features.map((feature) => [feature.properties.id, feature]));
    const points = new Map(kinds.map(({ id }) => [id, features.filter((feature) => feature.properties.kind === id && feature.geometry?.type === 'Point')]));
    const routes = features.filter((feature) => feature.geometry?.type === 'LineString');
    const collection = (items: CityFeature[]) => ({ type: 'FeatureCollection', features: items }) as GeoJSONSourceSpecification['data'];
    performance.mark(`personal-map-data-${city.id}`);
    import('maplibre-gl').then(({ default: maplibre }) => {
      if (disposed || !container.current) return;
      const instance = new maplibre.Map({ container: container.current, style: 'https://tiles.openfreemap.org/styles/liberty', center: city.center, zoom: 12, attributionControl: false });
      map.current = instance;
      instance.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
      instance.addControl(new maplibre.AttributionControl({ compact: false }), 'bottom-right');
      instance.on('load', () => {
        if (disposed) return;
        instance.addSource('signals-routes', { type: 'geojson', data: collection(routes) });
        instance.addLayer({ id: 'signals-line', type: 'line', source: 'signals-routes', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': signalColors, 'line-width': 3 } });
        for (const { id, color } of kinds) {
          const source = `signals-${id}`;
          instance.addSource(source, { type: 'geojson', data: collection(points.get(id) ?? []), cluster: true, clusterRadius: 48, clusterMaxZoom: 14 });
          instance.addLayer({ id: clusterLayer(id), type: 'circle', source, filter: ['has', 'point_count'], paint: { 'circle-color': color, 'circle-radius': 17, 'circle-opacity': 0.9, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
          instance.addLayer({ id: countLayer(id), type: 'symbol', source, filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 }, paint: { 'text-color': '#fff' } });
          instance.addLayer({ id: pointLayer(id), type: 'circle', source, filter: ['!', ['has', 'point_count']], paint: { 'circle-color': color, 'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
        }
        // Polygon topology is parsed by MapLibre only once a street-level zoom can show it.
        const showPolygons = () => {
          if (disposed || instance.getZoom() < 13 || instance.getSource('signals-polygons')) return;
          const polygons = features.filter((feature) => feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon');
          instance.addSource('signals-polygons', { type: 'geojson', data: collection(polygons) });
          const firstPoint = clusterLayer(kinds[0].id);
          const filter: ExpressionSpecification = ['==', ['geometry-type'], 'Polygon'];
          instance.addLayer({ id: 'signals-fill', type: 'fill', source: 'signals-polygons', minzoom: 13, filter, paint: { 'fill-color': signalColors, 'fill-opacity': 0.3 } }, firstPoint);
          instance.addLayer({ id: 'signals-boundary', type: 'line', source: 'signals-polygons', minzoom: 13, filter, paint: { 'line-color': signalColors, 'line-width': 2 } }, firstPoint);
          setPolygonRevision((value) => value + 1);
        };
        instance.on('zoomend', showPolygons);
        showPolygons();
        setMapReady(true);
        instance.once('idle', () => {
          if (disposed) return;
          performance.mark(`personal-map-first-render-${city.id}`);
          if (container.current) container.current.dataset.signalRendered = String(Math.round(performance.now()));
        });
      });
      instance.on('click', (event) => {
        if (placingRef.current) { saveRef.current(placingRef.current, [event.lngLat.lng, event.lngLat.lat]); return; }
        const clicked = instance.queryRenderedFeatures(event.point, { layers: layers.filter((id) => Boolean(instance.getLayer(id))) })[0];
        if (!clicked) return;
        if (clicked.properties?.cluster) {
          const source = instance.getSource(clicked.layer.source) as GeoJSONSource;
          source.getClusterExpansionZoom(clicked.properties.cluster_id).then((zoom) => instance.easeTo({ center: (clicked.geometry as GeoJSON.Point).coordinates as Coordinate, zoom }));
          return;
        }
        const feature = byId.get(clicked.properties?.id);
        if (feature) {
          const matched = matchPersonalRings([feature], parsePins(localStorage.getItem(pinsKey(city.id)) ?? ''), undefined, [], [feature.properties.category]);
          openRef.current(matched.home[0] ?? matched.commute[0] ?? matched.city[0] ?? { feature, distanceMetres: null, explanation: `${feature.properties.title}: ${feature.properties.statement}` });
        }
      });
    }).catch(() => { if (!disposed) setPositionError('Map tiles could not load; use the city lists below.'); });
    return () => { disposed = true; map.current?.remove(); map.current = null; markerInstances.current = []; setMapReady(false); };
  }, [result]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !mapReady) return;
    for (const { id } of kinds) {
      for (const layer of [pointLayer(id), clusterLayer(id), countLayer(id)]) {
        instance.setLayoutProperty(layer, 'visibility', enabled.includes(id) ? 'visible' : 'none');
      }
    }
    for (const [layer, geometry] of [['signals-fill', 'Polygon'], ['signals-line', 'LineString'], ['signals-boundary', 'Polygon']] as const) {
      if (instance.getLayer(layer)) instance.setFilter(layer, ['all', ['==', ['geometry-type'], geometry], ['in', ['get', 'kind'], ['literal', enabled]]]);
    }
  }, [mapReady, polygonRevision, enabled]);
  useEffect(() => {
    const instance = map.current;
    if (!instance || !mapReady) return;
    const previous = appliedCategories.current;
    // A new source already contains every place; do not parse Köln's points twice.
    if (!categories.length && (previous?.cityId !== cityId || previous.signals !== signals)) {
      appliedCategories.current = { cityId, values: categories, signals };
      return;
    }
    if (previous?.cityId === cityId && previous.signals === signals && previous.values === categories) return;
    const placeSource = instance.getSource('signals-place') as GeoJSONSource;
    const places = signals.filter((feature) => feature.properties.kind === 'place' && feature.geometry?.type === 'Point' &&
      (!categories.length || categories.includes(feature.properties.category)));
    placeSource.setData({ type: 'FeatureCollection', features: places } as GeoJSONSourceSpecification['data']);
    appliedCategories.current = { cityId, values: categories, signals };
  }, [signals, mapReady, categories, cityId]);
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
    {result?.state === 'not_covered' && <p className="personal-uncovered">{cityId ? `${cityId} is not covered yet.` : 'Choose a city to explore public signals.'} Explore a covered city without changing your chosen city.</p>}
    {result && <label className="personal-city-switcher">Explore covered city
      <select aria-label="Explore covered city" value={result.state === 'covered' ? result.data.catalogue.id : ''} onChange={(event) => { if (event.target.value !== cityId) changeExplorationCity(event.target.value); }}>
        {result.state === 'not_covered' && <option value="">Choose covered city</option>}
        {(result.state === 'covered' ? result.data.coveredCities : result.coveredCities).map((city) => <option key={city.id} value={city.id}>{city.name}, {city.state}</option>)}
      </select>
    </label>}
    {result?.state === 'covered' && <>
      {explorationCity && <button type="button" className="secondary-button" onClick={() => changeExplorationCity('')}>Back to my city</button>}
      <p>Exploring {result.data.catalogue.name} · catalogue generated {date(result.data.generatedAt)} · {signals.length} public items (not necessarily a complete city inventory) · {result.data.changes.added.length} added / {result.data.changes.changed.length} changed / {result.data.changes.removed.length} removed since previous run.</p>
      <fieldset className="personal-interests"><legend>Interests · stored on this device</legend>
        <p>Rank matching places and council items higher by their title or category; your interests are not sent to our server.</p>
        <div className="personal-legend">{interestOptions.map((interest) => <label key={interest}><input type="checkbox" checked={interests.includes(interest)} onChange={() => saveInterests(interests.includes(interest) ? interests.filter((item) => item !== interest) : [...interests, interest])} />{interest}</label>)}</div>
      </fieldset>
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
        {availableCategories.length > 0 && <div className="personal-category-picker" aria-label="Place categories">
          <label>Show places by category (also adds them to the city list)
            <select aria-label="Add place category" value="" onChange={(event) => {
              if (event.target.value && !categories.includes(event.target.value)) setCategorySelection({ cityId, values: [...categories, event.target.value] });
            }}>
              <option value="">Choose a category…</option>
              {availableCategories.map((category) => <option key={category} value={category} disabled={categories.includes(category)}>{category.replaceAll('_', ' ')}</option>)}
            </select>
          </label>
          {categories.map((category) => <button type="button" className="secondary-button" key={category} onClick={() => setCategorySelection({ cityId, values: categories.filter((item) => item !== category) })}>Remove {category.replaceAll('_', ' ')} ×</button>)}
        </div>}
      </div>{selected && selected.feature.properties.cityId === cityId && <div ref={panelRef} className="personal-panel-holder">
        {detail?.cityId === cityId && detail.id === selected.feature.properties.id && detail.feature
          ? <SignalPanel item={{ ...selected, feature: detail.feature }} close={() => setSelected(null)} />
          : <div className="personal-feature-panel"><button type="button" className="personal-close" onClick={() => setSelected(null)} aria-label="Close item">×</button><p role="status">{detail?.error || 'Loading full source record…'}</p></div>}
      </div>}</div>
      <p className="personal-corridor">Near home: within 1 km straight-line (walkable-neighbourhood scale, not a walking route). Way to work: approximate 400 m corridor around the straight line home→work; no routing or travel-time prediction. The city list shows council matters, budgets and city-scale projects; switch on place categories to browse them citywide. Citywide items without geometry do not get invented map pins.</p>
      {!pins.home && <p>Set my home to see nearby items; the city view is available below without a pin.</p>}
      <div className={`personal-rings${pins.home ? '' : ' city-only'}`}>{pins.home && <Ring title="Near my home" items={rings.home} empty="No mapped public items within 1 km." open={openFeature} />}
        {pins.home && <Ring title="On my way to work" items={rings.commute} empty={pins.work ? 'No mapped public items in the approximate corridor.' : 'Set my work to see the approximate corridor.'} open={openFeature} />}
        <Ring title="In my city" items={rings.city} empty="No citywide public items or selected place categories here yet." open={openFeature} /></div>
    </>}
  </section>;
}


export { CITY_CHANGED_EVENT };
