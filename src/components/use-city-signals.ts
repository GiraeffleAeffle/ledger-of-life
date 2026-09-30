'use client';
import { useEffect, useState } from 'react';
import type { CityResult } from '../server/city';
import type { SignalResult } from '../server/city-signals';
import { sharedReads } from './shared-reads';
export { pinsKey } from './personal-map-storage';

export type AuthorizedRequest = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
export const CITY_CHANGED_EVENT = 'ledger-personal-map-city-changed';
export const PINS_CHANGED_EVENT = 'ledger-personal-map-pins-changed';
// Keyed by the request function as well, so a read started before sign-up finished is never reused afterwards.
const cityReads = sharedReads<AuthorizedRequest, CityResult>();
const signalReads = sharedReads<AuthorizedRequest, SignalResult>();
let lastChange: Event | undefined;
function readCity(request: AuthorizedRequest): Promise<CityResult> {
  return cityReads.read(request, 'city', () => request<{ city: CityResult }>('/api/city').then(({ city }) => city));
}
function readSignals(request: AuthorizedRequest, id: string): Promise<SignalResult> {
  return signalReads.read(request, id, () => request<SignalResult>(`/api/city-signals?city=${encodeURIComponent(id)}`));
}

export function useCitySignals(request: AuthorizedRequest, explorationCity?: string) {
  const [view, setView] = useState<{ cityId: string; result: SignalResult | null; error: string; revision: number; explorationCity?: string; selectedCity: boolean; cityDisplayName: string }>({
    cityId: '', result: null, error: '', revision: -1, selectedCity: false, cityDisplayName: '',
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = (event: Event) => { if (lastChange !== event) { lastChange = event; cityReads.clear(); signalReads.clear(); } setRevision((value) => value + 1); };
    window.addEventListener(CITY_CHANGED_EVENT, update);
    return () => window.removeEventListener(CITY_CHANGED_EVENT, update);
  }, []);
  useEffect(() => {
    let current = true;
    let id = '';
    let selectedCity = false;
    let cityDisplayName = '';
    readCity(request)
      .then((city) => {
        if (!current) return;
        id = explorationCity ?? city.cityId ?? '';
        selectedCity = Boolean(city.cityId || (!city.available && city.explicitlyUncovered));
        cityDisplayName = city.name ?? '';
        return readSignals(request, id);
      })
      .then((result) => { if (current && result) setView({ cityId: id, result, error: '', revision, explorationCity, selectedCity, cityDisplayName }); })
      .catch((cause) => { if (current) setView((previous) => ({
        cityId: id, result: previous.cityId === id ? previous.result : null,
        error: cause instanceof Error ? cause.message : 'City information unavailable.', revision, explorationCity, selectedCity, cityDisplayName,
      })); });
    return () => { current = false; };
  }, [request, explorationCity, revision]);
  return view.revision === revision && view.explorationCity === explorationCity ? view : { cityId: '', result: null, error: '', selectedCity: false, cityDisplayName: '' };
}
