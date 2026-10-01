'use client';
import { useEffect, useState } from 'react';
import type { SignalResult } from '@/server/city-signals';
import type { AuthorizedRequest } from './use-city-signals';
import { selectCouncilRecords, type CouncilRecord } from './civic-decisions';
import { useEventClock } from './city-feed';
import { formatCityDate } from './city-coverage';

export function CivicDecisionsPanel({ request, cityId }: { request: AuthorizedRequest; cityId: string }) {
  const [view, setView] = useState<{ cityId: string; result?: SignalResult; error?: string }>({ cityId: '' });
  const now = useEventClock();
  useEffect(() => {
    if (!cityId || cityId === 'strausberg') return;
    let active = true;
    request<SignalResult>(`/api/city-signals?city=${encodeURIComponent(cityId)}`)
      .then((result) => { if (active) setView({ cityId, result }); })
      .catch(() => { if (active) setView({ cityId, error: 'Published council records unavailable.' }); });
    return () => { active = false; };
  }, [cityId, request]);
  if (!cityId) return <p>Choose a city to read its published council records.</p>;
  if (cityId === 'strausberg') return <p>Links only: no working public Strausberg OParl endpoint was confirmed. The district endpoint requires permission; its records are not imported.</p>;
  if (view.cityId !== cityId || !view.result) return <p role="status">{view.cityId === cityId && view.error ? view.error : 'Reading published council records…'}</p>;
  if (view.result.state !== 'covered') return <p>No council snapshot published for this city.</p>;
  if (now === null) return <p role="status">Checking upcoming meeting dates…</p>;
  const selected = selectCouncilRecords(view.result.data.signals.features, now);
  const list = (records: CouncilRecord[]) => <ul>{records.map((record) => <li key={record.id}><a href={record.url} target="_blank" rel="noopener noreferrer">{record.title} ↗</a><p>{record.date ? formatCityDate(record.date) : 'Date not published'} · {record.body} · agenda, not a decision</p></li>)}</ul>;
  return <div>
    <p className="places-meta">Published snapshot {formatCityDate(view.result.data.generatedAt)} · refreshed only when the collector runs. Body identifiers are shown where the snapshot has no body name.</p>
    <h3>Upcoming meetings</h3>{selected.meetings.length ? list(selected.meetings) : <p>No upcoming meetings in this published snapshot; check the official source for changes.</p>}
    <h3>Latest papers</h3>{selected.papers.length ? list(selected.papers) : <p>No papers in this published snapshot.</p>}
    <p className="places-meta">Agendas and papers do not establish a vote, adoption or delivery. Only attributed titles, dates and official links are shown.</p>
  </div>;
}
