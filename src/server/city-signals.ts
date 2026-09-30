import 'server-only';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type Coordinate = [number, number];
export type SignalKind = 'planning' | 'construction' | 'roadworks' | 'council_paper' | 'council_meeting' | 'budget' | 'consultation' | 'place';
export type SignalGeometry =
  | { type: 'Point'; coordinates: Coordinate }
  | { type: 'LineString'; coordinates: Coordinate[] }
  | { type: 'Polygon'; coordinates: Coordinate[][] }
  | { type: 'MultiPolygon'; coordinates: Coordinate[][][] }
  | null;
export interface SignalSource {
  url: string; snapshotUrl?: string; title: string; publisher: string; locator: string; retrievedAt: string;
  sha256: string | null; licence: string; reuse: string;
}
export interface Signal {
  type: 'Feature'; geometry: SignalGeometry;
  properties: {
    id: string; version: string | number; cityId: string; kind: SignalKind; category: string;
    title: string; statement: string; status: string; startDate: string | null; endDate: string | null;
    nextStep: string | null; unknowns: string[]; scale: 'street' | 'neighbourhood' | 'city' | 'district' | 'state' | 'national';
    geometryPrecision: 'exact' | 'approximate' | 'area' | 'none';
    sources: SignalSource[];
    extraction: { method: 'structured' | 'llm'; model?: string; faithfulness?: { score: number; reason: string; evaluator: string; threshold: number } };
    reviewState: 'candidate' | 'auto_checked' | 'reviewed' | 'rejected'; asOf: string;
  };
}
export interface SignalCollection { type: 'FeatureCollection'; features: Signal[] }
/** Compact public map/list record; detail is read from the full city file only on selection. */
export type SignalSummary = Omit<Signal, 'properties'> & {
  properties: Omit<Signal['properties'], 'sources' | 'unknowns' | 'extraction'> & {
    sourceCount: number;
    primarySource?: Pick<SignalSource, 'url' | 'title' | 'publisher' | 'licence' | 'reuse'>;
    faithfulness?: { score: number; threshold: number };
  };
};
export type CityFeature = Signal | SignalSummary;
export interface CityCollection { type: 'FeatureCollection'; features: CityFeature[] }
export interface SignalCity {
  id: string; name: string; state: string; center: Coordinate; bbox: [number, number, number, number];
  minUrl?: string; minBytes?: number; fullBytes?: number; feedUrl?: string;
  sources: { id: string; kind: string; publisher: string; url: string; licence: string; reuse: string; retrievedAt: string }[];
}
export interface SignalCatalogue { schemaVersion: 'stadtstack-signals-v1'; generatedAt: string; cities: SignalCity[] }
export interface CitySignals { catalogue: SignalCity; coveredCities: SignalCity[]; generatedAt: string; signals: CityCollection; changes: { added: string[]; changed: string[]; removed: string[] } }
export type SignalResult = { state: 'covered'; data: CitySignals } | { state: 'not_covered'; city: string; coveredCities: SignalCity[]; generatedAt: string };
export interface CityFeedItem {
  id: string; kind: 'news' | 'event'; title: string; url: string; publisher: string;
  publishedAt: string; eventStart: string | null; publisherRecordId: string | null; sourceId: string; reuse: string;
  venue: string | null; geometry: { type: 'Point'; coordinates: Coordinate } | null;
  geometryPrecision: 'exact' | 'approximate' | 'none';
  locationSource: { url: string; publisher: string; method: 'ics_geo' | 'official_event' | 'venue_registry' | 'syndication_geo'; retrievedAt: string; geometrySourceUrl?: string; geometryLicence?: 'ODbL-1.0'; geometryAttribution?: '© OpenStreetMap contributors' } | null;
  retrievedAt: string; reviewState: string;
}
export interface CityFeed {
  schemaVersion: 'stadtstack-feed-v1'; cityId: string; generatedAt: string;
  sources: { id: string; kind: 'press' | 'events'; publisher: string; url: string; licence: string; reuse: string; retrievedAt: string; status: string; pageUrl?: string }[];
  items: CityFeedItem[];
}
export type CityFeedResult =
  | { state: 'available'; cityId: string; cityName: string; feed: CityFeed }
  | { state: 'not_available'; cityId: string; cityName: string };
export interface RegionalTopicItem {
  title: string; url: string; date: string | null; sourceType: 'planningProcedure' | 'cityWebsite' | 'councilAgenda';
  locator: string; stage: string;
}
export interface RelevantRegionalTopic {
  id: string; label: string; summary: string; reviewState: 'candidate' | 'auto_checked' | 'reviewed';
  stage: string | null; items: RegionalTopicItem[];
  neighbours: { name: string; stage: string; source: RegionalTopicItem }[];
  furthest: { name: string; stage: string; source: RegionalTopicItem };
}
interface RegionalPublication {
  schemaVersion: 'stadtstack-regional-topics-v1';
  region: { id: string; name: string };
  cityRegions: Record<string, string>;
  municipalities: { id: string; name: string }[];
  topics: {
    id: string; label: string; summary: string; reviewState: RelevantRegionalTopic['reviewState'];
    municipalities: { municipalityId: string; stage: string; items: RegionalTopicItem[] }[];
  }[];
}
export type RegionalTopicResult =
  | { state: 'available'; regionName: string; cityId: string; topics: RelevantRegionalTopic[] }
  | { state: 'not_available'; cityId: string };

// mtime and file path are both part of the key: switching STADTSTACK_DATA_DIR never serves an old city.
const files = new Map<string, { mtimeMs: number; size: number; value: unknown }>();
async function jsonFile<T>(path: string): Promise<T> {
  const info = await stat(/* turbopackIgnore: true */ path);
  const cached = files.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value as T;
  const value = JSON.parse(await readFile(/* turbopackIgnore: true */ path, 'utf8')) as T;
  files.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
}
const dataDirectory = () => resolve(/* turbopackIgnore: true */ process.env.STADTSTACK_DATA_DIR ?? join(process.cwd(), 'stadtstack-data/out'));
export async function readSignalsCatalogue(): Promise<SignalCatalogue> {
  const catalogue = await jsonFile<SignalCatalogue>(join(dataDirectory(), 'catalogue.json'));
  if (catalogue.schemaVersion !== 'stadtstack-signals-v1' || !Array.isArray(catalogue.cities)) throw new Error('Unsupported city signals catalogue.');
  return catalogue;
}
export async function readCitySignals(cityId: string): Promise<SignalResult> {
  const catalogue = await readSignalsCatalogue();
  // Never use raw input as a filesystem path: only catalogue IDs select directories.
  const city = catalogue.cities.find((entry) => entry.id === cityId && /^[a-z0-9-]+$/.test(entry.id));
  if (!city) return { state: 'not_covered', city: cityId, coveredCities: catalogue.cities, generatedAt: catalogue.generatedAt };
  const directory = join(dataDirectory(), 'cities', city.id);
  const [signals, changes] = await Promise.all([
    jsonFile<CityCollection>(join(directory, city.minUrl ? 'signals.min.geojson' : 'signals.geojson')),
    jsonFile<CitySignals['changes']>(join(directory, 'changes.json')),
  ]);
  if (signals.type !== 'FeatureCollection' || !Array.isArray(signals.features)) throw new Error('Invalid city signals collection.');
  return { state: 'covered', data: { catalogue: city, coveredCities: catalogue.cities, generatedAt: catalogue.generatedAt, signals, changes } };
}
export interface CityCoverage {
  generatedAt: string;
  cities: { id: string; name: string; news: boolean; events: boolean; projects: boolean; councilPapers: boolean; evidence: boolean }[];
}
/** Lightweight catalogue coverage; no map geometry enters the picker response. */
export async function readCityCoverage(): Promise<CityCoverage> {
  const catalogue = await readSignalsCatalogue();
  const cities = await Promise.all(catalogue.cities.map(async (city) => {
    const feed = await readCityFeed(city.id);
    const items = feed.state === 'available' ? feed.feed.items : [];
    return {
      id: city.id, name: city.name,
      news: items.some((item) => item.kind === 'news'),
      events: items.some((item) => item.kind === 'event'),
      projects: city.sources.some((source) => source.kind === 'planning' || source.kind === 'atlas'),
      councilPapers: city.sources.some((source) => source.kind === 'council'),
      evidence: city.sources.some((source) => source.kind === 'planning' || source.kind === 'atlas' || source.kind === 'council'),
    };
  }));
  return { generatedAt: catalogue.generatedAt, cities };
}

export async function readCitySignal(cityId: string, signalId: string): Promise<Signal | null> {
  const catalogue = await readSignalsCatalogue();
  const city = catalogue.cities.find((entry) => entry.id === cityId && /^[a-z0-9-]+$/.test(entry.id));
  if (!city) return null;
  const signals = await jsonFile<SignalCollection>(join(dataDirectory(), 'cities', city.id, 'signals.geojson'));
  if (signals.type !== 'FeatureCollection' || !Array.isArray(signals.features)) throw new Error('Invalid city signals collection.');
  return signals.features.find((feature) => feature.properties.id === signalId) ?? null;
}

export async function readCityFeed(cityId: string): Promise<CityFeedResult> {
  const catalogue = await readSignalsCatalogue();
  const city = catalogue.cities.find((entry) => entry.id === cityId && /^[a-z0-9-]+$/.test(entry.id));
  if (!city || !city.feedUrl) return { state: 'not_available', cityId, cityName: city?.name ?? cityId };
  // A catalogue entry, never request input, selects the only allowed feed path.
  if (city.feedUrl !== `cities/${city.id}/feed.json`) throw new Error('Invalid city feed path.');
  const feed = await jsonFile<CityFeed>(join(dataDirectory(), city.feedUrl));
  if (feed.schemaVersion !== 'stadtstack-feed-v1' || feed.cityId !== city.id || !Array.isArray(feed.sources) || !Array.isArray(feed.items))
    throw new Error('Invalid city feed publication.');
  // Published files generated before venue enrichment carry no location fields.
  const items = feed.items.map((item) => {
    const geometry = item.geometry ?? null;
    if (geometry && (item.kind !== 'event' || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates) ||
      geometry.coordinates.length !== 2 || !Number.isFinite(geometry.coordinates[0]) || !Number.isFinite(geometry.coordinates[1]) ||
      Math.abs(geometry.coordinates[0]) > 180 || Math.abs(geometry.coordinates[1]) > 90 ||
      item.geometryPrecision === 'none' || !item.locationSource?.url)) throw new Error('Invalid city event geometry.');
    return { ...item, publisherRecordId: item.publisherRecordId ?? null, venue: item.venue ?? null, geometry, geometryPrecision: geometry ? (item.geometryPrecision ?? 'approximate') : 'none' as const, locationSource: item.locationSource ?? null };
  });
  return { state: 'available', cityId: city.id, cityName: city.name, feed: { ...feed, items } };
}

const stageOrder = ['adopted', 'decision_recorded', 'evaluation', 'decision_pending', 'consultation_closed', 'consultation', 'draft', 'planning', 'referred', 'agenda'];
const stageRank = (stage: string) => { const index = stageOrder.indexOf(stage); return index < 0 ? stageOrder.length : index; };

/** An optional published region applies only to cities explicitly named in its manifest. */
export async function readRegionalTopics(cityId: string): Promise<RegionalTopicResult> {
  if (!/^[a-z0-9-]+$/.test(cityId)) return { state: 'not_available', cityId };
  const directory = join(dataDirectory(), 'regions');
  const regions = await readdir(/* turbopackIgnore: true */ directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of regions) {
    if (!entry.isDirectory() || !/^[a-z0-9-]+$/.test(entry.name)) continue;
    const published = await jsonFile<RegionalPublication>(join(directory, entry.name, 'topics.json'));
    if (published.schemaVersion !== 'stadtstack-regional-topics-v1' || published.region?.id !== entry.name ||
      !Array.isArray(published.topics) || !Array.isArray(published.municipalities) || !published.cityRegions || typeof published.cityRegions !== 'object')
      throw new Error('Invalid regional topics publication.');
    if (published.cityRegions[cityId] !== entry.name) continue;
    const names = new Map(published.municipalities.map((municipality) => [municipality.id, municipality.name]));
    const topics = published.topics.flatMap((topic) => {
      const participants = topic.municipalities.flatMap((municipality) => {
        const name = names.get(municipality.municipalityId);
        return name && municipality.items[0]
          ? [{ id: municipality.municipalityId, name, stage: municipality.stage, source: municipality.items[0] }] : [];
      });
      if (participants.length < 2) return [];
      const furthest = participants.toSorted((a, b) => stageRank(a.stage) - stageRank(b.stage))[0];
      const own = topic.municipalities.find((municipality) => municipality.municipalityId === cityId);
      return [{
        id: topic.id, label: topic.label, summary: topic.summary, reviewState: topic.reviewState,
        stage: own?.stage ?? null, items: own?.items ?? [],
        neighbours: participants.filter((participant) => participant.id !== cityId),
        furthest,
      }];
    }).toSorted((a, b) => Number(b.items.length > 0) - Number(a.items.length > 0));
    return { state: 'available', regionName: published.region.name, cityId, topics };
  }
  return { state: 'not_available', cityId };
}
