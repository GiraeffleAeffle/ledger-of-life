import { isCivicCity } from './civic-cities.ts';

export const LOYALTY_ORIGIN = 'https://loyalty.stadtstack.eu';
export const LOYALTY_FEED = `${LOYALTY_ORIGIN}/api/loyalty-merchants`;
export const LOYALTY_TEST_LABEL = 'Test entry · not a real business';
const MAX_FEED_BYTES = 262144;

/** Owner-reviewed public records only; no customer identity, balances or wallet data. */
export interface LoyaltyMerchant {
  id: string;
  city: string;
  name: string;
  coordinates: [number, number];
  source: string;
  program: { id: string; name: string };
  network: 'sepolia';
  checkedAt: string;
  test?: true;
}
export interface LoyaltyPlaces {
  state: 'empty' | 'ready';
  merchants: LoyaltyMerchant[];
  links: { signup: string; collect: string; exchange: string };
}

/** Used by both the accessible merchant list and the actual optional map layer. */
export function loyaltyMapMerchants(result: LoyaltyPlaces | null, city: string, enabled: boolean): LoyaltyMerchant[] {
  return enabled && result?.state === 'ready' ? result.merchants.filter((merchant) => merchant.city === city) : [];
}

/** Test entries can be explored, but never contribute to real-shop participation. */
export function loyaltyRealShopCount(merchants: readonly LoyaltyMerchant[]): number {
  let count = 0;
  for (const merchant of merchants) if (merchant.test !== true) count++;
  return count;
}
export function loyaltyEntryLabel(merchant: LoyaltyMerchant): string {
  return merchant.test ? `${merchant.name} · ${LOYALTY_TEST_LABEL}` : merchant.name;
}
const sourceHosts = ['stadtstack.eu', 'loyalty.stadtstack.eu'];
const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function merchantRecord(value: unknown, today: string): LoyaltyMerchant | null {
  if (!object(value) || Object.keys(value).some((key) => !['id', 'city', 'name', 'coordinates', 'source', 'program', 'network', 'checkedAt', 'test'].includes(key))) return null;
  const { id, city, name, coordinates, source, program, network, checkedAt, test } = value;
  const testEntry = Object.hasOwn(value, 'test');
  if (testEntry && test !== true) return null;
  if (!text(id, 80) || !idPattern.test(id) || typeof city !== 'string' || !isCivicCity(city) || !text(name, 160) || network !== 'sepolia') return null;
  if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 85.051129) return null;
  if (!object(program) || Object.keys(program).some((key) => key !== 'id' && key !== 'name') || !text(program.id, 16) || !/^(0|[1-9][0-9]*)$/.test(program.id) || !Number.isSafeInteger(Number(program.id)) || !text(program.name, 160)) return null;
  if (!text(checkedAt, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) || checkedAt > today) return null;
  const timestamp = Date.parse(`${checkedAt}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== checkedAt) return null;
  // Evidence must be published on the approved Stadtstack hosts, not an arbitrary
  // fetch target, javascript link, private service, credential URL or Vercel page.
  if (!text(source, 2048) || /[\\\s]/.test(source)) return null;
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' || !sourceHosts.includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname === '/' || url.href !== source) return null;
    if (/%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)/i.test(url.pathname)) return null;
  } catch { return null; }
  return { id, city, name, coordinates: [coordinates[0], coordinates[1]], source, program: { id: program.id, name: program.name }, network, checkedAt, ...(testEntry ? { test: true as const } : {}) };
}

/** Invalid evidence is an error, never a misleading successful empty feed. */
export function parseLoyaltyPlaces(city: string, records: unknown, today = new Date().toISOString().slice(0, 10)): LoyaltyPlaces {
  if (!isCivicCity(city)) throw new Error('Unknown civic city');
  if (!Array.isArray(records) || records.length > 200) throw new Error('Invalid merchant feed');
  const ids = new Set<string>();
  const merchants: LoyaltyMerchant[] = [];
  for (const record of records) {
    const merchant = merchantRecord(record, today);
    if (!merchant || ids.has(merchant.id)) throw new Error('Invalid merchant evidence');
    ids.add(merchant.id);
    if (merchant.city === city) merchants.push(merchant);
  }
  // Native customer routes select their own program; opening a link never joins it.
  return {
    state: merchants.length ? 'ready' : 'empty',
    merchants,
    links: { signup: `${LOYALTY_ORIGIN}/profile`, collect: `${LOYALTY_ORIGIN}/rewards`, exchange: `${LOYALTY_ORIGIN}/exchange` },
  };
}

/** Browser-only public read: no Ledger identity, location, cookie or wallet data. */
export async function fetchLoyaltyPlaces(city: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<LoyaltyPlaces> {
  if (!isCivicCity(city)) throw new Error('Unknown civic city');
  const response = await fetcher(LOYALTY_FEED, {
    method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
    redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
    await response.body?.cancel();
    throw new Error('Merchant feed unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let json = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_FEED_BYTES) throw new Error('Merchant feed too large');
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
    return parseLoyaltyPlaces(city, JSON.parse(json));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
