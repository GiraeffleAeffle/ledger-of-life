import type { CityFeature, Coordinate, SignalGeometry } from '../server/city-signals';
import { formatCityDate } from './city-coverage.ts';
import { interestOptions, type Interest } from '../data/interests.ts';

export { interestOptions, type Interest };

export const HOME_RADIUS_METRES = 1000;
export const COMMUTE_CORRIDOR_METRES = 400;
export type PersonalPins = { home?: Coordinate; work?: Coordinate };
export type MatchedSignal = { feature: CityFeature; distanceMetres: number | null; explanation: string };
export type PersonalRings = { home: MatchedSignal[]; commute: MatchedSignal[]; city: MatchedSignal[] };
export const REVIEW_LABELS: Record<CityFeature['properties']['reviewState'], string> = {
  candidate: 'Not yet checked',
  auto_checked: 'Automatically checked · not reviewed by a person',
  reviewed: 'Human-reviewed',
  rejected: 'Rejected interpretation',
};
export const PRECISION_LABELS: Record<CityFeature['properties']['geometryPrecision'], string> = {
  exact: 'Mapped location',
  approximate: 'Approximate location',
  area: 'General area',
  none: 'Citywide',
};

// Local tangent plane for neighbourhood-scale distances; no network-based geocoding or routing.
function project(point: Coordinate, origin: Coordinate): [number, number] {
  const radians = Math.PI / 180;
  return [(point[0] - origin[0]) * 111_195 * Math.cos(origin[1] * radians), (point[1] - origin[1]) * 111_195];
}
function segmentDistance(point: [number, number], start: [number, number], end: [number, number]): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const t = dx * dx + dy * dy ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
}
function intersects(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const cross = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return abC * abD <= 0 && cdA * cdB <= 0 &&
    Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
    Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]));
}
function inside(point: [number, number], ring: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
/** Minimum surface distance to a feature, including polygon interiors and holes. */
export function distanceToGeometry(point: Coordinate, geometry: SignalGeometry): number | null {
  if (!geometry) return null;
  const p: [number, number] = [0, 0];
  const xy = (c: Coordinate) => project(c, point);
  if (geometry.type === 'Point') return Math.hypot(...xy(geometry.coordinates));
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  for (const rings of polygons) {
    if (rings[0]?.length && inside(p, rings[0].map(xy)) && !rings.slice(1).some((hole) => inside(p, hole.map(xy)))) return 0;
  }
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : polygons.flat();
  let nearest = Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const a = xy(line[i]);
      nearest = Math.min(nearest, i ? segmentDistance(p, xy(line[i - 1]), a) : Math.hypot(...a));
    }
  }
  return Number.isFinite(nearest) ? nearest : null;
}
/** Closest distance from any part of a feature to a straight home→work segment. */
export function distanceToCorridor(geometry: SignalGeometry, home: Coordinate, work: Coordinate): number | null {
  if (!geometry) return null;
  const origin: [number, number] = [0, 0];
  const destination = project(work, home);
  if (geometry.type === 'Point') return segmentDistance(project(geometry.coordinates, home), origin, destination);
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    if (distanceToGeometry(home, geometry) === 0 || distanceToGeometry(work, geometry) === 0) return 0;
  }
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  let nearest = Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const point = project(line[i], home);
      nearest = Math.min(nearest, segmentDistance(point, origin, destination));
      if (i) {
        const previous = project(line[i - 1], home);
        if (intersects(origin, destination, previous, point)) return 0;
        nearest = Math.min(nearest, segmentDistance(origin, previous, point), segmentDistance(destination, previous, point));
      }
    }
  }
  return Number.isFinite(nearest) ? nearest : null;
}

/** Device-derived state takes precedence over a stale source status, without rewriting the original. */
export function displayStatus(feature: CityFeature, today = new Date().toISOString().slice(0, 10)): string {
  const { kind, endDate, nextStep, status } = feature.properties;
  if (endDate && endDate < today && kind === 'consultation') return `Consultation closed on ${formatCityDate(endDate)}; next step: ${nextStep || 'not established'}`;
  if (endDate && endDate < today && kind === 'roadworks') return `Roadworks scheduled to end on ${formatCityDate(endDate)} (completion not verified)`;
  return status || 'Status not established';
}

function priority(feature: CityFeature, today: string): number {
  const { startDate, endDate, status } = feature.properties;
  if ((endDate && endDate < today) || /closed|complete|cancelled|ended|abgeschlossen|beendet/i.test(status)) return 2;
  return startDate && startDate > today ? 1 : 0;
}
function means(feature: CityFeature, ring: 'home' | 'commute' | 'city', distance: number | null, today: string): string {
  const { kind, title, statement, endDate, nextStep, startDate, status } = feature.properties;
  if (kind === 'consultation' && endDate && endDate < today) return `${displayStatus(feature, today).replace(/[.]+$/, '')}. A closed window is not open for comments.`;
  if (kind === 'roadworks' && endDate && endDate < today) return `${displayStatus(feature, today)}.`;
  if (kind === 'budget') return `Planned, not spent: ${statement}`;
  if (kind === 'council_paper' || kind === 'council_meeting') return `${/agenda/i.test(status) ? 'Your city council has on its agenda' : kind === 'council_paper' ? 'Council paper' : 'Council meeting'}: ${title}${startDate ? ` (${formatCityDate(startDate)})` : ''}. A paper or meeting does not confirm a decision.`;
  if (ring === 'commute' && kind === 'roadworks') return `Near your approximate way to work: ${title}${endDate ? ` until ${formatCityDate(endDate)}` : ''}. Check its status before travelling.`;
  if (ring === 'home' && distance !== null) return `${Math.round(distance)} m from your home: ${title}${nextStep ? `; next: ${nextStep.replace(/[.]+$/, '')}` : ''}. Nearby does not necessarily mean your street is affected.`;
  return `${title}: ${statement}${nextStep ? ` Next: ${nextStep.replace(/[.]+$/, '')}.` : ''}`;
}
const interestWords: Record<Interest, RegExp> = {
  sport: /sport|fitness|gym|schwimm|turn|fußball|fussball|stadion|athlet/i,
  kids: /kid|child|kinder|jugend|spielplatz|schule|kita|daycare|famil/i,
  shops: /shop|shopping|laden|geschäft|geschaeft|supermarkt|markt|retail|einzelhandel/i,
  health: /health|gesund|arzt|ärzt|aerzt|klinik|krankenhaus|apotheke|pharmacy|hospital/i,
  culture: /cultur|kultur|museum|bibliothek|library|theater|theatre|kino|kunst|music|musik/i,
  nature: /natur|wald|forst|park|garten|umwelt|grün|gruen|straussee|\bsee\b|ufer|strand|tier/i,
  volunteering: /ehrenamt|freiwillig|volunteer|spende|helfer|tafel|initiative/i,
};
/** The single matcher for interest words, so places, council items and the welcome guide agree. */
export function interestMatchesText(text: string, interest: Interest): boolean {
  return interestWords[interest].test(text);
}
/** The words behind an interest, read from the matcher itself so what people are shown cannot drift from what it does. */
export function interestWordList(interest: Interest): string[] {
  return interestWords[interest].source.split('|').map((word) => /^\\b.+\\b$/.test(word) ? `${word.slice(2, -2)} (whole word)` : word);
}
function interestMatch(feature: CityFeature, interests: readonly Interest[]): boolean {
  if (feature.properties.kind !== 'place' && feature.properties.kind !== 'council_paper' && feature.properties.kind !== 'council_meeting') return false;
  const words = `${feature.properties.title} ${feature.properties.category}`;
  return interests.some((interest) => interestWords[interest].test(words));
}
/** All matching and ranking execute in the browser, never on the server. */
export function matchPersonalRings(features: CityFeature[], pins: PersonalPins, today = new Date().toISOString().slice(0, 10), interests: readonly Interest[] = [], cityPlaceCategories: readonly string[] = []): PersonalRings {
  const result: PersonalRings = { home: [], commute: [], city: [] };
  for (const feature of features) {
    const { kind, scale, category } = feature.properties;
    const distance = pins.home ? distanceToGeometry(pins.home, feature.geometry) : null;
    const onWay = pins.home && pins.work ? distanceToCorridor(feature.geometry, pins.home, pins.work) : null;
    const citywide = !feature.geometry || scale === 'city';
    if (!citywide && distance !== null && distance <= HOME_RADIUS_METRES) result.home.push({ feature, distanceMetres: distance, explanation: means(feature, 'home', distance, today) });
    if (!citywide && onWay !== null && onWay <= COMMUTE_CORRIDOR_METRES) result.commute.push({ feature, distanceMetres: onWay, explanation: means(feature, 'commute', onWay, today) });
    // The city ring is for civic citywide matters, not an unbounded dump of every street/place.
    if ((kind === 'place' && cityPlaceCategories.includes(category)) ||
      (kind !== 'place' && (kind === 'council_paper' || kind === 'council_meeting' || kind === 'budget' || citywide))) {
      result.city.push({ feature, distanceMetres: null, explanation: means(feature, 'city', null, today) });
    }
  }
  for (const items of Object.values(result)) items.sort((a, b) =>
    Number(interestMatch(b.feature, interests)) - Number(interestMatch(a.feature, interests)) ||
    priority(a.feature, today) - priority(b.feature, today) ||
    (a.distanceMetres ?? Infinity) - (b.distanceMetres ?? Infinity) ||
    a.feature.properties.title.localeCompare(b.feature.properties.title));
  return result;
}
