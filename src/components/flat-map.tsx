'use client';
import { useEffect, useRef, useState } from 'react';
import type { Map as LibreMap, Marker } from 'maplibre-gl';
import { roundedLocation, type HomeLocation } from '../domain/home-location';
import './move-in.css';

/** Same map engine, worker and OSM tile source as Places; no address lookup or geolocation. */
export function FlatMap({ location, onChange }: { location?: HomeLocation; onChange?: (location: HomeLocation) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const latest = useRef({ location, onChange });
  const [error, setError] = useState('');
  useEffect(() => { latest.current = { location, onChange }; });
  useEffect(() => {
    let disposed = false;
    import('maplibre-gl').then((libre) => {
      if (disposed || !container.current) return;
      libre.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
      const pin = latest.current.location;
      const instance = new libre.Map({ container: container.current, style: '/api/map/styles/liberty',
        center: pin ? [pin.lon, pin.lat] : [13.883, 52.581], zoom: pin ? 14 : 12, attributionControl: false, cooperativeGestures: true });
      map.current = instance;
      instance.addControl(new libre.NavigationControl({ showCompass: false }), 'top-right');
      instance.addControl(new libre.AttributionControl({ compact: false }), 'bottom-right');
      const place = (point: HomeLocation) => {
        const rounded = roundedLocation(point)!;
        if (!marker.current) {
          marker.current = new libre.Marker({ color: '#15263b', draggable: Boolean(latest.current.onChange) }).setLngLat([rounded.lon, rounded.lat]).addTo(instance);
          marker.current.on('dragend', () => {
            const position = marker.current!.getLngLat();
            place({ lat: position.lat, lon: position.lng });
          });
        } else marker.current.setLngLat([rounded.lon, rounded.lat]);
        latest.current.onChange?.(rounded);
      };
      if (pin) place(pin);
      instance.on('click', (event) => { if (latest.current.onChange) place({ lat: event.lngLat.lat, lon: event.lngLat.lng }); });
      instance.on('error', (event) => { if (!disposed) setError(`Some map details could not load: ${event.error.message}`); });
      const observer = new ResizeObserver(() => instance.resize());
      observer.observe(container.current);
      instance.once('remove', () => observer.disconnect());
    }).catch(() => { if (!disposed) setError('Map unavailable.'); });
    return () => { disposed = true; map.current?.remove(); map.current = null; marker.current = null; };
  }, []);
  useEffect(() => {
    if (location && marker.current) marker.current.setLngLat([location.lon, location.lat]);
  }, [location]);
  return <div className="flat-map-wrap">
    <div ref={container} className="flat-map" role="region" aria-label={onChange ? 'Place the flat on the OpenStreetMap map' : 'Approximate flat location on OpenStreetMap'} />
    {onChange && <p className="small-copy">Click the map or drag the pin. Only a roughly 100 m grid location is published, not an exact address. Pan and zoom to your area; no address search is sent.</p>}
    {location && <p className="small-copy mono">Approximate pin: {location.lat.toFixed(3)}, {location.lon.toFixed(3)}</p>}
    {error && <p className="note" role="status">{error}</p>}
  </div>;
}
