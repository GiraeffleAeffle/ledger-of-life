'use client';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CityFeature, Coordinate } from '@/server/city-signals';
import { useCityFeed } from './city-feed';
import { useCitySignals, type AuthorizedRequest } from './use-city-signals';
import { useInterests, usePersonalPins } from './personal-map-preferences';
import { matchPersonalRings } from './personal-map-relevance';
import { useProjectFollowing } from './use-project-following';
import { caseForTarget } from './project-following';
import { baselineForVisit, meaningfulFeedChanges, meaningfulVisitChanges, snapshotCityFeed, snapshotCitySignals, type FeedVisitBaseline, type VisitBaseline } from './visit-diff';

const emptyFeatures: CityFeature[] = [];
const VISIT_CHANGED_EVENT = 'ledger-city-visit-changed';
const visitKey = (accountId: string, cityId: string) => `ledger-of-life:today-visit:v1:${accountId}:${cityId}`;
const feedVisitKey = (accountId: string, cityId: string) => `ledger-of-life:today-feed-visit:v1:${accountId}:${cityId}`;
function subscribeVisits(update: () => void) {
  window.addEventListener(VISIT_CHANGED_EVENT, update);
  window.addEventListener('storage', update);
  return () => { window.removeEventListener(VISIT_CHANGED_EVENT, update); window.removeEventListener('storage', update); };
}
function readBaseline(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}
function parseBaseline<T extends VisitBaseline | FeedVisitBaseline>(raw: string): T | null {
  try {
    const value = JSON.parse(raw || 'null') as T | null;
    return value?.schemaVersion === 1 && value.records ? value : null;
  } catch { return null; }
}

export function useCityVisitChanges(request: AuthorizedRequest, accountId: string) {
  const citySignals = useCitySignals(request);
  const { cityId, city, result: signals, error: signalError, homePin } = citySignals;
  const { result: feed, error: feedError } = useCityFeed(request, cityId);
  const devicePins = usePersonalPins(cityId, accountId);
  const interests = useInterests();
  const following = useProjectFollowing(accountId, request);
  const [storageError, setStorageError] = useState('');
  const [initialVisit, setInitialVisit] = useState<{ accountId: string; cityId: string; first: boolean } | null>(null);
  const signalRaw = useSyncExternalStore(subscribeVisits, () => accountId && cityId ? readBaseline(visitKey(accountId, cityId)) : '', () => '');
  const feedRaw = useSyncExternalStore(subscribeVisits, () => accountId && cityId ? readBaseline(feedVisitKey(accountId, cityId)) : '', () => '');
  const previousSignals = useMemo(() => parseBaseline<VisitBaseline>(signalRaw), [signalRaw]);
  const previousFeed = useMemo(() => parseBaseline<FeedVisitBaseline>(feedRaw), [feedRaw]);
  const features = signals?.state === 'covered' && signals.data.catalogue.id === cityId ? signals.data.signals.features : emptyFeatures;
  const homeInside = homePin && signals?.state === 'covered' && homePin.lon >= signals.data.catalogue.bbox[0] && homePin.lon <= signals.data.catalogue.bbox[2] && homePin.lat >= signals.data.catalogue.bbox[1] && homePin.lat <= signals.data.catalogue.bbox[3];
  const pins = useMemo(() => ({ ...devicePins, home: devicePins.home ?? (homeInside && homePin ? [homePin.lon, homePin.lat] as Coordinate : undefined) }), [devicePins, homeInside, homePin]);
  const relevant = useMemo(() => {
    const rings = matchPersonalRings(features, pins, undefined, interests);
    const matches = new Map<string, string>();
    for (const match of [...rings.home, ...rings.commute, ...rings.city]) {
      if (match.feature.properties.kind !== 'place' && !matches.has(match.feature.properties.id))
        matches.set(match.feature.properties.id, match.explanation);
    }
    return matches;
  }, [features, pins, interests]);
  const signalSnapshot = useMemo(() => signals?.state === 'covered' && signals.data.catalogue.id === cityId && !signalError
    ? snapshotCitySignals(features) : null, [signals, cityId, signalError, features]);
  const feedSnapshot = useMemo(() => feed?.state === 'available' && feed.cityId === cityId && !feedError
    ? snapshotCityFeed(feed.feed) : null, [feed, cityId, feedError]);
  if (accountId && cityId && (signalSnapshot || feedSnapshot) &&
    (initialVisit?.accountId !== accountId || initialVisit.cityId !== cityId)) {
    setInitialVisit({ accountId, cityId, first: !previousSignals && !previousFeed });
  }

  // Only the first successful snapshot initializes history. Navigation never acknowledges changes.
  useEffect(() => {
    if (!accountId || !cityId) return;
    let initialized = false;
    try {
      for (const [key, snapshot] of [
        [visitKey(accountId, cityId), signalSnapshot],
        [feedVisitKey(accountId, cityId), feedSnapshot],
      ] as const) {
        if (!snapshot) continue;
        const previous = parseBaseline<VisitBaseline | FeedVisitBaseline>(localStorage.getItem(key) ?? '');
        if (baselineForVisit(previous, snapshot) === snapshot) {
          localStorage.setItem(key, JSON.stringify(snapshot));
          initialized = true;
        }
      }
      queueMicrotask(() => setStorageError(''));
    } catch { queueMicrotask(() => setStorageError('Visit history could not be saved on this device; unread changes cannot be reliably checked.')); }
    if (initialized) window.dispatchEvent(new Event(VISIT_CHANGED_EVENT));
  }, [accountId, cityId, signalSnapshot, feedSnapshot]);

  const followed = Object.values(following.store.entries);
  const followedSignalIds = new Set(followed.filter((entry) => entry.target.cityId === cityId)
    .flatMap(({ target }) => target.kind === 'signal' ? [target.id] : caseForTarget(target)?.signalIds ?? []));
  const changes = [
    ...(signalSnapshot ? meaningfulVisitChanges(previousSignals, signalSnapshot, new Set(relevant.keys())) : [])
      .filter((change) => !followedSignalIds.has(change.id)),
    ...(feedSnapshot ? meaningfulFeedChanges(previousFeed, feedSnapshot) : []),
  ];
  const pendingCount = followed.reduce((count, entry) => count + entry.pending.length, 0);
  function markSeen() {
    if (!accountId || !cityId) return;
    try {
      if (signalSnapshot) localStorage.setItem(visitKey(accountId, cityId), JSON.stringify(signalSnapshot));
      if (feedSnapshot) localStorage.setItem(feedVisitKey(accountId, cityId), JSON.stringify(feedSnapshot));
      setStorageError('');
      setInitialVisit({ accountId, cityId, first: false });
    } catch { setStorageError('Changes could not be marked seen on this device.'); }
    window.dispatchEvent(new Event(VISIT_CHANGED_EVENT));
  }
  const loading = !signalError && (!city || (Boolean(cityId) && !signals)) || Boolean(cityId) && !feed && !feedError;
  const unavailable = Boolean(signalError || feedError || storageError || following.storageError || (city?.name && !cityId))
    || signals?.state === 'not_covered' || feed?.state === 'not_available'
    || (feed?.state === 'available' && feed.feed.sources.some((source) => source.status === 'not_available'));
  return { ...citySignals, feed, feedError, changes, relevant, pendingCount, markSeen, storageError,
    loading, unavailable, followingStorageError: following.storageError,
    firstVisit: initialVisit?.accountId === accountId && initialVisit.cityId === cityId && initialVisit.first };
}
