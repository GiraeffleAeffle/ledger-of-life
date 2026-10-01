'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { CityFeedItem, CityFeedResult } from '@/server/city-signals';
import type { AuthorizedRequest } from './use-city-signals';
import { formatCityDate, formatCityEventDate } from './city-coverage';

export function useCityFeed(request: AuthorizedRequest, cityId: string) {
  const [view, setView] = useState<{ cityId: string; result: CityFeedResult | null; error: string }>({ cityId: '', result: null, error: '' });
  useEffect(() => {
    if (!cityId) return;
    let active = true;
    request<CityFeedResult>(`/api/city-feed?city=${encodeURIComponent(cityId)}`)
      .then((result) => { if (active) setView({ cityId, result, error: '' }); })
      .catch((cause) => { if (active) setView((previous) => ({
        cityId, result: previous.cityId === cityId ? previous.result : null,
        error: cause instanceof Error ? cause.message : 'City feed unavailable.',
      })); });
    return () => { active = false; };
  }, [request, cityId]);
  return view.cityId === cityId ? view : { cityId, result: null, error: '' };
}
const subscribeClock = (changed: () => void) => {
  const timer = window.setInterval(changed, 60_000);
  return () => window.clearInterval(timer);
};
const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000;
const serverClock = () => null;
export function useEventClock() {
  return useSyncExternalStore<number | null>(subscribeClock, currentMinute, serverClock);
}
export type EventTimeState = 'upcoming' | 'past' | 'scheduled' | 'date unknown';
export function eventTimeState(item: CityFeedItem, now: number | null): EventTimeState {
  const start = item.eventStart ? Date.parse(item.eventStart) : NaN;
  return Number.isNaN(start) ? 'date unknown' : now === null ? 'scheduled' : start >= now ? 'upcoming' : 'past';
}

function FeedItems({ items, cityId, now, onSelectEvent }: { items: CityFeedItem[]; cityId: string; now: number | null; onSelectEvent?: (cityId: string, id: string) => void }) {
  return <ol className="city-feed-list">{items.map((item) => <li key={item.id}>
    <span className="eyebrow">{item.kind === 'event' ? `EVENT · ${eventTimeState(item, now).toUpperCase()}${item.geometry ? ' · MAPPED VENUE' : ' · UNLOCATED'}` : 'CITY NEWS'}</span>
    <a href={item.url} target="_blank" rel="noopener noreferrer"><strong>{item.title}</strong> <ArrowUpRight size={14} aria-hidden /></a>
    <span className="small-copy">{item.publisher} · {item.kind === 'event'
      ? `${item.eventStart && !Number.isNaN(Date.parse(item.eventStart)) ? formatCityEventDate(item.eventStart) : 'event date unknown'} · ${item.venue ?? 'venue not supplied'}${item.geometryPrecision === 'approximate' ? ' · approximate venue point' : ''}`
      : `published ${formatCityDate(item.publishedAt)}`}</span>
    {item.kind === 'event' && onSelectEvent && <button type="button" className="city-feed-map-action" onClick={() => onSelectEvent(cityId, item.id)}>{item.geometry ? 'Show venue on map →' : 'View event source details →'}</button>}
    {item.kind === 'event' && !item.geometry && <span className="small-copy">No sourced venue coordinate · no map pin</span>}
  </li>)}</ol>;
}

export function CityFeedList({ cityId, result, error, onSelectEvent }: {
  cityId: string; result: CityFeedResult | null; error: string; onSelectEvent?: (cityId: string, id: string) => void;
}) {
  const items = result?.state === 'available'
    ? result.feed.items.filter((item) => item.url.startsWith('https://') || item.url.startsWith('http://'))
    : [];
  const now = useEventClock();
  const events = items.filter((item) => item.kind === 'event').toSorted((a, b) => {
    const stateA = eventTimeState(a, now);
    const stateB = eventTimeState(b, now);
    const rank = { upcoming: 0, scheduled: 1, past: 2, 'date unknown': 3 };
    if (rank[stateA] !== rank[stateB]) return rank[stateA] - rank[stateB];
    if (stateA === 'date unknown') return 0;
    return stateA === 'past' ? Date.parse(b.eventStart!) - Date.parse(a.eventStart!) : Date.parse(a.eventStart!) - Date.parse(b.eventStart!);
  });
  const news = items.filter((item) => item.kind !== 'event').toSorted((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const unavailablePress = result?.state === 'available'
    ? result.feed.sources.find((source) => source.kind === 'press' && source.status === 'not_available')
    : undefined;
  return <section className="card city-feed-card" id="city-news" tabIndex={-1} aria-label="City news and events">
    <div className="section-heading"><div><span className="eyebrow">PUBLISHED CITY FEED</span><h2>Events &amp; city news in {result?.state === 'available' ? result.cityName : result?.state === 'not_available' ? result.cityName : 'your city'}</h2>{result?.state === 'available' && <p className="small-copy">{cityId === 'koeln' ? 'koeln.de events' : 'Source-attributed city headlines & events'} · published snapshot from {formatCityDate(result.feed.generatedAt)} · refreshed only when the collector runs.</p>}</div><span className="city-feed-place">Only sourced venue coordinates appear on the map.</span></div>
    {result?.state === 'not_available' && <p className="small-copy">Published catalogue snapshot {formatCityDate(result.generatedAt)} · refreshed only when the collector runs.</p>}
    {error && <p role="status">City feed could not be refreshed. {result?.state === 'available' ? 'Showing the last checked feed.' : error}</p>}
    {!cityId ? <p>Choose your city to see its published news and events.</p>
      : !result && !error ? <p role="status">Reading city feed…</p>
        : !result ? <p>City feed is temporarily unavailable.</p>
          : result.state === 'not_available' ? <p>No published feed for {result.cityName}. Choose a covered city or check its official website directly.</p>
            : items.length === 0 ? <p>{unavailablePress ? `No published feed for ${result.cityName}.` : `No dated news or event items in the published feed for ${result.cityName}.`} {unavailablePress?.pageUrl && (unavailablePress.pageUrl.startsWith('https://') || unavailablePress.pageUrl.startsWith('http://')) && <a href={unavailablePress.pageUrl} target="_blank" rel="noopener noreferrer">Open the city&apos;s news page <ArrowUpRight size={14} aria-hidden /></a>}</p>
              : <><div className="city-event-shelf"><strong>{events.length ? `Published events · ${events.length}` : 'No events in this published feed'}</strong>
                {events.length > 0 && <><FeedItems items={events.slice(0, 3)} cityId={cityId} now={now} onSelectEvent={onSelectEvent} />{events.length > 3 && <details className="city-feed-more"><summary>More events ({events.length - 3})</summary><FeedItems items={events.slice(3)} cityId={cityId} now={now} onSelectEvent={onSelectEvent} /></details>}</>}
              </div>{news.length > 0 && <details className="city-feed-more"><summary>City news · {news.length}</summary><FeedItems items={news} cityId={cityId} now={now} /></details>}</>}
  </section>;
}
