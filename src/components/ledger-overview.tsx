'use client';
import { Building2, Home, Wallet } from 'lucide-react';
import type { TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import type { AuthorizedRequest } from './use-city-signals';
import { AssetsOverview } from './assets';
import { goToSection, type Area } from './areas';
import { RealityChips } from './reality-chip';
import './ledger-overview.css';

type UnavailableHome = { agreementId: string; property: string; unavailable: string };
export function LedgerOverview({ request, tenancies, listings, homeError, cityId, cityName, selectedCity, cityLoading, cityError, citySnapshot, go }: {
  request: AuthorizedRequest; tenancies: (TenancyJourney | UnavailableHome)[] | null; listings: PublicListing[]; homeError: string;
  cityId: string; cityName: string; selectedCity: boolean; cityLoading: boolean; cityError: string; citySnapshot: string | null;
  go: (area: Area) => void;
}) {
  const relatedListings = listings.filter((item) => item.relation === 'landlord' || item.relation === 'applicant');
  const ready = (tenancies ?? []).filter((item): item is TenancyJourney => !('unavailable' in item));
  const unreadableHomes = (tenancies ?? []).filter((item): item is UnavailableHome => 'unavailable' in item);
  const home = ready[0];
  const listing = relatedListings[0];
  const homeTarget = home ? `tenancy-${home.agreementId}` : listing ? `listing-${listing.id}` : 'home-options';
  return <section className="ledger-overview" aria-label="Your current status">
    <div className="ledger-topic-cards">
      <article className="ledger-topic-card ledger-home"><header><Home size={18} /><h3>1–2 · Your home</h3></header>
        <strong>{home?.property ?? listing?.title ?? (homeError || unreadableHomes.length ? 'Home status unavailable' : tenancies === null ? 'Checking your home…' : 'No home recorded')}</strong>
        {home && <span>{home.role} · {home.next.kind === 'propose_claim' ? 'Test deposit secured' : home.next.label}</span>}
        {!home && listing && <span>{listing.relation === 'applicant' ? 'Application' : 'Your listing'} · {listing.status}</span>}
        {ready.length + relatedListings.length > 1 && <small>Other homes and applications remain in Home.</small>}
        {homeError && <span role="status">Home could not be refreshed. Known records have not been reset.</span>}
        {unreadableHomes.map((item) => <small key={item.agreementId} role="status">{item.property}: reading unavailable.</small>)}
        {!home && !listing && !homeError && !unreadableHomes.length && tenancies !== null && <span>Applications, deposit terms and test payouts stay in Home.</span>}
        <button type="button" className="text-button" onClick={() => goToSection(go, 'home', homeTarget)}>Home status</button>
      </article>
      <article className="ledger-topic-card ledger-money"><header><Wallet size={18} /><h3>3 · Your assets</h3></header>
        {tenancies !== null && !homeError && !unreadableHomes.length ? <AssetsOverview request={request} tenancies={ready} show="summary" go={go} /> : <>
          <RealityChips levels={['testnet_simulated']} /><strong>—</strong>
          <span role="status">{homeError || unreadableHomes.length ? 'Home context is incomplete; no combined balance inferred.' : 'Checking Home before the combined balance…'}</span>
          <button type="button" className="text-button" onClick={() => go('money')}>Holdings</button>
        </>}
      </article>
      <article className="ledger-topic-card ledger-places"><header><Building2 size={18} /><h3>4 · Your city</h3></header>
        <strong>{selectedCity || cityId ? cityName : cityError ? 'City check unavailable' : cityLoading ? 'Checking your city…' : 'No city selected'}</strong>
        <span role="status">{cityError ? `City sources could not be refreshed.${citySnapshot ? ' Last checked snapshot remains.' : ''}` : citySnapshot ? `Published feed prepared ${citySnapshot}` : selectedCity || cityId ? cityLoading ? 'Checking published sources…' : 'No published snapshot available.' : 'City news and events appear here after you select a city in Places.'}</span>
        {cityError && citySnapshot && <small>Last published feed prepared {citySnapshot}</small>}
        <button type="button" className="text-button" onClick={() => goToSection(go, 'places', !cityId && !selectedCity ? 'city-choice' : 'city-news')}>My city</button>
      </article>
    </div>
  </section>;
}
