'use client';
import type { TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import { citySourceLabel, type AuthorizedRequest } from './use-city-signals';
import type { CityResult } from '../server/city';
import { currentHomeTenancy } from './home-journey-logic';
import { AssetsOverview } from './assets';
import { goToSection, type Area } from './areas';
import './ledger-overview.css';

import { PathStrip } from './path-strip';
import { pathProgress } from './path-progress';
type UnavailableHome = { agreementId: string; property: string; unavailable: string };
export function LedgerOverview({ request, tenancies, listings, homeError, city, cityError, go }: {
  request: AuthorizedRequest; tenancies: (TenancyJourney | UnavailableHome)[] | null; listings: PublicListing[]; homeError: string;
  city: CityResult | null; cityError: string; go: (area: Area) => void;
}) {
  const ready = (tenancies ?? []).filter((item): item is TenancyJourney => !('unavailable' in item));
  const home = currentHomeTenancy(ready) ?? ready.find((item) => item.next.kind === 'done');
  const listing = listings.find((item) => item.relation !== null && item.status !== 'closed');
  const target = home ? `tenancy-${home.agreementId}` : listing ? `listing-${listing.id}` : 'home-options';
  const unavailable = ready.length !== (tenancies?.length ?? 0);
  const progress = pathProgress({ homeLoading: tenancies === null, homeError: Boolean(homeError) || unavailable, tenancies: ready, listings, cityChosen: Boolean(city?.name), cityLoading: !city, cityError: Boolean(cityError) });
  return <PathStrip>
    <li><strong>1 · Home</strong> · {home?.property ?? listing?.title ?? (homeError ? 'Status unavailable' : tenancies === null ? 'Checking your home…' : 'No home recorded')} · <button className="text-button" onClick={() => goToSection(go, 'home', target)}>Home →</button></li>
    <li><strong>2 · Deposit</strong> · {progress.deposit === 'unknown' ? 'Status unavailable' : home ? home.stage === 'living' ? 'Secured' : home.stage === 'paid' ? 'Paid out' : 'In progress' : listing ? 'Not secured yet' : 'No deposit recorded'} · <button className="text-button" onClick={() => goToSection(go, 'home', home || listing ? target : 'deposit-options')}>Deposit →</button></li>
    <li><strong>3 · Assets</strong> · {tenancies !== null && !homeError && !unavailable ? <AssetsOverview request={request} tenancies={ready} show="summary" go={go} /> : 'Checking holdings…'}</li>
    <li><strong>4 · City</strong> · {city?.name ? <>{city.name} · {citySourceLabel(city.source)}{!city.cityId && ' · not covered yet'}</> : cityError ? 'City check unavailable' : !city ? 'Checking your city…' : 'No city known'} · <button className="text-button" onClick={() => goToSection(go, 'places', city?.cityId ? 'city-news' : 'city-choice')}>Places →</button></li>
  </PathStrip>;
}
