'use client';

import { useId, useState } from 'react';
import osmCapture from '../../public/topic-b70/osm-surroundings.json';
import { PLACE_COMPENSATION, PLACE_DOCUMENT, PLACE_GEOMETRY_NOTICE, PLACE_LANDMARKS, PLACE_MAP_ASSET, PLACE_ORIENTATION_OUTLINE, PLACE_ORIENTATION_POINTS, type PlaceLandmarkId } from '../data/topic-place';
import { buildingWalls, isPlaceArea, orderPlaceFeatures, placePath, projectPlace, selectPlaceLandmark, togglePlaceView, type PlaceFeature, type PlaceView } from './topic-place-model';
import './topic-place.css';

const FEATURES = orderPlaceFeatures(osmCapture.features as unknown as PlaceFeature[]);
const GEOMETRY = Object.fromEntries((['raised', 'flat'] as const).map((view) => [view, FEATURES.map((feature) => ({
  ...feature,
  path: placePath(feature.coordinates, view, isPlaceArea(feature.kind), feature.kind === 'building' && view === 'raised' ? 4 : 0),
  walls: feature.kind === 'building' ? buildingWalls(feature.coordinates, view) : '',
  boundary: feature.muessenBoundary ? placePath(feature.coordinates, view, false) : '',
}))])) as Record<PlaceView, (PlaceFeature & { path: string; walls: string; boundary: string })[]>;

export function TopicPlace() {
  const instanceId = useId();
  const [view, setView] = useState<PlaceView>('raised');
  const [selected, setSelected] = useState<PlaceLandmarkId>('plan');
  const landmark = PLACE_LANDMARKS.find((entry) => entry.id === selected)!;
  const clipId = `${instanceId}-clip`;
  const glowId = `${instanceId}-glow`;
  const forestId = `${instanceId}-forest`;
  const select = (id: string) => setSelected(selectPlaceLandmark(id));

  return <section className="b70-place" aria-labelledby={`${instanceId}-title`}>
    <header className="b70-place-heading">
      <div><span className="b70-place-eyebrow">Vor Ort · Gemeinde Büchen</span><h3 id={`${instanceId}-title`}>Hier ist das Thema zu Hause.</h3></div>
      <button type="button" className="b70-place-view" aria-pressed={view === 'flat'} aria-label={view === 'raised' ? 'Zur flachen Karte mit Norden oben wechseln' : 'Zur räumlichen 2,5D-Ansicht wechseln'} onClick={() => setView(togglePlaceView(view))}>{view === 'raised' ? '↓ Draufsicht' : '↗ 2,5D'}</button>
    </header>
    <div className="b70-place-canvas">
      <svg viewBox="0 0 660 470" className="b70-place-map" role="group" aria-labelledby={`${instanceId}-map-title ${instanceId}-map-description`}>
        <title id={`${instanceId}-map-title`}>Die tatsächliche Umgebung des B-Plans 70 bei Steinkrug</title>
        <desc id={`${instanceId}-map-description`}>Straßen, Gebäude, Felder und Wald aus OpenStreetMap. Ein gestrichelter redaktioneller Orientierungsrahmen und orange Lagepunkte zeigen nur den ungefähren Bereich beidseits der Bahn, keine amtliche Plangrenze. Orte lassen sich auswählen.</desc>
        <defs>
          <clipPath id={clipId}><rect width="660" height="470" rx="20" /></clipPath>
          <radialGradient id={glowId}><stop offset="0" stopColor="#edb047" stopOpacity=".6" /><stop offset=".65" stopColor="#edb047" stopOpacity=".24" /><stop offset="1" stopColor="#edb047" stopOpacity="0" /></radialGradient>
          <pattern id={forestId} width="12" height="12" patternUnits="userSpaceOnUse"><path d="M3 8l2-4 2 4m2 4 2-4 2 4" fill="none" stroke="#436d55" strokeWidth=".7" opacity=".28" /></pattern>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <rect width="660" height="470" fill="#e5ebda" />
          <g aria-hidden="true" className={`b70-place-geography b70-place-${view}`}>
            {GEOMETRY[view].map((feature) => <g key={feature.id}>
              {feature.walls && <path d={feature.walls} className="b70-place-building-wall" />}
              {feature.kind === 'road' && <path d={feature.path} className="b70-place-road-edge" />}
              <path d={feature.path} className={`b70-place-feature b70-place-feature-${feature.kind} b70-place-variation-${feature.id % 3}`} />
              {feature.kind === 'forest' && <path d={feature.path} fill={`url(#${forestId})`} />}
              {feature.kind === 'railway' && <path d={feature.path} className="b70-place-rail-ties" />}
              {feature.boundary && <path d={feature.boundary} className="b70-place-muessen-boundary" />}
            </g>)}
            {PLACE_ORIENTATION_POINTS.map((coordinate, index) => {
              const point = projectPlace(coordinate, view);
              return <ellipse key={index} cx={point.x} cy={point.y} rx="47" ry={view === 'raised' ? 29 : 38} fill={`url(#${glowId})`} />;
            })}
            <path d={placePath(PLACE_ORIENTATION_OUTLINE, view, true)} className="b70-place-approximate-outline"><title>Ungefährer Orientierungsrahmen aus der Dokumentbeschreibung, keine Plangrenze</title></path>
            {([{ label: 'MÜSSEN', coordinate: [10.5625, 53.4965] }, { label: 'NÜSSAU', coordinate: [10.594, 53.4876] }, { label: 'NEUNÜSSAU', coordinate: [10.591, 53.5008] }] as const).map((place) => {
              const point = projectPlace(place.coordinate, view);
              return <text key={place.label} x={point.x} y={point.y} className="b70-place-village" textAnchor="middle">{place.label}</text>;
            })}
          </g>
          {PLACE_LANDMARKS.map((entry, index) => {
            const point = projectPlace(entry.coordinate, view);
            return <g key={entry.id} className={`b70-place-pin${entry.id === selected ? ' b70-place-pin-selected' : ''}${entry.id === 'plan' ? ' b70-place-pin-plan' : ''}`} role="button" tabIndex={0} aria-label={entry.label} aria-pressed={entry.id === selected} onClick={() => select(entry.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(entry.id); } }} transform={`translate(${point.x},${point.y})`}>
              <circle r="22" className="b70-place-pin-target" /><circle r="13" className="b70-place-pin-dot" /><text y="5" textAnchor="middle">{index + 1}</text>
            </g>;
          })}
          <g className="b70-place-north" aria-hidden="true" transform={`translate(612,47) rotate(${view === 'raised' ? -12 : 0})`}><path d="M0-16L-6 4 0 0 6 4Z" /><text y="24" textAnchor="middle">N</text></g>
          {view === 'flat' && <g className="b70-place-scale" aria-hidden="true" transform="translate(27,430)"><path d="M0-4v4h104v-4" /><text x="52" y="20" textAnchor="middle">500 m</text></g>}
        </g>
      </svg>
      <span className="b70-place-map-note">Gestrichelt ≈ Orientierungsrahmen · keine Plangrenze</span>
      <a className="b70-place-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap-Mitwirkende · ODbL</a>
    </div>
    <div className="b70-place-landmarks" aria-label="Orte auf der Karte">{PLACE_LANDMARKS.map((entry, index) => <button type="button" key={entry.id} aria-pressed={selected === entry.id} onClick={() => select(entry.id)}><span>{index + 1}</span>{entry.shortLabel}</button>)}</div>
    <p className="b70-place-sentence" aria-live="polite"><strong>{landmark.label}.</strong> {landmark.sentence}</p>
    <details className="b70-place-details"><summary>Lage, Ausgleich & Kartenquellen</summary>
      <p>{PLACE_GEOMETRY_NOTICE}</p>
      <section><h4>{PLACE_COMPENSATION.label}</h4><p>{PLACE_COMPENSATION.sentence}</p><p>{PLACE_COMPENSATION.reason}</p><small>{PLACE_COMPENSATION.parcelDescription}</small></section>
      <section><h4>Was das Dokument beschreibt</h4><blockquote>{PLACE_DOCUMENT.mainQuote}</blockquote><blockquote>Teilgebiet 2: {PLACE_DOCUMENT.compensationQuote}</blockquote><p>{PLACE_DOCUMENT.decision}</p><a href={PLACE_DOCUMENT.url} target="_blank" rel="noreferrer">{PLACE_DOCUMENT.title} ↗</a><small>{PLACE_DOCUMENT.capture}</small></section>
      <section><h4>Kartengrundlage & Lizenz</h4><p>© OpenStreetMap-Mitwirkende, <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">ODbL 1.0</a>. Datenstand {osmCapture.provenance.dataTimestamp.replace('T', ' ').replace('Z', ' UTC')}; lokal gespeichert, keine Kartenabrufe beim Öffnen.</p><p>OSM-Geometrie für Straßen, Gleise, Gebäude und Flächennutzung; Auswahl nach Objekttyp und Kartenausschnitt, Koordinaten auf sechs Nachkommastellen gerundet. Gemeindegrenze: OSM-Relation 1467719, keine Katasterauskunft. Kartenlücken sind möglich.</p><p>2,5D ist eine illustrative Neigung mit einheitlicher Gebäudehöhe, kein Geländemodell. Orange Lagepunkte sind redaktionell aus der Dokumentbeschreibung abgeleitet; sie bilden weder Flurstücke noch geplante oder gebaute Solarmodule ab.</p><div className="b70-place-source-links"><a href={PLACE_MAP_ASSET} download>Lokale OSM-Daten + Abfrage ↓</a><a href="https://www.openstreetmap.org/relation/1467719" target="_blank" rel="noreferrer">Gemeindegrenze ↗</a>{PLACE_LANDMARKS.filter((entry) => entry.osm).map((entry) => <a key={entry.id} href={`https://www.openstreetmap.org/${entry.osm!.type}/${entry.osm!.id}`} target="_blank" rel="noreferrer">{entry.shortLabel} ↗</a>)}</div></section>
    </details>
  </section>;
}
