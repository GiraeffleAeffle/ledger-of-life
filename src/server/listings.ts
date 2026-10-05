import { randomUUID } from 'node:crypto';
import type { VerifiedIdentity, VerifiedWallet } from '../wallets/identity-policy.ts';
import { atomic } from '../domain/assets.ts';
import { WorkflowError } from '../domain/errors.ts';
import { requireReady, walletFor, type Agreement } from './agreements.ts';
import { AccessError, ConflictError } from './errors.ts';
import type { Store } from './store.ts';
import { roundedLocation, type HomeLocation } from '../domain/home-location.ts';
import { cashDepositForm, shareDepositForm, solanaShareDepositForm, validateDepositSecurity, type DepositForm } from '../domain/deposit-form.ts';
import { loadShareDepositManifest, requireDeposit } from './share-deposit-chain.ts';
import { BUILDING_RENT_SHARE_BPS, RENT_BUILDING_ID, type BuildingRent } from '../domain/rent.ts';
import { loadSolanaHouseManifest } from './solana-house-config.ts';
import { solanaSharesConfiguration } from './solana-shares-config.ts';

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
  network: 'solana' | 'robinhood';
  depositForm?: DepositForm;
  buildingRent?: BuildingRent;
  landlord: { subject: string; wallet: VerifiedWallet };
  title: string;
  description: string;
  details: HomeDetails;
  location?: HomeLocation;
  rentMonthly: string;
  requiredSecurity: string;
  releaseAllowed: boolean;
  status: 'open' | 'let' | 'closed';
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
  /** Self-hosted sample photos; no uploaded personal files. */
  photos: string[];
}
/** Curated, self-hosted stock photos landlords can pick. */
export const PRESET_PHOTOS = [
  'photo-1502672260266-1c1ef2d93688',
  'photo-1522708323590-d24dbb6b0267',
  'photo-1560448204-e02f11c3d0e2',
  'photo-1493809842364-78817add7ffb',
  'photo-1484154218962-a197022b5858',
  'photo-1505691938895-1758d7feb511',
].map((id) => `/samples/${id}.jpg`);

export interface PublicListing {
  id: string;
  title: string;
  description: string;
  details: HomeDetails;
  location?: HomeLocation;
  rentMonthly: string;
  requiredSecurity: string;
  depositForm?: DepositForm;
  buildingRent?: BuildingRent;
  releaseAllowed: boolean;
  status: Listing['status'];
  createdAt: string;
  applicants: number;
  /** Viewer-specific: 'landlord', 'applicant', 'chosen' or null. */
  relation: 'landlord' | 'applicant' | 'chosen' | null;
  applications?: Omit<Application, 'subject' | 'wallet'>[];
  agreementId: string | null;
  sample?: boolean;
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
    details: { ...(value.details ?? { city: '', rooms: 0, sizeSqm: 0, availableFrom: '', photos: [] }),
      photos: (value.details?.photos ?? []).flatMap((photo) => {
        const sample = PRESET_PHOTOS.find((path) => path === photo || photo.startsWith(`https://images.unsplash.com/${path.slice('/samples/'.length, -4)}?`));
        return sample ? [sample] : [];
      }) },
    location: value.location,
    rentMonthly: value.rentMonthly,
    requiredSecurity: value.requiredSecurity,
    depositForm: value.depositForm ?? cashDepositForm(),
    buildingRent: value.buildingRent,
    releaseAllowed: value.releaseAllowed,
    status: value.status,
    createdAt: value.createdAt,
    applicants: value.applications.length,
    relation: own ? 'landlord' : application ? (chosen ? 'chosen' : 'applicant') : null,
    // Only the landlord sees applicants; applicants never see each other.
    applications: own ? value.applications.map(({ id, name, message, at, subject }) => ({ id, name: subject.startsWith('test-signer:') && !name.toLowerCase().includes('sample') ? `${name} · sample fixture` : name, message, at })) : undefined,
    sample: value.landlord.subject.startsWith('test-signer:'),
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
    if (typeof photo !== 'string' || !PRESET_PHOTOS.includes(photo))
      throw new WorkflowError('Use one of the self-hosted sample photos.');
  const availableFrom = typeof input.availableFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.availableFrom) ? input.availableFrom : '';
  return {
    city: text(input.city ?? '', 0, 80, 'The city'),
    rooms: whole(input.rooms ?? 1, 1, 20, 'Rooms'),
    sizeSqm: whole(input.sizeSqm ?? 40, 10, 1000, 'The size'),
    availableFrom,
    photos: photos as string[],
  };
}

export async function createListing(store: Store, identity: VerifiedIdentity, input: Record<string, unknown>, environment: Record<string, string | undefined> = process.env) {
  requireReady(identity);
  if (input.buildingHome !== undefined && typeof input.buildingHome !== 'boolean')
    throw new WorkflowError('Choose whether this flat is in the fictional Neighbourhood Homes building.');
  if (input.shareBps !== undefined || input.buildingRent !== undefined)
    throw new WorkflowError('The building rent share is fixed at 20%, not editable.');
  const houseManifest = input.buildingHome ? loadSolanaHouseManifest(environment) : null;
  const buildingRent: BuildingRent | undefined = input.buildingHome
    ? houseManifest
      ? { network: 'solana-devnet', house: houseManifest.houses['neighbourhood-homes'].house, shareBps: BUILDING_RENT_SHARE_BPS, landlordWallet: walletFor(identity, 'solana').address }
      : { buildingId: RENT_BUILDING_ID, shareBps: BUILDING_RENT_SHARE_BPS, landlordWallet: walletFor(identity, 'robinhood').address }
    : undefined;
  if (typeof input.releaseAllowed !== 'boolean') throw new WorkflowError('Choose the earnings policy.');
  if (input.depositForm !== undefined && input.depositForm !== 'cash' && input.depositForm !== 'shares' && input.depositForm !== 'shares-solana')
    throw new WorkflowError('Choose cash or shares for the deposit (Robinhood or Solana test shares).');
  const security = amount(input.requiredSecurity, 'The deposit');
  const rent = amount(input.rentMonthly, 'The monthly cold rent');
  validateDepositSecurity(rent, security, input.depositForm === 'shares' || input.depositForm === 'shares-solana' ? 'shares' : 'cash');
  const deployment = input.depositForm === 'shares' ? await loadShareDepositManifest() : null;
  if (input.depositForm === 'shares') requireDeposit(deployment?.factory, 'Share deposit not deployed yet');
  const solanaDeployment = input.depositForm === 'shares-solana' ? await solanaSharesConfiguration(environment) : null;
  if (input.depositForm === 'shares-solana' && !solanaDeployment) throw new WorkflowError('Solana share deposit not deployed yet.');
  const form = input.depositForm === 'shares-solana'
    ? solanaShareDepositForm(security, solanaDeployment!, input)
    : input.depositForm === 'shares'
      ? shareDepositForm(security, deployment!.factory, input)
      : cashDepositForm();
  const network = form.kind === 'shares' && form.network !== 'solana-devnet' ? 'robinhood' : 'solana';
  const value: Listing = {
    id: randomUUID(),
    network,
    depositForm: form,
    buildingRent,
    landlord: { subject: identity.subject, wallet: walletFor(identity, network) },
    title: text(input.title, 3, 120, 'The title'),
    description: text(input.description ?? '', 0, 2000, 'The description'),
    details: details(input),
    location: roundedLocation(input.location),
    rentMonthly: rent,
    requiredSecurity: security,
    releaseAllowed: form.kind === 'shares' ? false : input.releaseAllowed,
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
    .filter((value) => value.status === 'open' || (value.status === 'closed' && value.agreementId !== null) ||
      (identity && publicListing(value, identity).relation))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((value) => publicListing(value, identity));
}

export async function applyToListing(store: Store, identity: VerifiedIdentity, id: string, input: Record<string, unknown>) {
  requireReady(identity);
  const next = await store.update<Listing>(key(id), (value) => {
    const wallet = walletFor(identity, value.depositForm?.kind === 'shares' && value.depositForm.network !== 'solana-devnet' ? 'robinhood' : 'solana');
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
      name: text(input.name, 2, 40, 'Nickname'),
      message: text(input.message ?? '', 0, 500, 'Optional message'),
      at: new Date().toISOString(),
    };
    return { ...value, applications: [...value.applications, application] };
  });
  return publicListing(next, identity);
}

/** Closing an unchosen listing changes only its availability; no tenancy or deposit exists yet. */
export async function closeListing(store: Store, identity: VerifiedIdentity, id: string) {
  const listing = await store.update<Listing>(key(id), (value) => {
    if (value.landlord.subject !== identity.subject) throw new AccessError('Only the landlord can close this listing.');
    if (value.status === 'let') throw new ConflictError('A chosen tenancy cannot be cancelled here.');
    return { ...value, status: 'closed' };
  });
  return publicListing(listing, identity);
}

export async function withdrawApplication(store: Store, identity: VerifiedIdentity, id: string) {
  const listing = await store.update<Listing>(key(id), (value) => {
    if (value.status !== 'open') throw new ConflictError('This application is already part of a chosen or closed listing.');
    if (!value.applications.some((application) => application.subject === identity.subject))
      throw new AccessError('You have no application for this listing.');
    return { ...value, applications: value.applications.filter((application) => application.subject !== identity.subject) };
  });
  return publicListing(listing, identity);
}

/** The landlord's choice creates the agreement with landlord and tenant already bound. */
export async function chooseApplicant(store: Store, identity: VerifiedIdentity, id: string, applicationId: unknown) {
  const listing = await store.get<Listing>(key(id));
  if (!listing) throw new AccessError('This listing is unavailable.');
  const chosen = await store.update<Listing>(key(id), (value) => {
    if (value.landlord.subject !== identity.subject) throw new AccessError('Only the landlord chooses a tenant.');
    if (value.status !== 'open') {
      if (value.chosenApplicationId === applicationId && value.agreementId) return value;
      throw new ConflictError('A tenant was already chosen.');
    }
    if (typeof applicationId !== 'string' || !value.applications.some((item) => item.id === applicationId))
      throw new WorkflowError('Choose one of the applications.');
    return { ...value, status: 'let', agreementId: `listing-${value.id}`, chosenApplicationId: applicationId };
  });
  const application = chosen.applications.find((item) => item.id === chosen.chosenApplicationId)!;
  const agreement: Agreement = {
    id: chosen.agreementId!,
    network: chosen.network,
    depositForm: chosen.depositForm,
    ...(chosen.buildingRent ? { rentTerms: { ...chosen.buildingRent, rentMonthly: chosen.rentMonthly } } : {}),
    property: chosen.title,
    home: { city: chosen.details.city, location: chosen.location },
    requiredSecurity: chosen.requiredSecurity,
    releaseAllowed: chosen.releaseAllowed,
    createdAt: new Date().toISOString(),
    revision: 0,
    parties: {
      landlord: chosen.landlord,
      tenant: { subject: application.subject, wallet: application.wallet },
    },
    invitations: {},
    accepted: {},
    records: [],
  };
  const agreementKey = `agreement:${agreement.id}`;
  let existing = await store.get<Agreement>(agreementKey);
  if (!existing) {
    try {
      await store.create(agreementKey, agreement);
    } catch (error) {
      existing = await store.get<Agreement>(agreementKey);
      if (!existing) throw error;
    }
  }
  if (existing && (
    existing.id !== agreement.id ||
    existing.network !== agreement.network ||
    existing.property !== agreement.property ||
    existing.requiredSecurity !== agreement.requiredSecurity ||
    existing.releaseAllowed !== agreement.releaseAllowed ||
    JSON.stringify(existing.depositForm) !== JSON.stringify(agreement.depositForm) ||
    JSON.stringify(existing.rentTerms) !== JSON.stringify(agreement.rentTerms) ||
    existing.parties.landlord?.subject !== agreement.parties.landlord?.subject ||
    existing.parties.landlord?.wallet.id !== agreement.parties.landlord?.wallet.id ||
    existing.parties.landlord?.wallet.address !== agreement.parties.landlord?.wallet.address ||
    existing.parties.landlord?.wallet.chainType !== agreement.parties.landlord?.wallet.chainType ||
    existing.parties.tenant?.subject !== agreement.parties.tenant?.subject ||
    existing.parties.tenant?.wallet.id !== agreement.parties.tenant?.wallet.id ||
    existing.parties.tenant?.wallet.address !== agreement.parties.tenant?.wallet.address ||
    existing.parties.tenant?.wallet.chainType !== agreement.parties.tenant?.wallet.chainType
  )) throw new ConflictError('An agreement is already recorded for this listing.');
  return publicListing(chosen, identity);
}
