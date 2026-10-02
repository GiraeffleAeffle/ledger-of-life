'use client';
import { useEffect, useRef, useState } from 'react';
import type { GeoJSONSource, Map as LibreMap } from 'maplibre-gl';
import type { TestCityInvestment } from '../data/local-investments';
import { projectMapModel, type ProjectSystems } from './project-map-model';
import './project-map.css';

/** The fictional model is separate from OSM data and updates without replacing the map. */
export function ProjectMap({ project, systems }: { project: TestCityInvestment; systems: ProjectSystems }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const latest = useRef({ project, systems });
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { latest.current = { project, systems }; });
  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    import('maplibre-gl').then((libre) => {
      if (disposed || !container.current) return;
      libre.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
      const { project: initial } = latest.current;
      const instance = new libre.Map({ container: container.current, style: '/api/map/styles/liberty',
        center: [...initial.location.coordinates], zoom: 17, pitch: 58, bearing: -20,
        attributionControl: false, cooperativeGestures: true });
      map.current = instance;
      instance.addControl(new libre.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');
      instance.on('style.load', () => {
        if (instance.getLayer('building-3d')) {
          instance.setPaintProperty('building-3d', 'fill-extrusion-color', '#b6b9b2');
          instance.setLayoutProperty('building-3d', 'visibility', 'visible');
          instance.setFilter('building-3d', ['!=', ['get', 'hide_3d'], true]);
        }
        const current = latest.current;
        instance.addSource('fictional-project', { type: 'geojson', data: projectMapModel(current.project, current.systems) });
        instance.addLayer({ id: 'fictional-project-model', type: 'fill-extrusion', source: 'fictional-project',
          paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-opacity': 1 } });
      });
      const label = document.createElement('span');
      label.className = 'project-map-label';
      label.textContent = initial.kind === 'housing' ? 'Fictional tHOME house · illustrative' : 'Fictional tWORK workshop · illustrative';
      new libre.Marker({ element: label, anchor: 'bottom', offset: [0, -38] }).setLngLat([...initial.location.coordinates]).addTo(instance);
      instance.on('error', (event) => { if (!disposed) setError(`Some map details could not load: ${event.error.message}`); });
      const observer = new ResizeObserver(() => instance.resize());
      observer.observe(container.current);
      instance.once('remove', () => observer.disconnect());
    }).catch(() => { if (!disposed) setError('Map unavailable. The model description is below.'); });
    return () => { disposed = true; map.current?.remove(); map.current = null; };
  }, [visible]);
  useEffect(() => {
    const source = map.current?.getSource('fictional-project') as GeoJSONSource | undefined;
    source?.setData(projectMapModel(project, systems));
  }, [project, systems]);
  const shown = [systems.solar && 'rooftop solar panels', systems.heat && 'heat-pump box', systems.validator && 'validator equipment', systems.gpu && 'GPU equipment'].filter(Boolean);
  return <section className="project-map-wrap" aria-label={`${project.symbol} illustrative 3D building`}>
    <header><div><span className="eyebrow">ILLUSTRATIVE CITY PLACEMENT</span><h3>See the fictional {project.kind === 'housing' ? 'house' : 'workshop'} in 3D.</h3></div>
      <button type="button" className="text-button" onClick={() => {
        const view = { center: [...project.location.coordinates] as [number, number], zoom: 17, pitch: 58, bearing: -20 };
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) map.current?.jumpTo(view);
        else map.current?.easeTo({ ...view, duration: 500 });
      }}>Reset view</button></header>
    <div ref={container} className="project-map" role="region" aria-label={`OpenStreetMap context with fictional ${project.symbol} model`} />
    <p className="small-copy">Fictional building at an illustrative spot in Strausberg, not a real property, plan or offer. Surrounding buildings are from OpenStreetMap; heights may be estimated.</p>
    <p className="small-copy project-model-description"><strong>Model:</strong> {project.model.storeys} {project.model.storeys === 1 ? 'tall storey' : 'storeys'} · {project.model.footprintMetres[0]} × {project.model.footprintMetres[1]} m footprint · {project.model.storeys * project.model.storeyHeightMetres} m high. Systems shown: {shown.length ? shown.join(', ') : 'none'}{systems.validator || systems.gpu ? ' (shared equipment annex)' : ''}. These switches are illustrative only; fictional test units have no value, no rights.</p>
    <p className="small-copy">Map tiles by <a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a></p>
    {error && <p className="note" role="status">{error}</p>}
  </section>;
}
