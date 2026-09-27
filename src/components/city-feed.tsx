'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { CityFeedResult } from '@/server/city-signals';
import type { AuthorizedRequest } from './use-city-signals';

const publishedDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/Berlin' });
const eventDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' });

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

export function CityFeedList({ request, cityId }: { request: AuthorizedRequest; cityId: string }) {
  const { result, error } = useCityFeed(request, cityId);
  const items = result?.state === 'available'
    ? result.feed.items.filter((item) => item.url.startsWith('https://') || item.url.startsWith('http://')).toSorted((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    : [];
  const unavailablePress = result?.state === 'available'
    ? result.feed.sources.find((source) => source.kind === 'press' && source.status === 'not_available')
    : undefined;
  return <section className="card city-feed-card" aria-label="City news and events">
    <div className="section-heading"><div><span className="eyebrow">FROM PUBLISHED CITY SOURCES</span><h2>City news & events</h2></div></div>
    {error && <p role="status">City feed could not be refreshed. {result?.state === 'available' ? 'Showing the last checked feed.' : error}</p>}
    {!cityId ? <p>Choose your city to see its published news and events.</p>
      : !result && !error ? <p role="status">Reading city feed…</p>
        : !result ? <p>City feed is temporarily unavailable.</p>
          : result.state === 'not_available' ? <p>No news feed from {result.cityName} yet. Choose a covered city or check its official website directly.</p>
            : items.length === 0 ? <p>{unavailablePress ? `No news feed from ${result.cityName} yet.` : `No dated news or event items in the published feed for ${result.cityName}.`} {unavailablePress?.pageUrl && (unavailablePress.pageUrl.startsWith('https://') || unavailablePress.pageUrl.startsWith('http://')) && <a href={unavailablePress.pageUrl} target="_blank" rel="noopener noreferrer">Open the city&apos;s news page <ArrowUpRight size={14} aria-hidden /></a>}</p>
              : <ol className="city-feed-list">{items.map((item) => <li key={item.id}>
                <span className="eyebrow">{item.kind === 'event' ? 'EVENT' : 'NEWS'}</span>
                <a href={item.url} target="_blank" rel="noopener noreferrer"><strong>{item.title}</strong> <ArrowUpRight size={14} aria-hidden /></a>
                <span className="small-copy">{item.publisher} · {item.kind === 'event' && item.eventStart ? `event ${eventDate.format(new Date(item.eventStart))}` : `published ${publishedDate.format(new Date(item.publishedAt))}`}</span>
              </li>)}</ol>}
  </section>;
}
