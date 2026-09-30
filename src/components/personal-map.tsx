'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, GeoJSONSourceSpecification, Map as LibreMap, Marker } from 'maplibre-gl';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Coordinate, CityFeature, CityFeedItem, Signal, SignalKind } from '../server/city-signals';
import { displayStatus, interestOptions, matchPersonalRings, PRECISION_LABELS, REVIEW_LABELS, type MatchedSignal } from './personal-map-relevance';
import { CITY_CHANGED_EVENT, PINS_CHANGED_EVENT, pinsKey, useCitySignals, type AuthorizedRequest } from './use-city-signals';
import { parsePins, saveInterests, useInterests, usePersonalPins } from './personal-map-preferences';
import { TEST_CITY_INVESTMENTS, type TestCityInvestmentId } from '@/data/local-investments';
import { displayCityText, formatCityDate } from './city-coverage';
import { readAccountPins } from './personal-map-storage';

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
const layers = ['demo-issuer-point', 'city-event-point', 'signals-selected-boundary', 'signals-fill', 'signals-line', 'signals-boundary', ...kinds.flatMap(({ id }) => [pointLayer(id), clusterLayer(id), countLayer(id)])];
const noSignals: CityFeature[] = [];
const noEvents: CityFeedItem[] = [];
const emptyCategories: string[] = [];
const date = (value: string | null) => value ? formatCityDate(value) : 'not established';

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
    {sources.map((source) => <p key={`${source.snapshotUrl ?? source.url}\0${source.url}\0${source.locator}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.publisher}</a> · {source.publisher} · {source.locator} · retrieved {date(source.retrievedAt)} · {source.licence} ({source.reuse})</p>)}
    {!sources.length && <p>No source supplied; do not treat this as verified.</p>}
  </div>;
}
function SignalPanel({ item, close }: { item: MatchedSignal & { feature: Signal }; close: () => void }) {
  const { title, statement, kind, status, nextStep, unknowns, startDate, endDate } = item.feature.properties;
  return <aside className="personal-feature-panel" aria-label="Selected city item">
    <button type="button" className="personal-close" onClick={close} aria-label="Close item">×</button>
    <span className="eyebrow">{kind.replaceAll('_', ' ')}</span><h3>{displayCityText(title)}</h3>
    <strong>Published stage · {displayCityText(displayStatus(item.feature))}</strong>
    <p className="personal-source-meta">{REVIEW_LABELS[item.feature.properties.reviewState]} · {PRECISION_LABELS[item.feature.properties.geometryPrecision]} · as of {date(item.feature.properties.asOf)}</p>
    <details><summary>Meaning, next steps &amp; evidence</summary>
      <p>{displayCityText(statement)}</p>
      {displayStatus(item.feature) !== status && <p>Original source status: {displayCityText(status || 'not established')}</p>}
      <p>Dates: {date(startDate)} – {date(endDate)} · Next: {displayCityText(nextStep || 'not established')}</p>
      {unknowns.length > 0 && <p>Still unknown: {unknowns.join('; ')}</p>}
      <p>{displayCityText(item.explanation)}</p>
      <SignalMeta feature={item.feature} />
    </details>
  </aside>;
}

function Ring({ title, items, empty, open }: { title: string; items: MatchedSignal[]; empty: string; open: (item: MatchedSignal) => void }) {
  const [shown, setShown] = useState(10);
  return <section className="personal-ring"><h3>{title} <span>{items.length}</span></h3>
    {items.length ? <><ul>{items.slice(0, shown).map((item) => <li key={item.feature.properties.id}>
      <button type="button" onClick={() => open(item)}><strong>{displayCityText(item.feature.properties.title)}</strong><span>{displayCityText(item.explanation)}</span></button>
      <SignalMeta feature={item.feature} compact />
    </li>)}</ul>{items.length > shown && <button type="button" className="secondary-button personal-show-more" onClick={() => setShown((value) => value + 10)}>Show more ({items.length - shown} remaining)</button>}</> : <p>{empty}</p>}
  </section>;
}

/** Public city data enters the browser; home/work never enter an API request or tile URL. */
export function PersonalMap({ request, accountId, explorationCity = '', onExplorationCityChange, onMakeMyCity, selectedId, onSelect, events = noEvents, selectedEventId = null, onSelectEvent, showInvestments = false, selectedInvestmentId, onSelectInvestment }: {
  request: AuthorizedRequest; accountId: string; explorationCity?: string; onExplorationCityChange?: (id: string) => void; onMakeMyCity?: (name: string) => Promise<void>;
  selectedId?: string | null; onSelect?: (feature: CityFeature) => void;
  events?: CityFeedItem[]; selectedEventId?: string | null; onSelectEvent?: (id: string) => void;
  showInvestments?: boolean; selectedInvestmentId?: TestCityInvestmentId | null; onSelectInvestment?: (id: TestCityInvestmentId | null) => void;
}) {
  const [internalExplorationCity, setInternalExplorationCity] = useState('');
  const activeCity = onExplorationCityChange ? explorationCity : internalExplorationCity;
  const { cityId, result, error } = useCitySignals(request, activeCity || undefined);
  const pins = usePersonalPins(cityId, accountId);
  const [placing, setPlacing] = useState<'home' | 'work' | null>(null);
  const placingRef = useRef(placing);
  useEffect(() => { placingRef.current = placing; }, [placing]);
  const [enabled, setEnabled] = useState<SignalKind[]>(kinds.map((item) => item.id));
  const [threeD, setThreeD] = useState(true);
  const [showProjects, setShowProjects] = useState(true);
  const [showPlaces, setShowPlaces] = useState(true);
  const [showOther, setShowOther] = useState(false);
  const [categorySelection, setCategorySelection] = useState<{ cityId: string; values: string[] }>({ cityId: '', values: [] });
  const [showEvents, setShowEvents] = useState(true);
  const interests = useInterests();
  const [selected, setSelected] = useState<MatchedSignal | null>(null);
  const [detail, setDetail] = useState<{ cityId: string; id: string; feature?: Signal; error?: string } | null>(null);
  // A parent project selection owns the detail panel when supplied. An omitted id leaves
  // standalone PersonalMap's own selection untouched; null explicitly means unlocated.
  const visibleSelection = selectedId === undefined || selected?.feature.properties.id === selectedId ? selected : null;
  const detailRevision = useRef(0);
  const [positionError, setPositionError] = useState('');
  const [pinConfirmation, setPinConfirmation] = useState('');
  const [cityChangeError, setCityChangeError] = useState('');
  const citywideRef = useRef<HTMLDetailsElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const focusedCity = useRef<string | null>(null);
  const markerInstances = useRef<Marker[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const demoSelectRef = useRef(onSelectInvestment);
  useEffect(() => { demoSelectRef.current = onSelectInvestment; }, [onSelectInvestment]);
  const eventSelectRef = useRef(onSelectEvent);
  useEffect(() => { eventSelectRef.current = onSelectEvent; }, [onSelectEvent]);
  const [polygonRevision, setPolygonRevision] = useState(0);
  const appliedCategories = useRef<{ cityId: string; values: string[]; signals: CityFeature[] } | null>(null);
  const signals = result?.state === 'covered' ? result.data.signals.features : noSignals;
  const availableCategories = useMemo(() => [...new Set(signals.filter((feature) => feature.properties.kind === 'place').map((feature) => feature.properties.category))].sort(), [signals]);
  const categories = categorySelection.cityId === cityId ? categorySelection.values : emptyCategories;
  const rings = useMemo(() => matchPersonalRings(signals, pins, undefined, interests, categories), [signals, pins, interests, categories]);
  useEffect(() => {
    if (selectedId === undefined || !selected || selected.feature.properties.id === selectedId) return;
    detailRevision.current++;
    queueMicrotask(() => { setSelected(null); setDetail(null); });
  }, [selectedId, selected]);
  useEffect(() => {
    if (selected && window.matchMedia('(max-width: 680px)').matches) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selected]);
  function changeExplorationCity(id: string) {
    setPlacing(null);
    setSelected(null);
    setDetail(null);
    detailRevision.current++;
    if (onExplorationCityChange) onExplorationCityChange(id);
    else setInternalExplorationCity(id);
  }
  useEffect(() => {
    const clear = () => { setSelected(null); setDetail(null); detailRevision.current++; };
    window.addEventListener(CITY_CHANGED_EVENT, clear);
    return () => window.removeEventListener(CITY_CHANGED_EVENT, clear);
  }, []);

  function openFeature(item: MatchedSignal) {
    if (onSelect) { onSelect(item.feature); return; } // The parent owns one detail sheet and full-record request.
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
    if (next.home || next.work) localStorage.setItem(pinsKey(cityId, accountId), JSON.stringify(next));
    else localStorage.removeItem(pinsKey(cityId, accountId));
    window.dispatchEvent(new Event(PINS_CHANGED_EVENT));
    setPlacing(null);
    setPositionError('');
    setPinConfirmation(point ? `My ${which} is set for this account on this device.` : '');
    if (which === 'home' && point && citywideRef.current) {
      citywideRef.current.open = true;
      requestAnimationFrame(() => citywideRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
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
      const closeCity = city.id === 'strausberg';
      const instance = new maplibre.Map({ container: container.current, style: 'https://tiles.openfreemap.org/styles/liberty',
        center: closeCity ? [13.883, 52.581] : city.center, zoom: closeCity ? 15.8 : 12, pitch: closeCity ? 52 : 0,
        bearing: closeCity ? -17 : 0, attributionControl: false, cooperativeGestures: true });
      map.current = instance;
      instance.addControl(new maplibre.NavigationControl({ showCompass: true }), 'top-right');
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
        instance.addSource('city-event-venues', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        instance.addLayer({ id: 'city-event-point', type: 'circle', source: 'city-event-venues',
          paint: { 'circle-color': '#d39132', 'circle-radius': 9, 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
        instance.addLayer({ id: 'city-event-selected', type: 'circle', source: 'city-event-venues',
          filter: ['==', ['get', 'id'], ''], paint: { 'circle-color': '#ffdb87', 'circle-radius': 15, 'circle-stroke-color': '#734d12', 'circle-stroke-width': 3 } });
        instance.addSource('demo-issuers', { type: 'geojson', data: {
          type: 'FeatureCollection', features: TEST_CITY_INVESTMENTS.filter((item) => item.cityId === city.id).map((item) => ({
            type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [...item.location.coordinates] },
            properties: { id: item.id, label: 'Fictional test project · test tokens · no rights' },
          })),
        } });
        instance.addLayer({ id: 'demo-issuer-point', type: 'circle', source: 'demo-issuers', layout: { visibility: 'none' },
          paint: { 'circle-color': '#fff3cb', 'circle-radius': 12, 'circle-stroke-color': '#822f79', 'circle-stroke-width': 4 } });
        instance.addLayer({ id: 'demo-issuer-label', type: 'symbol', source: 'demo-issuers', layout: {
          visibility: 'none', 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 2.2], 'text-allow-overlap': true,
        }, paint: { 'text-color': '#612359', 'text-halo-color': '#fffaf0', 'text-halo-width': 2 } });
        // Polygon topology is parsed by MapLibre only once a street-level zoom can show it.
        const showPolygons = () => {
          if (disposed || instance.getZoom() < 13 || instance.getSource('signals-polygons')) return;
          const polygons = features.filter((feature) => feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon');
          instance.addSource('signals-polygons', { type: 'geojson', data: collection(polygons) });
          const firstPoint = clusterLayer(kinds[0].id);
          const filter: ExpressionSpecification = ['==', ['geometry-type'], 'Polygon'];
          instance.addLayer({ id: 'signals-fill', type: 'fill', source: 'signals-polygons', minzoom: 13, filter, paint: { 'fill-color': signalColors, 'fill-opacity': 0.3 } }, firstPoint);
          instance.addLayer({ id: 'signals-boundary', type: 'line', source: 'signals-polygons', minzoom: 13, filter, paint: { 'line-color': signalColors, 'line-width': 2 } }, firstPoint);
          instance.addLayer({ id: 'signals-selected-boundary', type: 'line', source: 'signals-polygons', minzoom: 13,
            filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#173e32', 'line-width': 5, 'line-opacity': 0.9 } }, firstPoint);
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
      instance.on('style.load', () => {
        if (instance.getLayer('building-3d')) {
          instance.setPaintProperty('building-3d', 'fill-extrusion-color', '#aab5ad');
          instance.setFilter('building-3d', ['!=', ['get', 'hide_3d'], true]);
        }
      });
      instance.on('click', (event) => {
        if (placingRef.current) { saveRef.current(placingRef.current, [event.lngLat.lng, event.lngLat.lat]); return; }
        const clicked = instance.queryRenderedFeatures(event.point, { layers: layers.filter((id) => Boolean(instance.getLayer(id))) })[0];
        if (clicked?.layer.id === 'city-event-point') {
          const id = clicked.properties?.id;
          if (typeof id === 'string') eventSelectRef.current?.(id);
          return;
        }
        if (clicked?.layer.id === 'demo-issuer-point') {
          const id = clicked.properties?.id;
          if (TEST_CITY_INVESTMENTS.some((item) => item.id === id && item.cityId === city.id)) demoSelectRef.current?.(id as TestCityInvestmentId);
          return;
        }
        if (!clicked) return;
        if (clicked.properties?.cluster) {
          const source = instance.getSource(clicked.layer.source) as GeoJSONSource;
          source.getClusterExpansionZoom(clicked.properties.cluster_id).then((zoom) => instance.easeTo({ center: (clicked.geometry as GeoJSON.Point).coordinates as Coordinate, zoom }));
          return;
        }
        const feature = byId.get(clicked.properties?.id);
        if (feature) {
          const matched = matchPersonalRings([feature], parsePins(readAccountPins(localStorage, city.id, accountId)), undefined, [], [feature.properties.category]);
          openRef.current(matched.home[0] ?? matched.commute[0] ?? matched.city[0] ?? { feature, distanceMetres: null, explanation: `${feature.properties.title}: ${feature.properties.statement}` });
        }
      });
    }).catch(() => { if (!disposed) setPositionError('Map tiles could not load; use the city lists below.'); });
    return () => { disposed = true; map.current?.remove(); map.current = null; markerInstances.current = []; setMapReady(false); };
  }, [result, accountId]);

  useEffect(() => {
    const instance = map.current;
    if (!mapReady || !instance?.getSource('city-event-venues')) return;
    const source = instance.getSource('city-event-venues') as GeoJSONSource;
    source.setData({ type: 'FeatureCollection', features: events.filter((item) => item.kind === 'event' && item.geometry?.type === 'Point')
      .map((item) => ({ type: 'Feature' as const, geometry: item.geometry!, properties: { id: item.id } })) });
  }, [events, mapReady, cityId]);
  useEffect(() => {
    const instance = map.current;
    if (!mapReady || !instance?.getLayer('city-event-selected')) return;
    instance.setFilter('city-event-selected', ['==', ['get', 'id'], selectedEventId ?? '']);
    const event = events.find((item) => item.id === selectedEventId && item.kind === 'event');
    if (event?.geometry?.type === 'Point') {
      focusedCity.current = cityId;
      instance.easeTo({ center: event.geometry.coordinates, zoom: 16 });
    }
  }, [events, selectedEventId, cityId, mapReady]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    for (const layer of ['city-event-point', 'city-event-selected'])
      if (map.current.getLayer(layer)) map.current.setLayoutProperty(layer, 'visibility', showEvents ? 'visible' : 'none');
  }, [mapReady, showEvents]);
  useEffect(() => {
    const instance = map.current;
    if (!instance || !mapReady) return;
    for (const { id } of kinds) {
      const visible = enabled.includes(id) && (id === 'place' ? showPlaces : id === 'planning' || id === 'construction' || id === 'roadworks' || id === 'consultation' ? showProjects : showOther);
      for (const layer of [pointLayer(id), clusterLayer(id), countLayer(id)]) {
        instance.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
      }
    }
    const polygonKinds = enabled.filter((id) => showProjects && (id === 'planning' || id === 'construction' || id === 'roadworks' || id === 'consultation'));
    for (const [layer, geometry] of [['signals-fill', 'Polygon'], ['signals-line', 'LineString'], ['signals-boundary', 'Polygon']] as const) {
      if (instance.getLayer(layer)) instance.setFilter(layer, ['all', ['==', ['geometry-type'], geometry], ['in', ['get', 'kind'], ['literal', polygonKinds]]]);
    }
    for (const id of ['demo-issuer-point', 'demo-issuer-label'])
      if (instance.getLayer(id)) instance.setLayoutProperty(id, 'visibility', showInvestments ? 'visible' : 'none');
  }, [mapReady, polygonRevision, enabled, showProjects, showPlaces, showOther, showInvestments]);
  useEffect(() => {
    if (!mapReady || !map.current?.getLayer('signals-selected-boundary')) return;
    map.current.setFilter('signals-selected-boundary', ['==', ['get', 'id'], showProjects ? selectedId ?? '' : '']);
  }, [mapReady, polygonRevision, showProjects, selectedId]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    if (map.current.getLayer('building-3d')) map.current.setLayoutProperty('building-3d', 'visibility', threeD ? 'visible' : 'none');
    map.current.easeTo({ pitch: threeD ? 52 : 0, bearing: threeD ? -17 : 0, duration: 600 });
  }, [threeD, mapReady]);
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
  useEffect(() => {
    if (selectedId === undefined || !mapReady || !map.current || result?.state !== 'covered') return;
    if (selectedEventId && events.some((item) => item.id === selectedEventId && item.geometry?.type === 'Point')) return;
    if (focusedCity.current === cityId) map.current.resize(); // Closing a prior detail widens the map.
    const geometry = selectedId ? signals.find((feature) => feature.properties.id === selectedId)?.geometry : null;
    if (!geometry) {
      if (focusedCity.current === cityId)
        map.current.easeTo({ center: cityId === 'strausberg' ? [13.883, 52.581] : result.data.catalogue.center, zoom: cityId === 'strausberg' ? 15.8 : 12 });
      focusedCity.current = null; // City context, never the previous project's map location.
      return;
    }
    focusedCity.current = cityId;
    if (geometry.type === 'Point') {
      map.current.easeTo({ center: geometry.coordinates, zoom: 16 });
      return;
    }
    const points: Coordinate[] = geometry.type === 'LineString' ? geometry.coordinates :
      geometry.type === 'Polygon' ? geometry.coordinates.flat() : geometry.coordinates.flat(2);
    if (!points.length) return;
    const west = Math.min(...points.map((point) => point[0]));
    const east = Math.max(...points.map((point) => point[0]));
    const south = Math.min(...points.map((point) => point[1]));
    const north = Math.max(...points.map((point) => point[1]));
    map.current.fitBounds([[west, south], [east, north]], { padding: 62, maxZoom: 16 });
  }, [selectedId, selectedEventId, events, cityId, signals, mapReady, result]);
  useEffect(() => {
    if (!mapReady || !map.current || !selectedInvestmentId || !showInvestments || cityId !== 'strausberg') return;
    const item = TEST_CITY_INVESTMENTS.find((entry) => entry.id === selectedInvestmentId);
    if (item) map.current.easeTo({ center: [...item.location.coordinates], zoom: 16 });
  }, [mapReady, selectedInvestmentId, cityId, showInvestments]);

  function geolocate(which: 'home' | 'work') {
    setPositionError('');
    if (!navigator.geolocation) { setPositionError('Browser location is unavailable. Click the map instead.'); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => savePin(which, [coords.longitude, coords.latitude]),
      () => setPositionError('Location permission denied or unavailable. Click the map instead.'),
      { enableHighAccuracy: false, timeout: 12000 },
    );
  }
  return <section className="card personal-map-section" aria-label="Personal city map" id="personal-map" tabIndex={-1}>
    <div className="personal-heading"><div><span className="eyebrow">EXPLORE THE CITY · SOURCE-BACKED CONTEXT</span><h2>Homes, local places &amp; council papers</h2></div><span className="places-level">PUBLIC CITY DATA · PRIVATE PINS</span></div>
    {error && <p role="alert">{error} The map needs published city signals; other Places sections still work.</p>}
    {!result && !error && <p>Reading city-wide public signals…</p>}
    {result?.state === 'not_covered' && <p className="personal-uncovered">{cityId ? 'Your place is not covered yet.' : 'Choose your city above.'} You can look at another covered city without changing yours.</p>}
    {result?.state === 'covered' && <label className="personal-city-switcher">Look at another covered city (does not change yours)
      <select aria-label="Look at another covered city" value={result.data.catalogue.id} onChange={(event) => { if (event.target.value !== cityId) changeExplorationCity(event.target.value); }}>
        {result.data.coveredCities.map((city) => <option key={city.id} value={city.id}>{city.name}, {city.state}</option>)}
      </select>
      {activeCity && onMakeMyCity && <button type="button" className="secondary-button" onClick={() => { setCityChangeError(''); void onMakeMyCity(result.data.catalogue.name).catch(() => setCityChangeError('Your city could not be saved. Try again.')); }}>Make this my city</button>}
    </label>}
    {cityChangeError && <p role="alert">{cityChangeError}</p>}
    {result?.state === 'covered' && <>
      {activeCity && <button type="button" className="secondary-button" onClick={() => changeExplorationCity('')}>Back to my city</button>}
      <div className="personal-map-toolbar" role="group" aria-label="Map layers and view">
        <button type="button" aria-pressed={showProjects} onClick={() => setShowProjects((value) => !value)}>▧ Public projects</button>
        <button type="button" aria-pressed={showPlaces} onClick={() => setShowPlaces((value) => !value)}>● OSM places</button>
        <button type="button" aria-pressed={showOther} onClick={() => setShowOther((value) => !value)}>⌁ Council papers &amp; budget</button>
        <button type="button" aria-pressed={showEvents} onClick={() => setShowEvents((value) => !value)}>◉ Event venues ({events.filter((item) => item.geometry).length})</button>
        {onSelectInvestment && <button type="button" className="personal-demo-toggle" aria-pressed={showInvestments}
          onClick={() => onSelectInvestment(showInvestments ? null : TEST_CITY_INVESTMENTS[0].id)}>◇ Fictional test project · test tokens · no rights</button>}
        <button type="button" className="personal-3d-toggle" aria-pressed={threeD} onClick={() => setThreeD((value) => !value)}>{threeD ? '3D buildings · switch to 2D' : '2D map · switch to 3D'}</button>
      </div>
      <details className="personal-map-caption"><summary>About map shapes</summary><p>OpenStreetMap building heights may be estimated. Planning areas show published boundaries, not building footprints. Project examples are illustrative placements.</p></details>
      <p className="small-copy">A council paper is not a decision.</p>
      {placing && <p role="status">Click anywhere on the map to mark your {placing} (no address search).</p>}
      {positionError && <p role="alert">{positionError}</p>}
      <div className="personal-map-layout"><div><div className="personal-map-canvas" ref={container} aria-label={`Map of ${result.data.catalogue.name}`} />
        <p className="personal-tile-note">Map tile requests reveal the viewed map area to OpenFreeMap; they never contain saved pin coordinates. © OpenStreetMap contributors / OpenMapTiles / OpenFreeMap.</p>
        <details className="personal-map-options"><summary>Map filters, private pins &amp; citywide records</summary>
          <p>Exploring {result.data.catalogue.name} · catalogue generated {date(result.data.generatedAt)} · {signals.length} published items (not a complete city inventory). Since the previous publication: {result.data.changes.added.length} added, {result.data.changes.changed.length} changed, {result.data.changes.removed.length} removed. Changes do not indicate construction progress.</p>
          <fieldset className="personal-interests"><legend>Interests · stored on this device</legend>
            <p>Used to rank the city lists, never sent to our server.</p>
            <div className="personal-legend">{interestOptions.map((interest) => <label key={interest}><input type="checkbox" checked={interests.includes(interest)} onChange={() => saveInterests(interests.includes(interest) ? interests.filter((item) => item !== interest) : [...interests, interest])} />{interest}</label>)}</div>
          </fieldset>
          <div className="personal-pin-controls">{(['home', 'work'] as const).map((which) => <div key={which}>
            <strong>My {which}</strong> · {pins[which] ? 'pin set' : 'not set'}
            <button type="button" className="secondary-button" aria-pressed={placing === which} onClick={() => setPlacing(placing === which ? null : which)}>{placing === which ? 'Cancel placing' : `Set my ${which} · click map`}</button>
            <button type="button" className="secondary-button" onClick={() => geolocate(which)}>Use browser location for {which}</button>
            {pins[which] && <button type="button" className="secondary-button" onClick={() => savePin(which)}>Remove {which}</button>}
          </div>)}</div>
          <p className="personal-privacy">Home and work stored only on this device. No address geocoding or route service; the map is not recentered on private pins.</p>
          <div className="personal-legend" aria-label="Map layer filters">{kinds.map(({ id, label, color }) => <label key={id}><input type="checkbox" checked={enabled.includes(id)} onChange={() => setEnabled((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} /><i style={{ background: color }} />{label}</label>)}</div>
        </details>
        {availableCategories.length > 0 && <div className="personal-category-picker" aria-label="Place categories">
          <label>Show places by category (also adds them to the city list)
            <select aria-label="Add place category" value="" onChange={(event) => {
              if (event.target.value && !categories.includes(event.target.value)) setCategorySelection({ cityId, values: [...categories, event.target.value] });
            }}>
              <option value="">Choose a category…</option>
              {availableCategories.map((category) => <option key={category} value={category} disabled={categories.includes(category)}>{category.split(';')[0].replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())}</option>)}
            </select>
          </label>
          {categories.map((category) => <button type="button" className="secondary-button" key={category} onClick={() => setCategorySelection({ cityId, values: categories.filter((item) => item !== category) })}>Remove {category.split(';')[0].replaceAll('_', ' ')} ×</button>)}
        </div>}
      </div>{!onSelect && visibleSelection && visibleSelection.feature.properties.cityId === cityId && <div ref={panelRef} className="personal-panel-holder">
        {detail?.cityId === cityId && detail.id === visibleSelection.feature.properties.id && detail.feature
          ? <SignalPanel item={{ ...visibleSelection, feature: detail.feature }} close={() => setSelected(null)} />
          : <div className="personal-feature-panel"><button type="button" className="personal-close" onClick={() => setSelected(null)} aria-label="Close item">×</button><p role="status">{detail?.error || 'Loading full source record…'}</p></div>}
      </div>}</div>
      <details ref={citywideRef} className="personal-map-options personal-citywide"><summary>Browse all public records, including those without map geometry</summary>
        {pinConfirmation && <p role="status">{pinConfirmation} {pins.home && 'Nearby public items appear in Near my home.'}</p>}
        <p className="personal-corridor">Near home: within 1 km straight-line, not a walking route. Way to work: approximate 400 m corridor around a straight line; no routing or travel-time prediction. Unlocated city items stay in these lists, never invented pins.</p>
        <div className={`personal-rings${pins.home ? '' : ' city-only'}`}>{pins.home && <Ring title="Near my home" items={rings.home} empty="No mapped public items within 1 km." open={openFeature} />}
          {pins.home && <Ring title="On my way to work" items={rings.commute} empty={pins.work ? 'No mapped public items in the approximate corridor.' : 'Set my work to see the approximate corridor.'} open={openFeature} />}
          <Ring title="In my city" items={rings.city} empty="No citywide public items or selected place categories here yet." open={openFeature} /></div>
      </details>
    </>}
  </section>;
}


export { CITY_CHANGED_EVENT };
