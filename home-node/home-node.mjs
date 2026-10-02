#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

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

export function localDeviceOrigin(value) {
  const origin = endpointOrigin(value);
  const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const octets = host.split('.').map(Number);
  const localV4 = isIP(host) === 4 && (octets[0] === 127 || octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254));
  assert(host === 'localhost' || host === '::1' || localV4 || (isIP(host) === 6 && /^fe[89ab]/.test(host)) || host.endsWith('.local') || host.endsWith('.home.arpa'), 'MCP device URLs must be loopback, RFC 1918, link-local, .local or .home.arpa. Use interactive setup and explicitly confirm any public origin.');
  return origin;
}

export function validateConfig(input, baseDirectory = process.cwd()) {
  assert(keys(input, ['appOrigin', 'ollamaUrl', 'models', 'name', 'stateDirectory', 'pairingCode', 'wakeOnLan', 'homeAssistant', 'gpuEnabled', 'validators', 'DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN']), 'Unknown Home Node configuration field');
  assert(input.gpuEnabled === undefined || typeof input.gpuEnabled === 'boolean', 'gpuEnabled must be boolean');
  const gpuEnabled = input.gpuEnabled ?? true;
  const validators = input.validators ?? [];
  assert(Array.isArray(validators) && validators.length <= 16 && validators.every((id) => text(id, 160) && /^[A-Za-z0-9:._-]+$/.test(id)) && new Set(validators).size === validators.length, 'Configure at most 16 unique public validator ids');
  const ollamaOptIn = input.DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN;
  assert(ollamaOptIn === undefined || typeof ollamaOptIn === 'boolean', 'Ollama plaintext opt-in must be boolean');
  const ollamaUrl = endpointOrigin(input.ollamaUrl);
  const ollamaHost = new URL(ollamaUrl).hostname;
  // Plain HTTP beyond this device lets anyone on that network read questions and forge answers.
  assert(ollamaUrl.startsWith('https:') || ['localhost', '127.0.0.1', '[::1]'].includes(ollamaHost) || ollamaOptIn === true,
    'Ollama beyond this device requires HTTPS unless DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN is explicitly true');
  assert(text(input.name, 80) && input.name.trim(), 'Host name is required (max 80 characters)');
  assert(Array.isArray(input.models) && (input.models.length > 0 || !gpuEnabled) && input.models.length <= 16 && input.models.every((model) => text(model, 128)) && new Set(input.models).size === input.models.length, 'Configure 1–16 unique model names for GPU hosting, at most 128 characters each');
  assert(text(input.stateDirectory, 4096), 'stateDirectory is required');
  assert(input.pairingCode === undefined || (typeof input.pairingCode === 'string' && /^[A-HJ-NP-Z2-9]{12}$/.test(input.pairingCode)), 'pairingCode must be a 12-character owner invitation');
  assert(input.homeAssistant === undefined || input.homeAssistant.wake === false || input.wakeOnLan === undefined, 'Configure only one wake mode');
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
    assert(keys(input.homeAssistant, ['url', 'tokenFile', 'sensors', 'wake', 'DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN']) && text(input.homeAssistant.tokenFile, 4096), 'Invalid Home Assistant configuration');
    assert(input.homeAssistant.wake === undefined || typeof input.homeAssistant.wake === 'boolean', 'Home Assistant wake must be boolean');
    const sensors = input.homeAssistant.sensors ?? {};
    assert(keys(sensors, ['power', 'energyToday']) && Object.values(sensors).every((id) => text(id, 160) && /^sensor\.[a-z0-9_]+$/.test(id)), 'Select public sensor entity ids only');
    const optIn = input.homeAssistant.DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN;
    assert(optIn === undefined || typeof optIn === 'boolean', 'Home Assistant plaintext opt-in must be boolean');
    const url = endpointOrigin(input.homeAssistant.url);
    assert(url.startsWith('https:') || optIn === true, 'Home Assistant requires HTTPS unless DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN is explicitly true');
    homeAssistant = { url, tokenFile: resolve(baseDirectory, input.homeAssistant.tokenFile), sensors, wake: input.homeAssistant.wake ?? true, DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN: optIn };
  }
  return { appOrigin: endpointOrigin(input.appOrigin, true), ollamaUrl, models: [...input.models], name: input.name.trim(), stateDirectory: resolve(baseDirectory, input.stateDirectory), pairingCode: input.pairingCode, wakeOnLan, homeAssistant, gpuEnabled, validators, DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN: ollamaOptIn };
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

function permissionError(message) {
  const error = new Error(`${message} Owner-only files must be 0600 and directories 0700. Run node home-node.mjs migrate-permissions --config /absolute/path/to/config.json. Symlinks or foreign-owned paths must instead be replaced with regular paths owned by your service user.`);
  error.code = 'HOME_NODE_PERMISSIONS';
  return error;
}

export async function checkPrivatePath(path, directory = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) {
    throw permissionError(directory ? 'Refused a non-owner-only directory.' : 'Refused a non-owner-only file.');
  }
}

function containedPath(root, path) {
  const within = relative(resolve(root), resolve(path));
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw permissionError('Secret paths must be contained within the Home Node private state directory.');
  }
  return resolve(path);
}

async function checkContainedParents(root, path) {
  containedPath(root, path);
  await checkPrivatePath(root, true);
  const resolvedRoot = await realpath(root);
  const parent = resolve(path, '..');
  if (parent !== resolve(root)) {
    const segments = relative(resolve(root), parent).split(sep);
    let current = resolve(root);
    for (const segment of segments) {
      current = join(current, segment);
      await checkPrivatePath(current, true);
    }
  }
  const actualParent = await realpath(parent);
  if (actualParent !== resolvedRoot) containedPath(resolvedRoot, actualParent);
}

async function readPrivate(path, root = resolve(path, '..')) {
  await checkContainedParents(root, path);
  await checkPrivatePath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) throw permissionError('Private file permissions changed.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

async function writePrivate(path, content, exclusive = false) {
  await checkContainedParents(resolve(path, '..'), path);
  try { await checkPrivatePath(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
  try { pem = await readPrivate(containedPath(config.stateDirectory, keyPath), config.stateDirectory); } catch (error) {
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
    state = JSON.parse(await readPrivate(containedPath(config.stateDirectory, statePath), config.stateDirectory));
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
  }

  async initialize() {
    if (this.config.homeAssistant) await readHomeAssistantToken(this.config);
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
    await this.app('heartbeat', { models: this.models, ollamaReachable: reachable, awake: reachable, canWake: Boolean((this.config.homeAssistant?.wake !== false && this.config.homeAssistant) || this.config.wakeOnLan) });
  }

  async execute(job) {
    let result;
    let deadline;
    try {
      const now = Date.now();
      const body = validateJob(job, this.models, now);
      deadline = jobDeadline(job, now);
      let reachable = await this.discover(Math.min(4000, deadline - Date.now()));
      if (!reachable && ((this.config.homeAssistant?.wake !== false && this.config.homeAssistant) || this.config.wakeOnLan)) {
        if (this.config.wakeOnLan) {
          const remaining = deadline - Date.now();
          assert(remaining > 0, 'Job deadline elapsed');
          const signal = AbortSignal.timeout(remaining);
          await sendWakePacket(this.config.wakeOnLan, this.signal ? AbortSignal.any([this.signal, signal]) : signal);
        } else {
          const wakeConfig = this.config;
          const token = await readHomeAssistantToken(wakeConfig);
          await fetchJson(`${wakeConfig.homeAssistant.url}/api/services/script/${WAKE_SCRIPT}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }, Math.min(5000, deadline - Date.now()), this.signal);
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
        else if (this.config.gpuEnabled !== false) {
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
      await delay(kind === 'heartbeat' ? 20_000 : this.config.gpuEnabled === false ? 1000 : 250, this.signal).catch(() => {});
    }
  }

  async run() {
    await this.initialize();
    // Separate loops: long-polls, wake waits and generation never delay heartbeats.
    await Promise.all([this.loop('heartbeat'), this.loop('poll')]);
  }
}


export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'ledger-home-node', 'config.json');
export const MCP_PROTOCOL_VERSION = '2026-07-28';
const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'ledger-home-node', version: '2.0.0' };
const MCP_CAPABILITIES = { tools: {}, resources: {}, prompts: {} };
const MCP_INSTRUCTIONS = 'Start with home_node_status. Secrets stay local. MCP never accepts token file paths; prefer interactive setup to keep Home Assistant tokens out of chat. This MCP configures the node; run the separate service for ongoing jobs/readings.';

export async function readConfig(path) {
  const config = validateConfig(JSON.parse(await readPrivate(path)), resolve(path, '..'));
  await checkConfigSecrets(config);
  return config;
}

async function checkConfigSecrets(config) {
  try { await checkPrivatePath(config.stateDirectory, true); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const filename of ['private-key.pem', 'host-state.json']) {
    const path = containedPath(config.stateDirectory, join(config.stateDirectory, filename));
    try { await checkContainedParents(config.stateDirectory, path); await checkPrivatePath(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (config.homeAssistant) {
    const path = containedPath(config.stateDirectory, config.homeAssistant.tokenFile);
    await checkContainedParents(config.stateDirectory, path);
    await checkPrivatePath(path);
  }
}

async function tightenOwnedPath(path, directory = false, read = false) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !(directory ? before.isDirectory() : before.isFile()) || (process.getuid !== undefined && before.uid !== process.getuid())) throw permissionError('Migration refuses symlinks and foreign-owned paths.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
  try {
    const stat = await file.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || !(directory ? stat.isDirectory() : stat.isFile()) || (process.getuid !== undefined && stat.uid !== process.getuid())) throw permissionError('Migration path changed while opening.');
    await file.chmod(directory ? 0o700 : 0o600);
    const after = await lstat(path);
    if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) throw permissionError('Migration path changed while tightening permissions.');
    return read ? await file.readFile('utf8') : undefined;
  } finally { await file.close(); }
}

export async function migratePermissions(configPath) {
  const path = resolve(configPath);
  await tightenOwnedPath(resolve(path, '..'), true);
  const config = validateConfig(JSON.parse(await tightenOwnedPath(path, false, true)), resolve(path, '..'));
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  await tightenOwnedPath(config.stateDirectory, true);
  for (const filename of ['private-key.pem', 'host-state.json']) {
    const secret = containedPath(config.stateDirectory, join(config.stateDirectory, filename));
    try { await tightenOwnedPath(secret); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (config.homeAssistant) {
    const source = config.homeAssistant.tokenFile;
    await tightenOwnedPath(resolve(source, '..'), true);
    const token = credentialToken((await tightenOwnedPath(source, false, true)).trim(), config.homeAssistant.url);
    const target = containedPath(config.stateDirectory, join(config.stateDirectory, 'home-assistant-token'));
    await writePrivate(target, JSON.stringify({ origin: config.homeAssistant.url, token }) + '\n');
    config.homeAssistant.tokenFile = target;
  }
  await saveConfig(path, config);
  return { migrated: true, identityPreserved: true, next: 'Stop the old connector, then run Home Node with this same config.' };
}

export async function saveConfig(path, input) {
  const config = validateConfig(input, resolve(path, '..'));
  if (config.homeAssistant) containedPath(config.stateDirectory, config.homeAssistant.tokenFile);
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  await checkPrivatePath(resolve(path, '..'), true);
  await writePrivate(path, JSON.stringify(config, null, 2) + '\n');
  return config;
}

function credentialToken(raw, origin) {
  let token = raw;
  if (raw.startsWith('{')) {
    const credential = JSON.parse(raw);
    assert(keys(credential, ['origin', 'token']) && credential.origin === origin, 'Home Assistant credential is bound to a different configured origin; reconnect locally');
    token = credential.token;
  }
  assert(text(token, 16384) && !/\s/.test(token), 'Invalid Home Assistant token file');
  return token;
}

async function readHomeAssistantToken(config) {
  const raw = (await readPrivate(containedPath(config.stateDirectory, config.homeAssistant.tokenFile), config.stateDirectory)).trim();
  return credentialToken(raw, config.homeAssistant.url);
}

export async function connectHomeAssistant(configPath, args, { allowPublicOrigin = false } = {}) {
  const config = await initialConfig(configPath);
  const url = allowPublicOrigin ? endpointOrigin(args.url) : localDeviceOrigin(args.url);
  assert(text(args.token, 16384) && !/\s/.test(args.token), 'Supply the token value; file paths are never accepted by MCP');
  const tokenFile = containedPath(config.stateDirectory, join(config.stateDirectory, 'home-assistant-token'));
  const homeAssistant = { url, tokenFile, sensors: { ...(args.powerSensor ? { power: args.powerSensor } : {}), ...(args.energyTodaySensor ? { energyToday: args.energyTodaySensor } : {}) }, wake: args.wake ?? false, DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN: args.allowPlaintextLan ?? false };
  const next = validateConfig({ ...config, homeAssistant }, resolve(configPath, '..'));
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  await checkPrivatePath(config.stateDirectory, true);
  // Bind each token to its origin so a concurrently running service cannot send it using an old configuration.
  await writePrivate(tokenFile, JSON.stringify({ origin: url, token: args.token }) + '\n');
  await saveConfig(configPath, next);
  await homeAssistantStates(next);
  return { connected: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, next: 'List power/energy sensors, confirm the daily counter resets in this device timezone, and select only the readings you want to share.' };
}

export function parseHomeAssistantSensors(states) {
  assert(Array.isArray(states), 'Invalid Home Assistant state list');
  return states.filter((state) => object(state) && /^sensor\.[a-z0-9_]+$/.test(state.entity_id) && object(state.attributes))
    .map((state) => {
      const unit = state.attributes.unit_of_measurement;
      const kind = ['W', 'kW'].includes(unit) ? 'power' : ['Wh', 'kWh', 'MWh'].includes(unit) ? 'energy' : null;
      const numeric = typeof state.state === 'string' && state.state.trim() !== '' ? Number(state.state) : NaN;
      return { entityId: state.entity_id, kind, unit, value: Number.isFinite(numeric) && numeric >= 0 ? numeric : null };
    }).filter((sensor) => sensor.kind !== null);
}

async function homeAssistantStates(config, signal) {
  assert(config.homeAssistant, 'Home Assistant is not configured');
  const token = await readHomeAssistantToken(config);
  return fetchJson(`${config.homeAssistant.url}/api/states`, { headers: { authorization: `Bearer ${token}` } }, 10_000, signal);
}

export function selectedReading(states, sensors, now = new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const candidates = parseHomeAssistantSensors(states);
  const energy = candidates.find((candidate) => candidate.entityId === sensors.energyToday && candidate.kind === 'energy');
  assert(energy?.value !== null && energy?.value !== undefined, 'Selected daily energy sensor is unavailable');
  const power = candidates.find((candidate) => candidate.entityId === sensors.power && candidate.kind === 'power');
  const energyTodayKwh = energy.value * ({ Wh: 0.001, kWh: 1, MWh: 1000 }[energy.unit]);
  const powerW = power?.value == null ? null : power.value * (power.unit === 'kW' ? 1000 : 1);
  assert(energyTodayKwh <= 1e6 && (powerW === null || powerW <= 1e9), 'Readings exceed protocol bounds');
  const dateParts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type) => dateParts.find((item) => item.type === type).value;
  const localDate = `${part('year')}-${part('month')}-${part('day')}`;
  return { powerW, energyTodayKwh, timestamp: now.toISOString(), localDate, timezone };
}

export async function detectDevices(ollamaUrl = 'http://127.0.0.1:11434') {
  let models = [];
  let ollamaReachable = false;
  try {
    const tags = await fetchJson(`${endpointOrigin(ollamaUrl)}/api/tags`, {}, 4000);
    assert(Array.isArray(tags.models), 'Invalid Ollama model list');
    models = tags.models.map((model) => model.name).filter((name) => text(name, 128)).slice(0, 16);
    ollamaReachable = true;
  } catch { /* Detection is optional; never echo endpoint errors. */ }
  let nvidia = [];
  try {
    const { stdout } = await promisify(execFile)('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 4000, maxBuffer: 8192 });
    nvidia = stdout.trim().split('\n').filter(Boolean).slice(0, 16);
  } catch { /* NVIDIA tools are not required for Ollama/CPU hosts. */ }
  return { ollamaReachable, models, nvidia };
}

export async function nodeStatus(configPath) {
  let config;
  try { config = await readConfig(configPath); } catch (error) {
    if (error.code === 'ENOENT') return { configured: false, next: 'Run setup or configure_gpu; then create a pairing code in Money → Devices & income.' };
    throw error;
  }
  let hostId = null;
  try {
    const state = JSON.parse(await readPrivate(join(config.stateDirectory, 'host-state.json')));
    hostId = text(state.hostId, 200) ? state.hostId : null;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { configured: true, paired: hostId !== null, hostId, appOrigin: config.appOrigin, gpuEnabled: config.gpuEnabled, models: config.models, solarSensors: Object.values(config.homeAssistant?.sensors ?? {}), validatorIds: config.validators, canWake: Boolean(config.wakeOnLan || config.homeAssistant?.wake), next: hostId ? 'Run the Home Node service. Income opt-ins and payout selection stay in the hosted app.' : 'Create a private pairing code in the hosted app, then call pair_home_node.' };
}

async function initialConfig(configPath) {
  try { return await readConfig(configPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { appOrigin: 'https://ledger.stadtstack.eu', ollamaUrl: 'http://127.0.0.1:11434', models: [], gpuEnabled: false, name: hostname().slice(0, 80), stateDirectory: resolve(configPath, '..', 'state'), validators: [] };
}

export async function pairHomeNode(configPath, code, options = {}) {
  const config = validateConfig({ ...await initialConfig(configPath), ...options, pairingCode: code }, resolve(configPath, '..'));
  const identity = await loadIdentity(config);
  const connector = new Connector(config, identity, { log: () => {} });
  await connector.initialize();
  delete config.pairingCode;
  await saveConfig(configPath, config);
  return { paired: true, hostId: identity.state.hostId };
}

export class HomeNode extends Connector {
  constructor(config, identity, options = {}) {
    super(config, identity, options);
    this.configPath = options.configPath;
    this.lastAnnouncement = 0;
    this.lastReading = 0;
    this.lastCapabilities = null;
  }

  async reload() {
    if (!this.configPath) return;
    const config = await readConfig(this.configPath);
    assert(config.appOrigin === this.config.appOrigin && config.stateDirectory === this.config.stateDirectory, 'Stop the service before changing app origin or identity directory');
    if (JSON.stringify(config) !== JSON.stringify(this.config)) {
      this.config = config;
      this.models = this.identity.state.advertisedModels.filter((model) => config.models.includes(model));
      await this.initialize();
    }
  }

  async discover(timeout = 4000) {
    if (this.config.gpuEnabled) return super.discover(timeout);
    this.models = [];
    return false;
  }

  async nodeApp(action, body) {
    const pathname = `/api/home-node/${action}`;
    const raw = JSON.stringify(body);
    return fetchJson(`${this.config.appOrigin}${pathname}`, { method: 'POST', body: raw, headers: signedHeaders(this.identity.privateKey, this.identity.state.hostId, pathname, raw) }, 10_000, this.signal);
  }

  async announce() {
    const capabilities = { gpuModels: this.config.gpuEnabled ? this.models : [], solarSensors: Object.values(this.config.homeAssistant?.sensors ?? {}), validatorIds: this.config.validators };
    const raw = JSON.stringify(capabilities);
    if (Date.now() - this.lastAnnouncement < 30_000 || raw === this.lastCapabilities) return;
    this.lastAnnouncement = Date.now();
    await this.nodeApp('capabilities', capabilities);
    this.lastCapabilities = raw;
  }

  async pushReadings() {
    assert(this.config.homeAssistant?.sensors.energyToday, 'Select a daily energy sensor first');
    const reading = selectedReading(await homeAssistantStates(this.config, this.signal), this.config.homeAssistant.sensors);
    await this.nodeApp('readings', reading);
    return { pushed: true, ...reading };
  }

  async heartbeat() {
    await this.reload();
    await super.heartbeat();
    await this.announce();
    if (this.config.homeAssistant?.sensors.energyToday && Date.now() - this.lastReading >= 60_000) {
      this.lastReading = Date.now();
      await this.pushReadings();
    }
  }

}

const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const stringField = (description) => ({ type: 'string', description });
const stringArray = (description) => ({ type: 'array', items: { type: 'string' }, description });
export const MCP_TOOLS = [
  { name: 'home_node_status', description: 'Start here. Check local configuration and pairing without exposing credentials. Then detect devices, configure selected capabilities, pair, and run the service.', inputSchema: schema() },
  { name: 'detect_devices', description: 'Step 1: detect local Ollama models and NVIDIA hardware. No installation or LAN scanning; Ollama defaults to 127.0.0.1:11434.', inputSchema: schema({ ollamaUrl: stringField('Optional HTTP(S) origin for Ollama.') }) },
  { name: 'configure_gpu', description: 'Step 2: choose only models detected by Ollama and an explicit host name. Set enabled=false for solar/validator-only nodes. Does not download models or expose Ollama publicly.', inputSchema: schema({ models: stringArray('1–16 installed model names; empty when disabled.'), enabled: { type: 'boolean' }, ollamaUrl: stringField('Local Ollama origin.'), name: stringField('Public host name, not a secret.'), allowPlaintextLan: { type: 'boolean', description: 'Explicit insecure trusted-LAN HTTP opt-in; prefer loopback or HTTPS.' } }, ['models', 'enabled']) },
  { name: 'pair_home_node', description: 'Step 3: ask the owner to create a ten-minute private pairing code in Money → Devices & income using a verified EVM wallet. Consume it once; never ask for a wallet private key. Existing host key and identity are kept. Changing the app origin requires interactive local setup.', inputSchema: schema({ code: stringField('Private twelve-character invitation; never repeat it.'), appOrigin: stringField('Optional confirmation of the already configured app origin; cannot change it.'), name: stringField('Optional public host name.') }, ['code']) },
  { name: 'connect_home_assistant', description: 'Optional step: store the supplied HA token in a fixed owner-only file inside this node’s state directory, bound to the configured origin. MCP never accepts a file path. Prefer interactive setup if the token must not enter the LLM conversation. URLs must be loopback, private/link-local IPs, .local or .home.arpa; public origins require explicit local setup confirmation. Use HTTPS or explicitly opt into trusted-LAN HTTP. Choose public sensor ids; energyToday must reset at midnight in this device’s timezone. Solar income is simulated and needs a separate in-app opt-in.', inputSchema: schema({ url: stringField('Local Home Assistant origin; public origins refused in MCP.'), token: stringField('Token value saved only locally, never echoed.'), powerSensor: stringField('Optional power sensor entity id.'), energyTodaySensor: stringField('Optional energy sensor accumulating today since local midnight in the device timezone.'), allowPlaintextLan: { type: 'boolean' }, wake: { type: 'boolean', description: 'Enable existing desktop_ai_wake_gpu_host HA script; false by default.' } }, ['url', 'token']) },
  { name: 'list_home_assistant_sensors', description: 'After connecting HA, list only power/energy entity ids, units and numeric values. Token and other HA attributes never appear. Ask the owner which sensors to share and confirm that their daily counter resets in the device timezone.', inputSchema: schema() },
  { name: 'add_validator', description: 'Optional step: announce a public validator id only (for example solana:PUBLIC_ID or ethereum:PUBLIC_ID). This does not operate a validator or promise yield. Never supply keys or seed phrases.', inputSchema: schema({ id: stringField('Public network-prefixed validator id, maximum 160 characters.') }, ['id']) },
  { name: 'test_gpu', description: 'After configuring GPU, run one tiny fixed local prompt to confirm a complete Ollama answer. No paid request, app submission or chain transaction.', inputSchema: schema() },
  { name: 'push_readings_now', description: 'After pairing and selecting an HA daily energy sensor, push one signed numeric reading with its local date and device timezone. Respect the server’s 30-second interval; run the service for ongoing minute readings. Building solar income requires an explicit in-app assignment, declared peak kWp and manual operator approval; anomalous above-ceiling readings pause it. Income is simulated, not a verified meter bill.', inputSchema: schema() },
];

export async function callTool(name, args, configPath) {
  const definition = MCP_TOOLS.find((tool) => tool.name === name);
  assert(definition && keys(args, Object.keys(definition.inputSchema.properties)) && definition.inputSchema.required.every((key) => Object.hasOwn(args, key)), 'Invalid tool arguments');
  for (const [key, value] of Object.entries(args)) {
    const type = definition.inputSchema.properties[key].type;
    assert(type === 'array' ? Array.isArray(value) && value.every((item) => typeof item === 'string') : typeof value === type, 'Invalid tool argument type');
  }
  if (name === 'home_node_status') return nodeStatus(configPath);
  if (name === 'detect_devices') return detectDevices(args.ollamaUrl ? localDeviceOrigin(args.ollamaUrl) : undefined);
  if (name === 'pair_home_node') {
    const current = await initialConfig(configPath);
    assert(!args.appOrigin || endpointOrigin(args.appOrigin, true) === current.appOrigin, 'Changing the app origin requires interactive local setup');
    return pairHomeNode(configPath, args.code, { ...(args.name ? { name: args.name } : {}) });
  }
  const config = await initialConfig(configPath);
  if (name === 'configure_gpu') {
    if (args.ollamaUrl) localDeviceOrigin(args.ollamaUrl);
    await saveConfig(configPath, { ...config, models: args.models, gpuEnabled: args.enabled, ...(args.ollamaUrl ? { ollamaUrl: args.ollamaUrl } : {}), ...(args.name ? { name: args.name } : {}), DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN: args.allowPlaintextLan ?? config.DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN });
    return { configured: true, next: 'Test the GPU, then pair_home_node.' };
  }
  if (name === 'connect_home_assistant') return connectHomeAssistant(configPath, args);
  if (name === 'list_home_assistant_sensors') return { sensors: parseHomeAssistantSensors(await homeAssistantStates(config)) };
  if (name === 'add_validator') {
    await saveConfig(configPath, { ...config, validators: [...new Set([...config.validators, args.id])] });
    return { added: true, next: 'Run the service to announce this public identifier. No validator keys are needed.' };
  }
  if (name === 'test_gpu') {
    assert(config.gpuEnabled && config.models.length, 'Configure a GPU model first');
    validateAnswer(await fetchJson(`${config.ollamaUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: config.models[0], messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, think: false, options: { num_ctx: 512, num_predict: 16, temperature: 0 } }) }, 90_000), config.models[0]);
    return { complete: true, next: 'Run the Home Node service to offer this model.' };
  }
  assert(name === 'push_readings_now', 'Unknown tool');
  const identity = await loadIdentity(config);
  assert(identity.state.hostId, 'Pair the Home Node first');
  return new HomeNode(config, identity, { log: () => {} }).pushReadings();
}

export async function serveMcp(input, output, { configPath = DEFAULT_CONFIG_PATH, invoke = callTool } = {}) {
  let initialized = false;
  let pending = '';
  const send = async (message) => {
    const raw = JSON.stringify(message) + '\n';
    if (!output.write(raw)) await new Promise((done) => output.once('drain', done));
  };
  async function handle(line) {
    let request;
    try { request = JSON.parse(line); } catch { await send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const id = request?.id ?? null;
    const notification = object(request) && !Object.hasOwn(request, 'id');
    if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (!notification && typeof id !== 'string' && !Number.isSafeInteger(id))) {
      await send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return;
    }
    if (notification) return;
    const meta = request.params?._meta;
    const version = meta?.['io.modelcontextprotocol/protocolVersion'];
    const modern = version !== undefined || request.method === 'server/discover';
    if (modern && version !== MCP_PROTOCOL_VERSION) {
      await send({ jsonrpc: '2.0', id, error: { code: version === undefined ? -32602 : -32022, message: version === undefined ? 'Protocol metadata required' : 'Unsupported protocol version', ...(version === undefined ? {} : { data: { supported: [MCP_PROTOCOL_VERSION], requested: version } }) } }); return;
    }
    if (modern && !object(meta?.['io.modelcontextprotocol/clientCapabilities'])) {
      await send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Client capability metadata required' } }); return;
    }
    let result;
    if (request.method === 'server/discover') {
      result = { supportedVersions: [MCP_PROTOCOL_VERSION, ...MCP_LEGACY_VERSIONS], capabilities: MCP_CAPABILITIES, instructions: MCP_INSTRUCTIONS };
    } else if (request.method === 'initialize') {
      initialized = true;
      const requested = request.params?.protocolVersion;
      result = { protocolVersion: MCP_LEGACY_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION, capabilities: MCP_CAPABILITIES, serverInfo: MCP_SERVER_INFO, instructions: MCP_INSTRUCTIONS };
    } else if (request.method === 'ping') result = {};
    else if (!modern && !initialized) { await send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Initialize or provide current protocol metadata first' } }); return; }
    else if (request.method === 'tools/list') result = { tools: MCP_TOOLS };
    else if (request.method === 'resources/list') result = { resources: [] };
    else if (request.method === 'prompts/list') result = { prompts: [] };
    else if (request.method === 'tools/call') {
      try {
        const value = await invoke(request.params?.name, request.params?.arguments ?? {}, configPath);
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error.code === 'HOME_NODE_PERMISSIONS' ? error.message : 'Home Node action failed. Check selected inputs, local connectivity and pairing in the app. Use interactive setup for public device URLs; no credentials or endpoint details were returned.' }] };
      }
    } else { await send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return; }
    if (modern) result = { ...result, resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO } };
    await send({ jsonrpc: '2.0', id, result });
  }
  const decoder = new StringDecoder('utf8');
  for await (const chunk of input) {
    pending += decoder.write(chunk);
    assert(Buffer.byteLength(pending) <= MAX_JSON_BYTES, 'MCP message exceeds limit');
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (line) await handle(line);
    }
  }
  pending += decoder.end();
  if (pending.trim()) await handle(pending);
}

export async function setup(configPath, { input = process.stdin, output = process.stdout } = {}) {
  let muted = false;
  const terminalOutput = new Writable({ write(chunk, encoding, done) { if (!muted) output.write(chunk, encoding); done(); } });
  const readline = createInterface({ input, output: terminalOutput, terminal: Boolean(input.isTTY) });
  const ask = async (label, fallback = '', secret = false) => {
    output.write(`${label}${fallback ? ` [${fallback}]` : ''}: `);
    muted = secret;
    try { return (await readline.question('')).trim() || fallback; }
    finally { muted = false; if (secret) output.write('\n'); }
  };
  try {
    let config = await initialConfig(configPath);
    const detection = await detectDevices(config.ollamaUrl);
    output.write(JSON.stringify(detection, null, 2) + '\n');
    config.appOrigin = await ask('App origin', config.appOrigin);
    config.name = await ask('Public node name', config.name);
    config.ollamaUrl = await ask('Ollama origin', config.ollamaUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.ollamaUrl).hostname) && config.ollamaUrl.startsWith('http:')) config.DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN = (await ask('Allow insecure Ollama HTTP on your trusted LAN? yes/no', 'no')) === 'yes';
    const discovered = await detectDevices(config.ollamaUrl);
    const offerGpu = (await ask('Offer GPU/CPU inference? yes/no', config.gpuEnabled || discovered.models.length ? 'yes' : 'no')) === 'yes';
    config.models = offerGpu ? (await ask('Installed models to offer (comma separated)', config.models.join(',') || discovered.models.join(','))).split(',').map((value) => value.trim()).filter(Boolean) : [];
    config.gpuEnabled = offerGpu;
    config = await saveConfig(configPath, config);
    const haUrl = await ask('Optional Home Assistant origin (blank to skip)');
    if (haUrl) {
      const allowPlaintextLan = haUrl.startsWith('http:') && (await ask('Allow insecure HA HTTP on your trusted LAN? yes/no', 'no')) === 'yes';
      let allowPublicOrigin = false;
      try { localDeviceOrigin(haUrl); } catch {
        assert((await ask('Home Assistant uses a public origin. Explicitly trust this origin to receive your token? yes/no', 'no')) === 'yes', 'Public Home Assistant origin was not confirmed locally');
        allowPublicOrigin = true;
      }
      const token = await ask('Home Assistant long-lived token (hidden; saved only locally)', '', true);
      await connectHomeAssistant(configPath, { url: haUrl, token, allowPlaintextLan }, { allowPublicOrigin });
      output.write(JSON.stringify(await callTool('list_home_assistant_sensors', {}, configPath), null, 2) + '\n');
      config = await readConfig(configPath);
      const power = await ask('Power entity id (blank to skip)');
      const energyToday = await ask(`Daily energy entity id, resets at midnight in ${Intl.DateTimeFormat().resolvedOptions().timeZone} (blank to skip)`);
      config.homeAssistant.sensors = { ...(power ? { power } : {}), ...(energyToday ? { energyToday } : {}) };
    }
    const validators = await ask('Optional public validator ids (comma separated)', config.validators.join(','));
    config.validators = validators.split(',').map((id) => id.trim()).filter(Boolean);
    const wake = await ask('Wake mode: none, wol, or ha', config.wakeOnLan ? 'wol' : config.homeAssistant?.wake ? 'ha' : 'none');
    assert(['none', 'wol', 'ha'].includes(wake), 'Invalid wake mode');
    delete config.wakeOnLan;
    if (config.homeAssistant) config.homeAssistant.wake = wake === 'ha';
    if (wake === 'ha') assert(config.homeAssistant, 'Connect Home Assistant first');
    if (wake === 'wol') config.wakeOnLan = { mac: await ask('GPU MAC address'), broadcastAddress: await ask('LAN broadcast IPv4 address'), port: Number(await ask('UDP port', '9')) };
    await saveConfig(configPath, config);
    const status = await nodeStatus(configPath);
    if (!status.paired) {
      const code = await ask('Private pairing code from Money → Devices & income (blank to pair later)', '', true);
      if (code) await pairHomeNode(configPath, code);
    }
    output.write('Simulated solar income also needs an in-app assignment, declared peak kWp and manual operator approval. Above-ceiling readings pause it; this node does not verify your meter.\n');
    output.write('Configuration saved privately. Start: node home-node.mjs run --config ' + configPath + '\n');
  } finally { readline.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  assert(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22 or newer is required');
  let configPath = DEFAULT_CONFIG_PATH;
  const args = [...argv];
  const index = args.indexOf('--config');
  if (index >= 0) {
    assert(text(args[index + 1], 4096), '--config requires a path');
    configPath = resolve(args[index + 1]);
    args.splice(index, 2);
  }
  const command = args.shift() ?? 'run';
  assert(['setup', 'pair', 'run', 'status', 'doctor', 'mcp', 'migrate-permissions'].includes(command) && args.length === (command === 'pair' ? 1 : 0), 'Usage: node home-node.mjs [setup|pair CODE|run|status|doctor|mcp|migrate-permissions] [--config PATH]');
  if (command === 'migrate-permissions') { console.log(JSON.stringify(await migratePermissions(configPath))); return; }
  if (command === 'mcp') {
    try { await readConfig(configPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return serveMcp(process.stdin, process.stdout, { configPath });
  }
  if (command === 'setup') return setup(configPath);
  if (command === 'pair') { console.log(JSON.stringify(await pairHomeNode(configPath, args[0]))); return; }
  if (command === 'status') { console.log(JSON.stringify(await nodeStatus(configPath), null, 2)); return; }
  if (command === 'doctor') {
    const config = await initialConfig(configPath);
    const status = await nodeStatus(configPath);
    const devices = await detectDevices(config.ollamaUrl);
    let homeAssistant = 'not configured';
    if (config.homeAssistant) {
      try { await homeAssistantStates(config); homeAssistant = 'reachable, credentials valid'; }
      catch { homeAssistant = 'unavailable: check local connectivity and owner-only token file'; }
    }
    let identity = 'not paired';
    if (status.paired) {
      try { await checkPrivatePath(config.stateDirectory, true); await readPrivate(join(config.stateDirectory, 'private-key.pem')); identity = 'owner-only identity files readable'; }
      catch { identity = 'check owner-only identity permissions'; }
    }
    console.log(JSON.stringify({ nodeVersion: process.versions.node, status, devices, homeAssistant, identity }, null, 2));
    return;
  }
  const config = await readConfig(configPath);
  const identity = await loadIdentity(config);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Home Node stopped'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await new HomeNode(config, identity, { signal: controller.signal, configPath }).run(); }
  finally { controller.abort(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.code === 'HOME_NODE_PERMISSIONS' ? error.message : 'Home Node stopped. Check configuration, owner-only key/token permissions, invitation expiry and host revocation. No endpoint credentials were logged.'); process.exitCode = 1; });
}
