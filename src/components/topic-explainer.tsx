'use client';

import { useEffect, useId, useState } from 'react';
import { EXPLAINER_CAPTIONS, EXPLAINER_SOURCES, SOLAR_REFERENCE } from '../data/topic-explainer';
import { nextExplainerCaption, solarScenario } from './topic-explainer-model';
import './topic-explainer.css';

const whole = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

export function TopicExplainer() {
  const id = useId();
  const [mode, setMode] = useState<'film' | 'calculator'>('film');
  const [captionIndex, setCaptionIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [quietMotion, setQuietMotion] = useState(false);
  const [capacity, setCapacity] = useState<number>(SOLAR_REFERENCE.initialMwp);
  const [offer, setOffer] = useState(false);
  const reducedMotion = systemReducedMotion || quietMotion;
  const caption = EXPLAINER_CAPTIONS[captionIndex]!;
  const lastCaption = captionIndex === EXPLAINER_CAPTIONS.length - 1;
  const scenario = solarScenario(capacity, offer);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setSystemReducedMotion(query.matches); if (query.matches) setPlaying(false); };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!playing || reducedMotion) return;
    const timer = window.setTimeout(() => {
      if (lastCaption) setPlaying(false);
      else setCaptionIndex(nextExplainerCaption(captionIndex));
    }, SOLAR_REFERENCE.captionMilliseconds);
    return () => window.clearTimeout(timer);
  }, [playing, reducedMotion, captionIndex, lastCaption]);

  return <section className="b70-explainer" aria-labelledby={`${id}-heading`}>
    <header><p className="b70-explainer-eyebrow">Solar in 18 Sekunden</p><h2 id={`${id}-heading`}>Was könnte das bringen?</h2></header>
    <div className="b70-explainer-modes" role="group" aria-label="Erklärstück oder Beispielrechnung"><button type="button" aria-pressed={mode === 'film'} onClick={() => { setMode('film'); setPlaying(false); }}>Kurzfilm</button><button type="button" aria-pressed={mode === 'calculator'} onClick={() => { setMode('calculator'); setPlaying(false); }}>Selbst rechnen</button></div>
    <div hidden={mode !== 'film'} className={`b70-explainer-film${playing && !reducedMotion ? ' is-playing' : ''}${reducedMotion ? ' is-reduced' : ''}`}>
      <div className={`b70-explainer-scene scene-${caption.scene}`} aria-hidden="true">
        <svg viewBox="0 0 320 115" focusable="false">
          <g className="b70-explainer-sun"><circle cx="53" cy="28" r="16" /><path d="M53 3v-3m0 56v-5M28 28h-6m62 0h-6M35 10l-4-4m44 44-4-4M35 46l-4 4m44-44-4 4" /></g>
          <path className="b70-explainer-wire" d="M81 80h60q12 0 12-12V45h37q12 0 12 12v23h37" />
          <g className="b70-explainer-panels"><path d="m25 62 63 0 18 35H12zM46 62l-4 35m24-35 9 35M19 80h78" /><path d="M36 98v10m46-10v10" /></g>
          <g className="b70-explainer-homes"><path d="m132 85 23-20 23 20v24h-46zM150 109V92h11v17" /><path d="m192 52 35-25 35 25v57h-70zM202 58h50m-43 9v31m18-31v31m18-31v31M186 109h83" /><circle cx="227" cy="45" r="5" /></g>
          <circle className="b70-explainer-current" cx="110" cy="80" r="5" />
        </svg>
      </div>
      <div className="b70-explainer-caption" role="status" aria-live="polite" aria-atomic="true"><small>{captionIndex + 1} / {EXPLAINER_CAPTIONS.length}</small><h3>{caption.title}</h3><p>{caption.text}</p></div>
      <div className="b70-explainer-controls">
        <button type="button" disabled={reducedMotion} aria-pressed={playing} onClick={() => { if (lastCaption && !playing) setCaptionIndex(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Abspielen'}</button>
        <button type="button" disabled={lastCaption} onClick={() => { setPlaying(false); setCaptionIndex(nextExplainerCaption(captionIndex)); }}>Weiter</button>
        <button type="button" onClick={() => { setCaptionIndex(0); setPlaying(!reducedMotion); }}>Von vorn</button>
      </div>
      <label className="b70-explainer-check"><input type="checkbox" checked={reducedMotion} disabled={systemReducedMotion} onChange={(event) => { setQuietMotion(event.target.checked); setPlaying(false); }} />Ohne Animation{systemReducedMotion ? ' · Systemeinstellung' : ''}</label>
    </div>
    <div hidden={mode !== 'calculator'} className="b70-explainer-calculator">
      <p className="b70-explainer-scenario">Beispielrechnung, keine B70-Prognose</p>
      <label className="b70-explainer-range-label" htmlFor={`${id}-capacity`}>Angenommene Leistung <strong>{capacity} MWp</strong></label>
      <input id={`${id}-capacity`} type="range" min={SOLAR_REFERENCE.minimumMwp} max={SOLAR_REFERENCE.maximumMwp} step="1" value={capacity} aria-describedby={`${id}-unknown`} aria-valuetext={`${capacity} Megawattpeak, angenommene Leistung`} onChange={(event) => setCapacity(Number(event.target.value))} />
      <p className="b70-explainer-note" id={`${id}-unknown`}>Die tatsächliche Leistung von B70 ist hier unbekannt.</p>
      <label className="b70-explainer-check"><input type="checkbox" checked={offer} onChange={(event) => setOffer(event.target.checked)} />Angenommen: Betreiber bietet freiwillig 0,2 ct/kWh</label>
      <div className="b70-explainer-results" role="status" aria-live="polite" aria-atomic="true">
        <dl><div><dt>Modellstrom / Jahr</dt><dd>{decimal.format(scenario.annualMwh)} <small>MWh</small></dd></div><div><dt>Haushaltsäquivalente</dt><dd>≈ {whole.format(scenario.householdEquivalents)}</dd></div><div><dt>§-6-Bruttozahlung / Jahr</dt><dd>{offer ? 'bis zu ' : ''}{whole.format(scenario.maximumGrossMunicipalEuro)} <small>€</small></dd></div></dl>
      </div>
      <p className="b70-explainer-note">Mengenvergleich, keine Versorgung; Zahlung nur bei Vereinbarung und tatsächlicher Einspeisung – kein Anspruch, kein Nettovorteil.</p>
      <details className="b70-explainer-details"><summary>Rechenweg, Annahmen & Quellen</summary>
        <p>{capacity} MWp × 1.000 = {whole.format(scenario.capacityKwp)} kWp; × 995,63 kWh/kWp = {whole.format(scenario.annualKwh)} kWh/Jahr. Geteilt durch 3.383 kWh ergibt die Haushaltsäquivalente.</p>
        <p>Obergrenzen-Szenario: Die gesamte Modellmenge wird als tatsächlich eingespeist und für § 6 geeignet angenommen; eine einzige Standortgemeinde erhält den vollen angebotenen Satz von 0,002 €/kWh. Eigenverbrauch, Abregelung oder Aufteilung auf mehrere Gemeinden können den Betrag verringern. Ohne Angebot wird nur diese §-6-Zahlung mit 0 € gerechnet, nicht jeder denkbare kommunale Ertrag. Kosten, Steuern und weitere kommunale Effekte werden nicht bilanziert.</p>
        <p>Genossenschaft und Ortstarif wären gesonderte Modelle, hier nicht beschlossen oder belegt; günstigerer Strom folgt aus einem Solarpark nicht automatisch.</p>
        <ul>{Object.entries(EXPLAINER_SOURCES).map(([key, source]) => <li key={key}><a href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a><p>{source.detail}</p></li>)}</ul>
        <p>Offizielle Quellen abgerufen am 16. November 2026; Modellreferenz fest gespeichert, keine Live-Ertragsdaten.</p>
      </details>
    </div>
    <details hidden={mode !== 'film'} className="b70-explainer-details"><summary>Alle vier Sätze lesen</summary><ol>{EXPLAINER_CAPTIONS.map((entry) => <li key={entry.scene}><strong>{entry.title}</strong> {entry.text}</li>)}</ol></details>
  </section>;
}
