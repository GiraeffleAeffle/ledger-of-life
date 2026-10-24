export const BUILDING_RPC_UNAVAILABLE = 'Testnetz-RPC derzeit nicht erreichbar';
export const BUILDING_READ_EXPLANATION = 'Unavailable balances and income cannot be verified right now. Missing readings are not zero; new financial actions are paused.';
export const BUILDING_READ_TIMEOUT_MS = 4_000;
export type BuildingNetwork = 'solana-devnet' | 'solana-localnet' | 'robinhood-testnet';
export type BuildingCache = { state: 'fresh' | 'stale'; checkedAt: string; ageMs: number };

/** Server age plus monotonic time on this page; wall-clock changes cannot revive a snapshot. */
export function buildingCacheState(cache: BuildingCache | undefined, receivedAt: number, now: number) {
  if (!cache) return 'unknown';
  const age = cache.ageMs + Math.max(0, now - receivedAt);
  if (age >= 900_000) return 'expired';
  return cache.state === 'stale' || age >= 60_000 ? 'stale' : 'fresh';
}

/** Bound reads only, never a signed submission or financial action. */
export async function boundedBuildingRead<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs = BUILDING_READ_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const { promise: stopped, reject } = Promise.withResolvers<never>();
  const abort = () => { controller.abort(); reject(new Error(BUILDING_RPC_UNAVAILABLE)); };
  const timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try { return await Promise.race([stopped, controller.signal.aborted ? stopped : read(controller.signal)]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Routing metadata is configuration, not proof of a healthy RPC or a balance. */
export function readBuilding<T>(path: string, signal?: AbortSignal) {
  return boundedBuildingRead(async readSignal => {
    const response = await fetch(path, { cache: 'no-store', signal: readSignal });
    const body = await response.json() as { network?: unknown; building?: T | null; cache?: BuildingCache };
    const network: BuildingNetwork | null = body.network === 'solana-devnet' || body.network === 'solana-localnet' || body.network === 'robinhood-testnet' ? body.network : null;
    const building = response.ok && network ? body.building ?? null : null;
    const cache = building && (body.cache?.state === 'fresh' || body.cache?.state === 'stale')
      && typeof body.cache.checkedAt === 'string' && Number.isFinite(Date.parse(body.cache.checkedAt))
      && typeof body.cache.ageMs === 'number' && Number.isFinite(body.cache.ageMs) && body.cache.ageMs >= 0 ? body.cache : null;
    return { network, building: cache ? building : null, cache };
  }, signal);
}
