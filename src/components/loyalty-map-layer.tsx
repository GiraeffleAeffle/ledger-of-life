'use client';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { Map as LibreMap, Marker } from 'maplibre-gl';
import { isCivicCity } from '@/data/civic-cities';
import { fetchLoyaltyPlaces, LOYALTY_ORIGIN, LOYALTY_TEST_LABEL, loyaltyEntryLabel, loyaltyMapMerchants, loyaltyRealShopCount, type LoyaltyPlaces } from '@/data/loyalty-places';

/** Companion layer: no changes to holdings, personal pins, council or project sources. */
export function LoyaltyMapLayer({ cityId, mapRef, mapReady }: {
  cityId: string; mapRef: RefObject<LibreMap | null>; mapReady: boolean;
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
    const controller = new AbortController();
    fetchLoyaltyPlaces(cityId, controller.signal).then((next) => {
      if (current) { setResult(next); setError(''); }
    }).catch(() => { if (current) { setResult(null); setError('Shops could not be loaded right now. No pins are shown.'); } });
    return () => { current = false; controller.abort(); };
  }, [cityId, enabled, supported]);
  const merchants = useMemo(() => loyaltyMapMerchants(result, cityId, enabled), [result, cityId, enabled]);
  const realShopCount = loyaltyRealShopCount(merchants);
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
        button.textContent = merchant.test ? 'T' : 'L';
        button.setAttribute('aria-label', `${loyaltyEntryLabel(merchant)} · loyalty · Sepolia test`);
        button.title = `${loyaltyEntryLabel(merchant)} · Sepolia test loyalty`;
        button.className = `loyalty-map-marker${merchant.test ? ' loyalty-map-marker-test' : ''}`;
        button.addEventListener('click', (event) => { event.stopPropagation(); setSelectedId(merchant.id); });
        markers.push(new Marker({ element: button }).setLngLat(merchant.coordinates).addTo(instance));
      }
      setMarkerError(false);
    }).catch(() => { if (!disposed) setMarkerError(true); });
    return () => { disposed = true; markers.forEach((marker) => marker.remove()); };
  }, [mapRef, mapReady, merchants]);
  if (!supported) return null;
  return <section className="personal-map-options loyalty-shop-layer" aria-label="Loyalty shop map layer">
    <button type="button" className="button secondary" aria-pressed={enabled} onClick={() => {
      setResult(null); setError(''); setSelectedId(null); setEnabled((value) => !value);
    }}>Loyalty shops · Sepolia test</button>
    {enabled && <>
      {!result && !error && <p role="status">Reading owner-published merchant evidence…</p>}
      {error && <p role="alert">{error}</p>}
      {result && realShopCount === 0 && <p>{merchants.length ? 'No real shops yet: be the first.' : 'No shops yet: be the first.'} <a href={LOYALTY_ORIGIN} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open ZK Loyalty for your shop</a></p>}
      <p>Public shop feed from ZK Loyalty · Sepolia test. Loading it shares your IP address with that service, not your Ledger account, city choice or wallet.</p>
      {merchants.length > 0 && <>
        <p>Owner-published entries · Sepolia test, not real customer rewards. Test entries are not real businesses and do not count as participation. Separate Safe/passkey account; Ledger sign-in and holdings do not transfer. Merchant enrollment and exchange approval happen in the loyalty service.</p>
        {(!mapReady || markerError) && <p>Shop locations are available in the list; map pins are currently unavailable.</p>}
        <ul>{merchants.map((merchant) => <li key={merchant.id} className={merchant.test ? 'loyalty-test-entry' : undefined}>
          <button type="button" aria-pressed={selectedId === merchant.id} onClick={() => {
            setSelectedId(merchant.id);
            if (mapReady) mapRef.current?.easeTo({ center: merchant.coordinates, zoom: 16 });
          }}>{loyaltyEntryLabel(merchant)} · {merchant.program.name} · Sepolia test</button>
        </li>)}</ul>
        {selected && <article aria-label={`${selected.name} loyalty details`}>
          <h3>{selected.name}</h3>
          {selected.test && <p className="loyalty-test-label">{LOYALTY_TEST_LABEL}. Operator test record, not evidence of real business participation.</p>}
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
