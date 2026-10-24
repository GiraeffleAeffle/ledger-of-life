'use client';
import type { AuthorizedRequest } from './use-city-signals';
import { useCityVisitChanges } from './use-city-visit-changes';
import { sourceReviewLabel } from '@/data/city-source-evidence';
import { formatCityDate } from './city-coverage';
import { MoreRow, StatusLine } from './blocks';
import { goToSection, type Area } from './areas';

export function CityVisitChanges({ request, accountId, go }: { request: AuthorizedRequest; accountId: string; go: (area: Area) => void }) {
  const visit = useCityVisitChanges(request, accountId);
  const issue = visit.error || visit.feedError || visit.storageError || visit.followingStorageError;
  const hasUpdates = Boolean(visit.changes.length || visit.pendingCount || issue);
  const summary = visit.loading ? 'Checking changes since your last visit…'
    : issue ? 'Some city changes could not be checked.'
    : visit.changes.length ? `${visit.changes.length} matching update${visit.changes.length === 1 ? '' : 's'} since your last visit.`
    : visit.pendingCount ? `${visit.pendingCount} followed-project update${visit.pendingCount === 1 ? '' : 's'} to review.`
    : visit.unavailable ? 'No published changes available for this city.'
    : visit.city && !visit.cityId ? 'Choose a city to check changes.'
    : visit.firstVisit ? 'First visit · your private baseline is ready.'
    : 'Nothing new since your last visit.';
  return <section className="city-visit-line" aria-label="City changes since your last visit">
    {hasUpdates && <div className="city-visit-status"><StatusLine tone={issue ? 'alert' : visit.changes.length || visit.pendingCount ? 'action' : 'neutral'}>{summary}</StatusLine>
      {visit.changes.length > 0 && <button type="button" className="text-button" onClick={visit.markSeen}>Mark changes seen</button>}
    </div>}
    <MoreRow id="city-changes" title={hasUpdates ? 'What changed' : summary} meta={hasUpdates ? visit.changes[0]?.title || 'Changes and source coverage' : undefined}>
      {issue && <p role="alert">{issue}</p>}
      {visit.changes.length > 0 && <ul className="city-change-list">{visit.changes.map((change) => <li key={change.id}><strong>{change.title}</strong><p>{change.description} · {sourceReviewLabel(change.reviewState, change.verification)}</p><small>{visit.relevant.get(change.id) ?? 'Published city feed item'} · {formatCityDate(change.asOf)}</small></li>)}</ul>}
      {visit.pendingCount > 0 && <p>{visit.pendingCount} followed-project update{visit.pendingCount === 1 ? '' : 's'}. <a href="#followed-projects" onClick={(event) => { event.preventDefault(); goToSection(go, 'places', 'followed-projects'); }}>Review followed projects →</a></p>}
      <p>Changes match your home, device pins and city interests. Only “Mark changes seen” advances this account’s private baseline on this device. Followed-project updates are reviewed separately. Unavailable sources cannot show changes.</p>
    </MoreRow>
  </section>;
}
