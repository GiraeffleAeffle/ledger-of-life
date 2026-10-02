import type { CityFeature, SignalCity } from '../server/city-signals.ts';

export const coveredNames: Record<string, string> = {
  koeln: 'Köln', muenster: 'Münster', wuppertal: 'Wuppertal', 'castrop-rauxel': 'Castrop-Rauxel',
  duesseldorf: 'Düsseldorf', dresden: 'Dresden', freiburg: 'Freiburg', strausberg: 'Strausberg',
};
const aliases: Record<string, string> = {
  koln: 'koeln', cologne: 'koeln', munster: 'muenster', dusseldorf: 'duesseldorf',
};
export function cityIdFor(name: string): string | null {
  const key = name.trim().toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
  return aliases[key] ?? Object.keys(coveredNames).find((id) => id.replace(/[^a-z0-9]/g, '') === key ||
    coveredNames[id].toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '') === key) ?? null;
}
/** Preserve complete city names before removing an optional postcode or district. */
export function homeCityId(name: string): string | null {
  const city = name.trim().replace(/^\d{5}\s+/, '');
  return cityIdFor(city) ?? cityIdFor(city.split(/[-,]/)[0]);
}
export function formatCityDate(value: string): string {
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(parsed).replace('Sept', 'Sep');
}
export function formatCityEventDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
  }).format(parsed).replace('Sept', 'Sep');
}
/** Published source prose is kept intact except for dates and raw multi-tag OSM categories. */
export function displayCityText(value: string): string {
  return value.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (date) => formatCityDate(date))
    .replace(/\b[a-z]+(?:_[a-z]+)*(?:;[a-z_]+)+\b/g, (tags) => tags.split(';')[0].replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()))
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (tag) => tag.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()));
}
export function shortlistFeatures(features: readonly CityFeature[], cityId: string, city?: SignalCity): CityFeature[] {
  return features.filter((item) => {
    if (item.properties.cityId !== cityId || item.properties.kind === 'place' ||
      item.properties.kind === 'council_meeting' || item.properties.kind === 'council_paper' ||
      item.properties.id.startsWith('autobahn:') || item.properties.reviewState === 'rejected') return false;
    if (!city || !item.geometry) return true;
    const points = item.geometry.type === 'Point' ? [item.geometry.coordinates] : item.geometry.type === 'LineString'
      ? item.geometry.coordinates : item.geometry.type === 'Polygon' ? item.geometry.coordinates.flat() : item.geometry.coordinates.flat(2);
    return points.some(([lon, lat]) => lon >= city.bbox[0] && lon <= city.bbox[2] && lat >= city.bbox[1] && lat <= city.bbox[3]);
  });
}
export function consultationGroups(features: readonly CityFeature[], cityId: string, asOf: string) {
  const today = asOf.slice(0, 10);
  const consultations = shortlistFeatures(features, cityId).filter((item) => item.properties.kind === 'consultation');
  return {
    open: consultations.filter((item) => item.properties.startDate && item.properties.startDate <= today &&
      (!item.properties.endDate || item.properties.endDate >= today)),
    closed: consultations.filter((item) => item.properties.endDate && item.properties.endDate < today)
      .sort((a, b) => (b.properties.endDate ?? '').localeCompare(a.properties.endDate ?? '')).slice(0, 3),
  };
}
export function nearestCoveredCity(cities: readonly SignalCity[], point: readonly [number, number]): SignalCity | undefined {
  const latitude = point[1] * Math.PI / 180;
  const distance = (candidate: SignalCity) => {
    const lat = candidate.center[1] * Math.PI / 180;
    const lon = (candidate.center[0] - point[0]) * Math.PI / 180;
    return Math.acos(Math.min(1, Math.max(-1, Math.sin(latitude) * Math.sin(lat) + Math.cos(latitude) * Math.cos(lat) * Math.cos(lon))));
  };
  return cities.reduce<SignalCity | undefined>((nearest, city) => !nearest || distance(city) < distance(nearest) ? city : nearest, undefined);
}
