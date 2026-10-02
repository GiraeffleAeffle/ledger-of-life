'use client';
import type { TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import { LedgerOverview } from './ledger-overview';
import { goToSection, type Area } from './areas';
import { type AuthorizedRequest } from './use-city-signals';
import { useCityVisitChanges } from './use-city-visit-changes';

type Unavailable = { agreementId: string; property: string; unavailable: string };
export function Today({ request, accountId, tenancies, listings, homeError, go }: {
  request: AuthorizedRequest; accountId: string; tenancies: (TenancyJourney | Unavailable)[] | null;
  listings: PublicListing[]; invitation: boolean; homeError: string; go: (area: Area) => void;
}) {
  const visit = useCityVisitChanges(request, accountId);
  const { city, error } = visit;
  return <div className="today-stack">
    <LedgerOverview request={request} tenancies={tenancies} listings={listings} homeError={homeError} city={city} cityError={error} go={go} />
    {city?.name && <p>{city.name} · {visit.loading ? 'Checking published updates…'
      : visit.unavailable ? `Published updates could not all be checked${visit.changes.length + visit.pendingCount ? ` · ${visit.changes.length + visit.pendingCount} known updates to review` : ''}`
        : `${visit.changes.length + visit.pendingCount} updates since you last marked changes seen`} · <button className="text-button" onClick={() => goToSection(go, 'places', 'city-changes')}>Places →</button></p>}
  </div>;
}
