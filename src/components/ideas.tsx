'use client';
import { AREAS, type Area } from './areas';

type Status = 'planned' | 'prototype' | 'partly built' | 'illustration' | 'built';
interface Idea {
  id: string;
  area: Exclude<Area, 'ideas'>;
  title: string;
  how: string;
  enables: string;
  status: Status;
  needs?: string;
}

/** Single source for planned features; mirrors docs/LEDGER_OF_LIFE.md and the ontology's roadmap items. */
export const IDEAS: Idea[] = [
  { id: 'today-cockpit', area: 'overview', status: 'built', title: 'A calm Today cockpit',
    how: 'Official city press leads; one real Home action, meaningful changes since this device last visited, regional topics where published, and a quiet Home and test-money summary follow.',
    enables: 'Start with what is new or needs attention without opening five dashboards.' },
  { id: 'city-news-feed', area: 'places', status: 'partly built', title: 'City news & events',
    how: 'Published city feed files show attributed headlines, original links and publication dates in Places. Today previews three official press headlines; event times appear only when sourced.',
    enables: 'Read a dated local source once, not a copied article or an invented event date.',
    needs: 'Published official feeds for more cities.' },
  { id: 'regional-shared-topics', area: 'places', status: 'partly built', title: 'In your region',
    how: 'Published Märkisch-Oderland source items group topics shared by municipalities. Your city’s items rank first; original links and separate stages remain visible. Interpretive summaries say “Not yet checked”.',
    enables: 'See where neighbouring municipalities work on similar topics without treating an agenda or proposal as an adopted policy.',
    needs: 'Reviewed interpretation and published regional coverage beyond Märkisch-Oderland.' },
  { id: 'timeline', area: 'me', status: 'partly built', title: 'Life timeline',
    how: 'Tenancies from this app appear automatically; earlier places you add yourself (labeled as your own statement); later a residence attestation from the EU wallet.',
    enables: 'Moving becomes the moment the app helps most, and a landlord can see "3 tenancies, all deposits returned" without any address.' },
  { id: 'roles', area: 'me', status: 'planned', title: 'Roles in every part of your life',
    how: 'Each context (tenancy, club, building, city) grants you a role; the EU wallet proves eligibility such as residence or age.',
    enables: 'One identity for tenant, landlord, club member and resident, and each context learns only what it needs.' },
  { id: 'service-charges', area: 'home', status: 'prototype', title: 'Real-time service charges',
    how: 'Example service-charge statement with a landlord-set test prepayment and optional live daily Home Assistant consumption; no escrow funding or payouts.',
    enables: 'See an illustrative running balance. It is not a legal annual statement or money movement.',
    needs: 'Real meter and invoice data before an actual service-charge balance can be calculated.' },
  { id: 'stock-deposit', area: 'money', status: 'prototype', title: 'Stocks as your deposit',
    how: 'Works on Robinhood Chain testnet with test TSLA at a simulated price: pledge 150 % of a new deposit (125 % maintenance), a price drop triggers a top-up request or a small protective sale, and at move-out only the approved claim is sold; the remaining shares come back.',
    enables: 'Keep remaining test shares after a claim rather than treating the full pledge as rent paid.' },
  { id: 'borrow-against-shares', area: 'money', status: 'prototype', title: 'Borrow against shares',
    how: 'Works on Robinhood Chain testnet: borrow test USD up to 50 % of your test shares\' value, interest accrues per second, at 80 % the pool liquidates, and repaying returns your shares.',
    enables: 'See an independent test loan and its debt, repayment and liquidation risk without confusing it with the direct stock pledge.' },
  { id: 'local-investments', area: 'money', status: 'illustration', title: 'Invest in your own city',
    how: 'Four legal forms and unverified Strausberg cooperative leads; no offers or investment in the app.',
    enables: 'Explore illustrated local investment participation without suggesting a live offer or verified membership.',
    needs: 'A specific test-token scenario tied to verified local sources before the illustration becomes interactive.' },
  { id: 'home-tokens', area: 'money', status: 'planned', title: 'Home shares towards owning a home',
    how: 'Collect shares of homes month by month; they count toward buying one. No live asset is offered.',
    enables: 'A potential path from renting to owning; now part of \"Invest in your own city\".' },
  { id: 'devices', area: 'money', status: 'planned', title: 'Electric car and other devices',
    how: 'Charging and vehicle-to-grid income read like the solar and validator adapters.',
    enables: 'Everything your hardware earns in one total.' },
  { id: 'budget', area: 'places', status: 'partly built', title: 'Where the money goes',
    how: 'Places explains statutory flows and links Strausberg’s 2025/26 ordinance, with planned investment outlays of €17,941,270 (2025) and €12,609,320 (2026). The full detailed plan is offered for inspection; no actual spending is inferred.',
    enables: 'Distinguish an adopted headline plan from money spent or an individual tax receipt.',
    needs: 'The complete city budget plan and verified line items before a spending breakdown can be shown.' },
  { id: 'scales', area: 'places', status: 'partly built', title: 'From your street to the world',
    how: 'The private personal map now matches city-wide published signals against on-device home/work pins in a neighbourhood ring and approximate straight commute corridor. Places still links district → state → Germany → EU portals; those wider levels are not live feeds.',
    enables: 'Start with what may affect your neighbourhood and city without disclosing your exact home or work to the server.',
    needs: 'Reviewed coverage across more cities and district/state/world levels.' },
  { id: 'measurable', area: 'places', status: 'partly built', title: 'A measurable city',
    how: 'Read-only live DWD weather via Bright Sky and nearby uncalibrated citizen PM sensors with observation time and distance.',
    enables: 'Inspect sourced local measurements; this is not a calibrated city-wide sensor layer.',
    needs: 'Verified environmental coverage and city-reviewed interpretation before comparing measures over time.' },
  { id: 'decisions', area: 'places', status: 'partly built', title: 'Council papers & meetings',
    how: 'Strausberg ALLRIS meeting calendar and document search are linked; no working public OParl endpoint was confirmed and no agendas are imported.',
    enables: 'Reach the official source yourself, without presenting unverified meeting records as a feed.',
    needs: 'A structured meeting feed (OParl or reviewed atlas/CCF data) for read-only meetings.' },
  { id: 'welcome', area: 'places', status: 'partly built', title: 'Welcome to your new city',
    how: 'Named OSM clubs and sports facilities are read-only, grouped by type and linked to OSM; Strausberg city and district directories are linked. Welcome vouchers can be illustrated without claiming a real offer.',
    enables: 'Find nearby activities now and explore a clearly simulated welcome voucher next.',
    needs: 'City partners for any real voucher redemption, registration help or consent-based matching.' },
];

const STATUS_LABEL: Record<Status, string> = { planned: 'Planned', prototype: 'Prototype', 'partly built': 'Partly built', illustration: 'Illustration', built: 'Built' };


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
