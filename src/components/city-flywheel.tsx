'use client';
import { useState } from 'react';
import { ArrowRight, Building2, Cpu, Leaf, Sun } from 'lucide-react';
import { openLocalAi, type Area } from './areas';

const windows = [[112, 137], [155, 137], [198, 137], [241, 137], [112, 174], [155, 174], [198, 174], [241, 174]] as const;
const technologies = [
  { id: 'solar', label: 'Solar roof', Icon: Sun },
  { id: 'heat', label: 'Heat pump', Icon: Leaf },
  { id: 'validator', label: 'Validator', Icon: Cpu },
  { id: 'gpu', label: 'GPU hosting', Icon: Cpu },
] as const;

export function ProjectBlueprint({ kind, go }: { kind: 'housing' | 'business'; go: (area: Area) => void }) {
  const [enabled, setEnabled] = useState({ solar: true, heat: true, validator: false, gpu: false });
  const computing = enabled.validator || enabled.gpu;
  return <div className="city-blueprint">
    <div className="city-blueprint-art">
      <span className="city-scenario-label">Project sketch</span>
      <svg viewBox="0 0 420 310" role="img" aria-label={`${kind === 'housing' ? 'Shared housing' : 'Local workshop'} concept${enabled.solar ? ' with rooftop solar' : ''}${enabled.heat ? ' and a heat pump' : ''}${computing ? ' and optional computing equipment' : ''}; not an actual building`}>
        <ellipse cx="208" cy="267" rx="166" ry="24" fill="#dce5d1" />
        <circle cx="343" cy="49" r="21" fill={enabled.solar ? '#e9b65c' : '#e4e6d8'} />
        <path d="M60 255h288M45 266h308" stroke="#afc09f" strokeWidth="2" />
        <path d="M95 117h201v140H95z" fill="#faf5e7" stroke="#6e896b" strokeWidth="2" />
        <path d="M296 117l55-33v143l-55 30z" fill="#bfcfae" stroke="#6e896b" strokeWidth="2" />
        <path d="M89 117l56-35h211l-60 35z" fill="#78956e" stroke="#6e896b" strokeWidth="2" />
        {enabled.solar && <g fill="#3e6472" stroke="#a6c9cd" strokeWidth="1.5"><path d="M139 104l20-13h63l-21 13zM212 104l21-13h63l-21 13z" /><path d="M158 92l43 12m-16-13l-23 13m88-13l-22 13m46-13l-22 13" /></g>}
        {windows.map(([x, y]) => <g key={`${x}:${y}`}><rect x={x} y={y} width="25" height="24" rx="2" fill="#b8d3ce" stroke="#74978d" /><path d={`M${x + 12.5} ${y}v24`} stroke="#f9f5e8" strokeWidth="2" /></g>)}
        <path d="M174 219h40v38h-40z" fill="#315e46" /><path d="M194 219v38" stroke="#abc5a2" />
        {kind === 'business' && <><rect x="107" y="213" width="49" height="39" fill="#deb975" /><path d="M111 222h41m-41 9h41m-41 9h41" stroke="#987640" /></>}
        {enabled.heat && <g><rect x="49" y="224" width="38" height="31" rx="4" fill="#edf0e4" stroke="#769470" strokeWidth="2" /><circle cx="67" cy="239" r="10" fill="none" stroke="#769470" /><path d="M67 229v20m-10-10h20m-17-7l14 14m0-14l-14 14" stroke="#769470" /><path d="M87 234h8" stroke="#769470" strokeWidth="3" /></g>}
        {computing && <g><rect x="308" y="179" width="27" height="54" rx="3" fill="#345348" /><path d="M312 190h19m-19 10h19m-19 10h19m-19 10h19" stroke="#94b091" /><circle cx="328" cy="186" r="2" fill="#edb96a" /><circle cx="328" cy="196" r="2" fill="#edb96a" /></g>}
        <path d="M70 221v34m-13-22c-10-28 22-46 30-17 7 23-25 31-30 17" fill="#78a06c" stroke="#6c8d62" />
        <path d="M370 211v43m-12-28c-17-31 19-59 31-30 14 31-19 48-31 30" fill="#78a06c" stroke="#6c8d62" />
      </svg>
      <div className="city-blueprint-caption"><Building2 size={16} />{kind === 'housing' ? 'Homes with useful shared infrastructure' : 'A workshop that helps the neighbourhood work'}</div>
    </div>
    <div className="city-blueprint-options">
      <span className="eyebrow">EXPLORE THE BUILDING IDEA</span>
      <h3>What could the building do?</h3>
      <p>Illustrative sketch only. These switches never change holdings or payouts.</p>
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
