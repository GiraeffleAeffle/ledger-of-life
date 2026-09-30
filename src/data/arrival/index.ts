import type { ArrivalGuide } from './types.ts';
import { strausbergGuide } from './strausberg.ts';

// A Map, not an object: an object would answer "__proto__" or "constructor" as if they were cities.
const guides = new Map<string, ArrivalGuide>([[strausbergGuide.cityId, strausbergGuide]]);

/** The welcome guide for a covered city, or null when nobody has written one. */
export function arrivalGuideFor(cityId: string): ArrivalGuide | null {
  return guides.get(cityId) ?? null;
}

export const arrivalGuideCityIds: readonly string[] = [...guides.keys()];
