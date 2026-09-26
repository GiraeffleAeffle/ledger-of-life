'use client';
import { Lightbulb } from 'lucide-react';
import { AREAS, type Area } from './areas';

type Status = 'planned' | 'prototype' | 'partly built';
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
  { id: 'service-charges', area: 'home', status: 'planned', title: 'Real-time service charges',
    how: 'Monthly prepayments go into an escrow like the deposit; consumption comes live from meters or Home Assistant; invoices arrive with their allocation key.',
    enables: 'A running balance ("you are €12 ahead") and surplus paid back monthly instead of after the yearly statement.' },
  { id: 'stock-deposit', area: 'home', status: 'prototype', title: 'Stocks as your deposit',
    how: 'Secure a flat with 150 % in tokenized shares instead of cash; a claim is paid by selling just enough shares.',
    enables: 'Keep your savings invested while renting. The contract ran on Robinhood Chain testnet; not an app flow yet.' },
  { id: 'local-investments', area: 'money', status: 'planned', title: 'Invest in your own city',
    how: 'Cooperative shares (housing, energy), electronic shares of local companies (eWpG, since 2024), crowdfunding via licensed platforms (up to €5 million per project owner a year), tokenized property shares via a property company.',
    enables: 'See a planned project in your city, the company or cooperative behind it, and take part financially and in the consultation.',
    needs: 'A licensed partner and legal review before any real offer; until then illustration or test network.' },
  { id: 'home-tokens', area: 'money', status: 'planned', title: 'Home shares towards owning a home',
    how: 'Collect shares of homes month by month; they count toward buying one.',
    enables: 'A path from renting to owning. Becomes part of "Invest in your own city".' },
  { id: 'devices', area: 'money', status: 'planned', title: 'Electric car and other devices',
    how: 'Charging and vehicle-to-grid income read like the solar and validator adapters.',
    enables: 'Everything your hardware earns in one total.' },
  { id: 'budget', area: 'places', status: 'planned', title: 'Where the money goes',
    how: 'Your city receives a share of income tax where you live and trade tax where companies operate; the state redistributes (for example Brandenburg to Strausberg); the budget and council decisions show what is planned.',
    enables: 'See what your city can realistically spend and on what. Figures only from published budgets, with source and date; anything per person is an estimate.',
    needs: 'Research which budget data each city and state publishes; delivered through the Stadtstack protocol.' },
  { id: 'scales', area: 'places', status: 'planned', title: 'From your street to the world',
    how: 'Every project, decision and figure carries its scale: neighbourhood, city, neighbouring cities, Landkreis, state, country, EU, world.',
    enables: 'Zoom out without losing the thread back to your own life.' },
  { id: 'measurable', area: 'places', status: 'planned', title: 'A measurable city',
    how: 'Sensors and open data (Stadtstack layers 1 and 2) show needs and whether a measure helped.',
    enables: 'Votes and priorities based on evidence, and results people can check.' },
  { id: 'decisions', area: 'places', status: 'planned', title: 'Council decisions',
    how: 'Council agendas and papers from OParl systems, collected by CCF (Council Context Feed), summarised with sources in the atlas.',
    enables: 'Know what is decided before it happens, not after.' },
  { id: 'welcome', area: 'places', status: 'planned', title: 'Welcome to your new city',
    how: 'When you move, see what is being built (3D atlas), what is decided, how to register, and clubs or groups that match your interests, maybe with a welcome voucher.',
    enables: 'Newcomers connect faster and can offer their expertise. Interests stay with you; matching only with your consent.',
    needs: 'City partners for vouchers and club listings.' },
];

const STATUS_LABEL: Record<Status, string> = { planned: 'Planned', prototype: 'Prototype', 'partly built': 'Partly built' };

/** Compact planned items at the end of an area, visibly separate from what works today. */
export function PlannedHere({ area, go }: { area: Idea['area']; go: (area: Area) => void }) {
  const ideas = IDEAS.filter((i) => i.area === area);
  if (!ideas.length) return null;
  return (
    <section className="planned-here">
      <span className="eyebrow"><Lightbulb size={12} /> PLANNED IN THIS AREA · NOT BUILT YET</span>
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
