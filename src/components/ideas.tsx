'use client';
import { Lightbulb } from 'lucide-react';
import { AREAS, type Area } from './areas';

type Status = 'planned' | 'prototype' | 'partly built' | 'illustration' | 'built';
interface Idea {
  id: string;
  area: Exclude<Area, 'overview' | 'ideas'>;
  title: string;
  how: string;
  enables: string;
  status: Status;
  needs?: string;
}

/** Single source for planned features; mirrors docs/LEDGER_OF_LIFE.md and the ontology's roadmap items. */
export const IDEAS: Idea[] = [
  { id: 'timeline', area: 'me', status: 'partly built', title: 'Life timeline',
    how: 'Tenancies from this app appear automatically; earlier places you add yourself (labeled as your own statement); later a residence attestation from the EU wallet.',
    enables: 'Moving becomes the moment the app helps most, and a landlord can see "3 tenancies, all deposits returned" without any address.' },
  { id: 'roles', area: 'me', status: 'planned', title: 'Roles in every part of your life',
    how: 'Each context (tenancy, club, building, city) grants you a role; the EU wallet proves eligibility such as residence or age.',
    enables: 'One identity for tenant, landlord, club member and resident, and each context learns only what it needs.' },
  { id: 'service-charges', area: 'home', status: 'prototype', title: 'Real-time service charges',
    how: 'Example service-charge statement with a landlord-set test prepayment and optional live daily Home Assistant consumption; no escrow funding or payouts.',
    enables: 'See an illustrative running balance. It is not a legal annual statement or money movement.',
    needs: 'Real meter/invoice integration and an authorized payment design before balances or refunds can become real.' },
  { id: 'stock-deposit', area: 'home', status: 'prototype', title: 'Stocks as your deposit',
    how: '150 % collateral calculator and Robinhood Chain testnet contract; no pledge flow in the app.',
    enables: 'Explore how tokenized shares might secure a deposit without claiming a working collateral tenancy.' },
  { id: 'local-investments', area: 'money', status: 'illustration', title: 'Invest in your own city',
    how: 'Four legal forms and unverified Strausberg cooperative leads; no offers or investment in the app.',
    enables: 'Understand possible forms of participation without implying membership, available shares or real investable projects.',
    needs: 'Verified provider terms, a licensed partner and legal review before any real offer.' },
  { id: 'home-tokens', area: 'money', status: 'planned', title: 'Home shares towards owning a home',
    how: 'Collect shares of homes month by month; they count toward buying one. No live asset is offered.',
    enables: 'A potential path from renting to owning; now part of \"Invest in your own city\".' },
  { id: 'devices', area: 'money', status: 'planned', title: 'Electric car and other devices',
    how: 'Charging and vehicle-to-grid income read like the solar and validator adapters.',
    enables: 'Everything your hardware earns in one total.' },
  { id: 'personal-map', area: 'places', status: 'built', title: 'Personal map · near home, in my city, on my way to work',
    how: 'MapLibre overlays published, sourced public city signals. Optional home/work pins are kept only in this browser; distance and straight-line commute matching run entirely on-device. Candidate signals remain visibly not yet reviewed.',
    enables: 'See what public sources say may matter nearby without giving your home or work coordinates to the app server. Coverage and review vary by city.' },
  { id: 'budget', area: 'places', status: 'partly built', title: 'Where the money goes',
    how: 'Places explains statutory flows and links Strausberg’s 2025/26 ordinance, with planned investment outlays of €17,941,270 (2025) and €12,609,320 (2026). The full detailed plan is offered for inspection; no actual spending is inferred.',
    enables: 'Distinguish an adopted headline plan from money spent or an individual tax receipt.',
    needs: 'The complete city budget plan, annexes, reusable licence and verified line items before a spending breakdown can be shown.' },
  { id: 'scales', area: 'places', status: 'partly built', title: 'From your street to the world',
    how: 'The private personal map now matches city-wide published signals against on-device home/work pins in a neighbourhood ring and approximate straight commute corridor. Places still links district → state → Germany → EU portals; those wider levels are not live feeds.',
    enables: 'Start with what may affect your neighbourhood and city without disclosing your exact home or work to the server.',
    needs: 'Reviewed, rights-cleared coverage across more cities and district/state/world levels.' },
  { id: 'measurable', area: 'places', status: 'partly built', title: 'A measurable city',
    how: 'Read-only live DWD weather via Bright Sky and nearby uncalibrated citizen PM sensors with observation time and distance.',
    enables: 'Inspect sourced local measurements; this is not a calibrated city-wide sensor layer.',
    needs: 'Verified environmental coverage and city-reviewed interpretation before comparing measures over time.' },
  { id: 'decisions', area: 'places', status: 'partly built', title: 'Council decisions',
    how: 'Strausberg ALLRIS meeting calendar and document search are linked; no working public OParl endpoint was confirmed and no agendas are imported.',
    enables: 'Reach the official source yourself, without presenting unverified meeting records as a feed.',
    needs: 'A permitted structured meeting feed (OParl or reviewed atlas/CCF data) for read-only meetings.' },
  { id: 'welcome', area: 'places', status: 'partly built', title: 'Welcome to your new city',
    how: 'Named OSM clubs and sports facilities are now read-only live, grouped by type and linked to OSM; Strausberg city and district directories are linked.',
    enables: 'Find nearby activities without claiming OSM contributions are an official directory.',
    needs: 'City partners for vouchers, registration help and any consent-based interest matching.' },
];

const STATUS_LABEL: Record<Status, string> = { planned: 'Planned', prototype: 'Prototype', 'partly built': 'Partly built', illustration: 'Illustration', built: 'Built' };

/** Roadmap work left in an area, separate from the built features and illustrations above. */
export function PlannedHere({ area, go }: { area: Idea['area']; go: (area: Area) => void }) {
  const ideas = IDEAS.filter((i) => i.area === area && i.status !== 'illustration' && i.status !== 'built');
  if (!ideas.length) return null;
  return (
    <section className="planned-here">
      <span className="eyebrow"><Lightbulb size={12} /> MORE TO BUILD IN THIS AREA</span>
      <div className="planned-grid">
        {ideas.map((idea) => (
          <div key={idea.id} className="planned-item">
            <strong>{idea.title}</strong>
            <span className={`idea-status ${idea.status.replace(' ', '-')}`}>{STATUS_LABEL[idea.status]}</span>
            <p>{idea.enables}</p>
          </div>
        ))}
      </div>
      <button className="text-button" onClick={() => go('ideas')}>All ideas, how they would work and what they need →</button>
    </section>
  );
}

/** Every idea with how it would work, what it enables and what it still needs. */
export function IdeasArea() {
  return (
    <div className="ideas-area">
      {AREAS.filter((a) => IDEAS.some((i) => i.area === a.id)).map((area) => (
        <section key={area.id} className="card ideas-group">
          <h2><area.icon size={18} /> {area.label}</h2>
          {IDEAS.filter((i) => i.area === area.id).map((idea) => (
            <article key={idea.id} className="idea">
              <header><strong>{idea.title}</strong><span className={`idea-status ${idea.status.replace(' ', '-')}`}>{STATUS_LABEL[idea.status]}</span></header>
              <p><b>How it would work.</b> {idea.how}</p>
              <p><b>What it enables.</b> {idea.enables}</p>
              {idea.needs && <p className="idea-needs"><b>Still needed.</b> {idea.needs}</p>}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
