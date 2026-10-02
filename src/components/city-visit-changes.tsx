'use client';
import { useState } from 'react';
import type { AuthorizedRequest } from './use-city-signals';
import { useCityVisitChanges } from './use-city-visit-changes';
import { REVIEW_LABELS } from './personal-map-relevance';
import { formatCityDate } from './city-coverage';

export function CityVisitChanges({ request, accountId }: { request: AuthorizedRequest; accountId: string }) {
  const visit = useCityVisitChanges(request, accountId);
  const [expandedCity, setExpandedCity] = useState<string | null>(null);
  const expanded = expandedCity === visit.cityId;
  const cityName = visit.city?.name || 'your city';
  return <section className="card today-changes" id="city-changes" tabIndex={-1} aria-label="City changes since your last visit">
    <div className="section-heading"><div><span className="eyebrow">SINCE YOU LAST MARKED CHANGES SEEN</span><h2>What changed for you</h2>
      {visit.city?.name && <p className="small-copy">{cityName}</p>}
    </div></div>
    {visit.error && <p role="status">City signals could not be refreshed. {visit.error}</p>}
    {visit.feedError && <p role="status">City feed changes could not be refreshed. {visit.feedError}</p>}
    {visit.storageError && <p role="alert">{visit.storageError}</p>}
    {visit.followingStorageError && <p role="alert">{visit.followingStorageError}</p>}
    {visit.result?.state === 'not_covered' && <p>This city does not have published signals yet; signal changes are unknown.</p>}
    {visit.feed?.state === 'not_available' && <p>No published news or event feed for {cityName} yet; feed changes are unknown.</p>}
    {visit.feed?.state === 'available' && visit.feed.feed.sources.some((source) => source.status === 'not_available') && <p>Some city feed sources are not available. Changes below cover only published sources.</p>}
    {visit.loading && <p role="status">Checking published city signals and feed changes…</p>}
    {visit.changes.length > 0 ? <>
      <p>{visit.changes.length} matching city update{visit.changes.length === 1 ? '' : 's'} to review.</p>
      <ul className="today-change-list">{(expanded ? visit.changes : visit.changes.slice(0, 3)).map((change) => <li key={change.id}>
        <strong>{change.title}</strong>
        <span>{change.description} · {REVIEW_LABELS[change.reviewState as keyof typeof REVIEW_LABELS] ?? 'Not yet checked'}</span>
        <small>{visit.relevant.get(change.id) ?? 'Published city feed item'} · {change.id.startsWith('feed:') ? 'published' : 'source as of'} {formatCityDate(change.asOf)}</small>
      </li>)}</ul>
      {visit.changes.length > 3 && <button type="button" className="text-button" onClick={() => setExpandedCity(expanded ? null : visit.cityId)}>{expanded ? 'Show fewer changes' : `Show all ${visit.changes.length} changes`}</button>}
      <button type="button" className="secondary-button" onClick={visit.markSeen}>Mark changes seen</button>
    </> : !visit.cityId && !visit.loading && !visit.error ? <p>{visit.city?.name ? `No published changes for ${cityName} yet.` : 'Choose or preview a city above to check published changes.'}</p>
      : !visit.loading && !visit.unavailable && <p>{visit.firstVisit
        ? 'First visit here: building a private baseline on this device. Check back for meaningful changes.'
        : 'No new matching changes in the published sources since you last marked changes seen.'}</p>}
    {visit.pendingCount > 0 && <p>{visit.pendingCount} pending followed-project update{visit.pendingCount === 1 ? '' : 's'} are listed separately. <a href="#followed-projects">Review followed projects →</a></p>}
    <details className="today-on-demand"><summary>How changes are chosen</summary><p>Public signal changes match your home, saved device map pins, and city interests. News and events use the published city feed. The first successful snapshot starts a private baseline for this account and city on this device. Only “Mark changes seen” advances it; leaving Today does not. Followed-project updates are reviewed separately. Pins never leave this device.</p></details>
  </section>;
}
