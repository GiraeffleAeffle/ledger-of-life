'use client';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Signal } from '../server/city-signals';
import { acknowledgeFollow, caseForTarget, emptyFollowStore, follow, followKey, parseFollowStore, projectSnapshot,
  refreshFollow, targetKey, unfollow, type FollowStore, type FollowTarget, type ProjectSnapshot } from './project-following.ts';
import type { AuthorizedRequest } from './use-city-signals';

const CHANGED = 'ledger-followed-projects-changed';
const UNAVAILABLE = '__storage_unavailable__';
const MISSING = '__storage_missing__';
function subscribe(update: () => void) {
  window.addEventListener(CHANGED, update);
  window.addEventListener('storage', update);
  return () => { window.removeEventListener(CHANGED, update); window.removeEventListener('storage', update); };
}
function localSnapshot(accountId: string) {
  if (!accountId) return MISSING;
  try { return localStorage.getItem(followKey(accountId)) ?? MISSING; } catch { return UNAVAILABLE; }
}
/** One public record, verified against the requested city and ID. Never send follow state. */
export async function readPublicSignal(request: AuthorizedRequest, cityId: string, id: string): Promise<Signal | null> {
  const { feature } = await request<{ feature: Signal }>(`/api/city-signals?city=${encodeURIComponent(cityId)}&id=${encodeURIComponent(id)}`);
  return feature?.properties.id === id && feature.properties.cityId === cityId ? feature : null;
}
export async function readCurrentProjectSnapshot(request: AuthorizedRequest, target: FollowTarget, cityName: string) {
  const caseStudy = caseForTarget(target);
  if (target.kind === 'case' && !caseStudy) throw new Error('Unknown public project.');
  const ids = target.kind === 'signal' ? [target.id] : caseStudy!.signalIds;
  const records = await Promise.all(ids.map((id) => readPublicSignal(request, target.cityId, id)));
  if (records.some((record) => !record)) throw new Error('A linked public record is unavailable.');
  const snapshot = projectSnapshot(target, cityName, records as Signal[]);
  if (!snapshot) throw new Error('Public project baseline unavailable.');
  return { snapshot, records: records as Signal[] };
}
export function useProjectFollowing(accountId: string, request: AuthorizedRequest) {
  const raw = useSyncExternalStore(subscribe, () => localSnapshot(accountId), () => MISSING);
  const storageAvailable = raw !== UNAVAILABLE;
  const parsed = useMemo(() => {
    if (!accountId || !storageAvailable || raw === MISSING) return { store: emptyFollowStore(), error: '' };
    try { return { store: parseFollowStore(raw), error: '' }; }
    catch { return { store: emptyFollowStore(), error: 'Saved following data is unreadable on this device. It was not overwritten.' }; }
  }, [accountId, storageAvailable, raw]);
  const { store } = parsed;
  const [writeError, setWriteError] = useState<{ accountId: string; message: string }>({ accountId: '', message: '' });
  const [sourceState, setSources] = useState<{ accountId: string; membership: string; values: Record<string, string> }>({ accountId: '', membership: '', values: {} });
  const keys = Object.entries(store.entries).map(([key, entry]) => `${key}:${entry.instance}`).sort().join('|');
  const update = useCallback((change: (previous: FollowStore) => FollowStore) => {
    if (!accountId || !storageAvailable || parsed.error) return false;
    try {
      const previous = parseFollowStore(localStorage.getItem(followKey(accountId)));
      const next = change(previous);
      if (next === previous) return true;
      localStorage.setItem(followKey(accountId), JSON.stringify(next));
      window.dispatchEvent(new Event(CHANGED));
      setWriteError({ accountId, message: '' });
      return true;
    } catch {
      setWriteError({ accountId, message: 'Browser storage could not save following on this device. Nothing was changed.' });
      return false;
    }
  }, [accountId, storageAvailable, parsed.error]);
  const add = useCallback((target: FollowTarget, snapshot: ProjectSnapshot) => update((previous) => follow(previous, target, snapshot)), [update]);
  const remove = useCallback((target: FollowTarget) => update((previous) => unfollow(previous, target)), [update]);
  const acknowledge = useCallback((target: FollowTarget, sequence: number, instance: number) =>
    update((previous) => acknowledgeFollow(previous, target, sequence, instance)), [update]);

  useEffect(() => {
    if (!accountId || !storageAvailable || parsed.error || !keys) return;
    let active = true;
    const entries = Object.values(store.entries);
    const ids = new Set<string>();
    for (const { target } of entries) {
      const signalIds = target.kind === 'signal' ? [target.id] : caseForTarget(target)?.signalIds ?? [];
      for (const id of signalIds) ids.add(`${target.cityId}\0${id}`);
    }
    // Only public city and exact signal IDs reach this API. Linked cases share each record request.
    Promise.all([...ids].map(async (composite) => {
      const [cityId, id] = composite.split('\0');
      try {
        return [composite, await readPublicSignal(request, cityId, id)] as const;
      } catch { return [composite, null] as const; }
    })).then((responses) => {
      if (!active) return;
      const records = new Map(responses);
      const updates: Record<string, string> = {};
      update((previous) => {
        let next = previous;
        for (const { target, latest, instance } of entries) {
          const key = targetKey(target);
          if (previous.entries[key]?.instance !== instance) continue;
          const signalIds = target.kind === 'signal' ? [target.id] : caseForTarget(target)?.signalIds ?? [];
          const features = signalIds.map((id) => records.get(`${target.cityId}\0${id}`));
          if (features.some((feature) => !feature)) {
            updates[key] = 'Public source unavailable or target removed; saved updates are retained.';
            continue;
          }
          const snapshot = projectSnapshot(target, latest.cityName, features as Signal[]);
          if (!snapshot) { updates[key] = 'Public target unavailable; saved updates are retained.'; continue; }
          next = refreshFollow(next, target, snapshot, instance);
          updates[key] = '';
        }
        return next;
      });
      setSources((previous) => ({ accountId, membership: keys,
        values: { ...(previous.accountId === accountId && previous.membership === keys ? previous.values : {}), ...updates } }));
    });
    return () => { active = false; };
    // Re-fetch only when account or membership changes, not after saved updates/read acknowledgments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, keys, request, storageAvailable, parsed.error]);
  return { store, sources: sourceState.accountId === accountId && sourceState.membership === keys ? sourceState.values : {}, add, remove, acknowledge,
    storageError: !storageAvailable ? 'Browser storage is unavailable; following cannot be saved on this device.'
      : parsed.error || (writeError.accountId === accountId ? writeError.message : '') };
}
