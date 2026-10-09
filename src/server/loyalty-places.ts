import { isCivicCity } from '../data/civic-cities.ts';
import type { LoyaltyMerchant, LoyaltyPlaces } from '../data/loyalty-places.ts';

/** Proposed owner-provisioned origin; configuration alone does not attest availability. */
const approvedOrigin = 'https://loyalty.stadtstack.eu';
const sourceHosts = ['stadtstack.eu', 'loyalty.stadtstack.eu'];
const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function merchantRecord(value: unknown, today: string): LoyaltyMerchant | null {
  if (!object(value) || Object.keys(value).some((key) => !['id', 'city', 'name', 'coordinates', 'source', 'program', 'network', 'checkedAt'].includes(key))) return null;
  const { id, city, name, coordinates, source, program, network, checkedAt } = value;
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
  return { id, city, name, coordinates: [coordinates[0], coordinates[1]], source, program: { id: program.id, name: program.name }, network, checkedAt };
}

/** LEDGER_LOYALTY_MERCHANTS is inline PUBLIC JSON, never a URL or file path.
 * No network reads occur. A malformed entry invalidates the entire registry.
 * Operator publication must substantiate merchant participation, program and location;
 * schema validation alone is not evidence of an operating shop or hosted acceptance. */
export function readLoyaltyPlaces(city: string, config: { origin?: string; merchants?: string } = {
  origin: process.env.LEDGER_LOYALTY_ORIGIN, merchants: process.env.LEDGER_LOYALTY_MERCHANTS,
}, today = new Date().toISOString().slice(0, 10)): LoyaltyPlaces {
  if (!isCivicCity(city)) throw new Error('Unknown civic city');
  const empty: LoyaltyPlaces = { state: 'needs_hosting', merchants: [], links: null };
  if (config.origin !== approvedOrigin && config.origin !== `${approvedOrigin}/`) return empty;
  empty.state = 'no_verified_shops';
  if (!config.merchants || config.merchants.length > 262144) return empty;
  let records: unknown;
  try { records = JSON.parse(config.merchants); } catch { return empty; }
  if (!Array.isArray(records) || !records.length || records.length > 200) return empty;
  const ids = new Set<string>();
  const merchants: LoyaltyMerchant[] = [];
  for (const record of records) {
    const merchant = merchantRecord(record, today);
    if (!merchant || ids.has(merchant.id)) return empty;
    ids.add(merchant.id);
    if (merchant.city === city) merchants.push(merchant);
  }
  if (!merchants.length) return empty;
  // Native customer routes have no merchant/program query contract. Hand off to
  // their existing selection UI, never pretend a merchant was automatically joined.
  return { state: 'ready', merchants, links: { signup: `${approvedOrigin}/profile`, collect: `${approvedOrigin}/rewards`, exchange: `${approvedOrigin}/exchange` } };
}
