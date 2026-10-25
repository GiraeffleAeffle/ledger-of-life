import type { CityFeature, CityFeed, SignalKind } from '@/server/city-signals';
import type { SourceVerification } from '../data/city-source-evidence.ts';

type VisitRecord = {
  id: string; version: string | number; kind: SignalKind; title: string; statement: string;
  status: string; startDate: string | null; endDate: string | null; nextStep: string | null;
  geometryPrecision: string; reviewState: string; asOf: string;
  verification?: SourceVerification;
};
export type VisitBaseline = { schemaVersion: 1; records: Record<string, VisitRecord> };
export type VisitChange = { id: string; title: string; description: string; reviewState: string; asOf: string; verification?: SourceVerification };
type FeedVisitRecord = {
  id: string; kind: 'news' | 'event'; title: string; publisher: string;
  url: string; publishedAt: string; eventStart: string | null; reviewState: string;
};
export type FeedVisitBaseline = { schemaVersion: 1; records: Record<string, FeedVisitRecord> };
/** A visit does not acknowledge published changes. Only the explicit seen action advances a valid baseline. */
export function baselineForVisit<T extends VisitBaseline | FeedVisitBaseline>(previous: T | null, current: T): T {
  return previous?.schemaVersion === 1 && previous.records ? previous : current;
}


/** Feed retrieval timestamps and source order are not publication changes. */
export function snapshotCityFeed(feed: CityFeed): FeedVisitBaseline {
  const records: Record<string, FeedVisitRecord> = {};
  for (const item of feed.items) {
    records[item.id] = {
      id: item.id, kind: item.kind, title: item.title, publisher: item.publisher, url: item.url,
      publishedAt: item.publishedAt, eventStart: item.eventStart, reviewState: item.reviewState,
    };
  }
  return { schemaVersion: 1, records };
}

export function meaningfulFeedChanges(previous: FeedVisitBaseline | null, current: FeedVisitBaseline): VisitChange[] {
  if (!previous || previous.schemaVersion !== 1 || !previous.records) return [];
  const changes: VisitChange[] = [];
  for (const item of Object.values(current.records)) {
    const old = previous.records[item.id];
    let description = '';
    if (!old) description = item.kind === 'event' ? 'Newly available city event' : 'Newly available city news';
    else if (old.reviewState !== item.reviewState) description = 'Review updated';
    else if (old.eventStart !== item.eventStart || old.publishedAt !== item.publishedAt) description = 'Date corrected';
    else if (old.title !== item.title || old.publisher !== item.publisher || old.url !== item.url) description = 'Headline or source corrected';
    if (description) changes.push({ id: `feed:${item.id}`, title: item.title, description, reviewState: item.reviewState, asOf: item.publishedAt });
  }
  return changes;
}

/** Store public display fields, not private pins or a publisher's evidence hash alone. */
export function snapshotCitySignals(features: CityFeature[]): VisitBaseline {
  const records: Record<string, VisitRecord> = {};
  for (const { properties: p } of features) {
    if (p.kind === 'place') continue;
    records[p.id] = {
      id: p.id, version: p.version, kind: p.kind, title: p.title, statement: p.statement,
      status: p.status, startDate: p.startDate, endDate: p.endDate, nextStep: p.nextStep,
      geometryPrecision: p.geometryPrecision, reviewState: p.reviewState, asOf: p.asOf,
      ...(p.verification ? { verification: p.verification } : {}),
    };
  }
  return { schemaVersion: 1, records };
}

/** A review decision and user-facing correction count; a changed source hash by itself does not. */
export function meaningfulVisitChanges(previous: VisitBaseline | null, current: VisitBaseline, relevantIds: Set<string>): VisitChange[] {
  if (!previous || previous.schemaVersion !== 1 || !previous.records) return [];
  const changes: VisitChange[] = [];
  for (const record of Object.values(current.records)) {
    if (!relevantIds.has(record.id)) continue;
    const old = previous.records[record.id];
    let description = '';
    if (!old) description = 'Newly available in city sources';
    else if (old.reviewState !== record.reviewState || old.verification?.status !== record.verification?.status) description = 'Review updated';
    else if (old.status !== record.status || old.startDate !== record.startDate || old.endDate !== record.endDate)
      description = 'Status or date updated';
    else if (old.title !== record.title || old.statement !== record.statement || old.nextStep !== record.nextStep)
      description = 'Details corrected';
    else if (old.geometryPrecision !== record.geometryPrecision) description = 'Location precision updated';
    if (description) changes.push({ id: record.id, title: record.title, description, reviewState: record.reviewState, asOf: record.asOf, ...(record.verification ? { verification: record.verification } : {}) });
  }
  // A missing record may mean a partial publication or ID migration, not withdrawal.
  return changes;
}
