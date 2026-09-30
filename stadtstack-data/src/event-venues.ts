export type EventPoint = { type: 'Point'; coordinates: [number, number] };
export interface EventLocationSource {
  url: string;
  publisher: string;
  method: 'ics_geo' | 'official_event' | 'venue_registry' | 'syndication_geo';
  retrievedAt: string;
  geometrySourceUrl?: string;
  geometryLicence?: 'ODbL-1.0';
  geometryAttribution?: '© OpenStreetMap contributors';
}

/** Resolve only an exact published venue/address pair. A building-centre pin for an event
 * described as "in front of" that building is approximate, not the event's exact position. */
const venues = [
  {
    cityId: 'strausberg',
    venue: 'Vor der Marienkirche in Strausberg, Predigerstr. 2, 15344 Strausberg',
    geometry: { type: 'Point', coordinates: [13.8804803, 52.5801295] } as EventPoint,
    geometryPrecision: 'approximate' as const,
    geometrySourceUrl: 'https://www.openstreetmap.org/way/38496130',
    geometryLicence: 'ODbL-1.0' as const,
    geometryAttribution: '© OpenStreetMap contributors' as const,
  },
];

export function findEventVenue(cityId: string, venue: string) {
  const normalized = venue.toLocaleLowerCase('de-DE').replace(/\s+/g, ' ').trim();
  return venues.find((entry) => entry.cityId === cityId && entry.venue.toLocaleLowerCase('de-DE').replace(/\s+/g, ' ').trim() === normalized) ?? null;
}
