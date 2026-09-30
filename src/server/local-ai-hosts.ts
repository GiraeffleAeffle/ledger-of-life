import { createHash, createPublicKey, randomInt, randomUUID, verify } from 'node:crypto';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/errors.ts';
import { AccessError, ConflictError } from './errors.ts';
import type { LocalAiRequestUsage } from './local-ai-types.ts';
import type { Store } from './store.ts';

export interface ConnectorHost {
  id: string;
  name: string;
  ownerSubject: string | null;
  payoutWallet: string | null;
  models: string[];
  lastHeartbeat: number | null;
  state: 'active' | 'revoked';
  ollamaReachable: boolean;
  awake: boolean;
  canWake?: boolean;
  freePublicAnswers?: boolean;
}
interface StoredHost extends ConnectorHost {
  publicKey: string;
  nonces: { nonce: string; timestamp: number }[];
}
interface HostInvitation {
  codeHash: string;
  ownerSubject: string;
  payoutWallet: string;
  expiresAt: number;
}
interface Registry {
  hosts: StoredHost[];
  invitations: HostInvitation[];
  rate: { source: string; started: number; count: number }[];
}
const KEY = 'local-ai:connector-registry';
const PAIR_TTL = 600000;
const SKEW = 60000;
export const CONNECTOR_JOB_TIMEOUT_MS = 240000;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const shared = globalThis as typeof globalThis & {
  __localAiConnectorState?: { registries: WeakMap<Store, Promise<void>>; runtimes: WeakMap<Store, Runtime> };
};
const singleton = shared.__localAiConnectorState ??= { registries: new WeakMap(), runtimes: new WeakMap() };
const registries = singleton.registries;
async function ready(store: Store) {
  let promise = registries.get(store);
  if (!promise) {
    promise = (async () => {
      const existing = await store.get<Registry>(KEY);
      if (!existing) {
        try { await store.create<Registry>(KEY, { hosts: [], invitations: [], rate: [] }); }
        catch (error) { if (!await store.get(KEY)) throw error; }
      } else if (!Array.isArray(existing.invitations) || !Array.isArray(existing.rate)) {
        await store.update<Registry>(KEY, (registry) => ({
          hosts: registry.hosts.filter((host) => host.state === 'active' || host.state === 'revoked')
            .map((host) => ({ ...rawHost(host), publicKey: host.publicKey, nonces: host.nonces })),
          invitations: [], rate: [],
        }));
      }
    })();
    registries.set(store, promise);
  }
  await promise;
}
const rawHost = ({ id, name, ownerSubject, payoutWallet, models, lastHeartbeat, state, ollamaReachable, awake, canWake, freePublicAnswers }: StoredHost): ConnectorHost =>
  ({ id, name, ownerSubject, payoutWallet, models, lastHeartbeat, state, ollamaReachable, awake, canWake: canWake === true, freePublicAnswers: freePublicAnswers === true });
const availability = (host: ConnectorHost, now: number): 'online' | 'asleep' | 'offline' =>
  host.state !== 'active' || host.lastHeartbeat === null || now - host.lastHeartbeat > 75000 || now < host.lastHeartbeat
    ? 'offline' : host.ollamaReachable ? 'online' : 'asleep';
function cleanRegistry(registry: Registry, now: number) {
  registry.invitations = registry.invitations.filter((invitation) => invitation.expiresAt > now);
  const revoked = registry.hosts.filter((host) => host.state === 'revoked').slice(-32);
  registry.hosts = registry.hosts.filter((host) => host.state !== 'revoked' || revoked.includes(host));
  for (const host of registry.hosts) host.nonces = host.nonces.filter((entry) => entry.timestamp >= now - SKEW);
}
function active(registry: Registry, hostId: string): StoredHost {
  const host = registry.hosts.find((entry) => entry.id === hostId);
  if (!host || host.state !== 'active') throw new AccessError('Host key is unknown or revoked.');
  return host;
}
function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkflowError('A JSON object is required.');
  return body as Record<string, unknown>;
}
function only(body: Record<string, unknown>, fields: string[]) {
  if (Object.keys(body).some((key) => !fields.includes(key))) throw new WorkflowError('Unsupported connector field.');
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function evmWallets(identity: VerifiedIdentity) {
  return identity.wallets.filter((wallet) => wallet.chainType === 'ethereum' && /^0x[0-9a-fA-F]{40}$/.test(wallet.address));
}
function allowedWallets(identity: VerifiedIdentity) {
  const allowed = new Set((process.env.LOCAL_AI_HOST_OWNER_WALLETS || '').split(/[\s,]+/).filter(Boolean).map((value) => value.toLowerCase()));
  return evmWallets(identity).filter((wallet) => allowed.has(wallet.address.toLowerCase()));
}
export function hostPairingAllowed(identity: VerifiedIdentity) { return allowedWallets(identity).length > 0; }

export async function createHostInvitation(store: Store, identity: VerifiedIdentity, input: unknown, now = Date.now()) {
  const body = object(input);
  only(body, ['payoutWallet']);
  if (!hostPairingAllowed(identity)) throw new AccessError('A verified allowlisted EVM account is required to invite hosts.');
  const wallets = evmWallets(identity);
  const payout = body.payoutWallet === undefined && wallets.length === 1 ? wallets[0].address : body.payoutWallet;
  if (payout === undefined) throw new WorkflowError('Choose a verified EVM payout wallet.');
  if (typeof payout !== 'string' || !wallets.some((wallet) => wallet.address.toLowerCase() === payout.toLowerCase()))
    throw new AccessError('Payout must use your own verified EVM wallet.');
  await ready(store);
  let code!: string;
  await store.update<Registry>(KEY, (registry) => {
    cleanRegistry(registry, now);
    if (registry.invitations.length >= 128) throw new ConflictError('Host invitation registry is full; wait for an invitation to expire.');
    let codeHash: string;
    do {
      code = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join('');
      codeHash = createHash('sha256').update(code).digest('hex');
    } while (registry.invitations.some((invitation) => invitation.codeHash === codeHash));
    registry.invitations.push({ codeHash, ownerSubject: identity.subject, payoutWallet: payout, expiresAt: now + PAIR_TTL });
    return registry;
  });
  return { code, expiresAt: new Date(now + PAIR_TTL).toISOString() };
}

export async function createHostPairing(store: Store, input: unknown, rateKey: string, now = Date.now()) {
  const body = object(input);
  only(body, ['code', 'publicKey', 'name']);
  if (typeof body.code !== 'string' || !/^[A-HJ-NP-Z2-9]{12}$/.test(body.code)) throw new WorkflowError('Use the twelve-character host invitation code.');
  if (!text(body.name, 80) || !body.name.trim() || /[\u0000-\u001f\u007f]/.test(body.name) || !text(body.publicKey, 128))
    throw new WorkflowError('A host name and Ed25519 public key are required.');
  let publicKey: string;
  try {
    const der = Buffer.from(body.publicKey, 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    publicKey = key.export({ format: 'der', type: 'spki' }).toString('base64');
    if (key.asymmetricKeyType !== 'ed25519' || publicKey !== body.publicKey) throw new Error('Noncanonical key');
  } catch { throw new WorkflowError('Use a base64 DER SPKI Ed25519 public key.'); }
  await ready(store);
  const source = createHash('sha256').update(rateKey.slice(0, 512)).digest('hex');
  let rateAllowed = false;
  await store.update<Registry>(KEY, (registry) => {
    registry.rate = registry.rate.filter((bucket) => bucket.started <= now && now - bucket.started < PAIR_TTL);
    let bucket = registry.rate.find((entry) => entry.source === source);
    if (!bucket) {
      if (registry.rate.length >= 1024) registry.rate.shift();
      bucket = { source, started: now, count: 0 };
      registry.rate.push(bucket);
    }
    if (bucket.count < 5) { bucket.count++; rateAllowed = true; }
    return registry;
  });
  if (!rateAllowed) throw new ConflictError('Too many pairing requests from this source; retry after ten minutes.');
  const codeHash = createHash('sha256').update(body.code).digest('hex');
  let hostId!: string;
  await store.update<Registry>(KEY, (registry) => {
    cleanRegistry(registry, now);
    const invitation = registry.invitations.find((entry) => entry.codeHash === codeHash);
    if (!invitation) throw new ConflictError('Host invitation is expired, used, or unknown.');
    if (registry.hosts.filter((host) => host.state === 'active').length >= 128) throw new ConflictError('Host registry is full; revoke an unused host.');
    if (registry.hosts.some((host) => host.publicKey === publicKey && host.state === 'active'))
      throw new ConflictError('This key already has an active host.');
    hostId = randomUUID();
    registry.hosts.push({ id: hostId, name: body.name as string, publicKey, ownerSubject: invitation.ownerSubject,
      payoutWallet: invitation.payoutWallet, models: [], lastHeartbeat: null, state: 'active', ollamaReachable: false, awake: false, canWake: false, nonces: [] });
    registry.invitations = registry.invitations.filter((entry) => entry !== invitation);
    return registry;
  });
  return { hostId };
}
export async function connectorHosts(store: Store, now = Date.now()) {
  await ready(store);
  expireJobs(store, now);
  const registry = await store.update<Registry>(KEY, (value) => { cleanRegistry(value, now); return value; });
  return registry.hosts.filter((host) => host.state === 'active').map((host) => ({ ...rawHost(host), availability: availability(host, now) }));
}
export async function publicConnectorHosts(store: Store, now = Date.now(), subject?: string) {
  return (await connectorHosts(store, now)).map(({ ownerSubject, ...host }) => ({ ...host, own: Boolean(subject && ownerSubject === subject) }));
}
export async function chooseConnectorHost(store: Store, owner: { subject?: string; payer?: string }, model: string, scope: 'own' | 'city', now = Date.now(), freePublic = false) {
  if (scope !== 'own' && scope !== 'city') throw new WorkflowError('Choose own or city host scope.');
  const runtime = state(store);
  const candidates = (await connectorHosts(store, now)).filter((host) => (host.availability === 'online' || (host.availability === 'asleep' && host.canWake)) && host.models.includes(model) &&
    host.payoutWallet && (Boolean(owner.subject && host.ownerSubject === owner.subject) || host.payoutWallet.toLowerCase() !== owner.payer?.toLowerCase()) &&
    (scope === 'city' || Boolean(owner.subject && host.ownerSubject === owner.subject)) && (!freePublic || host.freePublicAnswers === true));
  const busy = (host: ConnectorHost) => runtime.jobs.has(host.id) || runtime.reservations.has(host.id);
  candidates.sort((a, b) => Number(b.ownerSubject === owner.subject) - Number(a.ownerSubject === owner.subject) ||
    Number(busy(a)) - Number(busy(b)) || Number(b.availability === 'online') - Number(a.availability === 'online'));
  return candidates[0] || null;
}
export function connectorSigningBytes(method: string, pathname: string, timestamp: string, nonce: string, body: Uint8Array) {
  return Buffer.from(`${method.toUpperCase()}\n${pathname}\n${timestamp}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`, 'utf8');
}
export function checkConnectorHeaders(request: Request, now = Date.now()) {
  const hostId = request.headers.get('x-host-id');
  const timestamp = request.headers.get('x-host-timestamp') || '';
  const nonce = request.headers.get('x-host-nonce') || '';
  const signature = request.headers.get('x-host-signature') || '';
  if (!hostId || hostId.length > 64 || !/^[0-9]{1,16}$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) ||
      Math.abs(now - Number(timestamp)) > SKEW || !/^[0-9a-f]{32}$/.test(nonce) || !/^[A-Za-z0-9+/]{86}==$/.test(signature))
    throw new AccessError('Invalid connector signature headers or timestamp.');
  return { hostId, timestamp, nonce, signature };
}
export async function authenticateConnector(store: Store, request: Request, rawBody: Uint8Array, now = Date.now()): Promise<ConnectorHost> {
  const { hostId, timestamp, nonce, signature } = checkConnectorHeaders(request, now);
  await ready(store);
  let result!: ConnectorHost;
  await store.update<Registry>(KEY, (registry) => {
    const host = active(registry, hostId);
    const bytes = connectorSigningBytes(request.method, new URL(request.url).pathname, timestamp, nonce, rawBody);
    if (!verify(null, bytes, createPublicKey({ key: Buffer.from(host.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64')))
      throw new AccessError('Invalid connector signature.');
    host.nonces = host.nonces.filter((entry) => entry.timestamp >= now - SKEW);
    if (host.nonces.some((entry) => entry.nonce === nonce)) throw new AccessError('Connector nonce has already been used.');
    if (host.nonces.length >= 256) throw new ConflictError('Connector request limit reached; retry shortly.');
    host.nonces.push({ nonce, timestamp: Number(timestamp) });
    result = rawHost(host);
    return registry;
  });
  return result;
}
export async function recordHostHeartbeat(store: Store, hostId: string, input: unknown, now = Date.now()) {
  const body = object(input);
  only(body, ['models', 'ollamaReachable', 'awake', 'canWake']);
  if (!Array.isArray(body.models) || body.models.length > 16 || body.models.some((model) => !text(model, 128) || /[\u0000-\u001f]/.test(model)) ||
      typeof body.ollamaReachable !== 'boolean' || typeof body.awake !== 'boolean' || (body.canWake !== undefined && typeof body.canWake !== 'boolean'))
    throw new WorkflowError('Invalid host heartbeat.');
  await ready(store);
  await store.update<Registry>(KEY, (registry) => {
    const host = active(registry, hostId);
    host.models = [...new Set(body.models as string[])];
    host.lastHeartbeat = now;
    host.ollamaReachable = body.ollamaReachable as boolean;
    host.awake = body.awake as boolean;
    host.canWake = body.canWake === true;
    return registry;
  });
  expireJobs(store, now);
  return { ok: true };
}
export interface ConnectorInferenceInput {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  options: { num_ctx: number; num_predict: number; temperature: number };
}
export interface ConnectorPolledJob extends ConnectorInferenceInput {
  id: string;
  expiresAt: string;
}
interface Job extends ConnectorInferenceInput {
  id: string;
  requestId: string;
  expiresAt: number;
  pickupDeadline: number;
  pickedUp: boolean;
  started: number;
  freePublic: boolean;
  timer: NodeJS.Timeout;
  resolve: (value: { answer: string; usage: LocalAiRequestUsage }) => void;
  reject: (error: Error) => void;
}
interface Reservation { requestId: string; expiresAt: number; timer: NodeJS.Timeout }
interface Runtime { jobs: Map<string, Job>; reservations: Map<string, Reservation>; polls: Map<string, symbol>; wake: Map<string, () => void> }
const runtimes = singleton.runtimes;
function state(store: Store): Runtime {
  let value = runtimes.get(store);
  if (!value) { value = { jobs: new Map(), reservations: new Map(), polls: new Map(), wake: new Map() }; runtimes.set(store, value); }
  return value;
}
function finish(store: Store, hostId: string, error?: Error, value?: { answer: string; usage: LocalAiRequestUsage }) {
  const runtime = state(store);
  const job = runtime.jobs.get(hostId);
  if (!job) return;
  clearTimeout(job.timer);
  job.messages = [];
  runtime.jobs.delete(hostId);
  if (error) job.reject(error); else job.resolve(value!);
  runtime.wake.get(hostId)?.();
}
function expireJobs(store: Store, now: number) {
  for (const [hostId, job] of state(store).jobs) {
    if (now >= job.expiresAt || (!job.pickedUp && now >= job.pickupDeadline))
      finish(store, hostId, new ConflictError('Connector job expired. No inference payment was sent.'));
  }
  for (const [hostId, reservation] of state(store).reservations) {
    if (now >= reservation.expiresAt) releaseConnectorHost(store, hostId, reservation.requestId);
  }
}
function validateInference(input: ConnectorInferenceInput) {
  const body = object(input);
  only(body, ['model', 'messages', 'options']);
  if (!text(input.model, 128) || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 8 ||
      input.messages.some((message) => !message || !['system', 'user', 'assistant'].includes(message.role) || !text(message.content, 4000) || Object.keys(message).some((key) => !['role', 'content'].includes(key))) ||
      input.messages.reduce((total, message) => total + message.content.length, 0) > 12000) throw new WorkflowError('Invalid text-only connector messages.');
  const options = object(input.options);
  only(options, ['num_ctx', 'num_predict', 'temperature']);
  if (!Number.isSafeInteger(options.num_ctx) || (options.num_ctx as number) < 1 || (options.num_ctx as number) > 8192 ||
      !Number.isSafeInteger(options.num_predict) || (options.num_predict as number) < 16 || (options.num_predict as number) > 192 ||
      typeof options.temperature !== 'number' || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 1)
    throw new WorkflowError('Invalid connector inference options.');
}
/** Reserve capacity before changing request state or spending an attempt. No question is queued yet. */
export async function reserveConnectorHost(store: Store, hostId: string, requestId: string, now = Date.now(), model?: string, freePublic = false): Promise<void> {
  if (!text(requestId, 128)) throw new WorkflowError('A request ID is required.');
  await ready(store);
  const runtime = state(store);
  expireJobs(store, now);
  let created = false;
  try {
    await store.update<Registry>(KEY, (registry) => {
      const host = active(registry, hostId);
      const status = availability(host, now);
      if (status !== 'online' && !(status === 'asleep' && host.canWake)) throw new ConflictError('Selected connector is unavailable.');
      if (model !== undefined && !host.models.includes(model)) throw new ConflictError('Selected connector model is unavailable.');
      if (freePublic && host.freePublicAnswers !== true) throw new ConflictError('Selected connector does not offer free public answers.');
      const reservation = runtime.reservations.get(hostId);
      if (runtime.jobs.has(hostId) || (reservation && reservation.requestId !== requestId)) throw new ConflictError('Selected connector is busy.');
      if (!reservation) {
        runtime.reservations.set(hostId, { requestId, expiresAt: now + 30000,
          timer: setTimeout(() => releaseConnectorHost(store, hostId, requestId), 30000) });
        created = true;
      }
      return registry;
    });
  } catch (error) {
    if (created) releaseConnectorHost(store, hostId, requestId);
    throw error;
  }
}
export function releaseConnectorHost(store: Store, hostId: string, requestId: string): void {
  const runtime = state(store);
  const reservation = runtime.reservations.get(hostId);
  if (reservation?.requestId !== requestId) return;
  clearTimeout(reservation.timer);
  runtime.reservations.delete(hostId);
}

/** Questions exist only in this replica's memory, never in SQLite or a durable job record. */
export async function enqueueConnectorInference(store: Store, hostId: string, requestId: string, input: ConnectorInferenceInput, freePublic = false): Promise<{ answer: string; usage: LocalAiRequestUsage }> {
  validateInference(input);
  await ready(store);
  const runtime = state(store);
  const now = Date.now();
  expireJobs(store, now);
  if (runtime.reservations.get(hostId)?.requestId !== requestId) throw new ConflictError('Selected connector has no matching reservation.');
  let resolve!: Job['resolve'];
  let reject!: Job['reject'];
  const promise = new Promise<{ answer: string; usage: LocalAiRequestUsage }>((yes, no) => { resolve = yes; reject = no; });
  try {
    await store.update<Registry>(KEY, (registry) => {
      const host = active(registry, hostId);
      const status = availability(host, now);
      if ((status !== 'online' && !(status === 'asleep' && host.canWake)) || !host.models.includes(input.model))
        throw new ConflictError('Selected connector model is unavailable.');
      if (freePublic && host.freePublicAnswers !== true) throw new ConflictError('Selected connector does not offer free public answers.');
      if (runtime.jobs.has(hostId) || runtime.reservations.get(hostId)?.requestId !== requestId)
        throw new ConflictError('Selected connector is busy.');
      const job: Job = { ...input, messages: input.messages.map((message) => ({ ...message })), options: { ...input.options },
        id: randomUUID(), requestId, started: now, expiresAt: now + CONNECTOR_JOB_TIMEOUT_MS, pickupDeadline: now + 30000, pickedUp: false, freePublic,
        resolve, reject, timer: setTimeout(() => expireJobs(store, Date.now()), 30000) };
      releaseConnectorHost(store, hostId, requestId);
      runtime.jobs.set(hostId, job);
      return registry;
    });
  } catch (error) {
    releaseConnectorHost(store, hostId, requestId);
    throw error;
  }
  runtime.wake.get(hostId)?.();
  return promise;
}
export async function pollConnectorJob(store: Store, hostId: string, waitMs = 25000, now?: number, signal?: AbortSignal): Promise<{ job: ConnectorPolledJob | null }> {
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 25000) throw new WorkflowError('Poll wait must be between zero and 25 seconds.');
  if (signal?.aborted) return { job: null };
  await ready(store);
  if (signal?.aborted) return { job: null };
  const runtime = state(store);
  if (runtime.polls.has(hostId)) throw new ConflictError('Only one outstanding poll is allowed per host.');
  const token = Symbol();
  runtime.polls.set(hostId, token);
  const abort = () => {
    if (runtime.polls.get(hostId) !== token) return;
    runtime.polls.delete(hostId);
    runtime.wake.get(hostId)?.();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const deadline = Date.now() + waitMs;
  try {
    while (true) {
      if (signal?.aborted) return { job: null };
      const current = now ?? Date.now();
      expireJobs(store, current);
      let result: ConnectorPolledJob | null = null;
      await store.update<Registry>(KEY, (registry) => {
        if (signal?.aborted) return registry;
        active(registry, hostId);
        const job = runtime.jobs.get(hostId);
        if (job && !job.pickedUp) {
          job.pickedUp = true;
          clearTimeout(job.timer);
          job.timer = setTimeout(() => expireJobs(store, Date.now()), Math.max(0, job.expiresAt - Date.now()));
          result = { id: job.id, model: job.model, messages: job.messages.map((message) => ({ ...message })), options: { ...job.options }, expiresAt: new Date(job.expiresAt).toISOString() };
        }
        return registry;
      });
      if (result || Date.now() >= deadline || signal?.aborted) return { job: result };
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          if (runtime.wake.get(hostId) === wake) runtime.wake.delete(hostId);
          resolve();
        };
        const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
        runtime.wake.set(hostId, wake);
        // Work or an abort can arrive between the registry await and installing this waiter.
        if (signal?.aborted || (runtime.jobs.get(hostId) && !runtime.jobs.get(hostId)!.pickedUp)) wake();
      });
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (runtime.polls.get(hostId) === token) {
      runtime.polls.delete(hostId);
      runtime.wake.get(hostId)?.();
    }
  }
}
export function sanitizeConnectorAnswer(response: unknown, model: string, wallMs: number): { answer: string; usage: LocalAiRequestUsage } {
  const data = object(response);
  const message = data.message && typeof data.message === 'object' ? object(data.message) : null;
  if (data.done !== true || data.done_reason !== 'stop' || data.model !== model || data.error || !message || message.role !== 'assistant' ||
      typeof message.content !== 'string' || !message.content.trim() || message.content.length > 16000)
    throw new WorkflowError('The connector returned an incomplete answer. No inference payment was sent.');
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const duration = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value / 1e6 : null;
  const outputTokens = count(data.eval_count);
  const evalMs = duration(data.eval_duration);
  const speed = outputTokens !== null && evalMs && evalMs > 0 ? Math.round(outputTokens / evalMs * 100000) / 100 : null;
  return { answer: message.content.trim(), usage: { inputTokens: count(data.prompt_eval_count), outputTokens, wallMs: Math.max(0, Math.round(wallMs)),
    totalMs: duration(data.total_duration), loadMs: duration(data.load_duration), evalMs, tokensPerSecond: speed !== null && Number.isFinite(speed) ? speed : null } };
}
export async function completeConnectorJob(store: Store, hostId: string, input: unknown, now = Date.now()) {
  const body = object(input);
  only(body, ['jobId', 'response', 'error']);
  if (!text(body.jobId, 64) || (('response' in body) === ('error' in body)) || ('error' in body && !text(body.error, 1000)))
    throw new WorkflowError('Send a job ID and either response or error.');
  await ready(store);
  expireJobs(store, now);
  await store.update<Registry>(KEY, (registry) => {
    active(registry, hostId);
    const job = state(store).jobs.get(hostId);
    if (!job || job.id !== body.jobId || !job.pickedUp) throw new ConflictError('Job is expired, unassigned, or already completed.');
    if ('error' in body) finish(store, hostId, new ConflictError('Connector inference failed. No inference payment was sent.'));
    else {
      try { finish(store, hostId, undefined, sanitizeConnectorAnswer(body.response, job.model, now - job.started)); }
      catch (error) { finish(store, hostId, error instanceof Error ? error : new Error('Connector answer failed.')); }
    }
    return registry;
  });
  return { ok: true };
}
export async function setConnectorFreePublicAnswers(store: Store, identity: VerifiedIdentity, hostId: string, enabled: boolean) {
  if (!text(hostId, 64) || typeof enabled !== 'boolean') throw new WorkflowError('Choose a host and a free public answer setting.');
  await ready(store);
  await store.update<Registry>(KEY, (registry) => {
    const host = active(registry, hostId);
    if (host.ownerSubject !== identity.subject) throw new AccessError('Only the host owner may change its public allowance.');
    host.freePublicAnswers = enabled;
    return registry;
  });
  if (!enabled && state(store).jobs.get(hostId)?.freePublic)
    finish(store, hostId, new ConflictError('Host stopped offering free public answers. No payment was sent.'));
  return { ok: true };
}

export async function revokeConnectorHost(store: Store, identity: VerifiedIdentity, hostId: string) {
  await ready(store);
  await store.update<Registry>(KEY, (registry) => {
    const host = registry.hosts.find((entry) => entry.id === hostId);
    if (!host || host.ownerSubject !== identity.subject) throw new AccessError('Only the host owner may revoke it.');
    host.state = 'revoked';
    host.models = [];
    host.nonces = [];
    return registry;
  });
  const reservation = state(store).reservations.get(hostId);
  if (reservation) releaseConnectorHost(store, hostId, reservation.requestId);
  finish(store, hostId, new AccessError('Connector host was revoked. No inference payment was sent.'));
  state(store).wake.get(hostId)?.();
  return { ok: true };
}
export function cancelConnectorInference(store: Store, requestId: string) {
  for (const [hostId, job] of state(store).jobs) if (job.requestId === requestId)
    finish(store, hostId, new ConflictError('Connector question was erased. No inference payment was sent.'));
  for (const [hostId, reservation] of state(store).reservations) if (reservation.requestId === requestId)
    releaseConnectorHost(store, hostId, requestId);
}
/** Read exact signed bytes with a streaming cap and an overall deadline, before parsing JSON. */
export async function readConnectorBody(request: Request, maxBytes: number, deadlineMs = 3000): Promise<Buffer> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new WorkflowError('Send JSON.');
  const declared = request.headers.get('content-length');
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > maxBytes)) {
    void request.body?.cancel().catch(() => {});
    throw new WorkflowError('Request too large.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new WorkflowError('Send a JSON body.');
  let interrupt!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
  const abort = () => interrupt(new WorkflowError('Request body read aborted.'));
  const timer = setTimeout(() => interrupt(new WorkflowError('Request body read deadline exceeded.')), deadlineMs);
  request.signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (request.signal.aborted) throw new WorkflowError('Request body read aborted.');
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new WorkflowError('Request too large.');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    // Cancellation itself can stall or reject; neither may extend the body deadline.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
export function parseConnectorBody(raw: Uint8Array) {
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))); }
  catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError('Send a valid UTF-8 JSON object.');
  }
}
