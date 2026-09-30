import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/errors.ts';
import type { Store } from './store.ts';
import { cityIdFor, coveredNames } from '../components/city-coverage.ts';

/**
 * "Your city" through the Stadtstack project atlas. The atlas owns collection, sources and review;
 * this app only reads its public read model (atlas-city-read-model-v1) and keeps the atlas's own
 * provenance labels (as-of date, review state, coverage) next to every figure.
 */
const ATLAS = (process.env.STADTSTACK_ATLAS_URL ?? 'http://localhost:4317').replace(/\/$/, '');
const SCHEMA = 'atlas-city-read-model-v1';

type AtlasProject = {
  id: string; title: string; place?: string; stage: string; status: string; category?: string;
  latest?: string; next?: string; consultation?: { start?: string; end?: string; url?: string };
};
type AtlasReadModel = {
  schemaVersion: string; municipalityId: string; jurisdictionType?: string; asOf: string;
  reviewState: string; fullMunicipalInventory: boolean; projects: AtlasProject[];
};

export interface CityView {
  available: true;
  cityId: string;
  name: string;
  source: 'identity' | 'chosen';
  asOf: string;
  reviewState: string;
  fullInventory: boolean;
  projectCount: number;
  openConsultations: { id: string; title: string; place?: string; until: string; url?: string }[];
  recent: { id: string; title: string; status: string; stage: string; latest: string }[];
  portalUrl: string;
}
export type CityResult = CityView | { available: false; reason: string; name?: string; cityId?: string; source?: 'identity' | 'chosen'; explicitlyUncovered?: boolean };

const key = (subject: string) => `city:${subject}`;

/** Atlas ids are lowercase ASCII slugs: "Strausberg" → strausberg, "Frankfurt (Oder)" → frankfurt-oder. */
export function citySlug(name: string): string {
  return name.trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function chooseCity(store: Store, identity: VerifiedIdentity, name: string) {
  const city = name.trim().slice(0, 80);
  if (!citySlug(city)) throw new WorkflowError('Enter a city name.');
  if (!cityIdFor(city)) {
    const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ city, country: 'Germany', format: 'jsonv2', limit: '1' })}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'LedgerOfLifePlaces/1.0 (public city lookup)', 'Accept-Language': 'de' }, signal: AbortSignal.timeout(8000) })
      .catch(() => { throw new WorkflowError('We could not check that place right now. Please try again.'); });
    if (!response.ok) throw new WorkflowError('We could not check that place right now. Please try again.');
    const results = await response.json() as { lat?: string; lon?: string }[];
    if (!Array.isArray(results) || !results.some((result) => Number.isFinite(Number(result.lat)) && Number.isFinite(Number(result.lon))))
      throw new WorkflowError('We could not find that place in Germany. Check its spelling.');
  }
  const value = { name: cityIdFor(city) ? coveredNames[cityIdFor(city)!] : city, explicitlyUncovered: !cityIdFor(city) };
  await store.update(key(identity.subject), () => value).catch(() => store.create(key(identity.subject), value));
}

export async function readCity(store: Store, identity: VerifiedIdentity, verifiedCity?: string): Promise<CityResult> {
  const saved = await store.get<{ name: string; explicitlyUncovered?: boolean }>(key(identity.subject));
  const chosen = saved?.name;
  const name = chosen ?? verifiedCity;
  if (!name) return { available: false, reason: 'choose' };
  const cityId = cityIdFor(name);
  const source = chosen ? 'chosen' : 'identity';
  if (!cityId) return { available: false, reason: 'not_covered', name, source, explicitlyUncovered: Boolean(chosen && saved?.explicitlyUncovered) };
  const unavailable = (reason: string): CityResult => ({ available: false, reason, name: coveredNames[cityId], cityId, source });
  const response = await fetch(`${ATLAS}/api/atlas/${encodeURIComponent(cityId)}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!response) return unavailable('atlas_unavailable');
  if (response.status === 404) return unavailable('atlas_unavailable');
  if (!response.ok) return unavailable('atlas_unavailable');
  const model = await response.json().catch(() => null) as AtlasReadModel | null;
  if (!model || model.schemaVersion !== SCHEMA) return unavailable('atlas_unavailable');
  const today = new Date().toISOString().slice(0, 10);
  return {
    available: true,
    cityId,
    name: coveredNames[cityId],
    source,
    asOf: model.asOf,
    reviewState: model.reviewState,
    fullInventory: model.fullMunicipalInventory,
    projectCount: model.projects.length,
    openConsultations: model.projects
      .filter((p) => p.consultation?.end && p.consultation.end >= today)
      .sort((a, b) => a.consultation!.end!.localeCompare(b.consultation!.end!))
      .map((p) => ({ id: p.id, title: p.title, place: p.place, until: p.consultation!.end!, url: p.consultation!.url })),
    recent: model.projects
      .filter((p) => p.latest && /^\d{4}-\d{2}-\d{2}$/.test(p.latest))
      .sort((a, b) => b.latest!.localeCompare(a.latest!))
      .slice(0, 4)
      .map((p) => ({ id: p.id, title: p.title, status: p.status, stage: p.stage, latest: p.latest! })),
    portalUrl: `${ATLAS}/?city=${encodeURIComponent(cityId)}`,
  };
}
