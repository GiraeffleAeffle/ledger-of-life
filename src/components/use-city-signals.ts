'use client';
import { useEffect, useState } from 'react';
import type { CityResult } from '../server/city';
import { citySlug } from '../server/city';
import type { SignalResult } from '../server/city-signals';

export type AuthorizedRequest = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
export const CITY_CHANGED_EVENT = 'ledger-personal-map-city-changed';
export const PINS_CHANGED_EVENT = 'ledger-personal-map-pins-changed';
export const pinsKey = (cityId: string) => `ledger-of-life:personal-map-pins:v1:${cityId}`;

export function useCitySignals(request: AuthorizedRequest, explorationCity?: string) {
  const [view, setView] = useState<{ cityId: string; result: SignalResult | null; error: string; revision: number; explorationCity?: string }>({
    cityId: '', result: null, error: '', revision: -1,
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((value) => value + 1);
    window.addEventListener(CITY_CHANGED_EVENT, update);
    return () => window.removeEventListener(CITY_CHANGED_EVENT, update);
  }, []);
  useEffect(() => {
    let current = true;
    let id = '';
    request<{ city: CityResult }>('/api/city')
      .then(({ city }) => {
        if (!current) return;
        id = explorationCity ?? (city.available ? city.cityId : city.name ? citySlug(city.name) : '');
        return request<SignalResult>(`/api/city-signals?city=${encodeURIComponent(id)}`);
      })
      .then((result) => { if (current && result) setView({ cityId: id, result, error: '', revision, explorationCity }); })
      .catch((cause) => { if (current) setView((previous) => ({
        cityId: id, result: previous.cityId === id ? previous.result : null,
        error: cause instanceof Error ? cause.message : 'City signals unavailable.', revision, explorationCity,
      })); });
    return () => { current = false; };
  }, [request, explorationCity, revision]);
  return view.revision === revision && view.explorationCity === explorationCity ? view : { cityId: '', result: null, error: '' };
}
