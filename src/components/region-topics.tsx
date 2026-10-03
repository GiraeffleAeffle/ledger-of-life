'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { RelevantRegionalTopic, RegionalTopicItem, RegionalTopicResult } from '@/server/city-signals';
import { REVIEW_LABELS } from './personal-map-relevance';
import type { AuthorizedRequest } from './use-city-signals';
import { formatCityDate } from './city-coverage';

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

function Evidence({ item }: { item: RegionalTopicItem }) {
  return <><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title} <ArrowUpRight size={12} aria-hidden /></a>
    <span className="regional-evidence"> · {item.sourceType === 'planningProcedure' ? 'Planning procedure' : item.sourceType === 'councilAgenda' ? 'Council agenda' : 'City website'} · {regionalStageLabel(item.stage)} · {item.date ? formatCityDate(item.date) : 'date not supplied'} · {item.locator}</span></>;
}

export function RegionalComparison({ topic, cityName, compact = false }: {
  topic: RelevantRegionalTopic; cityName: string; compact?: boolean;
}) {
  const local = topic.items.find((item) => externalTopicUrl(item.url));
  const neighbour = topic.neighbours.find((item) => externalTopicUrl(item.source.url));
  return <article className="regional-comparison">
    <h3>{topic.label}</h3>
    <div className="regional-comparison-rows">
      <div><span className="eyebrow">IN {cityName.toUpperCase()}</span>
        <strong>{local ? regionalStageLabel(local.stage) : 'No local item in this publication'}</strong>
        <p>{local ? `${local.sourceType === 'planningProcedure' ? 'The planning procedure' : local.sourceType === 'councilAgenda' ? 'The council agenda' : 'The city source'} names “${local.title}”.` : 'This topic is published elsewhere in the region; no source item names this city.'}</p>
        {local && <span className="regional-evidence">{local.date ? `Source dated ${formatCityDate(local.date)}` : 'Source date not supplied'}</span>}
      </div>
      <div><span className="eyebrow">ELSEWHERE IN YOUR REGION</span>
        <strong>{neighbour ? `${neighbour.name} · ${regionalStageLabel(neighbour.source.stage)}` : 'No other municipality listed'}</strong>
        <p>{neighbour ? `${neighbour.source.sourceType === 'planningProcedure' ? 'The planning procedure' : neighbour.source.sourceType === 'councilAgenda' ? 'The council agenda' : 'The city source'} names “${neighbour.source.title}”.` : 'No comparable source item published here.'}</p>
        {neighbour && <span className="regional-evidence">{neighbour.source.date ? `Source dated ${formatCityDate(neighbour.source.date)}` : 'Source date not supplied'}</span>}
      </div>
    </div>
    <span className="regional-review">{REVIEW_LABELS[topic.reviewState] ?? 'Not yet checked'} · comparison of separate published source items, not a shared outcome</span>
    {!compact && <details className="regional-topic-neighbours"><summary>Source evidence · {topic.items.length} local, {topic.neighbours.length} elsewhere</summary>
      {topic.summary && <p>{topic.summary} · {REVIEW_LABELS[topic.reviewState] ?? 'Not yet checked'}</p>}
      {topic.items.length > 0 && <><h4>In {cityName}</h4><ul>{topic.items.filter((item) => externalTopicUrl(item.url)).map((item) =>
        <li key={`${item.url}:${item.locator}`}><Evidence item={item} /></li>)}</ul></>}
      {topic.neighbours.length > 0 && <><h4>Other municipalities</h4><ul>{topic.neighbours.filter((item) => externalTopicUrl(item.source.url)).map((item) =>
        <li key={`${item.name}:${item.source.url}`}><strong>{item.name} · {regionalStageLabel(item.source.stage)}</strong> · <Evidence item={item.source} /></li>)}</ul></>}
      <p className="regional-evidence">Only records with real published locations appear on the map below; an unlocated topic is not placed at a town centre.</p>
    </details>}
  </article>;
}

export function CityRegionTopics({ request, cityId, cityName }: { request: AuthorizedRequest; cityId: string; cityName: string }) {
  const { result, error } = useRegionalTopics(request, cityId);
  const [showAll, setShowAll] = useState(false);
  if (result?.state !== 'available') return null;
  const topics = result.topics.filter((topic) => externalTopicUrl(topic.furthest.source.url));
  if (!topics.length) return null;
  return <section className="card places-section city-region-topics civic-support" aria-label="In your region" tabIndex={-1}>
    <div className="places-heading"><div><span className="eyebrow">REGIONAL PUBLISHED SOURCES · {result.regionName.toUpperCase()}</span><h2>What nearby towns are planning</h2></div></div>
    {error && <p className="small-copy" role="status">{error} Showing last checked topics.</p>}
    <p>Compare each town&apos;s source and stage separately. An agenda does not mean adoption.</p>
    <div className="regional-topics-list">{(showAll ? topics : topics.slice(0, 1)).map((topic) =>
      <RegionalComparison key={topic.id} topic={topic} cityName={cityName} />)}</div>
    {topics.length > 1 && <button className="text-button" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer topics' : `Show all ${topics.length} topics`}</button>}
    <a href="#personal-map">Explore published locations on the map ↓</a>
  </section>;
}
