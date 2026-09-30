#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, readFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = '/api/local-ai/hosts/';
const MAX_JSON_BYTES = 128 * 1024;
const WAKE_SCRIPT = 'desktop_ai_wake_gpu_host';

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).every((key) => allowed.includes(key)); }
function text(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function assert(condition, message) { if (!condition) throw new Error(message); }

export function endpointOrigin(value, app = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid endpoint URL'); }
  assert(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Endpoint must be an HTTP(S) origin without credentials, path, query or fragment');
  assert(!app || url.protocol === 'https:' || url.hostname === 'localhost', 'App origin requires HTTPS (HTTP is permitted only for localhost)');
  return url.origin;
}

export function validateConfig(input, baseDirectory = process.cwd()) {
  assert(keys(input, ['appOrigin', 'ollamaUrl', 'models', 'name', 'stateDirectory', 'homeAssistant']), 'Unknown connector configuration field');
  assert(text(input.name, 80) && input.name.trim(), 'Host name is required (max 80 characters)');
  assert(Array.isArray(input.models) && input.models.length > 0 && input.models.length <= 16 && input.models.every((model) => text(model, 128)) && new Set(input.models).size === input.models.length, 'Configure 1–16 unique model names, at most 128 characters each');
  assert(text(input.stateDirectory, 4096), 'stateDirectory is required');
  let homeAssistant;
  if (input.homeAssistant !== undefined) {
    assert(keys(input.homeAssistant, ['url', 'tokenFile']) && text(input.homeAssistant.tokenFile, 4096), 'Home Assistant requires only url and tokenFile');
    homeAssistant = { url: endpointOrigin(input.homeAssistant.url), tokenFile: resolve(baseDirectory, input.homeAssistant.tokenFile) };
  }
  return { appOrigin: endpointOrigin(input.appOrigin, true), ollamaUrl: endpointOrigin(input.ollamaUrl), models: [...input.models], name: input.name.trim(), stateDirectory: resolve(baseDirectory, input.stateDirectory), homeAssistant };
}

export function validateJob(job, models, now = Date.now()) {
  assert(keys(job, ['id', 'model', 'messages', 'options', 'expiresAt']) && text(job.id, 200), 'Invalid job shape');
  assert(models.includes(job.model) && text(job.model, 128), 'Job model is not advertised');
  assert(typeof job.expiresAt === 'string' && Number.isFinite(Date.parse(job.expiresAt)) && Date.parse(job.expiresAt) > now && Date.parse(job.expiresAt) <= now + 90_000, 'Invalid job deadline');
  assert(Array.isArray(job.messages) && job.messages.length > 0 && job.messages.length <= 8, 'Invalid job messages');
  let total = 0;
  for (const message of job.messages) {
    assert(keys(message, ['role', 'content']) && ['system', 'user', 'assistant'].includes(message.role) && typeof message.content === 'string' && message.content.length <= 4000, 'Only bounded text messages are allowed');
    total += message.content.length;
  }
  assert(total > 0 && total <= 12000, 'Job text exceeds limits');
  assert(keys(job.options, ['num_ctx', 'num_predict', 'temperature']) && Number.isInteger(job.options.num_ctx) && job.options.num_ctx > 0 && job.options.num_ctx <= 8192 && Number.isInteger(job.options.num_predict) && job.options.num_predict >= 16 && job.options.num_predict <= 192 && Number.isFinite(job.options.temperature) && job.options.temperature >= 0 && job.options.temperature <= 1, 'Invalid inference options');
  return { model: job.model, messages: job.messages.map(({ role, content }) => ({ role, content })), options: { num_ctx: job.options.num_ctx, num_predict: job.options.num_predict, temperature: job.options.temperature }, stream: false, think: false };
}

export function validateAnswer(response, model) {
  assert(object(response) && response.error === undefined && response.model === model && response.done === true && response.done_reason === 'stop' && object(response.message) && response.message.role === 'assistant' && text(response.message.content, 16000) && response.message.content.trim() && !response.message.tool_calls?.length && !response.message.images?.length, 'Ollama returned an incomplete or invalid answer');
  return response;
}

export function signedHeaders(privateKey, hostId, pathname, body, timestamp = Date.now(), nonce = randomBytes(16).toString('hex')) {
  const canonical = `POST\n${pathname}\n${timestamp}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`;
  return { 'content-type': 'application/json', 'x-host-id': hostId, 'x-host-timestamp': String(timestamp), 'x-host-nonce': nonce, 'x-host-signature': sign(null, Buffer.from(canonical), privateKey).toString('base64') };
}

export async function checkPrivatePath(path, directory = false) {
  const stat = await lstat(path);
  assert(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) && (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid()), 'Private connector paths must be owner-only, owned by the current user, and not symlinks');
}

async function readPrivate(path) {
  await checkPrivatePath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert(stat.isFile() && (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid()), 'Private file permissions changed');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

async function writePrivate(path, content, exclusive = false) {
  const target = exclusive ? path : `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(target, 'wx', 0o600);
  try { await file.writeFile(content); } finally { await file.close(); }
  if (!exclusive) await rename(target, path);
}

export async function loadIdentity(config) {
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  await checkPrivatePath(config.stateDirectory, true);
  const keyPath = join(config.stateDirectory, 'private-key.pem');
  let pem;
  try { pem = await readPrivate(keyPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writePrivate(keyPath, pem, true);
  }
  const privateKey = createPrivateKey(pem);
  assert(privateKey.asymmetricKeyType === 'ed25519', 'Connector key must be Ed25519');
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  const statePath = join(config.stateDirectory, 'host-state.json');
  let state = { appOrigin: config.appOrigin, publicKey, advertisedModels: [...config.models] };
  try {
    state = JSON.parse(await readPrivate(statePath));
    assert(object(state) && state.appOrigin === config.appOrigin && state.publicKey === publicKey && Array.isArray(state.advertisedModels) && state.advertisedModels.every((model) => text(model, 128)) && (!state.hostId || text(state.hostId, 200)), 'Host state does not match this app and key');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let saving = Promise.resolve();
  const save = () => {
    const content = JSON.stringify(state, null, 2) + '\n';
    saving = saving.then(() => writePrivate(statePath, content));
    return saving;
  };
  await save();
  return { privateKey, publicKey, state, save };
}

class HttpError extends Error {
  constructor(status) { super(`Endpoint returned HTTP ${status}`); this.status = status; }
}

async function fetchJson(url, options, timeoutMs, signal) {
  assert(timeoutMs > 0, 'Job deadline elapsed');
  const response = await fetch(url, { ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(timeoutMs))]) : AbortSignal.timeout(Math.ceil(timeoutMs)) });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new Error('Endpoint response exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function delay(ms, signal) {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolveDelay(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class Connector {
  constructor(config, identity, { log = console.log, signal } = {}) {
    this.config = config;
    this.identity = identity;
    this.log = log;
    this.signal = signal;
    this.models = identity.state.advertisedModels.filter((model) => config.models.includes(model));
    this.haToken = undefined;
  }

  async initialize() {
    if (this.config.homeAssistant) {
      this.haToken = (await readPrivate(this.config.homeAssistant.tokenFile)).trim();
      assert(text(this.haToken, 16384) && !/\s/.test(this.haToken), 'Invalid Home Assistant token file');
    }
    const { state } = this.identity;
    if (state.hostId && (state.approved || Date.parse(state.expiresAt) > Date.now())) {
      if (!state.approved) this.log(`Pairing code: ${state.code} (expires ${state.expiresAt}). Approve it in the app host desk.`);
      return;
    }
    const pairing = await fetchJson(`${this.config.appOrigin}${API}pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: this.identity.publicKey, name: this.config.name }) }, 10_000, this.signal);
    assert(object(pairing) && /^[A-HJ-NP-Z2-9]{8}$/.test(pairing.code) && text(pairing.hostId, 200) && Number.isFinite(Date.parse(pairing.expiresAt)) && Date.parse(pairing.expiresAt) > Date.now() && Date.parse(pairing.expiresAt) <= Date.now() + 600_000, 'Invalid pairing response');
    Object.assign(state, { hostId: pairing.hostId, code: pairing.code, expiresAt: pairing.expiresAt, approved: false });
    await this.identity.save();
    this.log(`Pairing code: ${pairing.code} (expires ${pairing.expiresAt}). Approve it in the app host desk.`);
  }

  async app(action, body, timeout = 10_000) {
    const raw = JSON.stringify(body);
    const pathname = `${API}${action}`;
    const wasApproved = Boolean(this.identity.state.approved);
    let result;
    try {
      result = await fetchJson(`${this.config.appOrigin}${pathname}`, { method: 'POST', body: raw, headers: signedHeaders(this.identity.privateKey, this.identity.state.hostId, pathname, raw) }, timeout, this.signal);
    } catch (error) {
      error.wasApproved = wasApproved;
      throw error;
    }
    if (!this.identity.state.approved) {
      this.identity.state.approved = true;
      delete this.identity.state.code;
      delete this.identity.state.expiresAt;
      await this.identity.save();
      this.log('Host pairing approved.');
    }
    return result;
  }

  async discover(timeout = 4000) {
    try {
      const tags = await fetchJson(`${this.config.ollamaUrl}/api/tags`, { method: 'GET' }, timeout, this.signal);
      assert(object(tags) && Array.isArray(tags.models) && tags.models.every((model) => object(model) && typeof model.name === 'string'), 'Invalid Ollama model list');
      const available = new Set(tags.models.map((model) => model.name));
      const models = this.config.models.filter((model) => available.has(model));
      if (JSON.stringify(models) !== JSON.stringify(this.models)) {
        this.models = models;
        this.identity.state.advertisedModels = models;
        await this.identity.save();
      }
      return true;
    } catch (error) {
      if (this.signal?.aborted) throw error;
      return false;
    }
  }

  async heartbeat() {
    const reachable = await this.discover();
    await this.app('heartbeat', { models: this.models, ollamaReachable: reachable, awake: reachable, canWake: Boolean(this.config.homeAssistant) });
  }

  async execute(job) {
    let result;
    let deadline;
    try {
      const body = validateJob(job, this.models);
      deadline = Date.parse(job.expiresAt);
      let reachable = await this.discover(Math.min(4000, deadline - Date.now()));
      if (!reachable && this.config.homeAssistant) {
        await fetchJson(`${this.config.homeAssistant.url}/api/services/script/${WAKE_SCRIPT}`, { method: 'POST', headers: { authorization: `Bearer ${this.haToken}`, 'content-type': 'application/json' }, body: '{}' }, Math.min(5000, deadline - Date.now()), this.signal);
        while (!reachable && Date.now() < deadline) {
          await delay(Math.min(2000, deadline - Date.now()), this.signal);
          reachable = await this.discover(Math.min(4000, deadline - Date.now()));
        }
      }
      assert(reachable && this.models.includes(job.model), 'Requested Ollama model is unavailable');
      const response = validateAnswer(await fetchJson(`${this.config.ollamaUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, deadline - Date.now(), this.signal), job.model);
      assert(Date.now() < deadline, 'Job deadline elapsed');
      result = { jobId: job.id, response };
      assert(Buffer.byteLength(JSON.stringify(result)) <= MAX_JSON_BYTES, 'Result exceeds protocol body limit');
    } catch (error) {
      if (this.signal?.aborted) throw error;
      // Never reflect endpoint bodies, tokens, prompts, or arbitrary errors to logs/the app.
      if (text(job?.id, 200)) result = { jobId: job.id, error: 'Connector could not produce a complete bounded answer' };
      else throw new Error('Invalid job envelope');
    }
    // Submit once; a lost acknowledgement must not turn a valid answer into an error.
    await this.app('result', result, result.response ? Math.min(10_000, deadline - Date.now()) : 10_000);
  }

  async loop(kind) {
    while (!this.signal?.aborted) {
      try {
        if (kind === 'heartbeat') await this.heartbeat();
        else {
          const envelope = await this.app('poll', {}, 28_000);
          assert(keys(envelope, ['job']) && Object.hasOwn(envelope, 'job'), 'Invalid poll response');
          if (envelope.job !== null) await this.execute(envelope.job);
        }
      } catch (error) {
        if (this.signal?.aborted) return;
        if ((error.status === 403 || error.status === 401) && error.wasApproved) throw new Error('Host authorization rejected; stop this connector and check revocation in the app');
        if (error.status === 403 && !this.identity.state.approved && Date.parse(this.identity.state.expiresAt) <= Date.now()) throw new Error('Pairing expired; restart to request a new code');
        if (error.status !== 403) this.log(`${kind === 'heartbeat' ? 'Heartbeat' : 'Poll'} unavailable; retrying without exposing endpoint details.`);
        await delay(3000, this.signal).catch(() => {});
      }
      await delay(kind === 'heartbeat' ? 20_000 : 250, this.signal).catch(() => {});
    }
  }

  async run() {
    await this.initialize();
    // Separate loops: long-polls, wake waits and generation never delay heartbeats.
    await Promise.all([this.loop('heartbeat'), this.loop('poll')]);
  }
}

export async function main(argv = process.argv.slice(2)) {
  assert(argv.length === 2 && argv[0] === '--config', 'Usage: node connector.mjs --config /path/to/config.json');
  const configPath = resolve(argv[1]);
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')), resolve(configPath, '..'));
  const identity = await loadIdentity(config);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Connector stopped'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await new Connector(config, identity, { signal: controller.signal }).run(); }
  finally { controller.abort(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Connector stopped. Check configuration, owner-only key/token permissions, pairing expiry and host approval/revocation. No endpoint credentials were logged.'); process.exitCode = 1; });
}
