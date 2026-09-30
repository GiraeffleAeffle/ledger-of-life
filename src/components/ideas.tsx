'use client';
import { useEffect, useState } from 'react';
import { AREAS, IDEA_NAVIGATION_INTENT, goToSection, openLocalInvestment, openCivicMap, openLedgerAdapter, openShareWorkflow, type Area } from './areas';
import { IDEAS, LEDGER_ADAPTERS, LEDGER_TOPICS, STATUS_LABEL } from '@/data/ledger-catalogue';
import './capability-map.css';


/** A capability belongs to the same person → place → output → outcome journey. */
export function IdeasArea({ go }: { go: (area: Area) => void }) {
  const [selectedId, setSelectedId] = useState(IDEAS[0].id);
  useEffect(() => {
    function consume() {
      const id = sessionStorage.getItem(IDEA_NAVIGATION_INTENT);
      if (!id) return;
      sessionStorage.removeItem(IDEA_NAVIGATION_INTENT);
      if (IDEAS.some((idea) => idea.id === id)) queueMicrotask(() => setSelectedId(id));
    }
    window.addEventListener(IDEA_NAVIGATION_INTENT, consume);
    consume();
    return () => window.removeEventListener(IDEA_NAVIGATION_INTENT, consume);
  }, []);
  const selected = IDEAS.find((idea) => idea.id === selectedId) ?? IDEAS[0];
  const adapters = LEDGER_ADAPTERS.filter((item) => item.capabilities.includes(selected.id));
  const destination = selected.destination;
  function openCapability() {
    if (selected.id === 'local-investments' || selected.id === 'home-tokens') openLocalInvestment(go, 'demo-neighbourhood-homes');
    else if (selected.id === 'scales') openCivicMap(go);
    else if (selected.id === 'borrow-against-shares') openShareWorkflow(go, 'borrow');
    else if (selected.id === 'stock-deposit') openShareWorkflow(go, 'deposit');
    else if (destination?.section) goToSection(go, destination.area, destination.section);
    else if (destination) go(destination.area);
  }
  return <div className="ideas-area capability-area">
    <section className="card capability-map" aria-label="Capability system journey">
      <div className="civic-heading"><div><span className="eyebrow">FEATURES · ONE LEDGER</span><h2>What works, and what connects next</h2></div><span className="civic-key">Status: built · partly built · prototype · illustration · planned</span></div>
      <div className="capability-journey">{LEDGER_TOPICS.map((topic, index) => <div key={topic.id} className="capability-stage"><strong>{index + 1}. {topic.name}</strong><div>{IDEAS.filter((idea) => idea.topic === topic.id).map((idea) => <button type="button" key={idea.id} aria-pressed={selected.id === idea.id} onClick={() => setSelectedId(idea.id)}><span>{idea.title}</span><small className={`idea-status ${idea.status.replace(' ', '-')}`}>{STATUS_LABEL[idea.status]}</small></button>)}</div></div>)}</div>
    </section>
    <section className="card capability-detail" id="selected-capability" tabIndex={-1} aria-live="polite" aria-label="Selected capability">
      <div className="civic-heading"><h2>{selected.title}</h2><span className={`idea-status ${selected.status.replace(' ', '-')}`}>{STATUS_LABEL[selected.status]}</span></div>
      <p>{selected.enables}</p>
      <details><summary>How this works &amp; what remains</summary><p>{selected.how}</p>{selected.needs && <p><strong>Still needed:</strong> {selected.needs}</p>}</details>
      <div className="capability-links">{adapters.map((adapter) => <button type="button" className="text-button" key={adapter.id} onClick={() => openLedgerAdapter(go, adapter.id)}>{adapter.name} · source &amp; connection →</button>)}
        {destination && <button type="button" className="secondary-button" onClick={openCapability}>Open {AREAS.find((area) => area.id === destination.area)?.label} →</button>}</div>
    </section>
  </div>;
}
