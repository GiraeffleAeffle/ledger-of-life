'use client';
import { useEffect, useRef, useState } from 'react';
import type { Map as LibreMap, Marker } from 'maplibre-gl';
import { roundedLocation, type HomeLocation } from '../domain/home-location';
import './move-in.css';

/** Same map engine, worker and OSM tile source as Places; no address lookup or geolocation. */
export function FlatMap({ location, center, onChange, variant = 'default' }: { location?: HomeLocation; center?: readonly [number, number]; onChange?: (location: HomeLocation) => void; variant?: 'default' | 'hero' }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const latest = useRef({ location, center, onChange });
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const centerLon = center?.[0];
  const centerLat = center?.[1];
  useEffect(() => { latest.current = { location, center, onChange }; });
  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    import('maplibre-gl').then((libre) => {
      if (disposed || !container.current) return;
      libre.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
      const pin = latest.current.location;
      const cityCenter = latest.current.center;
      const instance = new libre.Map({ container: container.current, style: '/api/map/styles/liberty',
        center: pin ? [pin.lon, pin.lat] : cityCenter ? [cityCenter[0], cityCenter[1]] : undefined,
        zoom: pin ? 14 : cityCenter ? 12 : 2, attributionControl: false, cooperativeGestures: true });
      map.current = instance;
      instance.addControl(new libre.NavigationControl({ showCompass: false }), 'top-right');
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
  }, [visible]);
  useEffect(() => {
    if (location && marker.current) marker.current.setLngLat([location.lon, location.lat]);
  }, [location]);
  useEffect(() => {
    if (!location && centerLon !== undefined && centerLat !== undefined && map.current)
      map.current.jumpTo({ center: [centerLon, centerLat], zoom: 12 });
  }, [location, centerLon, centerLat]);
  return <div className={`flat-map-wrap${variant === 'hero' ? ' flat-map-wrap--hero' : ''}`}>
    <div ref={container} className="flat-map" role="region" aria-label={onChange ? 'Place the flat on the OpenStreetMap map' : 'Approximate flat location on OpenStreetMap'} />
    <p className="flat-map-credit">Map tiles by <a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a></p>
    {onChange && <p className="small-copy">Click the map or drag the pin. Only a roughly 100 m grid location is published, not an exact address. Pan and zoom to your area; no address search is sent.</p>}
    {location && onChange && <p className="small-copy mono">Approximate pin: {location.lat.toFixed(3)}, {location.lon.toFixed(3)}</p>}
    {error && <p className="note" role="status">{error}</p>}
  </div>;
}
