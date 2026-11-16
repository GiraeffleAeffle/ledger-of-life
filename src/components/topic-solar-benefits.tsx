import type { ReactNode } from 'react';
import {
  AGRI_PV_PANELS,
  SOLAR_BENEFITS,
  SOLAR_BENEFIT_RESEARCH_DATE,
  SOLAR_BENEFIT_SCOPE,
  SOLAR_BENEFIT_SOURCES,
  type SolarBenefitIcon,
  type SolarBenefitSourceId,
} from '../data/topic-solar-benefits';
import './topic-solar-benefits.css';

const BENEFIT_SOURCE_IDS: readonly SolarBenefitSourceId[] = [
  'climate', 'imports', 'backup', 'value', 'lease', 'profit', 'allocation', 'eeg', 'cooperative',
];
const AGRI_SOURCE_IDS: readonly SolarBenefitSourceId[] = ['agri', 'guide', 'din', 'b70', 'lichtenow'];

function SourceLinks({ sources }: { sources: readonly SolarBenefitSourceId[] }) {
  return <span className="b70-benefits-citations">{sources.map((key) => (
    <a key={key} href={SOLAR_BENEFIT_SOURCES[key].url} target="_blank" rel="noreferrer">
      {SOLAR_BENEFIT_SOURCES[key].label}<span aria-hidden="true"> ↗</span>
    </a>
  ))}</span>;
}

function SourceNotes({ sources }: { sources: readonly SolarBenefitSourceId[] }) {
  return <details className="b70-benefits-sources">
    <summary>Quellen & Einordnung</summary>
    <p>Recherche vom {SOLAR_BENEFIT_RESEARCH_DATE}. Allgemeine Möglichkeiten, keine B70-Prognose. Rechtsquellen: abgerufener Stand; keine individuelle Rechts- oder Anlageberatung. Kommunale Belege stammen ausschließlich aus der vorhandenen lokalen Erfassung.</p>
    <ul>{sources.map((key) => {
      const source = SOLAR_BENEFIT_SOURCES[key];
      return <li key={key}>
        <a href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a>
        <small>{source.publishedAt ? `Quellendatum: ${source.publishedAt} · ` : 'Quellendatum nicht angegeben · '}{source.locator}</small>
        <blockquote>„{source.quote}“</blockquote>
        <p>{source.detail}</p>
      </li>;
    })}</ul>
  </details>;
}

function BenefitIcon({ kind }: { kind: SolarBenefitIcon }) {
  let drawing: ReactNode;
  switch (kind) {
    case 'climate':
      drawing = <><path className="b70-benefits-icon-fill" d="M39 9C20 7 8 17 12 30c4 11 24 11 27-21Z" /><path d="M12 41 31 20M20 31v-9m4 5h9" /><circle className="b70-benefits-icon-sun" cx="9" cy="10" r="4" /></>;
      break;
    case 'imports':
      drawing = <><circle cx="24" cy="24" r="17" /><path d="M7 24h34M24 7c-10 10-10 24 0 34M24 7c10 10 10 24 0 34" /><path className="b70-benefits-icon-paper" d="M7 29h21v14H7z" /><path d="m13 36 4 4 7-8" /></>;
      break;
    case 'backup':
      drawing = <><path className="b70-benefits-icon-fill" d="M12 11h24v32H12z" /><path d="M19 6h10v5M19 20h10M24 15v10" /><path className="b70-benefits-icon-sun" d="m25 28-6 8h5l-1 5 7-9h-6z" /></>;
      break;
    case 'value':
      drawing = <><path className="b70-benefits-icon-fill" d="m7 22 10-8 9 8v20H7zM26 30l15-8v20H26z" /><path d="M12 28h8M12 34h8M31 32h5M31 37h5" /><circle className="b70-benefits-icon-sun" cx="35" cy="10" r="6" /><path d="M35 7v6m-3-3h6" /></>;
      break;
    case 'lease':
      drawing = <><path className="b70-benefits-icon-paper" d="M10 6h21l8 8v28H10z" /><path d="M30 6v9h9M16 22h16M16 28h10M16 34h6" /><circle className="b70-benefits-icon-sun" cx="33" cy="35" r="8" /><path d="m30 35 2 2 4-4" /></>;
      break;
    case 'tax':
      drawing = <><path className="b70-benefits-icon-fill" d="m7 18 17-12 17 12ZM11 21v17m9-17v17m8-17v17m9-17v17M7 42h34" /><circle className="b70-benefits-icon-sun" cx="24" cy="14" r="2" /></>;
      break;
    case 'eeg':
      drawing = <><path className="b70-benefits-icon-paper" d="M8 6h32v36H8z" /><path d="M18 15c7-7 15 3 7 7l-4 2c-8 4 0 14 7 7M17 21c-7 6 4 13 11 6 6-6-3-11-10-6" /><circle className="b70-benefits-icon-sun" cx="38" cy="38" r="6" /></>;
      break;
    case 'cooperative':
      drawing = <><circle className="b70-benefits-icon-fill" cx="24" cy="12" r="6" /><circle cx="9" cy="24" r="5" /><circle cx="39" cy="24" r="5" /><path d="M14 42v-5a10 10 0 0 1 20 0v5M2 41v-3a7 7 0 0 1 8-7M46 41v-3a7 7 0 0 0-8-7" /><path className="b70-benefits-icon-sun" d="m22 33 5-3 1 6-4 3z" /></>;
      break;
  }
  return <svg className="b70-benefits-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">{drawing}</svg>;
}

export function TopicSolarBenefits() {
  return <section className="b70-benefits" aria-label="Allgemeine Möglichkeiten und Grenzen von Solarenergie">
    <header className="b70-benefits-header">
      <div><p className="b70-benefits-eyebrow">Mehr als eine Stromrechnung</p><h2>Was Solar noch bringen kann</h2></div>
      <p className="b70-benefits-scope">{SOLAR_BENEFIT_SCOPE}</p>
    </header>
    <p className="b70-benefits-intro">Nicht alle profitieren auf dieselbe Weise. Diese Wege sind voneinander zu trennen.</p>
    <div className="b70-benefits-grid">
      {SOLAR_BENEFITS.map((benefit) => <article key={benefit.icon} className={`b70-benefits-card b70-benefits-card-${benefit.icon}`}>
        <div className="b70-benefits-card-heading"><BenefitIcon kind={benefit.icon} /><div><p>{benefit.audience}</p><h3>{benefit.title}</h3></div></div>
        <p className="b70-benefits-claim">{benefit.claim}</p>
        <p className="b70-benefits-limit"><strong>Wichtig:</strong> {benefit.limit}</p>
        <footer><span className="b70-benefits-card-scope">{SOLAR_BENEFIT_SCOPE}</span><SourceLinks sources={benefit.sources} /></footer>
      </article>)}
    </div>
    <p className="b70-benefits-boundary"><strong>B70 bleibt offen:</strong> Tatsächliche Leistung, Stromertrag und Kosten sind hier unbekannt. Keine CO₂-Bilanz, kein örtliches Liefermodell und keine Einnahmenzusage für dieses Vorhaben abgeleitet.</p>
    <SourceNotes sources={BENEFIT_SOURCE_IDS} />
  </section>;
}

function Crops({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`} className="b70-agri-crop"><path d="M0 0v-22m0 9c-7 0-10-5-10-9 6 0 10 5 10 9Zm0-7c7 0 10-5 10-9-6 0-10 5-10 9Z" /><path d="M-3 1h6" /></g>;
}

function SolarLandIllustration({ kind }: { kind: typeof AGRI_PV_PANELS[number]['kind'] }) {
  return <svg className={`b70-agri-art b70-agri-art-${kind}`} viewBox="0 0 320 160" aria-hidden="true" focusable="false">
    <path className="b70-agri-sky" d="M0 0h320v160H0z" />
    <circle className="b70-agri-sun" cx="279" cy="29" r="15" />
    <path className="b70-agri-hill" d="M0 97q65-39 128-8t192-8v79H0Z" />
    <path className="b70-agri-field" d="M0 118q160-25 320-4v46H0Z" />
    {kind === 'classic' ? <>
      <g className="b70-agri-structure"><path d="M38 88v35m91-35v28m38-23v25m91-25v24" /></g>
      <g className="b70-agri-panel"><path d="m30 65 86-7 22 40-105 9ZM162 70l86-6 24 39-106 9Z" /><path d="m58 63 4 41m25-43 13 40M32 86l94-8m64-10 8 41m23-43 13 41m-69-16 93-8" /></g>
      <g className="b70-agri-sheep"><path d="M112 133v10m18-10v10" /><path d="M105 128c-4-12 9-15 12-11 8-8 18-1 16 7 8 10-1 17-10 12-10 6-18 0-18-8Z" /><path d="m134 123 9-2 3 5-5 8-8-4Z" /><circle cx="141" cy="125" r="1" /></g>
      <path className="b70-agri-grass" d="m31 142 3-9 4 9m18-7 3-8 4 9m137 5 3-9 4 9m30-4 3-9 4 9" />
    </> : kind === 'raised' ? <>
      <path className="b70-agri-furrow" d="m0 154 320-17M0 141l320-16" />
      {[37, 68, 99, 208, 239, 270].map((x) => <Crops key={x} x={x} y={140} />)}
      <g className="b70-agri-structure"><path d="M38 47v87m114-87v80m20-80v80m113-80v87M38 73h114m20 0h113" /></g>
      <g className="b70-agri-panel"><path d="m29 37 104-8 28 30-126 10ZM165 37l104-8 28 30-126 10Z" /><path d="m63 35 10 31m25-34 18 31M33 52l114-9m51-8 10 31m25-34 18 31m-83-11 114-9" /></g>
      <g className="b70-agri-tractor"><path d="M115 113h21V88h22l9 25h15v17h-67Z" /><path d="M141 93h13l5 19h-18Z" /><circle cx="133" cy="130" r="12" /><circle cx="174" cy="132" r="8" /><path d="M166 109v-9" /></g>
    </> : <>
      <path className="b70-agri-furrow" d="m0 150 320-34M0 133l320-34" />
      {[32, 57, 132, 157, 232, 257].map((x) => <Crops key={x} x={x} y={x % 2 ? 140 : 123} />)}
      {[78, 178, 278].map((x) => <g key={x}>
        <path className="b70-agri-structure" d={`M${x} 64v81m24-85v80`} />
        <path className="b70-agri-panel" d={`m${x - 5} 53 34-15v78l-34 14Zm0 26 34-15m-34 41 34-15m-17-44v78`} />
      </g>)}
    </>}
  </svg>;
}

export function TopicAgriPv() {
  return <section className="b70-benefits b70-agri" aria-label="Agri-Photovoltaik und klassische Freiflächen-Photovoltaik im Vergleich">
    <header className="b70-benefits-header">
      <div><p className="b70-benefits-eyebrow">Eine Fläche, zwei Nutzungen?</p><h2>Solarpark ist nicht gleich Agri-PV</h2></div>
      <p className="b70-benefits-scope">{SOLAR_BENEFIT_SCOPE}</p>
    </header>
    <p className="b70-benefits-intro">Agri-PV verbindet Landwirtschaft und Solarstrom auf derselben Fläche. So können unterschiedliche Anordnungen aussehen. <SourceLinks sources={['agri']} /></p>
    <div className="b70-agri-grid">
      {AGRI_PV_PANELS.map((panel) => <article key={panel.kind} className={`b70-agri-card b70-agri-card-${panel.kind}`}>
        <SolarLandIllustration kind={panel.kind} />
        <div className="b70-agri-card-body"><p className="b70-agri-label">{panel.label}</p><h3>{panel.title}</h3><p className="b70-benefits-claim">{panel.claim}</p><p className="b70-benefits-limit"><strong>Wichtig:</strong> {panel.limit}</p><SourceLinks sources={panel.sources} /></div>
      </article>)}
    </div>
    <div className="b70-agri-proof"><span className="b70-agri-proof-mark" aria-hidden="true">≠</span><div><h3>Grünpflege ≠ Nachweis der Doppelnutzung</h3><p>Für Agri-PV nach DIN SPEC 91434 zählen landwirtschaftliche Hauptnutzung, Nutzungskonzept und prüfbare Kriterien – nicht allein das Bild von Schafen oder Grün zwischen Modulen. Landwirtschaftliche Tierhaltung kann Teil eines Agri-PV-Konzepts sein.</p><SourceLinks sources={['din', 'guide']} /></div></div>
    <div className="b70-agri-case-boundaries">
      <p><strong>Büchen B70</strong><span>Hier nicht als Agri-PV belegt. Die Bilder zeigen keine B70-Planung.</span><SourceLinks sources={['b70']} /></p>
      <p><strong>Lichtenow</strong><span>„Agri-Photovoltaik“ steht im Planungstitel. Kein Bau-, Betriebs- oder Erfolgsnachweis.</span><SourceLinks sources={['lichtenow']} /></p>
    </div>
    <p className="b70-agri-art-note">Eigene schematische Illustrationen · keine Standortansichten, Größen- oder Ertragsvergleiche.</p>
    <SourceNotes sources={AGRI_SOURCE_IDS} />
  </section>;
}
