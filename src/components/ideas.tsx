'use client';
import { useEffect, useRef, useState } from 'react';
import { AREAS, IDEA_NAVIGATION_INTENT, goToSection, openLocalInvestment, openCivicMap, openLedgerAdapter, openShareWorkflow, type Area } from './areas';
import { AVAILABILITY_LABELS, IDEAS, LEDGER_ADAPTERS, STATUS_LABEL } from '@/data/ledger-catalogue';
import { RealityChips } from './reality-chip';
import './capability-map.css';
import './thread-public.css';

/** Availability is distinct from build maturity and the current health of a service. */
export function IdeasArea({ go, showDepositOptions = false }: { go: (area: Area) => void; showDepositOptions?: boolean }) {
  const [selectedId, setSelectedId] = useState(IDEAS[0].id);
  const detailRef = useRef<HTMLElement>(null);
  const reveal = useRef(false);
  function select(id: string) { reveal.current = true; setSelectedId(id); }
  useEffect(() => {
    function consume() {
      const id = sessionStorage.getItem(IDEA_NAVIGATION_INTENT);
      if (!id) return;
      sessionStorage.removeItem(IDEA_NAVIGATION_INTENT);
      if (IDEAS.some((idea) => idea.id === id)) queueMicrotask(() => { reveal.current = true; setSelectedId(id); });
    }
    window.addEventListener(IDEA_NAVIGATION_INTENT, consume);
    consume();
    return () => window.removeEventListener(IDEA_NAVIGATION_INTENT, consume);
  }, []);
  useEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    if (window.matchMedia('(max-width: 700px)').matches) {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
    }
  }, [selectedId]);
  const selected = IDEAS.find((idea) => idea.id === selectedId) ?? IDEAS[0];
  const adapters = LEDGER_ADAPTERS.filter((item) => item.capabilities.includes(selected.id));
  const destination = selected.destination;
  function openCapability() {
    if (selected.id === 'local-investments') openLocalInvestment(go, 'demo-neighbourhood-homes');
    else if (selected.id === 'scales') openCivicMap(go);
    else if (selected.id === 'borrow-against-shares') openShareWorkflow(go, 'borrow');
    else if (destination?.section === 'deposit-options' && !showDepositOptions) go(destination.area);
    else if (destination?.section) goToSection(go, destination.area, destination.section);
    else if (destination) go(destination.area);
  }
  return <div className="ideas-area capability-area">
    <section className="card ideas-catalogue" aria-label="Capabilities by availability">
      <p>Available here means there is a working area, not that every deployment or service is online. Check its current status before acting.</p>
      {AVAILABILITY_LABELS.map((availability) => <section className="ideas-group" key={availability} aria-label={availability}>
        <h2>{availability}</h2>
        {IDEAS.filter((idea) => idea.availability === availability).map((idea) => <div className={`ideas-row${selected.id === idea.id ? ' selected' : ''}`} key={idea.id}>
          <button className="ideas-choice" type="button" aria-pressed={selected.id === idea.id} aria-controls={selected.id === idea.id ? 'selected-capability' : undefined} onClick={() => select(idea.id)}>
            <strong>{idea.title}</strong><span className={`idea-status ${idea.status.replace(' ', '-')}`}>{STATUS_LABEL[idea.status]}</span>
          </button>
          {selected.id === idea.id && <article ref={detailRef} className="capability-detail" id="selected-capability" tabIndex={-1} aria-live="polite" aria-label="Selected capability">
            <h3>{selected.title}</h3><p><strong>{selected.availability}</strong> · {STATUS_LABEL[selected.status]}</p>
            <RealityChips levels={selected.availability === 'Planned' ? ['roadmap'] : selected.availability === 'Needs a local setup' ? ['prototype'] : [...new Set(adapters.map((adapter) => adapter.explain.reality))]} />
            <p>{selected.enables}</p><p>{selected.how}</p>
            {showDepositOptions && ['rental-deposit', 'stock-deposit', 'rental-earnings'].includes(selected.id) && <button type="button" className="text-button" onClick={() => goToSection(go, 'home', 'deposit-options')}>Ways to hold the deposit → Home</button>}
            {selected.needs && <p><strong>What remains:</strong> {selected.needs}</p>}
            <div className="capability-links">
              {destination && selected.availability !== 'Planned' && selected.availability !== 'Needs a local setup' && <button type="button" className="secondary-button" onClick={openCapability}>{`Open ${AREAS.find((area) => area.id === destination.area)?.label}`}</button>}
              {adapters[0] && <button type="button" className="text-button" onClick={() => openLedgerAdapter(go, adapters[0].id)}>Connection and data permissions</button>}
            </div>
          </article>}
        </div>)}
      </section>)}
    </section>
  </div>;
}
