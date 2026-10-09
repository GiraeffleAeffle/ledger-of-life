'use client';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { Map as LibreMap, Marker } from 'maplibre-gl';
import { isCivicCity } from '@/data/civic-cities';
import { loyaltyMapMerchants, type LoyaltyPlaces } from '@/data/loyalty-places';
import type { AuthorizedRequest } from './use-city-signals';

/** Companion layer: no changes to holdings, personal pins, council or project sources. */
export function LoyaltyMapLayer({ request, cityId, mapRef, mapReady }: {
  request: AuthorizedRequest; cityId: string; mapRef: RefObject<LibreMap | null>; mapReady: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [result, setResult] = useState<LoyaltyPlaces | null>(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [markerError, setMarkerError] = useState(false);
  const supported = isCivicCity(cityId);
  useEffect(() => {
    if (!enabled || !supported) return;
    let current = true;
    request<LoyaltyPlaces>(`/api/loyalty-places?city=${encodeURIComponent(cityId)}`).then((next) => {
      if (current) { setResult(next); setError(''); }
    }).catch(() => { if (current) { setResult(null); setError('Loyalty shop evidence could not be read. No shops are shown.'); } });
    return () => { current = false; };
  }, [request, cityId, enabled, supported]);
  const merchants = useMemo(() => loyaltyMapMerchants(result, cityId, enabled), [result, cityId, enabled]);
  const selected = merchants.find((merchant) => merchant.id === selectedId);
  useEffect(() => {
    const instance = mapRef.current;
    if (!mapReady || !instance || !merchants.length) return;
    let disposed = false;
    const markers: Marker[] = [];
    import('maplibre-gl').then(({ Marker }) => {
      if (disposed || mapRef.current !== instance) return;
      for (const merchant of merchants) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'L';
        button.setAttribute('aria-label', `${merchant.name} · loyalty · Sepolia test`);
        button.title = `${merchant.name} · Sepolia test loyalty`;
        button.className = 'loyalty-map-marker';
        button.addEventListener('click', (event) => { event.stopPropagation(); setSelectedId(merchant.id); });
        markers.push(new Marker({ element: button }).setLngLat(merchant.coordinates).addTo(instance));
      }
      setMarkerError(false);
    }).catch(() => { if (!disposed) setMarkerError(true); });
    return () => { disposed = true; markers.forEach((marker) => marker.remove()); };
  }, [mapRef, mapReady, merchants]);
  if (!supported) return null;
  return <section className="personal-map-options loyalty-shop-layer" aria-label="Loyalty shop map layer">
    <button type="button" className="button secondary" aria-pressed={enabled} onClick={() => setEnabled((value) => !value)}>Loyalty shops · Sepolia test</button>
    {enabled && <>
      {!result && !error && <p role="status">Reading owner-published merchant evidence…</p>}
      {error && <p role="alert">{error}</p>}
      {result?.state === 'needs_hosting' && <p>Needs hosting: a Stadtstack-hosted loyalty service is not configured. No verified shop pins or handoff links are available.</p>}
      {result?.state === 'no_verified_shops' && <p>No verified shops for this city. Hosting configuration is not merchant evidence; no shop pins or handoff links are shown.</p>}
      {merchants.length > 0 && <>
        <p>Owner-reviewed merchant registry · Sepolia test, not real customer rewards. Separate Safe/passkey account; Ledger sign-in and holdings do not transfer. Merchant enrollment and exchange approval happen in the loyalty service.</p>
        {(!mapReady || markerError) && <p>Shop locations are available in the list; map pins are currently unavailable.</p>}
        <ul>{merchants.map((merchant) => <li key={merchant.id}>
          <button type="button" aria-pressed={selectedId === merchant.id} onClick={() => {
            setSelectedId(merchant.id);
            if (mapReady) mapRef.current?.easeTo({ center: merchant.coordinates, zoom: 16 });
          }}>{merchant.name} · {merchant.program.name}</button>
        </li>)}</ul>
        {selected && <article aria-label={`${selected.name} loyalty details`}>
          <h3>{selected.name}</h3>
          <p>{selected.program.name} · program {selected.program.id} · Sepolia test</p>
          <p>Location: {selected.coordinates[1]}, {selected.coordinates[0]} · checked {selected.checkedAt}</p>
          <p><a href={selected.source} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Merchant, location and program source</a></p>
          <p>These links open the separate loyalty service. Select this program there; no membership, collection or exchange is performed by opening a link. Passkeys are origin-bound; an old-origin backup does not automatically migrate.</p>
          {result?.links && <nav aria-label="Loyalty service handoff">
            <a href={result.links.signup} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Sign up / membership card</a>{' · '}
            <a href={result.links.collect} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Collect a reward</a>{' · '}
            <a href={result.links.exchange} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Exchange points</a>
          </nav>}
        </article>}
      </>}
    </>}
  </section>;
}
