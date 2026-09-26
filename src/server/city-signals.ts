import 'server-only';
import { readFile, stat } from 'node:fs/promises';
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
  url: string; title: string; publisher: string; locator: string; retrievedAt: string;
  sha256: string; licence: string; reuse: string;
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
    reviewState: 'candidate' | 'auto_checked' | 'reviewed'; asOf: string;
  };
}
export interface SignalCollection { type: 'FeatureCollection'; features: Signal[] }
export interface SignalCity {
  id: string; name: string; state: string; center: Coordinate; bbox: [number, number, number, number];
  sources: { id: string; kind: string; publisher: string; url: string; licence: string; reuse: string; retrievedAt: string }[];
}
export interface SignalCatalogue { schemaVersion: 'stadtstack-signals-v1'; generatedAt: string; cities: SignalCity[] }
export interface CitySignals { catalogue: SignalCity; generatedAt: string; signals: SignalCollection; changes: { added: string[]; changed: string[]; removed: string[] } }
export type SignalResult = { state: 'covered'; data: CitySignals } | { state: 'not_covered'; city: string; coveredCities: SignalCity[] };

// mtime and file path are both part of the key: switching STADTSTACK_DATA_DIR never serves an old city.
const files = new Map<string, { mtimeMs: number; size: number; value: unknown }>();
async function jsonFile<T>(path: string): Promise<T> {
  const info = await stat(path);
  const cached = files.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value as T;
  const value = JSON.parse(await readFile(path, 'utf8')) as T;
  files.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
}
const dataDirectory = () => resolve(process.env.STADTSTACK_DATA_DIR ?? join(process.cwd(), 'stadtstack-data/out'));
export async function readSignalsCatalogue(): Promise<SignalCatalogue> {
  const catalogue = await jsonFile<SignalCatalogue>(join(dataDirectory(), 'catalogue.json'));
  if (catalogue.schemaVersion !== 'stadtstack-signals-v1' || !Array.isArray(catalogue.cities)) throw new Error('Unsupported city signals catalogue.');
  return catalogue;
}
export async function readCitySignals(cityId: string): Promise<SignalResult> {
  const catalogue = await readSignalsCatalogue();
  // Never use raw input as a filesystem path: only catalogue IDs select directories.
  const city = catalogue.cities.find((entry) => entry.id === cityId && /^[a-z0-9-]+$/.test(entry.id));
  if (!city) return { state: 'not_covered', city: cityId, coveredCities: catalogue.cities };
  const directory = join(dataDirectory(), 'cities', city.id);
  const [signals, changes] = await Promise.all([
    jsonFile<SignalCollection>(join(directory, 'signals.geojson')),
    jsonFile<CitySignals['changes']>(join(directory, 'changes.json')),
  ]);
  if (signals.type !== 'FeatureCollection' || !Array.isArray(signals.features)) throw new Error('Invalid city signals collection.');
  return { state: 'covered', data: { catalogue: city, generatedAt: catalogue.generatedAt, signals, changes } };
}
