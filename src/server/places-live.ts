import { citySlug } from './city.ts';
import { strausbergSources } from '../data/cities/strausberg.ts';

const ATLAS = (process.env.STADTSTACK_ATLAS_URL ?? 'http://localhost:4317').replace(/\/$/, '');
const AGENT = 'LedgerOfLifePlaces/1.0 (https://github.com/GiraeffleAeffle/rental-deposit-hackathon; public read-only research)';
const WEATHER_TTL = 10 * 60_000;
const CLUB_TTL = 24 * 60 * 60_000;
const LOCATION_TTL = 24 * 60 * 60_000;
const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
const OVERPASS_INSTANCES = [
  'https://gall.openstreetmap.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
] as const;

export type LiveSection<T> =
  | { state: 'available'; value: T; observedAt: string; stale: boolean }
  | { state: 'unavailable'; reason: 'temporarily unavailable' };
export interface PlaceSource { name: string; url: string; licence: string; licenceUrl: string; }
export interface Coordinates { lat: number; lon: number; source: string; url: string; observedAt: string; }
export interface Weather { temperature: number; humidity: number | null; condition: string; station: string; distanceKm: number; timestamp: string; fallback: boolean; source: PlaceSource; }
export interface AirSensor { id: number; pm25: number; pm10: number | null; distanceKm: number; timestamp: string; url: string; }
export interface AirQuality { sensors: AirSensor[]; source: PlaceSource; caveat: string; }
export interface Club { id: string; name: string; kind: string; url: string; }
export interface ClubGroup { type: string; count: number; items: Club[]; }
export interface Clubs { total: number; groups: ClubGroup[]; source: PlaceSource; caveat: string; directories: readonly { label: string; url: string }[]; }
export interface PlacesResult {
  city: string;
  cityId: string;
  coordinates: LiveSection<Coordinates>;
  weather: LiveSection<Weather>;
  air: LiveSection<AirQuality>;
  clubs: LiveSection<Clubs>;
}

type CacheEntry<T> = { value?: T; observedAt?: string; stale?: boolean; expiresAt: number; inFlight?: Promise<LiveSection<T>> };
const locationCache = new Map<string, CacheEntry<Coordinates>>();
const weatherCache = new Map<string, CacheEntry<Weather>>();
const airCache = new Map<string, CacheEntry<AirQuality>>();
const clubCache = new Map<string, CacheEntry<Clubs>>();

/** Coalesce requests by city; on error retain the last good payload and its original time. */
function cached<T>(cache: Map<string, CacheEntry<T>>, city: string, ttl: number, load: () => Promise<T>): Promise<LiveSection<T>> {
  const entry = cache.get(city) ?? { expiresAt: 0 };
  if (entry.expiresAt > Date.now()) return Promise.resolve(entry.value !== undefined
    ? { state: 'available', value: entry.value, observedAt: entry.observedAt!, stale: entry.stale ?? false }
    : { state: 'unavailable', reason: 'temporarily unavailable' });
  if (entry.inFlight) return entry.inFlight;
  const inFlight = (async (): Promise<LiveSection<T>> => {
    try {
      const value = await load();
      entry.value = value;
      entry.observedAt = new Date().toISOString();
      entry.stale = false;
      entry.expiresAt = Date.now() + ttl;
      return { state: 'available', value, observedAt: entry.observedAt, stale: false };
    } catch {
      entry.stale = true;
      // A failed first read or stale value retries soon; healthy reads respect their feed's TTL.
      entry.expiresAt = Date.now() + 60_000;
      return entry.value !== undefined
        ? { state: 'available', value: entry.value, observedAt: entry.observedAt!, stale: true }
        : { state: 'unavailable', reason: 'temporarily unavailable' };
    } finally {
      entry.inFlight = undefined;
    }
  })();
  entry.inFlight = inFlight;
  cache.set(city, entry);
  return inFlight;
}

async function json(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: { 'User-Agent': AGENT, ...init?.headers }, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  return response.json();
}
function numeric(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}
function validPoint(lat: number | null, lon: number | null): lat is number {
  return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}
function distanceKm(lat: number, lon: number, otherLat: number, otherLon: number): number {
  const a = Math.PI / 180;
  const dLat = (otherLat - lat) * a;
  const dLon = (otherLon - lon) * a;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat * a) * Math.cos(otherLat * a) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

async function locate(city: string, id: string): Promise<Coordinates> {
  try {
    const url = `${ATLAS}/api/atlas/${encodeURIComponent(id)}/map`;
    const map = await json(url) as { view?: { center?: unknown }; snapshot?: { asOf?: string } };
    const center = map.view?.center;
    if (Array.isArray(center) && validPoint(numeric(center[1]), numeric(center[0]))) {
      return { lat: numeric(center[1])!, lon: numeric(center[0])!, source: 'Stadtstack atlas map centre (research preview, not municipal centroid)', url, observedAt: map.snapshot?.asOf ?? new Date().toISOString() };
    }
  } catch { /* Atlas may be down or have no map; use one cached geocode instead. */ }
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ city, country: 'Germany', format: 'jsonv2', limit: '1' })}`;
  const results = await json(url, { headers: { 'Accept-Language': 'de' } }) as { lat?: string; lon?: string }[];
  const lat = numeric(results?.[0]?.lat);
  const lon = numeric(results?.[0]?.lon);
  if (!validPoint(lat, lon)) throw new Error('City location not found');
  return { lat, lon: lon!, source: 'OpenStreetMap Nominatim geocode (approximate city centre)', url, observedAt: new Date().toISOString() };
}

async function loadWeather({ lat, lon }: Coordinates): Promise<Weather> {
  const url = `https://api.brightsky.dev/current_weather?lat=${lat}&lon=${lon}`;
  const body = await json(url) as { weather?: Record<string, unknown>; sources?: Record<string, unknown>[] };
  const weather = body.weather;
  const temperature = numeric(weather?.temperature);
  const time = timestamp(weather?.timestamp);
  if (temperature === null || !time) throw new Error('Missing weather observation');
  const fallbackId = (weather?.fallback_source_ids as Record<string, unknown> | undefined)?.temperature;
  const source = body.sources?.find((item) => item.id === (fallbackId ?? weather?.source_id));
  const distance = numeric(source?.distance);
  if (!source || distance === null) throw new Error('Missing weather station');
  return {
    temperature, humidity: numeric(weather?.relative_humidity), condition: typeof weather?.condition === 'string' ? weather.condition : 'not reported',
    station: typeof source.station_name === 'string' ? source.station_name : 'DWD station', distanceKm: distance / 1000,
    timestamp: time, fallback: fallbackId !== undefined && fallbackId !== weather?.source_id,
    source: { name: 'DWD via Bright Sky', url, licence: 'DWD terms of use (Bright Sky attribution)', licenceUrl: 'https://www.dwd.de/EN/service/copyright/copyright_node.html' },
  };
}

async function loadAir({ lat, lon }: Coordinates): Promise<AirQuality> {
  const url = `https://data.sensor.community/airrohr/v1/filter/area=${lat},${lon},5`;
  const rows = await json(url) as { sensor?: { id?: number }; location?: { latitude?: string; longitude?: string; indoor?: number }; timestamp?: string; sensordatavalues?: { value_type?: string; value?: string }[] }[];
  if (!Array.isArray(rows)) throw new Error('Invalid sensor response');
  const sensors = new Map<number, AirSensor>();
  for (const row of rows) {
    const id = numeric(row.sensor?.id), sensorLat = numeric(row.location?.latitude), sensorLon = numeric(row.location?.longitude);
    const pm25 = numeric(row.sensordatavalues?.find((v) => v.value_type === 'P2')?.value);
    const pm10 = numeric(row.sensordatavalues?.find((v) => v.value_type === 'P1')?.value);
    const time = timestamp(row.timestamp?.replace(' ', 'T') + 'Z'); // sensor.community timestamps are UTC without an offset
    if (id === null || !validPoint(sensorLat, sensorLon) || pm25 === null || pm25 < 0 || !time || row.location?.indoor === 1) continue;
    const distance = distanceKm(lat, lon!, sensorLat, sensorLon!);
    if (distance > 5) continue; // The API's area filter can include readings outside the radius.
    const existing = sensors.get(id);
    if (!existing || time > existing.timestamp) sensors.set(id, { id, pm25, pm10: pm10 !== null && pm10 >= 0 ? pm10 : null, distanceKm: distance, timestamp: time, url: `https://maps.sensor.community/#2/${sensorLat}/${sensorLon}` });
  }
  return {
    sensors: [...sensors.values()].sort((a, b) => a.distanceKm - b.distanceKm),
    source: { name: 'sensor.community · nearby outdoor PM2.5 / PM10 readings', url, licence: 'CC BY-SA 4.0 (project data); database reuse: ODbL / DBCL — check service terms', licenceUrl: 'https://sensor.community/en/' },
    caveat: 'Uncalibrated citizen sensors; nearby readings are not official air-quality measurements or city-wide averages.',
  };
}

async function loadClubs(city: string): Promise<Clubs> {
  const safeName = city.replace(/["\\\[\]]/g, '');
  const query = `[out:json][timeout:8];area["name"="${safeName}"]["boundary"="administrative"]["admin_level"="8"]->.city;(nwr(area.city)["leisure"~"^(sports_centre|fitness_centre|sports_hall|stadium|pitch|swimming_pool)$"]["name"];);out center;`;
  let url = '';
  let elements: { type: string; id: number; tags?: Record<string, string> }[] | undefined;
  for (const instance of OVERPASS_INSTANCES) {
    try {
      const body = await json(instance, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: query }) }, 10_000) as { elements?: typeof elements };
      if (!Array.isArray(body.elements)) continue;
      elements = body.elements;
      url = instance;
      break;
    } catch { /* Try the next public instance; never infer that an empty response is a club directory. */ }
  }
  if (!elements) throw new Error('Overpass temporarily unavailable');
  const groups = new Map<string, Club[]>();
  for (const object of elements) {
    const name = object.tags?.name;
    // Published city signals already collect every named club/sport OSM object.
    if (!name || object.tags?.club || object.tags?.sport || !['node', 'way', 'relation'].includes(object.type) || !Number.isSafeInteger(object.id)) continue;
    const kind = `Facility · ${object.tags?.leisure ?? 'other'}`;
    const items = groups.get(kind) ?? [];
    items.push({ id: `${object.type}/${object.id}`, name, kind, url: `https://www.openstreetmap.org/${object.type}/${object.id}` });
    groups.set(kind, items);
  }
  const sorted = [...groups].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([type, items]) => ({ type, count: items.length, items }));
  return {
    total: sorted.reduce((sum, group) => sum + group.count, 0), groups: sorted,
    source: { name: 'OpenStreetMap via Overpass', url, licence: 'OpenStreetMap contributors · ODbL 1.0', licenceUrl: OSM_COPYRIGHT },
    caveat: 'Leisure-tagged places without club or sport tags; those tags already appear in the published city map. OpenStreetMap contributions, not an official directory; incomplete and not verified by the city.',
    directories: citySlug(city) === 'strausberg' ? strausbergSources.directories : [],
  };
}

/** All feeds run on the server and fail independently, so one outage does not hide other sections. */
export async function readPlaces(city: string): Promise<PlacesResult> {
  const cityId = citySlug(city);
  const coordinates = await cached(locationCache, cityId, LOCATION_TTL, () => locate(city, cityId));
  const clubs = cached(clubCache, cityId, CLUB_TTL, () => loadClubs(city));
  if (coordinates.state === 'unavailable') {
    return { city, cityId, coordinates, clubs: await clubs,
      weather: { state: 'unavailable', reason: 'temporarily unavailable' }, air: { state: 'unavailable', reason: 'temporarily unavailable' } };
  }
  const [weather, air, clubResult] = await Promise.all([
    cached(weatherCache, cityId, WEATHER_TTL, () => loadWeather(coordinates.value)),
    cached(airCache, cityId, WEATHER_TTL, () => loadAir(coordinates.value)), clubs,
  ]);
  return { city, cityId, coordinates, weather, air, clubs: clubResult };
}
