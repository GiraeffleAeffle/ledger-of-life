import { randomUUID } from 'node:crypto';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/errors.ts';
import { moveInAvailable } from '../domain/home-location.ts';
import { agreementRole, publicAgreement, requireOpenAgreement, type Agreement } from './agreements.ts';
import { AccessError, ConflictError } from './errors.ts';
import type { Store } from './store.ts';
import type { tenancyJourney } from './journey.ts';

export type MeterReading = { meter: 'electricity' | 'gas' | 'water'; value: number; unit: 'kWh' | 'm³'; date: string };
export type HandoverRecord = { revision: string; readings: MeterReading[]; rooms: { room: string; note: string }[]; confirmed: Partial<Record<'tenant' | 'landlord', string>> };

export function handoverInput(input: Record<string, unknown>): Pick<HandoverRecord, 'readings' | 'rooms'> {
  if (!Array.isArray(input.readings) || input.readings.length > 3 || !Array.isArray(input.rooms) || input.rooms.length > 12)
    throw new WorkflowError('Use up to three meter readings and twelve room notes.');
  const readings = input.readings.map((row: unknown): MeterReading => {
    if (!row || typeof row !== 'object') throw new WorkflowError('Enter a meter reading.');
    const { meter, value, unit, date } = row as Record<string, unknown>;
    if (!['electricity', 'gas', 'water'].includes(String(meter)) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9 ||
      !((meter === 'electricity' && unit === 'kWh') || (meter === 'gas' && (unit === 'kWh' || unit === 'm³')) || (meter === 'water' && unit === 'm³')) ||
      typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
      throw new WorkflowError('Each meter needs a non-negative number, the correct unit and a real date.');
    return { meter: meter as MeterReading['meter'], value, unit: unit as MeterReading['unit'], date };
  });
  if (new Set(readings.map((row) => row.meter)).size !== readings.length) throw new WorkflowError('Enter each meter only once.');
  const rooms = input.rooms.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new WorkflowError('Enter a room note.');
    const { room, note } = row as Record<string, unknown>;
    if (typeof room !== 'string' || !room.trim() || room.length > 60 || typeof note !== 'string' || !note.trim() || note.length > 500)
      throw new WorkflowError('Room labels must be 1–60 characters and notes 1–500 characters. No names or addresses.');
    return { room: room.trim(), note: note.trim() };
  });
  if (!readings.length && !rooms.length) throw new WorkflowError('Add a meter reading or a room note.');
  return { readings, rooms };
}

/** A revision binds each confirmation to exactly the shared readings and notes it reviewed. */
export async function updateHandover(store: Store, id: string, identity: VerifiedIdentity, input: Record<string, unknown>, readJourney: typeof tenancyJourney) {
  const agreement = await store.get<Agreement>(`agreement:${id}`);
  if (!agreement) throw new AccessError('This tenancy is unavailable.');
  const role = agreementRole(agreement, identity);
  if (role === 'arbitrator') throw new AccessError('Only the tenant and landlord record the handover.');
  requireOpenAgreement(agreement);
  const journey = await readJourney(store, identity, agreement);
  if (!moveInAvailable(journey.stage, journey.chain?.phase)) throw new ConflictError('Secure the deposit before recording the move-in handover.');
  const content = input.action === 'handover_save' ? handoverInput(input) : null;
  if (!content && input.action !== 'handover_confirm') throw new WorkflowError('Choose a handover action.');
  const next = await store.update<Agreement>(`agreement:${id}`, (value) => {
    requireOpenAgreement(value);
    if (value.handover?.revision !== input.revision) throw new ConflictError('The handover changed. Reload and review it before saving or confirming.');
    if (content) return { ...value, handover: { ...content, revision: randomUUID(), confirmed: {} } };
    if (!value.handover) throw new ConflictError('Record a handover before confirming it.');
    return { ...value, handover: { ...value.handover, confirmed: { ...value.handover.confirmed, [role]: new Date().toISOString() } } };
  });
  return publicAgreement(next, identity);
}
