'use client';
import { useState } from 'react';
import { Leaf, Sun } from 'lucide-react';
import { AGRI_PV_EXAMPLE } from '../data/local-investments';
import { AGRI_PV_INPUT_BOUNDS, simulateAgriPv, type AgriPvInputs, type AgriPvResult } from '../domain/agri-pv-simulation';
import { RoebelPrecedent } from './city-flywheel';
import './agri-pv-example.css';

const fields: { key: keyof AgriPvInputs; label: string; step: string; source: string }[] = [
  { key: 'plantSizeMWp', label: 'Plant size (MWp)', step: '0.1', source: 'Röbel variant 1 · developer proposal, 21 Jan 2026. Context only; edit annual production separately.' },
  { key: 'annualProductionKWh', label: 'Annual electricity sold (kWh)', step: '1000', source: 'Röbel variant 1 annual production · developer proposal, 21 Jan 2026. Editable assumption: all production is sold.' },
  { key: 'investmentEuro', label: 'Total investment (€)', step: '1000', source: 'Röbel variant 1 · developer proposal, 21 Jan 2026.' },
  { key: 'electricityPriceEuroPerKWh', label: 'Electricity price (€/kWh)', step: '0.0001', source: 'Editable assumption using the Bundesnetzagentur award benchmark below, 18 Aug 2026; not an achieved sales price.' },
  { key: 'areaHectares', label: 'Crop area (ha)', step: '0.1', source: '8 ha leased in the developer proposal, 21 Jan 2026. Editable assumption: the whole area produces crops.' },
  { key: 'cropRevenueEuroPerHectare', label: 'Annual crop revenue (€/ha)', step: '100', source: 'Editable assumption, not a measured Röbel crop result. Example: 5 tonnes/ha × €400/tonne; both are invented assumptions.' },
  { key: 'operatingCostPercent', label: 'Operating costs (% of both revenues)', step: '1', source: 'Editable assumption covering electricity and agriculture together; not sourced project costs.' },
  { key: 'ticketEuro', label: 'Illustrative ticket (€)', step: '1', source: 'Default matches DKB-Crowd minimum named in the developer proposal, 21 Jan 2026. No ticket is offered here.' },
];
const euro = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ratio = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 });

export function AgriPvExample() {
  const [values, setValues] = useState<Record<keyof AgriPvInputs, string>>(() => Object.fromEntries(Object.entries(AGRI_PV_EXAMPLE.defaults).map(([key, value]) => [key, String(value)])) as Record<keyof AgriPvInputs, string>);
  let result: AgriPvResult | null = null;
  let error = '';
  const invalidFields: Partial<Record<keyof AgriPvInputs, string>> = {};
  const inputs = {} as AgriPvInputs;
  for (const { key, label } of fields) {
    const [min, max] = AGRI_PV_INPUT_BOUNDS[key];
    const value = Number(values[key]);
    if (!values[key].trim() || !Number.isFinite(value) || value < min || value > max) invalidFields[key] = `${label}: enter a number from ${min.toLocaleString('en-GB')} to ${max.toLocaleString('en-GB')}.`;
    inputs[key] = value;
  }
  if (inputs.ticketEuro > inputs.investmentEuro) invalidFields.ticketEuro = 'The illustrative ticket cannot exceed the total investment.';
  if (Object.keys(invalidFields).length) error = Object.values(invalidFields).join(' ');
  else {
    try { result = simulateAgriPv(inputs); } catch (cause) { error = cause instanceof Error ? cause.message : 'Check the calculator inputs.'; }
  }
  const rows = [
    { label: 'Electricity sold', project: result?.electricityRevenueEuro, ticket: result?.ticketElectricityEuro },
    { label: 'Agricultural products', project: result?.cropRevenueEuro, ticket: result?.ticketCropEuro },
    { label: 'Operating costs (deducted)', project: result?.operatingCostsEuro, ticket: result?.ticketCostsEuro },
    { label: 'Total after operating costs', project: result?.netIncomeEuro, ticket: result?.ticketNetEuro },
  ];
  return <article className="agri-pv-example" aria-label="Illustrative Agri-PV income model">
    <div className="agri-pv-intro">
      <div className="city-blueprint-art">
        <span className="city-scenario-label">Illustrative project sketch</span>
        <svg viewBox="0 0 420 310" role="img" aria-label="Solar panel rows on high stands over crops; fictional Agri-PV concept, not a site plan">
          <ellipse cx="210" cy="261" rx="175" ry="29" fill="#dce5d1" />
          <circle cx="350" cy="44" r="21" fill="#e9b65c" />
          <g stroke="#afc09f" strokeWidth="2"><path d="M41 249l284-43M53 265l285-43M81 280l284-43" /></g>
          {[0, 70, 140].map((offset) => <g key={offset} transform={`translate(0 ${offset * 0.55})`}>
            <path d="M97 98v118m104-135v119m85-110v105m50-119v114" stroke="#769470" strokeWidth="5" />
            <path d="M73 103l63-38h225l-75 43z" fill="#3e6472" stroke="#6e896b" strokeWidth="2" />
            <path d="M111 102l63-37m-9 39l64-38m-12 39l64-38m-13 39l65-38M103 86l220 2" stroke="#a6c9cd" strokeWidth="1.5" />
          </g>)}
          <g stroke="#6c8d62" strokeWidth="2" fill="#78a06c">{[88, 126, 164, 202, 240, 278, 316].map((x) => <g key={x}><path d={`M${x} 267v-23`} /><path d={`M${x} 258q-18-4-14-15q16 0 14 15m0-6q18-4 14-15q-16 0-14 15`} /></g>)}</g>
        </svg>
        <div className="city-blueprint-caption"><Leaf size={16} />Crops below, electricity above</div>
      </div>
      <div className="agri-pv-story">
        <span className="eyebrow">ILLUSTRATION · NO TOKEN OR PURCHASE</span>
        <h3>One piece of land, two possible income streams.</h3>
        <p>In a hypothetical legally defined project, a token holder’s share could be funded by electricity sold and agricultural products sold. Here, a ticket is only a calculator input: no units, contracts, desk, buy/sell or payout.</p>
        <ul className="city-blueprint-benefits"><li><Sun size={17} /><span><strong>Electricity sold</strong>Annual sold kWh × an assumed price per kWh.</span></li><li><Leaf size={17} /><span><strong>Agricultural products sold</strong>Crop hectares × assumed annual revenue per hectare.</span></li></ul>
        <p className="agri-pv-caveat"><strong>Illustrative calculation with editable assumptions.</strong> Not a forecast, offer, yield promise or investment advice. Developer’s figures, not verified; a proposal, not a decision. Existing fictional issuer units elsewhere use test networks only; this example has no token.</p>
      </div>
    </div>
    <section className="agri-pv-calculator" aria-label="Agri-PV calculator">
      <h4>Edit the assumptions</h4>
      <p>All figures remain editable. The model assumes one common income pool and allocates it by ticket ÷ investment. This is not the DKB-Crowd product’s legal payout model.</p>
      <div className="agri-pv-fields">{fields.map(({ key, label, step, source }) => <div className="agri-pv-field" key={key}>
        <label htmlFor={`agri-pv-${key}`}>{label}</label>
        <input id={`agri-pv-${key}`} type="number" inputMode="decimal" min={AGRI_PV_INPUT_BOUNDS[key][0]} max={AGRI_PV_INPUT_BOUNDS[key][1]} step={step} value={values[key]} aria-invalid={Boolean(invalidFields[key])} aria-describedby={`agri-pv-${key}-source${invalidFields[key] ? ' agri-pv-error' : ''}`} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
        <small id={`agri-pv-${key}-source`}>{source}</small>
      </div>)}</div>
      {error && <p id="agri-pv-error" className="agri-pv-error" role="alert">{error} Results are unavailable until corrected.</p>}
      <div className="agri-pv-results" aria-live="polite" aria-atomic="true">
        <h4>Simulated annual income · not a payout</h4>
        <table><thead><tr><th scope="col">Income / costs</th><th scope="col">Whole project</th><th scope="col">Your illustrative ticket</th></tr></thead><tbody>{rows.map(({ label, project, ticket }) => <tr key={label}><th scope="row">{label}</th><td>{project === undefined ? '—' : euro.format(project)}</td><td>{ticket === undefined ? '—' : euro.format(ticket)}</td></tr>)}</tbody></table>
        <p className="agri-pv-ratio"><strong>{result ? `${ratio.format(result.simpleRatioPercent)}%` : '—'}</strong> Simple annual net-income / ticket ratio · not a promised yield, compound return or IRR.</p>
        <p className="small-copy">Costs are deducted from the combined revenues before allocation. Excludes financing, tax, depreciation, reserves and legal distribution terms. Crop costs are included only through the assumed cost share. No project viability or actual holder entitlement is established. A zero ticket has zero share and a displayed zero ratio.</p>
      </div>
      <details className="city-blueprint-evidence agri-pv-price-source"><summary>Electricity benchmark · source and limits</summary><p><a href={AGRI_PV_EXAMPLE.electricitySource.url} target="_blank" rel="noopener noreferrer">{AGRI_PV_EXAMPLE.electricitySource.label}</a></p><p>{AGRI_PV_EXAMPLE.electricitySource.description}</p></details>
      <RoebelPrecedent />
    </section>
  </article>;
}
