'use client';
import { useMemo, useSyncExternalStore } from 'react';
import type { Coordinate } from '@/server/city-signals';
import { interestOptions, type Interest, type PersonalPins } from './personal-map-relevance';
import { PINS_CHANGED_EVENT } from './use-city-signals';
import { readAccountPins } from './personal-map-storage';

const INTEREST_KEY = 'ledger-of-life:personal-map-interests:v1';
const INTEREST_CHANGED_EVENT = 'ledger-personal-map-interests-changed';

function subscribeInterests(update: () => void) {
  window.addEventListener(INTEREST_CHANGED_EVENT, update);
  window.addEventListener('storage', update);
  return () => { window.removeEventListener(INTEREST_CHANGED_EVENT, update); window.removeEventListener('storage', update); };
}
export function useInterests(): Interest[] {
  const raw = useSyncExternalStore(subscribeInterests, () => localStorage.getItem(INTEREST_KEY) ?? '', () => '');
  return useMemo(() => {
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? interestOptions.filter((item) => value.includes(item)) : [];
    } catch { return []; }
  }, [raw]);
}
export function saveInterests(values: Interest[]) {
  if (values.length) localStorage.setItem(INTEREST_KEY, JSON.stringify(values));
  else localStorage.removeItem(INTEREST_KEY);
  window.dispatchEvent(new Event(INTEREST_CHANGED_EVENT));
}
function subscribePins(update: () => void) {
  window.addEventListener(PINS_CHANGED_EVENT, update);
  window.addEventListener('storage', update);
  return () => { window.removeEventListener(PINS_CHANGED_EVENT, update); window.removeEventListener('storage', update); };
}
export function parsePins(raw: string): PersonalPins {
  try {
    const value = JSON.parse(raw || '{}') as PersonalPins;
    const valid = (point?: Coordinate) => Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
    return { home: valid(value.home) ? value.home : undefined, work: valid(value.work) ? value.work : undefined };
  } catch { return {}; }
}
export function usePersonalPins(cityId: string, accountId: string): PersonalPins {
  const raw = useSyncExternalStore(subscribePins, () => readAccountPins(localStorage, cityId, accountId), () => '');
  return useMemo(() => parsePins(raw), [raw]);
}
