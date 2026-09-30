#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
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
  assert(keys(input, ['appOrigin', 'ollamaUrl', 'models', 'name', 'stateDirectory', 'pairingCode', 'wakeOnLan', 'homeAssistant', 'DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN']), 'Unknown connector configuration field');
  const ollamaOptIn = input.DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN;
  assert(ollamaOptIn === undefined || typeof ollamaOptIn === 'boolean', 'Ollama plaintext opt-in must be boolean');
  const ollamaUrl = endpointOrigin(input.ollamaUrl);
  const ollamaHost = new URL(ollamaUrl).hostname;
  // Plain HTTP beyond this device lets anyone on that network read questions and forge answers.
  assert(ollamaUrl.startsWith('https:') || ['localhost', '127.0.0.1', '[::1]'].includes(ollamaHost) || ollamaOptIn === true,
    'Ollama beyond this device requires HTTPS unless DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN is explicitly true');
  assert(text(input.name, 80) && input.name.trim(), 'Host name is required (max 80 characters)');
  assert(Array.isArray(input.models) && input.models.length > 0 && input.models.length <= 16 && input.models.every((model) => text(model, 128)) && new Set(input.models).size === input.models.length, 'Configure 1–16 unique model names, at most 128 characters each');
  assert(text(input.stateDirectory, 4096), 'stateDirectory is required');
  assert(input.pairingCode === undefined || (typeof input.pairingCode === 'string' && /^[A-HJ-NP-Z2-9]{12}$/.test(input.pairingCode)), 'pairingCode must be a 12-character owner invitation');
  assert(input.homeAssistant === undefined || input.wakeOnLan === undefined, 'Configure only one wake mode');
  let wakeOnLan;
  if (input.wakeOnLan !== undefined) {
    const wake = input.wakeOnLan;
    assert(keys(wake, ['mac', 'broadcastAddress', 'port']) && typeof wake.mac === 'string' && /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(wake.mac), 'Wake-on-LAN requires a colon-separated MAC address');
    const mac = Buffer.from(wake.mac.replaceAll(':', ''), 'hex');
    assert((mac[0] & 1) === 0 && mac.some((byte) => byte !== 0), 'Wake-on-LAN requires a unicast device MAC');
    assert(typeof wake.broadcastAddress === 'string' && isIP(wake.broadcastAddress) === 4 && wake.broadcastAddress !== '0.0.0.0' && (Number(wake.broadcastAddress.split('.')[0]) < 224 || wake.broadcastAddress === '255.255.255.255'), 'Wake-on-LAN requires an IPv4 broadcast address');
    assert(wake.port === undefined || (Number.isInteger(wake.port) && wake.port > 0 && wake.port <= 65535), 'Invalid Wake-on-LAN UDP port');
    wakeOnLan = { mac: wake.mac, broadcastAddress: wake.broadcastAddress, port: wake.port ?? 9 };
  }
  let homeAssistant;
  if (input.homeAssistant !== undefined) {
    assert(keys(input.homeAssistant, ['url', 'tokenFile', 'DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN']) && text(input.homeAssistant.tokenFile, 4096), 'Invalid Home Assistant configuration');
    const optIn = input.homeAssistant.DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN;
    assert(optIn === undefined || typeof optIn === 'boolean', 'Home Assistant plaintext opt-in must be boolean');
    const url = endpointOrigin(input.homeAssistant.url);
    assert(url.startsWith('https:') || optIn === true, 'Home Assistant requires HTTPS unless DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN is explicitly true');
    homeAssistant = { url, tokenFile: resolve(baseDirectory, input.homeAssistant.tokenFile) };
  }
  return { appOrigin: endpointOrigin(input.appOrigin, true), ollamaUrl, models: [...input.models], name: input.name.trim(), stateDirectory: resolve(baseDirectory, input.stateDirectory), pairingCode: input.pairingCode, wakeOnLan, homeAssistant };
}

export function jobDeadline(job, now = Date.now()) {
  const deadline = typeof job.expiresAt === 'string' ? Date.parse(job.expiresAt) : NaN;
  assert(Number.isFinite(deadline) && deadline > now, 'Invalid job deadline');
  return Math.min(deadline, now + 240_000);
}

export function sendWakePacket(wake, signal) {
  const packet = Buffer.alloc(102, 0xff);
  const mac = Buffer.from(wake.mac.replaceAll(':', ''), 'hex');
  for (let offset = 6; offset < packet.length; offset += mac.length) mac.copy(packet, offset);
  return new Promise((resolveSend, reject) => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      try { socket.close(); } catch { /* Socket may not have bound before cancellation. */ }
      if (error) reject(error); else resolveSend();
    };
    const abort = () => finish(signal.reason);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('error', finish);
    socket.bind(0, () => {
      if (settled) { socket.close(); return; }
      try {
        socket.setBroadcast(true);
        socket.send(packet, wake.port, wake.broadcastAddress, finish);
      } catch (error) { finish(error); }
    });
  });
}

export function validateJob(job, models, now = Date.now()) {
  assert(keys(job, ['id', 'model', 'messages', 'options', 'expiresAt']) && text(job.id, 200), 'Invalid job shape');
  assert(models.includes(job.model) && text(job.model, 128), 'Job model is not advertised');
  jobDeadline(job, now);
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
    assert(keys(state, ['appOrigin', 'publicKey', 'advertisedModels', 'hostId']) && state.appOrigin === config.appOrigin && state.publicKey === publicKey && Array.isArray(state.advertisedModels) && state.advertisedModels.every((model) => text(model, 128)) && (state.hostId === undefined || text(state.hostId, 200)), 'Host state does not match this app and key');
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
    if (state.hostId) return;
    assert(this.config.pairingCode, 'Create an owner invitation in the app and set pairingCode before first registration');
    const pairing = await fetchJson(`${this.config.appOrigin}${API}pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: this.config.pairingCode, publicKey: this.identity.publicKey, name: this.config.name }) }, 10_000, this.signal);
    assert(keys(pairing, ['hostId']) && text(pairing.hostId, 200), 'Invalid pairing response');
    state.hostId = pairing.hostId;
    await this.identity.save();
    this.log('Host registered. Remove pairingCode from the local configuration.');
  }

  async app(action, body, timeout = 10_000) {
    const raw = JSON.stringify(body);
    const pathname = `${API}${action}`;
    return fetchJson(`${this.config.appOrigin}${pathname}`, { method: 'POST', body: raw, headers: signedHeaders(this.identity.privateKey, this.identity.state.hostId, pathname, raw) }, timeout, this.signal);
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
    await this.app('heartbeat', { models: this.models, ollamaReachable: reachable, awake: reachable, canWake: Boolean(this.config.homeAssistant || this.config.wakeOnLan) });
  }

  async execute(job) {
    let result;
    let deadline;
    try {
      const now = Date.now();
      const body = validateJob(job, this.models, now);
      deadline = jobDeadline(job, now);
      let reachable = await this.discover(Math.min(4000, deadline - Date.now()));
      if (!reachable && (this.config.homeAssistant || this.config.wakeOnLan)) {
        if (this.config.wakeOnLan) {
          const remaining = deadline - Date.now();
          assert(remaining > 0, 'Job deadline elapsed');
          const signal = AbortSignal.timeout(remaining);
          await sendWakePacket(this.config.wakeOnLan, this.signal ? AbortSignal.any([this.signal, signal]) : signal);
        } else {
          await fetchJson(`${this.config.homeAssistant.url}/api/services/script/${WAKE_SCRIPT}`, { method: 'POST', headers: { authorization: `Bearer ${this.haToken}`, 'content-type': 'application/json' }, body: '{}' }, Math.min(5000, deadline - Date.now()), this.signal);
        }
        while (!reachable && Date.now() < deadline) {
          await delay(Math.min(2000, deadline - Date.now()), this.signal);
          reachable = await this.discover(Math.min(4000, deadline - Date.now()));
        }
      }
      assert(reachable && this.models.includes(job.model), 'Requested Ollama model is unavailable');
      const preload = await fetchJson(`${this.config.ollamaUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: job.model, keep_alive: '5m', stream: false }) }, deadline - Date.now(), this.signal);
      assert(object(preload) && preload.error === undefined && preload.model === job.model && preload.done === true && [undefined, 'load', 'stop'].includes(preload.done_reason) && preload.response === '', 'Ollama returned an incomplete or invalid preload');
      const response = validateAnswer(await fetchJson(`${this.config.ollamaUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, Math.min(90_000, deadline - Date.now()), this.signal), job.model);
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
        if (error.status === 403 || error.status === 401) throw new Error('Host authorization rejected; stop this connector and check revocation in the app');
        this.log(`${kind === 'heartbeat' ? 'Heartbeat' : 'Poll'} unavailable; retrying without exposing endpoint details.`);
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
  main().catch(() => { console.error('Connector stopped. Check configuration, owner-only key/token permissions, invitation expiry and host revocation. No endpoint credentials were logged.'); process.exitCode = 1; });
}
