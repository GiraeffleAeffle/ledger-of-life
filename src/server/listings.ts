import { randomUUID } from 'node:crypto';
import type { VerifiedIdentity, VerifiedWallet } from '../wallets/identity-policy.ts';
import { atomic } from '../domain/assets.ts';
import { WorkflowError } from '../domain/workflow.ts';
import { requireReady, walletFor, type Agreement } from './agreements.ts';
import { AccessError, ConflictError } from './workspaces.ts';
import type { Store } from './store.ts';

/**
 * Pre-tenancy workflow: a landlord publishes a home, verified people apply, the landlord chooses
 * one applicant, and that choice creates the agreement with both parties already bound. Only the
 * neutral arbitrator still joins by invitation. No money or chain state is involved here.
 */
export interface Application {
  id: string;
  subject: string;
  wallet: VerifiedWallet;
  name: string;
  message: string;
  at: string;
}
export interface Listing {
  id: string;
  network: 'solana';
  landlord: { subject: string; wallet: VerifiedWallet };
  title: string;
  description: string;
  details: HomeDetails;
  rentMonthly: string;
  requiredSecurity: string;
  releaseAllowed: boolean;
  status: 'open' | 'let';
  createdAt: string;
  applications: Application[];
  agreementId: string | null;
  chosenApplicationId: string | null;
}
export interface HomeDetails {
  city: string;
  rooms: number;
  sizeSqm: number;
  availableFrom: string;
  /** Preset stock photos or small uploaded JPEG/PNG/WebP data URLs. */
  photos: string[];
}
/** Curated stock photos landlords can pick instead of uploading. */
export const PRESET_PHOTOS = [
  'photo-1502672260266-1c1ef2d93688',
  'photo-1522708323590-d24dbb6b0267',
  'photo-1560448204-e02f11c3d0e2',
  'photo-1493809842364-78817add7ffb',
  'photo-1484154218962-a197022b5858',
  'photo-1505691938895-1758d7feb511',
].map((id) => `https://images.unsplash.com/${id}?w=1200&q=70&auto=format&fit=crop`);

export interface PublicListing {
  id: string;
  title: string;
  description: string;
  details: HomeDetails;
  rentMonthly: string;
  requiredSecurity: string;
  releaseAllowed: boolean;
  status: Listing['status'];
  createdAt: string;
  applicants: number;
  /** Viewer-specific: 'landlord', 'applicant', 'chosen' or null. */
  relation: 'landlord' | 'applicant' | 'chosen' | null;
  applications?: Omit<Application, 'subject' | 'wallet'>[];
  agreementId: string | null;
}

const key = (id: string) => `listing:${id}`;
const text = (value: unknown, min: number, max: number, field: string) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    throw new WorkflowError(`${field} must be between ${min} and ${max} characters.`);
  return value.trim();
};
const amount = (value: unknown, field: string) => {
  if (typeof value !== 'string') throw new WorkflowError(`${field} is required.`);
  const parsed = atomic(value);
  if (parsed <= 0n || parsed > 10_000_000_000n)
    throw new WorkflowError(`${field} must be between zero and 10,000 units.`);
  return parsed.toString();
};

export function publicListing(value: Listing, identity: VerifiedIdentity | null): PublicListing {
  const own = identity && value.landlord.subject === identity.subject;
  const application = identity && value.applications.find((item) => item.subject === identity.subject);
  const chosen = Boolean(application && application.id === value.chosenApplicationId);
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    details: value.details ?? { city: '', rooms: 0, sizeSqm: 0, availableFrom: '', photos: [] },
    rentMonthly: value.rentMonthly,
    requiredSecurity: value.requiredSecurity,
    releaseAllowed: value.releaseAllowed,
    status: value.status,
    createdAt: value.createdAt,
    applicants: value.applications.length,
    relation: own ? 'landlord' : application ? (chosen ? 'chosen' : 'applicant') : null,
    // Only the landlord sees applicants; applicants never see each other.
    applications: own ? value.applications.map(({ id, name, message, at }) => ({ id, name, message, at })) : undefined,
    agreementId: own || chosen ? value.agreementId : null,
  };
}

function details(input: Record<string, unknown>): HomeDetails {
  const whole = (value: unknown, min: number, max: number, field: string) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new WorkflowError(`${field} must be between ${min} and ${max}.`);
    return parsed;
  };
  const photos = Array.isArray(input.photos) ? input.photos : [];
  if (photos.length > 4) throw new WorkflowError('Add up to four photos.');
  for (const photo of photos)
    if (typeof photo !== 'string' || !(PRESET_PHOTOS.includes(photo) || (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) && photo.length <= 700_000)))
      throw new WorkflowError('Use one of the sample photos or a JPEG, PNG or WebP under 500 KB.');
  const availableFrom = typeof input.availableFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.availableFrom) ? input.availableFrom : '';
  return {
    city: text(input.city ?? '', 0, 80, 'The city'),
    rooms: whole(input.rooms ?? 1, 1, 20, 'Rooms'),
    sizeSqm: whole(input.sizeSqm ?? 40, 10, 1000, 'The size'),
    availableFrom,
    photos: photos as string[],
  };
}

export async function createListing(store: Store, identity: VerifiedIdentity, input: Record<string, unknown>) {
  requireReady(identity);
  if (typeof input.releaseAllowed !== 'boolean') throw new WorkflowError('Choose the earnings policy.');
  const value: Listing = {
    id: randomUUID(),
    network: 'solana',
    landlord: { subject: identity.subject, wallet: walletFor(identity, 'solana') },
    title: text(input.title, 3, 120, 'The title'),
    description: text(input.description ?? '', 0, 2000, 'The description'),
    details: details(input),
    rentMonthly: amount(input.rentMonthly, 'The monthly rent'),
    requiredSecurity: amount(input.requiredSecurity, 'The deposit'),
    releaseAllowed: input.releaseAllowed,
    status: 'open',
    createdAt: new Date().toISOString(),
    applications: [],
    agreementId: null,
    chosenApplicationId: null,
  };
  await store.create(key(value.id), value);
  return publicListing(value, identity);
}

export async function listListings(store: Store, identity: VerifiedIdentity | null) {
  const rows = await store.scan<Listing>('listing:', '', 200);
  return rows
    .map((row) => row.value)
    .filter((value) => value.status === 'open' || (identity && publicListing(value, identity).relation))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((value) => publicListing(value, identity));
}

export async function applyToListing(store: Store, identity: VerifiedIdentity, id: string, input: Record<string, unknown>) {
  requireReady(identity);
  const wallet = walletFor(identity, 'solana');
  const next = await store.update<Listing>(key(id), (value) => {
    if (value.status !== 'open') throw new ConflictError('This home is no longer available.');
    if (value.landlord.subject === identity.subject || value.landlord.wallet.address === wallet.address)
      throw new AccessError('Landlords cannot apply to their own listing.');
    if (value.applications.some((item) => item.subject === identity.subject))
      throw new ConflictError('You already applied for this home.');
    if (value.applications.length >= 50) throw new ConflictError('This listing has reached its application limit.');
    const application: Application = {
      id: randomUUID(),
      subject: identity.subject,
      wallet,
      name: text(input.name, 2, 80, 'Your name'),
      message: text(input.message, 10, 2000, 'Your message'),
      at: new Date().toISOString(),
    };
    return { ...value, applications: [...value.applications, application] };
  });
  return publicListing(next, identity);
}

/** The landlord's choice creates the agreement with landlord and tenant already bound. */
export async function chooseApplicant(store: Store, identity: VerifiedIdentity, id: string, applicationId: unknown) {
  const listing = await store.get<Listing>(key(id));
  if (!listing) throw new AccessError('This listing is unavailable.');
  if (listing.landlord.subject !== identity.subject) throw new AccessError('Only the landlord chooses a tenant.');
  if (listing.status !== 'open') throw new ConflictError('A tenant was already chosen.');
  const application = listing.applications.find((item) => item.id === applicationId);
  if (!application) throw new WorkflowError('Choose one of the applications.');
  const agreement: Agreement = {
    id: randomUUID(),
    network: 'solana',
    property: listing.title,
    requiredSecurity: listing.requiredSecurity,
    releaseAllowed: listing.releaseAllowed,
    createdAt: new Date().toISOString(),
    revision: 0,
    parties: {
      landlord: listing.landlord,
      tenant: { subject: application.subject, wallet: application.wallet },
    },
    invitations: {},
    accepted: {},
    records: [],
  };
  await store.create(`agreement:${agreement.id}`, agreement);
  const next = await store.update<Listing>(key(id), (value) => {
    if (value.status !== 'open') throw new ConflictError('A tenant was already chosen.');
    return { ...value, status: 'let', agreementId: agreement.id, chosenApplicationId: application.id };
  });
  return publicListing(next, identity);
}
