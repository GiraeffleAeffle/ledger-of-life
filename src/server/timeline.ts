import { randomUUID } from 'node:crypto';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/errors.ts';
import type { Store } from './store.ts';

export interface PlaceEntry {
  id: string;
  city: string;
  from: string;
  to: string;
  note?: string;
  source: 'self_declared';
}

const key = (subject: string) => `timeline:${subject}`;
const period = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/;

function validatePeriod(value: unknown, label: string): string {
  if (typeof value !== 'string' || !period.test(value)) throw new WorkflowError(`Enter ${label} as YYYY or YYYY-MM.`);
  return value;
}

export async function listPlaces(store: Store, identity: VerifiedIdentity): Promise<PlaceEntry[]> {
  return (await store.get<PlaceEntry[]>(key(identity.subject))) ?? [];
}

export async function addPlace(store: Store, identity: VerifiedIdentity, input: { city: unknown; from: unknown; to: unknown; note?: unknown }): Promise<PlaceEntry[]> {
  if (typeof input.city !== 'string' || !input.city.trim() || input.city.trim().length > 80) {
    throw new WorkflowError('Enter a city name up to 80 characters.');
  }
  const from = validatePeriod(input.from, 'the start date');
  const to = validatePeriod(input.to, 'the end date');
  if (from > to) throw new WorkflowError('The start date must be before or the same as the end date.');
  let note: string | undefined;
  if (input.note !== undefined && input.note !== '') {
    if (typeof input.note !== 'string' || input.note.trim().length > 140) throw new WorkflowError('Notes must be 140 characters or fewer.');
    note = input.note.trim() || undefined;
  }
  const entry: PlaceEntry = { id: randomUUID(), city: input.city.trim(), from, to, ...(note ? { note } : {}), source: 'self_declared' };
  let result: PlaceEntry[] = [];
  await store.update<PlaceEntry[]>(key(identity.subject), (current) => {
    if (current.length >= 30) throw new WorkflowError('You can add up to 30 earlier places.');
    result = [...current, entry];
    return result;
  }).catch(async (error) => {
    if (error instanceof WorkflowError) throw error;
    result = [entry];
    await store.create(key(identity.subject), result);
  });
  return result;
}

export async function removePlace(store: Store, identity: VerifiedIdentity, id: string): Promise<PlaceEntry[]> {
  let result: PlaceEntry[] = [];
  await store.update<PlaceEntry[]>(key(identity.subject), (current) => {
    result = current.filter((place) => place.id !== id);
    return result;
  }).catch(async () => {
    result = [];
    await store.create(key(identity.subject), result);
  });
  return result;
}
