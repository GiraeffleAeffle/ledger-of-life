import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/workflow.ts';
import type { Store } from './store.ts';

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
export type CityResult = CityView | { available: false; reason: string; name?: string };

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
  const value = { name: city };
  await store.update(key(identity.subject), () => value).catch(() => store.create(key(identity.subject), value));
}

export async function readCity(store: Store, identity: VerifiedIdentity, verifiedCity?: string): Promise<CityResult> {
  const chosen = (await store.get<{ name: string }>(key(identity.subject)))?.name;
  const name = verifiedCity ?? chosen;
  if (!name) return { available: false, reason: 'choose' };
  const cityId = citySlug(name);
  const response = await fetch(`${ATLAS}/api/atlas/${encodeURIComponent(cityId)}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!response) return { available: false, reason: 'The Stadtstack atlas is not reachable right now.', name };
  if (response.status === 404) return { available: false, reason: `The Stadtstack atlas has no research for ${name} yet.`, name };
  if (!response.ok) return { available: false, reason: `The Stadtstack atlas answered ${response.status}.`, name };
  const model = (await response.json()) as AtlasReadModel;
  if (model.schemaVersion !== SCHEMA) return { available: false, reason: `Unsupported atlas format (${model.schemaVersion}).`, name };
  const today = new Date().toISOString().slice(0, 10);
  return {
    available: true,
    cityId,
    name,
    source: verifiedCity ? 'identity' : 'chosen',
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
