'use client';
import { useEffect, useMemo } from 'react';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import type { CityFeature } from '@/server/city-signals';
import type { TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import { AssetsOverview } from './assets';
import type { Area } from './areas';
import { useCityFeed } from './city-feed';
import { useInterests, usePersonalPins } from './personal-map-preferences';
import { matchPersonalRings, REVIEW_LABELS } from './personal-map-relevance';
import { regionalStageLabel, useRegionalTopics } from './region-topics';
import { useCitySignals, type AuthorizedRequest } from './use-city-signals';
import { meaningfulFeedChanges, meaningfulVisitChanges, snapshotCityFeed, snapshotCitySignals, type FeedVisitBaseline, type VisitBaseline } from './visit-diff';

const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/Berlin' });
const emptyFeatures: CityFeature[] = [];
const visitKey = (accountId: string, cityId: string) => `ledger-of-life:today-visit:v1:${accountId}:${cityId}`;
const feedVisitKey = (accountId: string, cityId: string) => `ledger-of-life:today-feed-visit:v1:${accountId}:${cityId}`;
const externalUrl = (url: string) => url.startsWith('https://') || url.startsWith('http://');
const waitingKinds = new Set(['confirming', 'paying_out', 'wait']);

type Unavailable = { agreementId: string; property: string; unavailable: string };
export function Today({ request, accountId, tenancies, listings, invitation, homeError, go }: {
  request: AuthorizedRequest; accountId: string; tenancies: (TenancyJourney | Unavailable)[] | null;
  listings: PublicListing[]; invitation: boolean; homeError: string; go: (area: Area) => void;
}) {
  const { cityId, result: currentSignals, error: signalError } = useCitySignals(request);
  const { result: currentFeed, error: feedError } = useCityFeed(request, cityId);
  const regionView = useRegionalTopics(request, cityId);
  const pins = usePersonalPins(cityId);
  const interests = useInterests();

  const signalResult = currentSignals;
  const feedResult = currentFeed;
  const features = signalResult?.state === 'covered' ? signalResult.data.signals.features : emptyFeatures;
  const rings = useMemo(() => matchPersonalRings(features, pins, undefined, interests), [features, pins, interests]);
  const relevant = useMemo(() => {
    const found = new Map<string, { feature: CityFeature; explanation: string }>();
    for (const match of [...rings.home, ...rings.commute, ...rings.city])
      if (match.feature.properties.kind !== 'place' && !found.has(match.feature.properties.id))
        found.set(match.feature.properties.id, match);
    return found;
  }, [rings]);

  // The baseline is per person and city. It contains public display fields, never saved pin coordinates.
  const signalSnapshot = useMemo(() => currentSignals?.state === 'covered'
    ? snapshotCitySignals(currentSignals.data.signals.features) : null, [currentSignals]);
  const feedSnapshot = useMemo(() => currentFeed?.state === 'available'
    ? snapshotCityFeed(currentFeed.feed) : null, [currentFeed]);
  const signalChanges = useMemo(() => {
    if (!accountId || !cityId || !signalSnapshot || typeof window === 'undefined') return [];
    let previous: VisitBaseline | null = null;
    try { previous = JSON.parse(localStorage.getItem(visitKey(accountId, cityId)) ?? 'null') as VisitBaseline | null; } catch { /* Invalid local baseline is a first visit. */ }
    return meaningfulVisitChanges(previous, signalSnapshot, new Set(Object.keys(signalSnapshot.records)));
  }, [accountId, cityId, signalSnapshot]);
  const feedChanges = useMemo(() => {
    if (!accountId || !cityId || !feedSnapshot || typeof window === 'undefined') return [];
    let previous: FeedVisitBaseline | null = null;
    try { previous = JSON.parse(localStorage.getItem(feedVisitKey(accountId, cityId)) ?? 'null') as FeedVisitBaseline | null; } catch { /* First feed visit. */ }
    return meaningfulFeedChanges(previous, feedSnapshot);
  }, [accountId, cityId, feedSnapshot]);
  useEffect(() => {
    if (!accountId || !cityId || !signalSnapshot) return;
    try { localStorage.setItem(visitKey(accountId, cityId), JSON.stringify(signalSnapshot)); } catch { /* City map still works without storage. */ }
  }, [accountId, cityId, signalSnapshot]);
  useEffect(() => {
    if (!accountId || !cityId || !feedSnapshot) return;
    try { localStorage.setItem(feedVisitKey(accountId, cityId), JSON.stringify(feedSnapshot)); } catch { /* City news still works without storage. */ }
  }, [accountId, cityId, feedSnapshot]);
  const pressIds = feedResult?.state === 'available'
    ? new Set(feedResult.feed.sources.filter((source) => source.kind === 'press').map((source) => source.id)) : new Set<string>();
  const news = feedResult?.state === 'available' ? feedResult.feed.items
    .filter((item) => item.kind === 'news' && pressIds.has(item.sourceId) && externalUrl(item.url))
    .toSorted((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 3) : [];
  const leadIds = new Set(news.map((item) => `feed:${item.id}`));
  const changes = [
    ...signalChanges.filter((change) => relevant.has(change.id)),
    ...feedChanges.filter((change) => !leadIds.has(change.id)),
  ].slice(0, 3);
  const noFeed = feedResult?.state === 'available'
    ? feedResult.feed.sources.find((source) => source.kind === 'press' && source.status === 'not_available') : undefined;
  const cityName = feedResult?.cityName || (signalResult?.state === 'covered' ? signalResult.data.catalogue.name : 'your city');
  const regional = regionView.cityId === cityId && regionView.result?.state === 'available' ? regionView.result : null;
  const regionalTopics = regional?.topics.filter((topic) => externalUrl(topic.furthest.source.url)).slice(0, 3) ?? [];

  const ready = (tenancies ?? []).filter((tenancy): tenancy is TenancyJourney => !('unavailable' in tenancy));
  const actionable = ready.find((tenancy) => !waitingKinds.has(tenancy.next.kind) && tenancy.next.kind !== 'done' && tenancy.next.kind !== 'propose_claim');
  const applicants = listings.find((listing) => listing.relation === 'landlord' && listing.status === 'open' && listing.applicants > 0);
  const needsAction = invitation || Boolean(actionable || applicants);
  const needTitle = invitation ? 'Join your invitation' : actionable?.next.label ?? (applicants ? 'Review applicants' : 'Nothing needs you today');
  const needDetail = invitation ? 'Open the private invitation in Home.' : actionable?.property
    ?? (applicants ? `${applicants.title} · ${applicants.applicants} applicant(s)` : 'Your Home is here when you need it.');

  return <div className="today-stack">
    <section className="card today-news" aria-label="Latest city news">
      <div className="section-heading"><div><span className="eyebrow">TODAY · OFFICIAL CITY PRESS</span><h2>Latest from {cityName}</h2></div><button className="text-button" onClick={() => go('places')}>All city news & events →</button></div>
      {feedError && <p className="small-copy" role="status">City news could not be refreshed{feedResult?.state === 'available' ? '; showing the last checked feed.' : '.'}</p>}
      {news.length ? <ol className="today-news-list">{news.map((item) => <li key={item.id}>
        <a href={item.url} target="_blank" rel="noopener noreferrer"><strong>{item.title}</strong> <ArrowUpRight size={15} aria-hidden /></a>
        <span className="small-copy">{item.publisher} · published {date.format(new Date(item.publishedAt))}</span>
      </li>)}</ol> : !cityId ? <p>{signalError ? 'Your city could not be checked right now.' : 'Choose your city in Places to see official city news.'}</p>
        : !feedResult && !feedError ? <p role="status">Reading official city news…</p>
          : feedResult?.state === 'not_available' ? <p>No news feed from {cityName} yet. Choose a covered city in Places.</p>
            : noFeed ? <p>No news feed from {cityName} yet. {noFeed.pageUrl && externalUrl(noFeed.pageUrl) && <a href={noFeed.pageUrl} target="_blank" rel="noopener noreferrer">Open the official news page <ArrowUpRight size={14} aria-hidden /></a>}</p>
              : <p>{feedError ? 'City news is temporarily unavailable.' : `No dated press news in the published feed for ${cityName}.`}</p>}
    </section>

    <section className="card today-needs" aria-label="Things needing your attention">
      <span className="eyebrow">{needsAction ? 'NEEDS YOU' : 'YOUR HOME RIGHT NOW'}</span>
      {tenancies === null && !invitation ? <p role="status">{homeError || <><Loader2 className="spin" size={17} /> Checking your home…</>}</p>
        : <><h2>{needTitle}</h2><p>{needDetail}</p>{needsAction && <button className="text-button" onClick={() => go('home')}>Open Home →</button>}</>}
    </section>

    <section className="card today-changes" aria-label="What changed near you">
      <div className="section-heading"><div><span className="eyebrow">SINCE YOUR LAST VISIT</span><h2>What changed near you</h2></div><button className="text-button" onClick={() => go('places')}>Explore Places →</button></div>
      {signalError && <p className="small-copy" role="status">City signals could not be refreshed{signalResult?.state === 'covered' ? '; showing last checked signals.' : '.'}</p>}
      {feedError && <p className="small-copy" role="status">City feed changes could not be refreshed{feedResult?.state === 'available' ? '; showing last checked feed.' : '.'}</p>}
      {changes.length ? <ul className="today-change-list">{changes.map((change) => <li key={change.id}>
        <strong>{change.title}</strong><span>{change.description} · {REVIEW_LABELS[change.reviewState as keyof typeof REVIEW_LABELS] ?? 'Not yet checked'}</span>
        <small>{relevant.get(change.id)?.explanation ?? 'Published city feed item'} · {change.id.startsWith('feed:') ? 'published' : 'source as of'} {date.format(new Date(change.asOf))}</small>
      </li>)}</ul> : !cityId ? <p>Choose a city in Places to see relevant changes.</p>
        : !signalResult && !signalError ? <p role="status">Checking published city signals…</p>
          : signalResult?.state === 'not_covered' && feedResult?.state !== 'available' ? <p>This city does not have published signals yet.</p>
            : <p>{signalError || feedError ? 'No new changes in the last checked sources; refresh is currently unavailable.' : 'No new changes relevant to your chosen city and saved map pins since your last visit.'}</p>}
      <p className="small-copy">Nearby is based on your saved map pins in this browser. They are never sent with this request.</p>
    </section>

    {regional && regionalTopics.length > 0 && <section className="card today-region" aria-label="In your region">
      <div className="section-heading"><div><span className="eyebrow">ACROSS {regional.regionName.toUpperCase()} · PUBLISHED SOURCES</span><h2>In your region</h2></div><button className="text-button" onClick={() => go('places')}>All regional sources in Places →</button></div>
      {regionView.error && <p className="small-copy" role="status">{regionView.error} Showing last checked topics.</p>}
      <ul className="today-change-list">{regionalTopics.map((topic) => <li key={topic.id}>
        <strong>{topic.neighbours.length + Number(topic.items.length > 0)} municipalities are working on {topic.label}</strong>
        <span>Furthest along: <a href={topic.furthest.source.url} target="_blank" rel="noopener noreferrer">{topic.furthest.name} <ArrowUpRight size={12} aria-hidden /></a> · {regionalStageLabel(topic.furthest.stage)} · {REVIEW_LABELS[topic.reviewState] ?? 'Not yet checked'}</span>
        {topic.items.filter((item) => externalUrl(item.url)).slice(0, 1).map((item) => <small key={`${item.url}:${item.locator}`}>
          In {cityName}: <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title} <ArrowUpRight size={12} aria-hidden /></a> · {regionalStageLabel(topic.stage)}
        </small>)}
      </li>)}</ul>
    </section>}

    <section className="card today-things" aria-label="Your things">
      <span className="eyebrow">YOUR THINGS</span><h2>Home & Money</h2>
      <p>{tenancies === null ? homeError ? 'Home information is unavailable right now.' : 'Checking your Home…'
        : <>{ready.length ? `${ready.length} tenancy ${ready.length === 1 ? 'journey' : 'journeys'} in Home` : 'No tenancy journey yet'}{listings.some((listing) => listing.relation === 'landlord') ? ' · Your listed homes are in Home' : ''}.</>}</p>
      <div className="today-links"><button className="text-button" onClick={() => go('home')}>Open Home →</button><button className="text-button" onClick={() => go('me')}>Open Me →</button></div>
      {tenancies !== null && <AssetsOverview request={request} tenancies={ready} show="summary" go={go} />}
    </section>
  </div>;
}
