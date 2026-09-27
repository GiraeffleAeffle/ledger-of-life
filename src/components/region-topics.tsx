'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { RegionalTopicResult } from '@/server/city-signals';
import { REVIEW_LABELS } from './personal-map-relevance';
import type { AuthorizedRequest } from './use-city-signals';

const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/Berlin' });
export const externalTopicUrl = (url: string) => url.startsWith('https://') || url.startsWith('http://');

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
  const topics = result.topics.filter((topic) => topic.items.some((item) => externalTopicUrl(item.url)));
  if (!topics.length) return null;
  return <section className="card places-section city-region-topics" aria-label="Regional topics involving your city" id="regional-topics">
    <div className="places-heading"><div><span className="eyebrow">REGIONAL PUBLISHED SOURCES · {result.regionName.toUpperCase()}</span><h2>Topics involving your city</h2></div></div>
    {error && <p className="small-copy" role="status">{error} Showing last checked topics.</p>}
    <p className="small-copy">Related public source items are grouped by topic. Interpretations are not yet checked; each municipality&apos;s stage is shown separately. Adoption is stated only when its source stage is adopted.</p>
    <ul className="regional-topics-list">{topics.map((topic) => <li key={topic.id}>
      <h3>{topic.label}</h3><p>{topic.summary}</p>
      <p className="small-copy">{topic.stage === 'adopted' ? 'Adopted' : `Stage: ${topic.stage}`} · {REVIEW_LABELS[topic.reviewState] ?? 'Not yet checked'}</p>
      <ul>{topic.items.filter((item) => externalTopicUrl(item.url)).map((item) => <li key={`${item.url}:${item.locator}`}>
        <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title} <ArrowUpRight size={12} aria-hidden /></a>
        <span className="small-copy"> · {item.sourceType === 'planningProcedure' ? 'Planning procedure' : item.sourceType === 'councilAgenda' ? 'Council agenda' : 'City website'} · {item.date ? date.format(new Date(item.date)) : 'date not supplied'} · {item.locator}</span>
      </li>)}</ul>
      {topic.neighbours.length > 0 && <details className="regional-topic-neighbours"><summary>Related sources in {topic.neighbours.length} other {topic.neighbours.length === 1 ? 'municipality' : 'municipalities'}</summary>
        <ul>{topic.neighbours.filter((other) => externalTopicUrl(other.source.url)).map((other) => <li key={`${other.name}:${other.source.url}`}>
          <strong>{other.name}</strong> · {other.stage === 'adopted' ? 'Adopted' : `Stage: ${other.stage}`} ·
          {' '}<a href={other.source.url} target="_blank" rel="noopener noreferrer">{other.source.title} <ArrowUpRight size={12} aria-hidden /></a>
          <span className="small-copy"> · {other.source.date ? date.format(new Date(other.source.date)) : 'date not supplied'} · {other.source.locator}</span>
        </li>)}</ul>
      </details>}
    </li>)}</ul>
  </section>;
}
