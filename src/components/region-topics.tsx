'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { RegionalTopicResult } from '@/server/city-signals';
import { REVIEW_LABELS } from './personal-map-relevance';
import type { AuthorizedRequest } from './use-city-signals';

const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/Berlin' });
export const externalTopicUrl = (url: string) => url.startsWith('https://') || url.startsWith('http://');
const stageLabels: Record<string, string> = {
  adopted: 'Adopted', decision_recorded: 'Decision recorded', evaluation: 'Evaluation',
  decision_pending: 'Decision pending', consultation_closed: 'Consultation closed',
  consultation: 'Consultation', draft: 'Draft', planning: 'Planning',
  referred: 'Referred', agenda: 'On the agenda',
};
export const regionalStageLabel = (stage: string | null) => stage ? stageLabels[stage] ?? stage.replaceAll('_', ' ') : 'Stage not supplied';

export function useRegionalTopics(request: AuthorizedRequest, cityId: string) {
  const [view, setView] = useState<{ cityId: string; result: RegionalTopicResult | null; error: string }>({ cityId: '', result: null, error: '' });
  useEffect(() => {
    if (!cityId) return;
    let active = true;
    request<RegionalTopicResult>(`/api/region-topics?city=${encodeURIComponent(cityId)}`)
      .then((result) => { if (active) setView({ cityId, result, error: '' }); })
      .catch(() => { if (active) setView((previous) => ({
        cityId, result: previous.cityId === cityId ? previous.result : null, error: 'Regional topics could not be refreshed.',
      })); });
    return () => { active = false; };
  }, [request, cityId]);
  return view.cityId === cityId ? view : { cityId, result: null, error: '' };
}

export function CityRegionTopics({ request, cityId }: { request: AuthorizedRequest; cityId: string }) {
  const { result, error } = useRegionalTopics(request, cityId);
  if (result?.state !== 'available') return null;
  const topics = result.topics.filter((topic) => externalTopicUrl(topic.furthest.source.url));
  if (!topics.length) return null;
  return <section className="card places-section city-region-topics" aria-label="In your region" id="regional-topics">
    <div className="places-heading"><div><span className="eyebrow">REGIONAL PUBLISHED SOURCES · {result.regionName.toUpperCase()}</span><h2>In your region</h2></div></div>
    {error && <p className="small-copy" role="status">{error} Showing last checked topics.</p>}
    <p className="small-copy">Shared topics are ranked with your city&apos;s source items first. Summaries are not yet checked; each municipality&apos;s stage is shown separately. An agenda does not mean adoption.</p>
    <ul className="regional-topics-list">{topics.map((topic) => <li key={topic.id}>
      <h3>{topic.label}</h3><p>{topic.summary} · {REVIEW_LABELS[topic.reviewState] ?? 'Not yet checked'}</p>
      <p className="small-copy">{topic.neighbours.length + Number(topic.items.length > 0)} municipalities have source items · Furthest along: <a href={topic.furthest.source.url} target="_blank" rel="noopener noreferrer">{topic.furthest.name} <ArrowUpRight size={12} aria-hidden /></a> ({regionalStageLabel(topic.furthest.stage)})</p>
      {topic.items.length > 0 && <p className="small-copy">In your city: {regionalStageLabel(topic.stage)}</p>}
      <ul>{topic.items.filter((item) => externalTopicUrl(item.url)).map((item) => <li key={`${item.url}:${item.locator}`}>
        <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title} <ArrowUpRight size={12} aria-hidden /></a>
        <span className="small-copy"> · {item.sourceType === 'planningProcedure' ? 'Planning procedure' : item.sourceType === 'councilAgenda' ? 'Council agenda' : 'City website'} · {item.date ? date.format(new Date(item.date)) : 'date not supplied'} · {item.locator}</span>
      </li>)}</ul>
      {topic.neighbours.length > 0 && <details className="regional-topic-neighbours"><summary>Related sources in {topic.neighbours.length} other {topic.neighbours.length === 1 ? 'municipality' : 'municipalities'}</summary>
        <ul>{topic.neighbours.filter((other) => externalTopicUrl(other.source.url)).map((other) => <li key={`${other.name}:${other.source.url}`}>
          <strong>{other.name}</strong> · {regionalStageLabel(other.stage)} ·
          {' '}<a href={other.source.url} target="_blank" rel="noopener noreferrer">{other.source.title} <ArrowUpRight size={12} aria-hidden /></a>
          <span className="small-copy"> · {other.source.date ? date.format(new Date(other.source.date)) : 'date not supplied'} · {other.source.locator}</span>
        </li>)}</ul>
      </details>}
    </li>)}</ul>
  </section>;
}
