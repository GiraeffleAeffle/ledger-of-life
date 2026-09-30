'use client';
import { useState } from 'react';
import type { CivicOutcomeEvidence } from '@/data/civic-outcome-evidence';
import { DEFAULT_SCENARIO, scenarioAllocation, SYSTEM_LOOP_IDS, SYSTEM_NODES, SYSTEM_RELATIONS, type ScenarioInputs, type SystemNodeId } from './civic-system';

const euros = (value: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
const allocation = [
  { id: 'wages', label: 'Wages', color: '#387d65' },
  { id: 'suppliers', label: 'Local suppliers', color: '#be8046' },
  { id: 'external', label: 'External purchases', color: '#8d8490' },
  { id: 'reserve', label: 'Reserve', color: '#637a9c' },
] as const;
// Grid-centre coordinates use a 300×300 viewBox. Every arrow ends at the
// visible card edge; long feedback links travel through gutters, not cards.
const edgePaths: Record<string, string> = {
  'resident-enterprise': 'M 95 50 L 105 50',
  'enterprise-work': 'M 195 50 L 205 50',
  'work-households': 'M 250 89 L 250 100 L 50 100 L 50 111',
  'households-housing': 'M 95 150 L 105 150',
  'housing-builders': 'M 195 150 L 205 150',
  'builders-work': 'M 250 111 L 250 89',
  'households-public': 'M 50 189 L 50 211',
  'enterprise-public': 'M 105 50 L 100 50 L 100 250 L 95 250',
  'public-services': 'M 95 250 L 105 250',
  'services-wellbeing': 'M 195 250 L 205 250',
  'wellbeing-resident': 'M 250 211 L 250 196 L 97 196 L 97 98 L 50 98 L 50 89',
  'wellbeing-enterprise': 'M 245 211 L 245 204 L 103 204 L 103 106 L 150 106 L 150 89',
};
export function CivicLoop({ selected, onSelect, mode, onMode, projectTitle, evidence }: {
  selected: SystemNodeId; onSelect: (id: SystemNodeId) => void;
  mode: 'observed' | 'scenario'; onMode: (value: 'observed' | 'scenario') => void; projectTitle?: string;
  evidence?: CivicOutcomeEvidence;
}) {
  const [inputs, setInputs] = useState<ScenarioInputs>(DEFAULT_SCENARIO);
  const values = scenarioAllocation(inputs);
  const set = (key: keyof ScenarioInputs, value: number) => setInputs((current) => ({ ...current, [key]: value }));
  const connected = SYSTEM_RELATIONS.filter((edge) => edge.from === selected || edge.to === selected);
  const linked = new Set(connected.flatMap((edge) => [edge.from, edge.to]));
  const max = Math.max(inputs.localReceipts + inputs.redistribution, inputs.serviceCosts, 1);
  const observedFact = evidence?.outputs.find((item) => item.basis === 'reported_output') ??
    evidence?.outputs[0] ?? evidence?.metrics[0];
  const nextPlanned = evidence?.outputs.find((item) => item !== observedFact && item.basis === 'planned');
  const factText = observedFact ? `${observedFact.unit === 'EUR' ? euros(Number(observedFact.value)) : observedFact.value}${observedFact.unit && observedFact.unit !== 'EUR' ? ` ${observedFact.unit}` : ''}` : 'No sourced quantity';
  return <section className="civic-loop" aria-label="Local economy connections">
    <div className="civic-mode" role="group" aria-label="Connection mode">
      <button type="button" aria-pressed={mode === 'observed'} onClick={() => onMode('observed')}>━ Observed / sourced</button>
      <button type="button" aria-pressed={mode === 'scenario'} onClick={() => onMode('scenario')}>┄ Scenario</button>
    </div>
    {mode === 'observed' ? <div className="civic-observed" role="status">
      <div className="civic-observed-chain" aria-label="Published source, selected project, reported or planned output, and outcome evidence">
        <span><small>━ PUBLIC SOURCE</small><strong>{evidence?.sourceTitle ?? 'Published record'}</strong></span>
        <span><small>━ SAME PROJECT</small><strong>{projectTitle ?? 'Select a project'}</strong></span>
        <span className={observedFact?.basis === 'planned' ? 'is-planned' : ''}><small>{observedFact?.basis === 'planned' ? '┄ PLANNED TARGET' : observedFact?.basis === 'reported_output' ? '━ REPORTED OUTPUT' : '━ PUBLISHED RECORD'}</small><strong>{observedFact ? `${observedFact.label}: ${factText}` : factText}</strong></span>
        <span className={evidence?.indicator ? '' : 'is-unknown'}><small>◇ MEASURE</small><strong>{evidence?.indicator ? `${evidence.indicator.baseline.value} → ${evidence.indicator.followUp.value} ${evidence.indicator.unit} · before/during, not causal` : 'Outcome evidence missing'}</strong></span>
      </div>
      {evidence?.relations && <div className="civic-observed-relations"><strong>Documented roles · not an effect chain</strong><ol>{evidence.relations.map((relation) => <li key={`${relation.from}:${relation.to}`}><b>{relation.from}</b><span>━ {relation.predicate} →</span><b>{relation.to}</b></li>)}</ol><small>Source and exact PDF page for each link in Evidence. The measured difference is not attributed to these roles.</small></div>}
      {evidence?.spending && <small>{typeof evidence.spending.planned.value === 'number' ? euros(evidence.spending.planned.value) : evidence.spending.planned.value} forecast · {evidence.spending.recorded.value} through 2021, provisional. Funding source unknown.</small>}
      {nextPlanned && <small>┄ Next source-era planned output: {nextPlanned.label} · {nextPlanned.value}{nextPlanned.unit ? ` ${nextPlanned.unit}` : ''}; delivery not confirmed by this cited source.</small>}
      <small>{evidence?.indicator ? 'The report compares bus GPS observations in two different years; no verified job, tax, passenger-wide or current-lane benefit follows.' : 'No verified project-specific funding → jobs → tax → wellbeing link in these sources. Switch to Scenario to inspect assumptions.'}</small>
    </div> : <>
      <p className="civic-caption">Fictional Example local business · dashed links are assumptions, not a funding offer or city forecast.</p>
      <div className="civic-graph" aria-label="Select a node to highlight upstream and downstream assumed relationships">
        <svg className="civic-graph-arrows" viewBox="0 0 300 300" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="civic-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 6 3 L 0 6 Z" fill="var(--line-strong)" /></marker><marker id="civic-arrow-active" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 6 3 L 0 6 Z" fill="var(--ink)" /></marker></defs>
          {SYSTEM_RELATIONS.map((edge) => <path key={`${edge.from}-${edge.to}`} d={edgePaths[`${edge.from}-${edge.to}`]} className={edge.from === selected || edge.to === selected ? 'is-active' : ''} markerEnd={`url(#civic-arrow${edge.from === selected || edge.to === selected ? '-active' : ''})`} />)}</svg>
        {SYSTEM_LOOP_IDS.map((id) => { const node = SYSTEM_NODES.find((entry) => entry.id === id)!; return <button type="button" key={node.id} className={`civic-node civic-${node.kind}${selected === node.id ? ' is-selected' : ''}${linked.has(node.id) ? ' is-linked' : ''}`} aria-pressed={selected === node.id} onClick={() => onSelect(node.id)}><span aria-hidden="true">{node.kind === 'person' ? '○' : node.kind === 'organization' ? '▣' : node.kind === 'outcome' ? '◇' : '□'}</span>{node.label}{id === 'resident' && <small>{euros(inputs.capital)}</small>}{id === 'work' && <small>{euros(values.wages)} wages</small>}{id === 'public' && <small>{euros(values.netLocal)} net*</small>}</button>; })}
      </div>
      <div className="civic-relations" aria-live="polite"><strong>{SYSTEM_NODES.find((node) => node.id === selected)?.label} · incoming / outgoing assumptions</strong><div>{connected.map((edge) => <span key={`${edge.from}-${edge.to}`}>┄ {SYSTEM_NODES.find((node) => node.id === edge.from)?.label} → {SYSTEM_NODES.find((node) => node.id === edge.to)?.label} · {edge.label}</span>)}</div></div>
      <div className="civic-scenario-controls"><label>Illustrative capital <input type="range" min="10000" max="300000" step="10000" value={inputs.capital} onChange={(event) => set('capital', Number(event.target.value))} /><output>{euros(inputs.capital)}</output></label>
        <label>Wages <input type="range" min="0" max={100 - inputs.suppliersPercent - inputs.externalPercent} value={inputs.wagesPercent} onChange={(event) => set('wagesPercent', Number(event.target.value))} /><output>{inputs.wagesPercent}%</output></label>
        <label>Local suppliers <input type="range" min="0" max={100 - inputs.wagesPercent - inputs.externalPercent} value={inputs.suppliersPercent} onChange={(event) => set('suppliersPercent', Number(event.target.value))} /><output>{inputs.suppliersPercent}%</output></label>
        <label>External purchases <input type="range" min="0" max={100 - inputs.wagesPercent - inputs.suppliersPercent} value={inputs.externalPercent} onChange={(event) => set('externalPercent', Number(event.target.value))} /><output>{inputs.externalPercent}%</output></label></div>
      <div className="civic-allocation" aria-label="Capital allocation; wages, local suppliers, external purchases and reserve sum to capital"><div className="civic-stack" aria-hidden="true">{allocation.map(({ id, color }) => <span key={id} style={{ width: `${values[id] / inputs.capital * 100}%`, background: color }} />)}</div><div className="civic-allocation-labels">{allocation.map(({ id, label, color }) => <span key={id}><i style={{ background: color }} />{label} <b>{euros(values[id])}</b></span>)}</div></div>
      <div className="civic-results"><div><span>Modeled capacity</span><strong>{values.jobYears.toFixed(2)} job-years</strong><small>Wage allocation ÷ assumed cost per job-year; not permanent hires.</small></div><div><span>Illustrative municipal balance</span><strong className={values.netLocal < 0 ? 'civic-negative' : ''}>{euros(values.netLocal)}</strong><small>Independent assumptions, not calculated from capital.</small></div></div>
      <div className="civic-balance"><div><span>Local receipts + redistribution · {euros(inputs.localReceipts + inputs.redistribution)}</span><i style={{ width: `${(inputs.localReceipts + inputs.redistribution) / max * 100}%` }} /></div><div><span>Service costs · {euros(inputs.serviceCosts)}</span><i style={{ width: `${inputs.serviceCosts / max * 100}%` }} /></div></div>
      <details className="civic-assumptions"><summary>Inspect assumptions &amp; leakage</summary><div className="civic-assumption-fields">
        <label>Assumed cost per job-year (€) <input type="number" min="1000" max="500000" step="1000" value={inputs.costPerJobYear} onChange={(event) => set('costPerJobYear', Math.max(1000, Number(event.target.value) || 1000))} /></label>
        <label>Assumed municipal receipts (€) <input type="number" min="0" step="500" value={inputs.localReceipts} onChange={(event) => set('localReceipts', Math.max(0, Number(event.target.value) || 0))} /></label>
        <label>Assumed intergovernmental transfers (€) <input type="number" min="0" step="500" value={inputs.redistribution} onChange={(event) => set('redistribution', Math.max(0, Number(event.target.value) || 0))} /></label>
        <label>Assumed service costs (€) <input type="number" min="0" step="500" value={inputs.serviceCosts} onChange={(event) => set('serviceCosts', Math.max(0, Number(event.target.value) || 0))} /></label>
      </div><p>Capital is allocated once: wages + local suppliers + external purchases + reserve = input. External purchases leave this local allocation. Receipts and redistribution are separate hypothetical inputs, not a tax formula; company and personal taxes also flow to other levels of government. Housing demand, building, population, taxes and service quality are not predicted. Change costs to see a negative balance.</p></details>
    </>}
  </section>;
}
