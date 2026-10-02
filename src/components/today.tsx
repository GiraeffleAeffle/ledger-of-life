'use client';
import { useEffect, useMemo } from 'react';
import type { TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import { LedgerOverview } from './ledger-overview';
import { goToSection, type Area } from './areas';
import { useCityFeed } from './city-feed';
import { useCitySignals, type AuthorizedRequest } from './use-city-signals';
import { meaningfulFeedChanges, meaningfulVisitChanges, snapshotCityFeed, snapshotCitySignals, type FeedVisitBaseline, type VisitBaseline } from './visit-diff';
import { useProjectFollowing } from './use-project-following';

type Unavailable = { agreementId: string; property: string; unavailable: string };
export function Today({ request, accountId, tenancies, listings, homeError, go }: {
  request: AuthorizedRequest; accountId: string; tenancies: (TenancyJourney | Unavailable)[] | null;
  listings: PublicListing[]; invitation: boolean; homeError: string; go: (area: Area) => void;
}) {
  const { cityId, city, result: signals, error } = useCitySignals(request);
  const { result: feed, error: feedError } = useCityFeed(request, cityId);
  const following = useProjectFollowing(accountId, request);
  const updateCount = useMemo(() => {
    let previousSignals: VisitBaseline | null = null;
    let previousFeed: FeedVisitBaseline | null = null;
    if (typeof window !== 'undefined' && accountId && cityId) {
      try {
        previousSignals = JSON.parse(localStorage.getItem(`ledger-of-life:today-visit:v1:${accountId}:${cityId}`) ?? 'null');
        previousFeed = JSON.parse(localStorage.getItem(`ledger-of-life:today-feed-visit:v1:${accountId}:${cityId}`) ?? 'null');
      } catch { /* Unavailable device history cannot imply unread updates. */ }
    }
    const signalSnapshot = signals?.state === 'covered' ? snapshotCitySignals(signals.data.signals.features) : null;
    const feedSnapshot = feed?.state === 'available' ? snapshotCityFeed(feed.feed) : null;
    const ids = new Set<string>();
    if (previousSignals && signalSnapshot) for (const change of meaningfulVisitChanges(previousSignals, signalSnapshot, new Set(Object.keys(signalSnapshot.records)))) ids.add(change.id);
    if (previousFeed && feedSnapshot) for (const change of meaningfulFeedChanges(previousFeed, feedSnapshot)) ids.add(change.id);
    return ids.size;
  }, [accountId, cityId, signals, feed]);
  useEffect(() => {
    if (!accountId || !cityId) return;
    return () => {
      try {
        if (signals?.state === 'covered') localStorage.setItem(`ledger-of-life:today-visit:v1:${accountId}:${cityId}`, JSON.stringify(snapshotCitySignals(signals.data.signals.features)));
        if (feed?.state === 'available') localStorage.setItem(`ledger-of-life:today-feed-visit:v1:${accountId}:${cityId}`, JSON.stringify(snapshotCityFeed(feed.feed)));
      } catch { /* Reading public updates never requires device storage. */ }
    };
  }, [accountId, cityId, signals, feed]);
  const pending = Object.values(following.store.entries).reduce((count, entry) => count + entry.pending.length, 0);
  return <div className="today-stack">
    <LedgerOverview request={request} tenancies={tenancies} listings={listings} homeError={homeError} city={city} cityError={error} go={go} />
    {city?.name && <p>{city.name} · {error || feedError ? 'Published updates could not be checked' : !signals && cityId ? 'Checking published updates…' : `${updateCount + pending} updates since your last visit`} · <button className="text-button" onClick={() => goToSection(go, 'places', 'followed-projects')}>Places →</button></p>}
  </div>;
}
