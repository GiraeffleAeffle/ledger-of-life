'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { IDEAS, LEDGER_ADAPTERS, STATUS_LABEL, type AdapterAction, type LedgerAdapter } from '@/data/ledger-catalogue';
import { ADAPTER_NAVIGATION_INTENT, goToSection, openCivicScenario, openLedgerIdea, openShareWorkflow, type Area } from './areas';
import { adapterAction, adapterState, type DynamicHomeAction, type LedgerStateInputs } from './ledger-adapter-state';
import { WALLET_LABELS } from '@/wallets/labels';
import { RealityChips } from './reality-chip';
import { MoreList, MoreRow } from './blocks';
import './ledger-overview.css';

export function activateAdapterAction(action: AdapterAction | DynamicHomeAction, go: (area: Area) => void) {
  if (action.kind === 'idea') openLedgerIdea(go, action.idea);
  else if (action.kind === 'scenario') openCivicScenario(go);
  else if (action.kind === 'share') openShareWorkflow(go, action.choice);
  else if (action.section) goToSection(go, action.area, action.section);
  else go(action.area);
}

const rowId = (id: string) => id === 'eudi' ? 'identity-eudi' : id === 'homeAssistant' ? 'adapter-home-assistant' : id === 'validator' ? 'adapter-validator' : `connection-${id}`;
const PERSONAL_CONNECTIONS: Partial<Record<string, true>> = { eudi: true, homeAssistant: true, validator: true };

/** One labelled door per source; permissions and controls live together inside it. */
export function LedgerAdapters({ inputs, go, controls = {} }: {
  inputs: LedgerStateInputs; go: (area: Area) => void; controls?: Partial<Record<string, ReactNode>>;
}) {
  const [plannedOpen, setPlannedOpen] = useState(false);
  const [builtInOpen, setBuiltInOpen] = useState(false);
  useEffect(() => {
    function consume() {
      const id = sessionStorage.getItem(ADAPTER_NAVIGATION_INTENT);
      if (!id) return;
      sessionStorage.removeItem(ADAPTER_NAVIGATION_INTENT);
      const adapter = LEDGER_ADAPTERS.find((item) => item.id === id);
      if (!adapter) return;
      if (adapter.connection === 'future') setPlannedOpen(true);
      else if (!PERSONAL_CONNECTIONS[adapter.id]) setBuiltInOpen(true);
      const groupId = adapter.connection === 'future' ? 'planned-connections' : !PERSONAL_CONNECTIONS[adapter.id] ? 'built-in-connections' : null;
      const group = groupId ? document.getElementById(groupId) : null;
      if (group instanceof HTMLDetailsElement) group.open = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const row = document.getElementById(rowId(id));
        if (row instanceof HTMLDetailsElement) row.open = true;
        row?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        row?.focus({ preventScroll: true });
      }));
    }
    window.addEventListener(ADAPTER_NAVIGATION_INTENT, consume);
    consume();
    return () => window.removeEventListener(ADAPTER_NAVIGATION_INTENT, consume);
  }, []);

  function connectionRow(adapter: LedgerAdapter) {
    const state = adapterState(adapter, inputs);
    const action = adapter.id === 'homeAssistant' && inputs.homeAssistantPull === false
      ? { kind: 'area' as const, area: 'money' as const, section: 'money-devices' as const, label: 'Connect through Home Node' }
      : adapterAction(adapter, inputs);
    return <MoreRow key={adapter.id} id={rowId(adapter.id)} title={adapter.id === 'solana' ? WALLET_LABELS.solana : adapter.id === 'robinhood' ? WALLET_LABELS.ethereum : adapter.name}
      meta={<span className={`ledger-state ${state.tone}`}>{state.label}</span>}>
      <div className="ledger-adapter-detail">
        <p>{adapter.explain.brings}</p>
        <RealityChips levels={[adapter.explain.reality]} />
        <dl className="ledger-explain">
          <div><dt>Reads</dt><dd>{adapter.explain.reads}</dd></div>
          <div><dt>Keeps</dt><dd>{adapter.explain.keeps}</dd></div>
          <div><dt>Who can see it</dt><dd>{adapter.explain.visibility}</dd></div>
          <div><dt>You need</dt><dd>{adapter.explain.needs}</dd></div>
          <div><dt>Disconnect</dt><dd>{adapter.explain.disconnect}</dd></div>
        </dl>
        {adapter.explain.caveat && <p className="ledger-caveat">{adapter.explain.caveat}</p>}
        {controls[adapter.id] ?? <div className="ledger-action-row">
          <button className="button primary" type="button" onClick={() => activateAdapterAction(action, go)}>{action.label}<ArrowUpRight size={16} /></button>
          {adapter.secondaryAction && <button className="secondary-button" type="button" onClick={() => activateAdapterAction(adapter.secondaryAction!, go)}>{adapter.secondaryAction.label}</button>}
        </div>}
        {controls[adapter.id] && adapter.settings && state.configured && !(adapter.connection === 'homeAssistant' && inputs.homeAssistantPull === false) && <div className="ledger-action-row">
          <button className="secondary-button" type="button" onClick={() => activateAdapterAction(adapter.action, go)}>{adapter.action.label}<ArrowUpRight size={16} /></button>
        </div>}
        <details><summary>Technical source &amp; related capabilities</summary>
          <dl className="ledger-source-facts"><div><dt>Source</dt><dd>{adapter.source}</dd></div><div><dt>Environment</dt><dd>{adapter.environment}</dd></div></dl>
          <div className="ledger-capability-links">{adapter.capabilities.map((id) => { const idea = IDEAS.find((item) => item.id === id); return idea ? <button className="text-button" type="button" key={id} onClick={() => openLedgerIdea(go, id)}>{idea.title} · {STATUS_LABEL[idea.status]} →</button> : null; })}</div>
        </details>
      </div>
    </MoreRow>;
  }
  const planned = LEDGER_ADAPTERS.filter((adapter) => adapter.connection === 'future');
  const builtIn = LEDGER_ADAPTERS.filter((adapter) => adapter.connection !== 'future' && !PERSONAL_CONNECTIONS[adapter.id]);
  const builtInNeedsYou = builtIn.reduce((count, adapter) => count + Number(adapterState(adapter, inputs).tone === 'setup'), 0);
  return <section className="ledger-adapters" id="ledger-adapters" tabIndex={-1} aria-label="Connections">
    <h2>Connections</h2>
    <div id="adapter-settings" tabIndex={-1}>
      <MoreList>
        {LEDGER_ADAPTERS.filter((adapter) => PERSONAL_CONNECTIONS[adapter.id]).map(connectionRow)}
        <MoreRow id="built-in-connections" title={`Built into your account (${builtIn.length})`} meta={builtInNeedsYou ? `${builtInNeedsYou} ${builtInNeedsYou === 1 ? 'needs' : 'need'} you` : 'Included with your account'} defaultOpen={builtInOpen}>
          <MoreList>{builtIn.map(connectionRow)}</MoreList>
        </MoreRow>
        <MoreRow id="planned-connections" title={`Planned connections (${planned.length})`} meta="Not available yet · nothing to set up" defaultOpen={plannedOpen}>
          <MoreList>{planned.map(connectionRow)}</MoreList>
        </MoreRow>
      </MoreList>
    </div>
  </section>;
}
