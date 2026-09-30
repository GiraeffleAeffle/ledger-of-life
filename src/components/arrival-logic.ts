import { ARRIVAL_SITUATIONS } from '../data/arrival/types.ts';
import type { ArrivalGroup, ArrivalInterest, ArrivalSituation, ArrivalStep } from '../data/arrival/types.ts';
import type { CityFeedItem } from '../server/city-signals.ts';
import { interestMatchesText } from './personal-map-relevance.ts';

export interface ArrivalProfile { situations: ArrivalSituation[]; interests: ArrivalInterest[] }
export const emptyProfile = (): ArrivalProfile => ({ situations: [], interests: [] });
export const welcomeStorageKey = (cityId: string) => `ledger-of-life:welcome:v1:${cityId}`;

function allowed<T extends string>(value: unknown, vocabulary: readonly T[]): T[] {
  return Array.isArray(value) ? vocabulary.filter((entry) => value.includes(entry)) : [];
}
export function parseProfile(raw: string | null): ArrivalProfile {
  if (!raw) return emptyProfile();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyProfile();
    const object = value as Record<string, unknown>;
    return { situations: allowed(object.situations, ARRIVAL_SITUATIONS), interests: [] };
  } catch { return emptyProfile(); }
}
export function serializeProfile(profile: ArrivalProfile): string {
  return JSON.stringify({ situations: allowed(profile.situations, ARRIVAL_SITUATIONS) });
}
export function stepMatches(step: ArrivalStep, profile: ArrivalProfile): boolean {
  return Boolean(step.situations?.some((item) => profile.situations.includes(item)) || step.interests?.some((item) => profile.interests.includes(item)));
}
export function orderSteps(steps: readonly ArrivalStep[], profile: ArrivalProfile): ArrivalStep[] {
  return [...steps].sort((a, b) => Number(stepMatches(b, profile)) - Number(stepMatches(a, profile)));
}
export function groupMatches(group: ArrivalGroup, interests: readonly ArrivalInterest[]): boolean {
  return group.interests.some((interest) => interests.includes(interest));
}
export function filterGroups(groups: readonly ArrivalGroup[], interests: readonly ArrivalInterest[], search: string, onlyMatching = false): ArrivalGroup[] {
  const query = search.trim().toLocaleLowerCase();
  return groups.filter((group) => (!onlyMatching || (interests.length > 0 && groupMatches(group, interests))) &&
    (!query || [group.name, group.kind, group.summary, group.address ?? '', group.tryFirst ?? ''].some((part) => part.toLocaleLowerCase().includes(query))))
    .sort((a, b) => Number(groupMatches(b, interests)) - Number(groupMatches(a, interests)));
}

// The Places matcher checks the published feed title, never the reader's private choices on the server.
export function feedMatches(item: CityFeedItem, interests: readonly ArrivalInterest[]): ArrivalInterest[] {
  return interests.filter((interest) => interestMatchesText(item.title, interest));
}
export function selectFeed(items: readonly CityFeedItem[], now: Date, interests: readonly ArrivalInterest[]) {
  const start = now.getTime();
  const end = start + 21 * 24 * 60 * 60 * 1000;
  const accessible = items.filter((item) => /^https?:\/\//.test(item.url));
  const events = accessible.filter((item) => item.kind === 'event' && item.eventStart &&
    Number.isFinite(Date.parse(item.eventStart)) && Date.parse(item.eventStart) >= start && Date.parse(item.eventStart) <= end)
    .sort((a, b) => Date.parse(a.eventStart!) - Date.parse(b.eventStart!));
  const news = accessible.filter((item) => item.kind === 'news' && Number.isFinite(Date.parse(item.publishedAt)))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 3);
  const matchedFirst = (list: CityFeedItem[]) => list.sort((a, b) => Number(feedMatches(b, interests).length > 0) - Number(feedMatches(a, interests).length > 0));
  return { events: matchedFirst(events), news: matchedFirst(news) };
}
