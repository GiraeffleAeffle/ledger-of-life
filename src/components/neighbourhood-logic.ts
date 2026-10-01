import type { HomeLocation } from '../domain/home-location.ts';
import type { SignalResult, CityFeedItem } from '../server/city-signals.ts';
import { distanceToGeometry } from './personal-map-relevance.ts';
import { shortlistFeatures } from './city-coverage.ts';

/** Covered city AND pin inside its published bounding box; a city label alone is insufficient. */
export function listingNeighbourhood(result: SignalResult, location: HomeLocation, events: CityFeedItem[], now = new Date()) {
  if (result.state !== 'covered') return null;
  const [west, south, east, north] = result.data.catalogue.bbox;
  if (location.lon < west || location.lon > east || location.lat < south || location.lat > north) return null;
  const point: [number, number] = [location.lon, location.lat];
  const near = result.data.signals.features.flatMap((feature) => {
    const distance = distanceToGeometry(point, feature.geometry);
    return feature.properties.reviewState !== 'rejected' && distance !== null && distance <= 2000 ? [{ feature, distance }] : [];
  }).sort((a, b) => a.distance - b.distance);
  const nearbyEvents = events.flatMap((item) => {
    const distance = distanceToGeometry(point, item.geometry);
    return item.kind === 'event' && item.eventStart && Date.parse(item.eventStart) >= now.getTime() && distance !== null && distance <= 2000 ? [{ item, distance }] : [];
  }).sort((a, b) => a.distance - b.distance).slice(0, 4);
  return { city: result.data.catalogue, generatedAt: result.data.generatedAt,
    places: near.filter((row) => row.feature.properties.kind === 'place').slice(0, 4),
    projects: near.filter((row) => row.feature.properties.kind !== 'place').slice(0, 4),
    events: nearbyEvents,
    changing: shortlistFeatures(result.data.signals.features, result.data.catalogue.id, result.data.catalogue)
      .sort((a, b) => (b.properties.asOf ?? '').localeCompare(a.properties.asOf ?? '')).slice(0, 3) };
}
