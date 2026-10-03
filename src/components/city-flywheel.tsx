'use client';
import type { Dispatch, SetStateAction } from 'react';
import type { ProjectSystems } from './project-map-model';
import { ArrowRight, Building2, Cpu, Leaf, Sun } from 'lucide-react';
import { openLocalAi, type Area } from './areas';
import { ROEBEL_AGRI_PV } from '../data/local-investments';

export function RoebelPrecedent() {
  return <details className="city-blueprint-evidence"><summary>{ROEBEL_AGRI_PV.title}</summary>
    <p>{ROEBEL_AGRI_PV.summary}</p><p><strong>{ROEBEL_AGRI_PV.caveat}</strong></p>
    <p>{ROEBEL_AGRI_PV.tokenization}</p><p className="small-copy">Source: {ROEBEL_AGRI_PV.source} Privately shared presentation; no public online record located. <a href={ROEBEL_AGRI_PV.noteUrl} target="_blank" rel="noopener noreferrer">Read the attributed research note</a></p>
  </details>;
}

const technologies = [
  { id: 'solar', label: 'Solar roof', Icon: Sun },
  { id: 'heat', label: 'Heat pump', Icon: Leaf },
  { id: 'validator', label: 'Validator', Icon: Cpu },
  { id: 'gpu', label: 'GPU hosting', Icon: Cpu },
] as const;

export function ProjectBlueprint({ kind, go, enabled, setEnabled }: { kind: 'housing' | 'business'; go: (area: Area) => void; enabled: ProjectSystems; setEnabled: Dispatch<SetStateAction<ProjectSystems>> }) {
  const computing = enabled.validator || enabled.gpu;
  return <div className="city-blueprint">
    <div className="city-blueprint-options">
      <h3>What could the building do?</h3>
      <p>These switches update the {kind === 'housing' ? 'house' : 'workshop'} above, not your holdings or payouts.</p>
      <div className="city-tech-toggles">{technologies.map(({ id, label, Icon }) => <button type="button" key={id} aria-pressed={enabled[id]} onClick={() => setEnabled((value) => ({ ...value, [id]: !value[id] }))}><Icon size={17} />{label}<span>{enabled[id] ? 'On' : 'Off'}</span></button>)}</div>
      <ul className="city-blueprint-benefits">
        {enabled.solar && <li><Sun size={16} /><span><strong>Use more power where it is generated.</strong> Explore a roof designed for local energy use.</span></li>}
        {enabled.heat && <li><Leaf size={16} /><span><strong>Get more useful heat per kWh.</strong> Match the system to the building.</span></li>}
        {enabled.validator && <li><Cpu size={16} /><span><strong>Optional network infrastructure.</strong> Plan for uptime and security.</span></li>}
        {enabled.gpu && <li><Cpu size={16} /><span><strong>Compute with a credible customer.</strong> Explore whether useful heat can be recovered.</span></li>}
        {!enabled.solar && !enabled.heat && !computing && <li><Building2 size={16} /><span>Start with a useful building, then choose systems that fit its needs.</span></li>}
      </ul>
      {enabled.gpu && <button type="button" className="button primary" onClick={() => openLocalAi(go)}>Try the connected GPU node <ArrowRight size={16} /></button>}
      <details className="city-blueprint-evidence"><summary>Costs, evidence &amp; realism</summary><p>These switches change a schematic, not a building, holding, bill or return. Capital cost, finance, servicing, grid charges and actual demand need a project-specific assessment.</p><p><a href="https://www.ise.fraunhofer.de/en/press-media/press-releases/2025/fraunhofer-ise-research-project-completed-heat-pumps-provide-climate-friendly-heating-in-existing-buildings.html" target="_blank" rel="noopener noreferrer">Fraunhofer ISE’s field study</a> found substantial variation in heat-pump efficiency and partial—not universal—solar autonomy. It is not a forecast for this fictional building.</p><p><a href="https://www.iea.org/commentaries/opportunities-for-district-heating-in-the-changing-energy-landscape" target="_blank" rel="noopener noreferrer">IEA on heat recovery</a>: location, temperature, timing, infrastructure and a viable business model all matter. A validator is not a substitute for a heating design.</p></details>
    </div>
  </div>;
}
