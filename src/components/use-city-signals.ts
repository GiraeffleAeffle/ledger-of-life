'use client';
import { useEffect, useState } from 'react';
import type { CityResult } from '../server/city';
import type { SignalResult } from '../server/city-signals';
export { pinsKey } from './personal-map-storage';

export type AuthorizedRequest = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
export const CITY_CHANGED_EVENT = 'ledger-personal-map-city-changed';
export const PINS_CHANGED_EVENT = 'ledger-personal-map-pins-changed';
let cityReads = new WeakMap<AuthorizedRequest, Promise<CityResult>>();
let signalReads = new WeakMap<AuthorizedRequest, Map<string, Promise<SignalResult>>>();
let lastChange: Event | undefined;
export function readPersonCity(request: AuthorizedRequest): Promise<CityResult> {
  let pending = cityReads.get(request);
  if (!pending) {
    pending = request<{ city: CityResult }>('/api/city').then(({ city }) => city);
    cityReads.set(request, pending);
    void pending.catch(() => { if (cityReads.get(request) === pending) cityReads.delete(request); });
  }
  return pending;
}
export function citySourceLabel(source?: CityResult['source']): string {
  return source === 'home' ? 'From your home' : source === 'chosen' ? 'Chosen by you' : source === 'identity' ? 'From your EU wallet' : '';
}
export function useCitySignals(request: AuthorizedRequest, explorationCity?: string) {
  const [city, setCity] = useState<CityResult | null>(null);
  const [result, setResult] = useState<SignalResult | null>(null);
  const [cityId, setCityId] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = (event: Event) => {
      if (lastChange !== event) { lastChange = event; cityReads = new WeakMap(); signalReads = new WeakMap(); }
      setRevision((value) => value + 1);
    };
    window.addEventListener(CITY_CHANGED_EVENT, update);
    return () => window.removeEventListener(CITY_CHANGED_EVENT, update);
  }, []);
  useEffect(() => {
    let current = true;
    readPersonCity(request).then(async (next) => {
      if (!current) return;
      const id = explorationCity ?? next.cityId ?? '';
      setCity(next); setCityId(id); setError('');
      setResult((previous) => previous?.state === 'covered' && previous.data.catalogue.id === id ? previous : null);
      if (!id) return;
      let reads = signalReads.get(request);
      if (!reads) { reads = new Map(); signalReads.set(request, reads); }
      let pending = reads.get(id);
      if (!pending) {
        pending = request<SignalResult>(`/api/city-signals?city=${encodeURIComponent(id)}`);
        reads.set(id, pending);
        void pending.catch(() => { if (reads.get(id) === pending) reads.delete(id); });
      }
      const signals = await pending;
      if (current) setResult(signals);
    }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : 'City information unavailable.'); });
    return () => { current = false; };
  }, [request, explorationCity, revision]);
  return { cityId, result, error, city, source: city?.source, homePin: city?.home?.location,
    selectedCity: Boolean(city?.name), cityDisplayName: city?.name ?? '' };
}
