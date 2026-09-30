'use client';
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import type { CityFeature } from '@/server/city-signals';
import type { TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import { LedgerOverview } from './ledger-overview';
import { goToSection, openCivicProject, openCivicSignal, type Area } from './areas';
import { useCityFeed } from './city-feed';
import { formatCityDate } from './city-coverage';
import { useInterests, usePersonalPins } from './personal-map-preferences';
import { matchPersonalRings, REVIEW_LABELS } from './personal-map-relevance';
import { civicOutcomeEvidence, MUNSTER_BUS_TRIAL_ID } from '@/data/civic-outcome-evidence';
import { useCitySignals, type AuthorizedRequest } from './use-city-signals';
import { baselineForVisit, meaningfulFeedChanges, meaningfulVisitChanges, snapshotCityFeed, snapshotCitySignals, type FeedVisitBaseline, type VisitBaseline } from './visit-diff';
import { useProjectFollowing } from './use-project-following';
import { caseForTarget, targetKey } from './project-following';

const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/Berlin' });
const emptyFeatures: CityFeature[] = [];
const visitKey = (accountId: string, cityId: string) => `ledger-of-life:today-visit:v1:${accountId}:${cityId}`;
const feedVisitKey = (accountId: string, cityId: string) => `ledger-of-life:today-feed-visit:v1:${accountId}:${cityId}`;
const externalUrl = (url: string) => url.startsWith('https://') || url.startsWith('http://');
const waitingFor = (tenancy: TenancyJourney) => {
  if (tenancy.next.kind === 'paying_out') return 'Waiting for the test-network payout';
  if (tenancy.next.kind === 'confirming') return 'Waiting for test-network confirmation';
  if (tenancy.next.kind !== 'wait' && tenancy.next.kind !== 'propose_claim') return '';
  return tenancy.next.label.toLowerCase().includes('arbitrator') ? 'Waiting for the arbitrator'
    : tenancy.next.label.toLowerCase().includes('landlord') ? 'Waiting for the landlord'
      : tenancy.next.label.toLowerCase().includes('tenant') ? 'Waiting for the tenant' : `Waiting: ${tenancy.next.label}`;
};


type Unavailable = { agreementId: string; property: string; unavailable: string };
export function Today({ request, accountId, tenancies, listings, invitation, homeError, go }: {
  request: AuthorizedRequest; accountId: string; tenancies: (TenancyJourney | Unavailable)[] | null;
  listings: PublicListing[]; invitation: boolean; homeError: string; go: (area: Area) => void;
}) {
  const { cityId, selectedCity, cityDisplayName, result: currentSignals, error: signalError } = useCitySignals(request);
  const [visitRevision, setVisitRevision] = useState(0);
  const { result: currentFeed, error: feedError } = useCityFeed(request, cityId);
  const pins = usePersonalPins(cityId, accountId);
  const interests = useInterests();
  const following = useProjectFollowing(accountId, request);
  const followed = Object.values(following.store.entries);
  const pending = followed.flatMap((entry) => entry.pending.map((update) => ({ entry, update })))
    .toSorted((a, b) => b.update.snapshot.asOf.localeCompare(a.update.snapshot.asOf));
  const sourceIssues = followed.filter((entry) => following.sources[targetKey(entry.target)]);
  const checkingSources = followed.some((entry) => following.sources[targetKey(entry.target)] === undefined);
  const openFollowed = (target: (typeof followed)[number]['target'], changes: (typeof pending)[number]['update']['changes']) => {
    const sourceKey = changes.find((change) => change.key.startsWith('signal:'))?.key;
    const signalId = sourceKey?.slice('signal:'.length, sourceKey.lastIndexOf(':'));
    if (target.kind === 'case') openCivicProject(go, target.cityId, target.id,
      signalId && caseForTarget(target)?.signalIds.includes(signalId) ? signalId : undefined);
    else openCivicSignal(go, target.cityId, target.id);
  };

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- visitRevision re-reads the stored baseline after "Mark changes seen"
  }, [accountId, cityId, signalSnapshot, visitRevision]);
  const feedChanges = useMemo(() => {
    if (!accountId || !cityId || !feedSnapshot || typeof window === 'undefined') return [];
    let previous: FeedVisitBaseline | null = null;
    try { previous = JSON.parse(localStorage.getItem(feedVisitKey(accountId, cityId)) ?? 'null') as FeedVisitBaseline | null; } catch { /* First feed visit. */ }
    return meaningfulFeedChanges(previous, feedSnapshot);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- visitRevision re-reads the stored baseline after "Mark changes seen"
  }, [accountId, cityId, feedSnapshot, visitRevision]);
  useEffect(() => {
    if (!accountId || !cityId || !signalSnapshot) return;
    try {
      const key = visitKey(accountId, cityId);
      const previous = JSON.parse(localStorage.getItem(key) ?? 'null') as VisitBaseline | null;
      if (baselineForVisit(previous, signalSnapshot) === signalSnapshot) localStorage.setItem(key, JSON.stringify(signalSnapshot));
    } catch { /* City map still works without storage. */ }
  }, [accountId, cityId, signalSnapshot]);
  useEffect(() => {
    if (!accountId || !cityId || !feedSnapshot) return;
    try {
      const key = feedVisitKey(accountId, cityId);
      const previous = JSON.parse(localStorage.getItem(key) ?? 'null') as FeedVisitBaseline | null;
      if (baselineForVisit(previous, feedSnapshot) === feedSnapshot) localStorage.setItem(key, JSON.stringify(feedSnapshot));
    } catch { /* City news still works without storage. */ }
  }, [accountId, cityId, feedSnapshot]);
  function markSeen() {
    if (!accountId || !cityId) return;
    try {
      if (signalSnapshot) localStorage.setItem(visitKey(accountId, cityId), JSON.stringify(signalSnapshot));
      if (feedSnapshot) localStorage.setItem(feedVisitKey(accountId, cityId), JSON.stringify(feedSnapshot));
      setVisitRevision((revision) => revision + 1);
    } catch { /* Leave unread changes visible when storage fails. */ }
  }
  const pressIds = feedResult?.state === 'available'
    ? new Set(feedResult.feed.sources.filter((source) => source.kind === 'press').map((source) => source.id)) : new Set<string>();
  const news = feedResult?.state === 'available' ? feedResult.feed.items
    .filter((item) => item.kind === 'news' && pressIds.has(item.sourceId) && externalUrl(item.url))
    .toSorted((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 3) : [];
  const leadIds = new Set(news.map((item) => `feed:${item.id}`));
  const followedSignalIds = new Set(followed.filter((entry) => entry.target.cityId === cityId)
    .flatMap(({ target }) => target.kind === 'signal' ? [target.id] : caseForTarget(target)?.signalIds ?? []));
  const changes = [
    ...signalChanges.filter((change) => relevant.has(change.id) && !followedSignalIds.has(change.id)),
    ...feedChanges.filter((change) => !leadIds.has(change.id)),
  ].slice(0, 3);
  const noFeed = feedResult?.state === 'available'
    ? feedResult.feed.sources.find((source) => source.kind === 'press' && source.status === 'not_available') : undefined;
  const pressCollected = feedResult?.state === 'available'
    ? feedResult.feed.sources.filter((source) => source.kind === 'press').map((source) => source.retrievedAt).sort().at(-1) : null;
  const cityName = cityDisplayName || feedResult?.cityName || (signalResult?.state === 'covered' ? signalResult.data.catalogue.name : 'your city');
  const highlighted = civicOutcomeEvidence.find((item) => item.cityId === cityId &&
    item.signalIds.some((id) => features.some((feature) => feature.properties.id === id)));
  const historicalExample = civicOutcomeEvidence.find((item) => item.id === MUNSTER_BUS_TRIAL_ID)!;
  const firstVisit = useMemo(() => {
    if (!accountId || !cityId || typeof window === 'undefined') return false;
    try { return !localStorage.getItem(visitKey(accountId, cityId)) && !localStorage.getItem(feedVisitKey(accountId, cityId)); }
    catch { return false; }
  }, [accountId, cityId]);

  const ready = (tenancies ?? []).filter((tenancy): tenancy is TenancyJourney => !('unavailable' in tenancy));
  const actionable = ready.find((tenancy) => !waitingFor(tenancy) && tenancy.next.kind !== 'done');
  const waiting = ready.map((tenancy) => ({ tenancy, label: waitingFor(tenancy) })).filter(({ label }) => label);
  const applicants = listings.find((listing) => listing.relation === 'landlord' && listing.status === 'open' && listing.applicants > 0);
  const needsAction = invitation || Boolean(actionable || applicants);
  const needTitle = invitation ? 'Join your invitation' : actionable?.next.label ?? (applicants ? 'Review applicants' : 'Nothing needs you today');
  const needDetail = invitation ? 'Open the private invitation in Home.' : actionable?.property
    ?? (applicants ? `${applicants.title} · ${applicants.applicants} applicant(s)` : 'Your Home is here when you need it.');
  const showHomeStatus = tenancies === null || tenancies.length > 0 || invitation || Boolean(homeError)
    || listings.some((listing) => listing.status === 'open' && (listing.relation === 'landlord' || listing.relation === 'applicant'));

  return <div className="today-stack">

    {showHomeStatus && <section className={`today-attention${needsAction ? ' active' : ''}`} aria-label="Things needing your attention">
      <span className="eyebrow">{needsAction ? 'NEEDS YOU' : 'HOME STATUS'}</span>
      {tenancies === null && !invitation ? <span role="status">{homeError || <><Loader2 className="spin" size={17} /> Checking your home…</>}</span>
        : <><strong>{needTitle}</strong><span>{needDetail}</span>{needsAction && <button className="text-button" onClick={() => actionable ? goToSection(go, 'home', `tenancy-${actionable.agreementId}`) : go('home')}>Take this step →</button>}</>}
      {waiting.map(({ tenancy, label }) => <span key={tenancy.agreementId} className="today-waiting">{tenancy.property} · {label}</span>)}
    </section>}

    <LedgerOverview request={request} accountId={accountId} tenancies={tenancies} listings={listings} homeError={homeError} cityId={cityId} cityName={cityName}
      selectedCity={selectedCity} cityLoading={!currentSignals && !signalError} cityError={signalError} followedCount={followed.length}
      followingError={following.storageError} go={go} />

    <section className="today-news" aria-label="Latest city news">
      <div className="today-news-head"><span className="eyebrow">LATEST OFFICIAL PRESS · {cityName}</span><span>German{feedResult?.state === 'available' ? ` · ${pressCollected ? `press collected ${formatCityDate(pressCollected)}` : `feed prepared ${formatCityDate(feedResult.feed.generatedAt)}`} · refreshed only when the collector runs` : ''}</span></div>
      {feedError && <p className="today-alert" role="status">City news could not be refreshed{feedResult?.state === 'available' ? '; showing the last checked feed.' : '.'}</p>}
      {news.length ? <>
        <a className="today-lead" href={news[0].url} target="_blank" rel="noopener noreferrer" lang="de"><span>OFFICIAL PRESS · GERMAN <ArrowUpRight size={16} aria-hidden /></span><strong>{news[0].title}</strong>
          <small>{news[0].publisher} · published {date.format(new Date(news[0].publishedAt))}</small></a>
        {news.length > 1 && <ol className="today-news-list">{news.slice(1).map((item) => <li key={item.id}>
          <a href={item.url} target="_blank" rel="noopener noreferrer" lang="de"><strong>{item.title}</strong> <ArrowUpRight size={15} aria-hidden /></a>
          <span>{item.publisher} · official press · German · published {date.format(new Date(item.publishedAt))}</span>
        </li>)}</ol>}
      </> : !cityId ? <p>{signalError ? 'Your city could not be checked right now.' : selectedCity ? <>No news feed from {cityName} yet. <button className="text-button" onClick={() => goToSection(go, 'places', 'city-choice')}>Choose a covered city in Places →</button></> : <>Choose your city to see official city news. <button className="text-button" onClick={() => goToSection(go, 'places', 'city-choice')}>Choose my city →</button></>}</p>
        : !feedResult && !feedError ? <p role="status">Reading official city news…</p>
          : feedResult?.state === 'not_available' ? <p>No news feed from {cityName} yet. Choose a covered city in Places.</p>
            : noFeed ? <p>No news feed from {cityName} yet. {noFeed.pageUrl && externalUrl(noFeed.pageUrl) && <a href={noFeed.pageUrl} target="_blank" rel="noopener noreferrer">Open the official news page <ArrowUpRight size={14} aria-hidden /></a>}</p>
              : <p>{feedError ? 'City news is temporarily unavailable.' : `No dated press news in the published feed for ${cityName}.`}</p>}
      <button className="text-button" onClick={() => goToSection(go, 'places', 'city-news')}>All city news & events →</button>
    </section>
    {(followed.length > 0 || following.storageError) && <section className="today-following" aria-label="Followed public projects">
      <div className="today-briefing-head"><div><span className="eyebrow">PUBLIC PROJECTS YOU FOLLOW</span><h2>{pending.length ? `${pending.length} update${pending.length === 1 ? '' : 's'} to review` : 'Followed projects'}</h2></div></div>
      {following.storageError && <p role="alert">{following.storageError}</p>}
      {pending.slice(0, 2).map(({ entry, update }) => <article key={`${entry.target.cityId}:${entry.target.id}:${update.sequence}`}>
        <strong>{update.snapshot.title} · {update.snapshot.cityName}</strong>
        {update.changes.map((change) => <p key={change.key}>{change.label}: {change.value}
          <small> {change.context}</small>{change.sourceUrl && <a href={change.sourceUrl} target="_blank" rel="noopener noreferrer"> Official/public source ↗</a>}</p>)}
        {following.sources[targetKey(entry.target)] && <small role="status">Source refresh unavailable; this saved update remains.</small>}
        <button className="text-button" onClick={() => openFollowed(entry.target, update.changes)}>Review exact project in Places →</button>
        <button className="text-button" onClick={() => following.acknowledge(entry.target, update.sequence, entry.instance)}>Mark this update read</button>
      </article>)}
      {pending.length > 2 && <p>{pending.length - 2} more saved update{pending.length - 2 === 1 ? '' : 's'} in Places.</p>}
      {sourceIssues.length > 0 && <p role="status">{sourceIssues.length} followed source{sourceIssues.length === 1 ? '' : 's'} unavailable; saved updates remain and no status was inferred.</p>}
      {!pending.length && !sourceIssues.length && <p>{checkingSources ? 'Checking followed public sources…' : 'No unread sourced developments. Following does not join a project or grant a role.'}</p>}
      <button className="text-button" onClick={() => goToSection(go, 'places', 'followed-projects')}>See followed projects in Places →</button>
    </section>}
    <div className="today-briefing">
      <section className="today-changes" aria-label="What changed near you">
        <div className="today-briefing-head"><div><span className="eyebrow">SINCE YOUR LAST VISIT</span><h2>What changed for you</h2></div></div>
        {signalError && <p role="status">City signals could not be refreshed{signalResult?.state === 'covered' ? '; showing last checked signals.' : '.'}</p>}
        {feedError && <p role="status">City feed changes could not be refreshed{feedResult?.state === 'available' ? '; showing last checked feed.' : '.'}</p>}
        {changes.length ? <><ul className="today-change-list">{changes.map((change) => <li key={change.id}>
          <strong>{change.title}</strong><span>{change.description} · {REVIEW_LABELS[change.reviewState as keyof typeof REVIEW_LABELS] ?? 'Not yet checked'}</span>
          <small>{relevant.get(change.id)?.explanation ?? 'Published city feed item'} · {change.id.startsWith('feed:') ? 'published' : 'source as of'} {date.format(new Date(change.asOf))}</small>
        </li>)}</ul><button type="button" className="secondary-button" onClick={markSeen}>Mark changes seen</button></> : !cityId ? <p>{selectedCity ? <>No published changes for {cityName} yet. <button className="text-button" onClick={() => goToSection(go, 'places', 'city-choice')}>Choose a covered city in Places →</button></> : <>Choose a city to see relevant changes. <button className="text-button" onClick={() => goToSection(go, 'places', 'city-choice')}>Choose my city →</button></>}</p>
          : !signalResult && !signalError ? <p role="status">Checking published city signals…</p>
            : signalResult?.state === 'not_covered' && feedResult?.state !== 'available' ? <p>This city does not have published signals yet.</p>
              : <p>{signalError || feedError ? 'No new changes in the last checked sources; refresh is currently unavailable.'
                : firstVisit ? 'First visit here: building a private baseline on this device. Check back for meaningful changes.'
                  : 'No new changes relevant to your chosen city and saved map pins since your last visit.'}</p>}
        <details className="today-on-demand"><summary>How changes are chosen</summary><p>Changes since the last successful visit on this device; nearby uses only saved browser map pins. Pins never leave this device.</p></details>
        <button className="text-button" onClick={() => goToSection(go, 'places', 'personal-map')}>Explore public changes →</button>
      </section>
      {(highlighted || cityId === 'muenster') && <section className="today-region today-system-preview" aria-label="City project evidence preview">
        {highlighted && <><div className="today-briefing-head"><div><span className="eyebrow">PLACE → OUTPUT → OUTCOME</span><h2>{highlighted.title}</h2></div></div>
          <div className="today-system-track"><span>⌖ Published place</span><span>▣ {highlighted.outputs.some((item) => item.basis === 'reported_output') ? 'Reported physical output' : highlighted.outputs.some((item) => item.basis === 'planned') ? 'Planned output' : 'Published status'}</span><span>◇ Outcome evidence missing</span></div>
          <button className="text-button" onClick={() => openCivicProject(go, highlighted.cityId, highlighted.id)}>See the selected project evidence →</button></>}
        {cityId === 'muenster' && <div className="today-historical-example"><span className="eyebrow">HISTORICAL MEASURED EXAMPLE · MÜNSTER 2021</span>
          <strong>{historicalExample.title}</strong><small>Official bus GPS report: 251 → 235 seconds on the same whole route, before/during. Not a proven causal benefit or current city status.</small>
          <button className="text-button" onClick={() => openCivicProject(go, historicalExample.cityId, historicalExample.id)}>Explore the Münster evidence →</button></div>}
      </section>}
    </div>
  </div>;
}
