import { WorkflowError } from './errors.ts';

export type HomeLocation = { lat: number; lon: number };
/** A roughly 100 m grid: never publish the original pin or a street address. */
export function roundedLocation(input: unknown): HomeLocation | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkflowError('Choose a valid map pin.');
  const { lat, lon } = input as Record<string, unknown>;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180)
    throw new WorkflowError('Choose a valid map pin (latitude −85 to 85, longitude −180 to 180).');
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
}

/** A submitted or pending deposit is not secured. The published journey uses finalized state. */
export function moveInAvailable(stage: string, phase?: string): boolean {
  return ['living', 'move-out', 'paid'].includes(stage) && ['active', 'claim-proposed', 'disputed', 'settling', 'closed'].includes(phase ?? '');
}
