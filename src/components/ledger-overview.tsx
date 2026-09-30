'use client';
import { ArrowRight, BookmarkPlus, Fingerprint, Home, Plug, Sun, Wallet, Building2 } from 'lucide-react';
import type { TenancyJourney } from '@/server/journey';
import { LEDGER_TOPICS, type LedgerTopicId } from '@/data/ledger-catalogue';
import type { PublicListing } from '@/server/listings';
import { CITY_CHANGED_EVENT, type AuthorizedRequest } from './use-city-signals';
import { AssetsOverview } from './assets';
import { goToSection, openLedgerAdapter, openLedgerIdea, openShareWorkflow, type Area } from './areas';
import { GettingStarted } from './getting-started';
import { RecoveryPrompt } from './recovery-step';
import { RealityChips } from './reality-chip';
import type { LedgerStateInputs } from './ledger-adapter-state';
import { useLedgerConnections } from './use-ledger-connections';
import './ledger-overview.css';

type UnavailableHome = { agreementId: string; property: string; unavailable: string };
export function LedgerOverview({ request, accountId, tenancies, listings, homeError, cityId, cityName, selectedCity, cityLoading, cityError, followedCount, followingError, go }: {
  request: AuthorizedRequest; accountId: string; tenancies: (TenancyJourney | UnavailableHome)[] | null; listings: PublicListing[]; homeError: string;
  cityId: string; cityName: string; selectedCity: boolean; cityLoading: boolean; cityError: string; followedCount: number; followingError: string;
  go: (area: Area) => void;
}) {
  const connections = useLedgerConnections(request);
  const listingCount = listings.filter((item) => item.status === 'open' && (item.relation === 'landlord' || item.relation === 'applicant')).length;
  const setupInputs: LedgerStateInputs = {
    ...connections.facts, homeLoading: tenancies === null && !homeError, homeError, tenancyCount: tenancies?.length ?? 0, listingCount,
    cityId, cityName, selectedCity, cityLoading, cityError,
  };
  const ready = (tenancies ?? []).filter((item): item is TenancyJourney => !('unavailable' in item));
  const unreadableHomes = (tenancies ?? []).filter((item) => 'unavailable' in item).length;
  const configuredDevices = Number(Boolean(connections.adapters.config?.homeAssistant)) + Number(Boolean(connections.adapters.config?.validator));
  const walletCount = Number(connections.facts.solanaLinked) + Number(connections.facts.robinhoodLinked);
  const topicName = (id: LedgerTopicId) => LEDGER_TOPICS.find((topic) => topic.id === id)!.name;
  const identityNote = connections.identityLoading ? 'Checking optional identity proof…' : connections.identityError ? 'Optional proof could not be checked'
    : connections.identity?.state === 'verified' ? 'Verified adult (EU test wallet)' : 'Optional EU test-wallet proof available';
  return <section className="ledger-overview" aria-label="Your life and adapter overview">
    <GettingStarted inputs={setupInputs} accountId={accountId} go={go} retry={{
      // The city event also clears the shared caches, so this is a real second read and not a repaint.
      city: () => window.dispatchEvent(new Event(CITY_CHANGED_EVENT)),
      eudi: () => { void connections.refreshIdentity(); },
      homeAssistant: () => { void connections.adapters.refresh(); },
      validator: () => { void connections.adapters.refresh(); },
    }} />
    <RecoveryPrompt request={request} />
    <header className="ledger-root">
      <h2>One person. Connected parts of life.</h2>
      <button type="button" className="text-button" onClick={() => goToSection(go, 'me', 'ledger-adapters')}><Plug size={16} />See what feeds your ledger<ArrowRight size={15} /></button>
    </header>
    <div className="ledger-topic-cards">
      <article className="ledger-topic-card ledger-identity"><header><Fingerprint size={20} /><h3>{topicName('identity')}</h3></header>
        <strong>{connections.wallet.authenticated ? 'Your account' : 'Check account access'}</strong><span>{walletCount} linked wallet{walletCount === 1 ? '' : 's'} · private roles &amp; history</span><small>{identityNote}</small>
        <button type="button" className="text-button" onClick={() => openLedgerAdapter(go, 'account')}>Identity &amp; adapters →</button>
      </article>
      <article className="ledger-topic-card ledger-home"><header><Home size={20} /><h3>{topicName('home')}</h3></header>
        <strong>{tenancies === null ? homeError ? 'Home unavailable' : 'Checking your home…' : tenancies.length ? `${tenancies.length} ${tenancies.length === 1 ? 'tenancy' : 'tenancies'}` : listingCount ? `${listingCount} ${listingCount === 1 ? 'listing or application' : 'listings or applications'}` : 'Start with a home'}</strong>
        <span>{unreadableHomes ? `${unreadableHomes} tenancy reading${unreadableHomes === 1 ? '' : 's'} unavailable` : 'Agreement · deposit · service charges'}</span>
        <small>Signed test-network steps stay in Home.</small><button type="button" className="text-button" onClick={() => goToSection(go, 'home', tenancies?.length ? 'home-tenancies' : 'home-options')}>{tenancies?.length || listingCount ? 'Open my home' : 'Find or add a home'} →</button>
      </article>
      <article className="ledger-topic-card ledger-money"><header><Wallet size={20} /><h3>{topicName('money')}</h3></header>
        {tenancies !== null && !unreadableHomes ? <AssetsOverview request={request} tenancies={ready} show="summary" go={go} /> : <><RealityChips levels={['testnet_simulated']} /><strong>—</strong><span>{homeError || unreadableHomes ? 'Home context is incomplete; no combined balance inferred.' : 'Checking Home before the combined balance…'}</span><button type="button" className="text-button" onClick={() => go('money')}>Open Money →</button></>}
        <div className="ledger-money-paths"><span>Working test workflows</span><div>
          <button type="button" onClick={() => openShareWorkflow(go, 'deposit')}>Share-backed deposit →</button>
          <button type="button" onClick={() => openShareWorkflow(go, 'borrow')}>Loan against shares →</button>
        </div><button className="text-button" type="button" onClick={() => openLedgerIdea(go, 'home-tokens')}>Home ownership · planned →</button></div>
      </article>
      <article className="ledger-topic-card ledger-devices"><header><Sun size={20} /><h3>{topicName('devices')}</h3></header>
        <strong>{connections.adapters.loading ? 'Checking connections…' : connections.adapters.error ? 'Connections unavailable' : configuredDevices ? `${configuredDevices} read-only source${configuredDevices === 1 ? '' : 's'} configured` : 'Connect something you run'}</strong>
        <span>Home solar · validator · local AI node</span><small>EV and other device feeds remain planned.</small>
        <button type="button" className="text-button" onClick={() => goToSection(go, 'money', 'money-devices')}>See devices in Money →</button>
      </article>
      <article className="ledger-topic-card ledger-places"><header><Building2 size={20} /><h3>{topicName('places')}</h3></header>
        <strong>{cityLoading ? 'Checking your city…' : cityError ? cityId || selectedCity ? cityName : 'City check unavailable' : cityId || selectedCity ? cityName : 'Choose your city'}</strong>
        <span>{followingError ? 'Saved following could not be checked' : followedCount ? `${followedCount} public project${followedCount === 1 ? '' : 's'} followed on this device` : 'Projects · public decisions · local life'}</span>
        <button type="button" className="button primary ledger-follow-entry" onClick={() => goToSection(go, 'places', !cityId && (selectedCity || !cityLoading && !cityError) ? 'city-choice' : 'project-browser')}><BookmarkPlus size={17} />{selectedCity && !cityId ? 'Choose a covered city' : !cityId && !cityLoading && !cityError ? 'Choose my city' : 'Explore & follow projects'}</button>
      </article>
    </div>
    <div className="ledger-overview-key"><span>Account links ≠ live readings</span><span>Test assets stay labelled</span><span>Planned adapters stay separate</span></div>
  </section>;
}
