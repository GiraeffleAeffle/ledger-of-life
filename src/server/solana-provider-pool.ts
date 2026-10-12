import { createSolanaRpcFromTransport, type RpcTransport } from '@solana/kit';
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from '@solana/rpc-spec-types';
import { SOLANA_DEVNET_MANIFEST, SOLANA_MAINNET_MANIFEST } from '../finance/solana/manifest.ts';

export type SolanaRpcConfiguration = { rpcUrl: string; rpcFallbackUrls?: readonly string[]; genesisHash: string };
const GENESIS_TTL_MS = 60_000;
// Supports reviewed program accounts (up to 2MB binary) and the existing 30MB
// base64 account bound, while imposing an aggregate decoded response limit.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const COOLDOWN = { quota: 300_000, auth: 60_000, health: 15_000, transport: 5_000 };
type FailureKind = keyof typeof COOLDOWN;
class ProviderUnavailable extends Error {
  readonly kind: FailureKind;
  readonly retryAfterMs: number;
  constructor(kind: FailureKind, retryAfterMs = 0) {
    super('RPC unavailable');
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}
function endpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error();
    return url.toString();
  } catch { throw new Error('Invalid Solana RPC configuration'); }
}
/** Server environment only. Local validators never inherit the devnet fallback chain. */
export function solanaRpcConfiguration(environment: Record<string, string | undefined>, network: { genesisHash: string; cluster?: string }): SolanaRpcConfiguration {
  if (!environment.SOLANA_RPC_URL) throw new Error('Solana RPC is not configured.');
  const rpcUrl = endpoint(environment.SOLANA_RPC_URL);
  let fallbacks: unknown = [];
  if (network.cluster !== 'localnet' && network.genesisHash === SOLANA_DEVNET_MANIFEST.genesisHash && environment.SOLANA_RPC_FALLBACK_URLS) {
    try { fallbacks = JSON.parse(environment.SOLANA_RPC_FALLBACK_URLS); }
    catch { throw new Error('Invalid Solana RPC fallback configuration'); }
  }
  if (!Array.isArray(fallbacks) || fallbacks.length > 8 || fallbacks.some(value => typeof value !== 'string')) throw new Error('Invalid Solana RPC fallback configuration');
  const rpcFallbackUrls = [...new Set((fallbacks as string[]).map(endpoint))].filter(value => value !== rpcUrl);
  return { rpcUrl, rpcFallbackUrls, genesisHash: network.genesisHash };
}

type Probe = { promise: Promise<void>; controller: AbortController; waiters: number };
type Health = { until: number; verifiedUntil: number; probe?: Probe; recovering: boolean; mismatchUntil: number; generation: number };
// Only endpoint/network health is shared. No wallet, account, manifest, signal or selected
// endpoint is stored globally. Injectable transports have separate health namespaces.
const healthByTransport = new WeakMap<typeof fetch, Map<string, Health>>();
function health(fetcher: typeof fetch, url: string, genesis: string) {
  let entries = healthByTransport.get(fetcher);
  if (!entries) { entries = new Map(); healthByTransport.set(fetcher, entries); }
  const key = JSON.stringify([url, genesis]);
  let state = entries.get(key);
  if (!state) { state = { until: 0, verifiedUntil: 0, recovering: false, mismatchUntil: 0, generation: 0 }; entries.set(key, state); }
  return state;
}
function recordFailure(state: Health, error: ProviderUnavailable) {
  state.until = Math.max(state.until, Date.now() + Math.max(COOLDOWN[error.kind], error.retryAfterMs));
  state.verifiedUntil = 0;
  state.generation++;
}
function aborted(signal: AbortSignal): Error {
  return new DOMException('Solana RPC deadline exceeded', signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError');
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw aborted(signal);
  let listener: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    listener = () => reject(aborted(signal));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', listener); }
}
function quota(error: Record<string, unknown>): boolean {
  const message = typeof error.message === 'string' ? error.message : '';
  const code = error.code === undefined ? undefined : Number(error.code);
  // Never reinterpret simulation/preflight/invalid-parameter rejection or its logs
  // as provider quota. Only explicit rate limits and generic provider errors qualify.
  if (error.data != null || /simulation|preflight|transaction/i.test(message)) return false;
  if (code === 429) return true;
  if (code !== undefined && code !== -32000) return false;
  return /(?:credits?|quota).{0,50}(?:exhaust|exceed|deplet|limit)|(?:exhaust|exceed|deplet).{0,50}(?:credits?|quota)|rate[ -]?limit|too many requests/i.test(message);
}
function retryAfter(response: Response): number {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(milliseconds, 900_000)) : 0;
}

export class SolanaProviderPool {
  private readonly urls: readonly string[];
  private readonly config: SolanaRpcConfiguration;
  private readonly fetcher: typeof fetch;
  private readonly lossless: boolean;
  // A timed-out candidate must not be retried immediately by the next method of
  // this gateway's read. This hint is never shared with another gateway.
  private readonly candidateTimeouts = new Map<string, number>();
  constructor(config: SolanaRpcConfiguration, fetcher: typeof fetch = fetch, lossless = false) {
    this.config = config;
    this.fetcher = fetcher;
    this.lossless = lossless;
    if (!config.genesisHash || config.genesisHash === SOLANA_MAINNET_MANIFEST.genesisHash) throw new Error('Mainnet execution is disabled');
    this.urls = [...new Set([config.rpcUrl, ...(config.genesisHash === SOLANA_DEVNET_MANIFEST.genesisHash ? config.rpcFallbackUrls ?? [] : [])].map(endpoint))];
  }
  private async request(url: string, method: string, params: readonly unknown[], signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new ProviderUnavailable('transport');
    let response: Response;
    try {
      response = await bounded(this.fetcher(url, { method: 'POST', cache: 'no-store', redirect: 'manual', headers: { 'content-type': 'application/json' },
        body: stringifyJsonWithBigInts({ jsonrpc: '2.0', id: 1, method, params }), signal }), signal);
    } catch { throw new ProviderUnavailable('transport'); }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      throw new Error('RPC redirect refused');
    }
    if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) {
      const kind = response.status === 429 ? 'quota' : response.status >= 500 ? 'health' : 'auth';
      void response.body?.cancel().catch(() => {});
      throw new ProviderUnavailable(kind, response.status === 429 ? retryAfter(response) : 0);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Malformed RPC response');
    const decoder = new TextDecoder(), chunks: string[] = [];
    let length = 0, complete = false;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await bounded(reader.read(), signal); }
        catch { throw new ProviderUnavailable('transport'); }
        if (chunk.done) { complete = true; break; }
        length += chunk.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw new Error('RPC response exceeds size limit');
        chunks.push(decoder.decode(chunk.value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } finally {
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const text = chunks.join('');
    let body: unknown;
    try { body = this.lossless ? parseJsonWithBigInts(text) : JSON.parse(text); } catch { throw new Error('Malformed RPC response'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Malformed RPC response');
    const envelope = body as Record<string, unknown>;
    if (('jsonrpc' in envelope && envelope.jsonrpc !== '2.0') ||
        ('id' in envelope && envelope.id !== 1 && envelope.id !== 1n) ||
        ('result' in envelope && envelope.error != null)) throw new Error('Malformed RPC response');
    if (envelope.error != null) {
      if (!envelope.error || typeof envelope.error !== 'object' || Array.isArray(envelope.error)) throw new Error('Malformed RPC response');
      const error = envelope.error as Record<string, unknown>;
      if (quota(error)) throw new ProviderUnavailable('quota');
      if (Number(error.code) === -32005) throw new ProviderUnavailable('health');
      // Simulation, invalid params and unrecognized errors are semantic failures, not
      // permission to shop around for a provider that accepts the operation.
      throw new Error('RPC request failed');
    }
    if (!response.ok) {
      if (quota(envelope)) throw new ProviderUnavailable('quota');
      throw new Error('RPC request failed');
    }
    if (!('result' in envelope)) throw new Error('Malformed RPC response');
    return envelope.result;
  }
  async rpc(method: string, params: readonly unknown[], signal?: AbortSignal, budgetMs = 10_000): Promise<unknown> {
    const deadline = Date.now() + budgetMs;
    const total = signal ? AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]) : AbortSignal.timeout(budgetMs);
    for (let index = 0; index < this.urls.length; index++) {
      if (total.aborted) throw aborted(total);
      const url = this.urls[index], state = health(this.fetcher, url, this.config.genesisHash);
      if (state.mismatchUntil > Date.now()) throw new Error('RPC genesis mismatch');
      if (state.until > Date.now() || state.recovering || (this.candidateTimeouts.get(url) ?? 0) > Date.now()) continue;
      const recovering = state.until !== 0;
      // Only one real request may half-open a cooled endpoint.
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DOMException('Solana RPC deadline exceeded', 'TimeoutError');
      if (recovering) state.recovering = true;
      const generation = state.generation;
      const attempt = AbortSignal.any([total, AbortSignal.timeout(Math.max(1, Math.floor(remaining / (this.urls.length - index))))]);
      let sent = false, requestStarted = false;
      try {
        if (state.verifiedUntil <= Date.now()) {
          if (!state.probe || state.probe.controller.signal.aborted) {
            const controller = new AbortController();
            const probe: Probe = { controller, waiters: 0, promise: Promise.resolve() };
            const probeGeneration = state.generation;
            // The endpoint probe owns its deadline. A display caller may stop waiting
            // without cancelling another caller's financial network validation.
            const probeSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
            probe.promise = (async () => {
              try {
                const genesis = await this.request(url, 'getGenesisHash', [], probeSignal);
                if (genesis !== this.config.genesisHash) {
                  state.mismatchUntil = Date.now() + GENESIS_TTL_MS;
                  throw new Error('RPC genesis mismatch');
                }
                if (!controller.signal.aborted && state.generation === probeGeneration)
                  state.verifiedUntil = Date.now() + GENESIS_TTL_MS;
              } catch (error) {
                if (!controller.signal.aborted && error instanceof ProviderUnavailable) recordFailure(state, error);
                throw error;
              } finally { if (state.probe === probe) state.probe = undefined; }
            })();
            state.probe = probe;
          }
          const probe = state.probe;
          probe.waiters++;
          try { await bounded(probe.promise, attempt); }
          finally {
            probe.waiters--;
            if (probe.waiters === 0) probe.controller.abort();
          }
        }
        if (state.mismatchUntil > Date.now()) throw new Error('RPC genesis mismatch');
        if (state.generation !== generation && state.until > Date.now()) continue;
        if (total.aborted) throw aborted(total);
        if (Date.now() >= deadline) throw new DOMException('Solana RPC deadline exceeded', 'TimeoutError');
        if (attempt.aborted) throw aborted(attempt);
        sent = method === 'sendTransaction';
        requestStarted = method !== 'getGenesisHash';
        const result = method === 'getGenesisHash' ? this.config.genesisHash : await this.request(url, method, params, attempt);
        if (total.aborted) throw aborted(total);
        if (Date.now() >= deadline) throw new DOMException('Solana RPC deadline exceeded', 'TimeoutError');
        if (recovering && state.generation === generation) state.until = 0;
        return result;
      } catch (error) {
        // Cancellation and shared-probe waiting are caller-local, not endpoint
        // failures. Probe failures record health exactly once under probe ownership.
        if (signal?.aborted) throw aborted(signal);
        if (attempt.aborted && !total.aborted && !requestStarted)
          this.candidateTimeouts.set(url, Date.now() + COOLDOWN.transport);
        if (attempt.aborted) error = new ProviderUnavailable('transport');
        // A waiter that never reached its own request must not poison the circuit.
        if (requestStarted && error instanceof ProviderUnavailable) recordFailure(state, error);
        if (total.aborted) throw aborted(total);
        if (!(error instanceof ProviderUnavailable)) throw error;
        // A lost response may mean the signed transaction landed. Leave its durable
        // journal unresolved for signature reconciliation; never generate a replacement.
        if (sent && (error.kind === 'transport' || error.kind === 'health')) throw new Error('Broadcast response ambiguous');
      } finally { if (recovering) state.recovering = false; }
    }
    throw new Error('RPC unavailable');
  }
}

/** Kit callers use exactly the same policy, including sends and genesis validation. */
export function createPooledSolanaRpc(config: SolanaRpcConfiguration, fetcher: typeof fetch = fetch) {
  const pool = new SolanaProviderPool(config, fetcher, true);
  const transport = (async ({ payload, signal }: Parameters<RpcTransport>[0]) => {
    const request = payload as { method: string; params: readonly unknown[]; id: unknown };
    return { jsonrpc: '2.0', id: request.id, result: await pool.rpc(request.method, request.params ?? [], signal) };
  }) as RpcTransport;
  return createSolanaRpcFromTransport(transport);
}
