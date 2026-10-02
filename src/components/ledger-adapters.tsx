'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Building2, CircleUserRound, Cpu, Fingerprint, Home, Landmark, Plug, ShieldCheck, Sun, Wallet, type LucideIcon } from 'lucide-react';
import { IDEAS, LEDGER_ADAPTERS, LEDGER_TOPICS, STATUS_LABEL, type AdapterAction, type LedgerTopicId } from '@/data/ledger-catalogue';
import { ADAPTER_NAVIGATION_INTENT, goToSection, openCivicScenario, openLedgerIdea, openShareWorkflow, type Area } from './areas';
import { adapterAction, adapterState, type DynamicHomeAction, type LedgerStateInputs } from './ledger-adapter-state';
import { RealityChips } from './reality-chip';
import './ledger-overview.css';

export const TOPIC_ICONS: Record<LedgerTopicId, LucideIcon> = { identity: Fingerprint, home: Home, money: Wallet, devices: Sun, places: Building2 };
const adapterIcons: Record<string, LucideIcon> = { account: CircleUserRound, eudi: ShieldCheck, validator: Cpu, 'local-capital': Landmark, 'local-ai': Cpu };
const directionLabel = { account: 'Account control', 'read-only': 'Read-only', signed: 'Explicit wallet approval', 'device-local': 'On this device', illustration: 'No value movement' };

export function activateAdapterAction(action: AdapterAction | DynamicHomeAction, go: (area: Area) => void) {
  if (action.kind === 'idea') openLedgerIdea(go, action.idea);
  else if (action.kind === 'scenario') openCivicScenario(go);
  else if (action.kind === 'share') openShareWorkflow(go, action.choice);
  else if (action.section) goToSection(go, action.area, action.section);
  else go(action.area);
}

/** One topic list, one selected source: not another full proof dashboard on every page. */
export function LedgerAdapters({ inputs, go }: { inputs: LedgerStateInputs; go: (area: Area) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = LEDGER_ADAPTERS.find((adapter) => adapter.id === selectedId)
    ?? LEDGER_ADAPTERS.find((adapter) => adapterState(adapter, inputs).tone === 'setup')
    ?? LEDGER_ADAPTERS[0];
  const state = adapterState(selected, inputs);
  const action = selected.id === 'homeAssistant' && inputs.homeAssistantPull === false
    ? { kind: 'area' as const, area: 'money' as const, section: 'money-devices' as const, label: 'Connect through Home Node' }
    : adapterAction(selected, inputs);
  useEffect(() => {
    function consume() {
      const id = sessionStorage.getItem(ADAPTER_NAVIGATION_INTENT);
      if (!id) return;
      sessionStorage.removeItem(ADAPTER_NAVIGATION_INTENT);
      if (LEDGER_ADAPTERS.some((adapter) => adapter.id === id)) queueMicrotask(() => setSelectedId(id));
    }
    window.addEventListener(ADAPTER_NAVIGATION_INTENT, consume);
    consume();
    return () => window.removeEventListener(ADAPTER_NAVIGATION_INTENT, consume);
  }, []);
  return <section className="card ledger-adapters" id="ledger-adapters" tabIndex={-1} aria-label="Ledger connections">
    <div className="ledger-section-heading"><div><span className="eyebrow">ONE LEDGER · MANY SOURCES</span><h2>Your connections</h2></div><span className="ledger-catalogue-count">{LEDGER_ADAPTERS.length} sources</span></div>
    <p className="ledger-intro">Connections use adapters to read or act on a source. Select one to see its purpose, status and data permissions. Planned sources do nothing yet; they are not unfinished account setup.</p>
    <div className="ledger-topic-tabs" role="group" aria-label="Ledger connection topics">
      {LEDGER_TOPICS.map((topic) => { const Icon = TOPIC_ICONS[topic.id]; return <button type="button" key={topic.id} aria-pressed={selected.topic === topic.id} onClick={() => setSelectedId(LEDGER_ADAPTERS.find((adapter) => adapter.topic === topic.id)!.id)}><Icon size={18} />{topic.name}</button>; })}
    </div>
    <div className="ledger-adapter-browser">
      <div className="ledger-adapter-options" aria-label={`${LEDGER_TOPICS.find((topic) => topic.id === selected.topic)?.name} adapters`}>
        {LEDGER_ADAPTERS.filter((adapter) => adapter.topic === selected.topic).map((adapter) => {
          const status = adapterState(adapter, inputs);
          const Icon = adapterIcons[adapter.id] ?? TOPIC_ICONS[adapter.topic];
          return <button type="button" key={adapter.id} className="ledger-adapter-option" aria-pressed={adapter.id === selected.id} onClick={() => setSelectedId(adapter.id)}><Icon size={19} /><span><strong>{adapter.name}</strong><small>{adapter.environment}</small></span><span className={`ledger-state ${status.tone}`}>{status.label}</span></button>;
        })}
      </div>
      <article className="ledger-adapter-detail" aria-live="polite" aria-label="Selected adapter">
        <span className="eyebrow">{STATUS_LABEL[selected.maturity]} · {directionLabel[selected.direction]}</span>
        <h3>{selected.name}</h3><p>{selected.explain.brings}</p>
        {selected.id === 'homeAssistant' && <p className="small-copy">On the hosted site, connect through your Home Node. It reads Home Assistant inside your network and pushes signed sensor readings; the token stays on your device.</p>}
        {selected.id === 'validator' && <p className="small-copy">Report public validator IDs through your Home Node, or use the read-only adapter here. Neither proves stake ownership.</p>}
        <div className="ledger-detail-chips"><span className={`ledger-state ${state.tone}`}>{state.label}</span><RealityChips levels={[selected.explain.reality]} /><span className="ledger-effort">Effort: {selected.explain.effort}</span></div>
        <div className="ledger-action-row"><button className="button primary" type="button" onClick={() => activateAdapterAction(action, go)}>{action.label}<ArrowUpRight size={16} /></button>
          {selected.secondaryAction && <button className="secondary-button" type="button" onClick={() => activateAdapterAction(selected.secondaryAction!, go)}>{selected.secondaryAction.label}<ArrowUpRight size={15} /></button>}
          {selected.settings && state.configured && <button className="text-button" type="button" onClick={() => goToSection(go, 'me', selected.settings!)}><Plug size={15} />Manage connection</button>}
        </div>
        <dl className="ledger-explain">
          <div><dt>Reads</dt><dd>{selected.explain.reads}</dd></div>
          <div><dt>Keeps</dt><dd>{selected.explain.keeps}</dd></div>
          <div><dt>Who can see it</dt><dd>{selected.explain.visibility}</dd></div>
          <div><dt>You need</dt><dd>{selected.explain.needs}</dd></div>
          <div><dt>To disconnect</dt><dd>{selected.explain.disconnect}</dd></div>
        </dl>
        {selected.explain.caveat && <p className="ledger-caveat"><strong>Good to know.</strong> {selected.explain.caveat}</p>}
        <details><summary>Technical source &amp; related capabilities</summary>
          <dl className="ledger-source-facts"><div><dt>Source</dt><dd>{selected.source}</dd></div><div><dt>Environment</dt><dd>{selected.environment}</dd></div></dl>
          <div className="ledger-capability-links">{selected.capabilities.map((id) => { const idea = IDEAS.find((item) => item.id === id); return idea ? <button className="text-button" type="button" key={id} onClick={() => openLedgerIdea(go, id)}>{idea.title} · {STATUS_LABEL[idea.status]} →</button> : null; })}</div>
        </details>
      </article>
    </div>
  </section>;
}
