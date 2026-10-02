import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, createHash, verify } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { HomeNode, callTool, connectHomeAssistant, loadIdentity, localDeviceOrigin, migratePermissions, nodeStatus, parseHomeAssistantSensors, readConfig, saveConfig, selectedReading, serveMcp, signedHeaders, validateConfig } from './home-node.mjs';

const base = { appOrigin: 'http://localhost:4175', ollamaUrl: 'http://127.0.0.1:11434', models: ['fixture:tiny'], name: 'Fixture', stateDirectory: './state' };
const fixtures = [
  { entity_id: 'sensor.solar_power', state: '1.25', attributes: { unit_of_measurement: 'kW', friendly_name: 'Not shared' } },
  { entity_id: 'sensor.solar_today', state: '2500', attributes: { unit_of_measurement: 'Wh' } },
  { entity_id: 'sensor.energy_unavailable', state: 'unavailable', attributes: { unit_of_measurement: 'kWh' } },
  { entity_id: 'sensor.temperature', state: '21', attributes: { unit_of_measurement: '°C' } },
  { entity_id: 'switch.secret', state: 'on', attributes: { token: 'do-not-share' } },
];
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-home-node-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function server(t, handler) {
  const instance = createServer((request, response) => Promise.resolve(handler(request, response)).catch(error => response.destroy(error)));
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); return new Promise(done => instance.close(done)); });
  return `http://localhost:${instance.address().port}`;
}
function json(response, value, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks).toString(); }

// Public, deterministic fixture seed, not an operational key.
export const vectorKey = () => createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + '11'.repeat(32), 'hex'), type: 'pkcs8', format: 'der' });
export const vectorBody = '{"powerW":1250,"energyTodayKwh":2.5,"timestamp":"2026-10-02T12:00:00.000Z"}';
export const vectorPath = '/api/home-node/readings';
export const vectorTimestamp = 1790942400000;
export const vectorNonce = '22'.repeat(16);

test('old connector config and state retain their key and host identity after migration', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(base), { mode: 0o600 });
  const original = await loadIdentity(await readConfig(path));
  original.state.hostId = 'existing-host';
  await original.save();
  const pem = await readFile(join(directory, 'state/private-key.pem'), 'utf8');
  const migrated = await saveConfig(path, { ...await readConfig(path), validators: ['solana:public_fixture'] });
  const next = await loadIdentity(migrated);
  assert.equal(next.publicKey, original.publicKey);
  assert.equal(next.state.hostId, 'existing-host');
  assert.equal(await readFile(join(directory, 'state/private-key.pem'), 'utf8'), pem);
  assert.equal(migrated.gpuEnabled, true);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('signed headers verify exact protocol bytes and reject path/body tampering', () => {
  const key = vectorKey();
  const headers = signedHeaders(key, 'host-vector', vectorPath, vectorBody, vectorTimestamp, vectorNonce);
  const canonical = (path, value) => Buffer.from(`POST\n${path}\n${vectorTimestamp}\n${vectorNonce}\n${createHash('sha256').update(value).digest('hex')}`);
  const signature = Buffer.from(headers['x-host-signature'], 'base64');
  assert(verify(null, canonical(vectorPath, vectorBody), createPublicKey(key), signature));
  assert(!verify(null, canonical('/api/home-node/capabilities', vectorBody), createPublicKey(key), signature));
  assert(!verify(null, canonical(vectorPath, vectorBody + ' '), createPublicKey(key), signature));
});

test('Home Assistant parsing shares only numeric power/energy candidates and normalizes selected units', () => {
  assert.deepEqual(parseHomeAssistantSensors(fixtures), [
    { entityId: 'sensor.solar_power', kind: 'power', unit: 'kW', value: 1.25 },
    { entityId: 'sensor.solar_today', kind: 'energy', unit: 'Wh', value: 2500 },
    { entityId: 'sensor.energy_unavailable', kind: 'energy', unit: 'kWh', value: null },
  ]);
  const time = new Date('2026-10-02T12:00:00.000Z');
  assert.deepEqual(selectedReading(fixtures, { power: 'sensor.solar_power', energyToday: 'sensor.solar_today' }, time, 'UTC'), { powerW: 1250, energyTodayKwh: 2.5, timestamp: time.toISOString(), localDate: '2026-10-02', timezone: 'UTC' });
  assert.equal(selectedReading(fixtures, { energyToday: 'sensor.solar_today' }, time).powerW, null);
  assert.throws(() => selectedReading(fixtures, { energyToday: 'sensor.energy_unavailable' }), /unavailable/);
  assert.throws(() => selectedReading(fixtures, { energyToday: 'sensor.solar_power' }), /unavailable/);
  assert.throws(() => selectedReading([{ entity_id: 'sensor.large', state: '1001', attributes: { unit_of_measurement: 'MWh' } }], { energyToday: 'sensor.large' }), /bounds/);
});

test('MCP JSON-RPC round trip negotiates protocol, handles notifications and redacts tool failures', async t => {
  const directory = await temporary(t);
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = '';
  output.on('data', chunk => { raw += chunk; });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'home_node_status', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'resources/list' },
    { jsonrpc: '2.0', id: 6, method: 'prompts/list' },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'connect_home_assistant', arguments: { token: 'NEVER-ECHO-THIS' } } },
    { jsonrpc: '2.0', id: 8, method: 'unknown' },
  ];
  const serving = serveMcp(input, output, { configPath: join(directory, 'config.json') });
  input.end(requests.map(request => JSON.stringify(request)).join('\n') + '\n');
  await serving;
  const replies = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(replies[0].result.protocolVersion, '2025-11-25');
  assert.equal(replies[3].result.structuredContent.configured, false);
  assert.deepEqual(replies[4].result.resources, []);
  assert.deepEqual(replies[5].result.prompts, []);
  assert.equal(replies[6].result.isError, true);
  assert.equal(replies[7].error.code, -32601);
  assert(!raw.includes('NEVER-ECHO-THIS'));
});

test('HA token stays 0600 locally, never enters outputs, readings or capabilities; running service reloads config', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'config.json');
  const token = 'fixture-long-lived-secret';
  let authorized = false;
  const haOrigin = await server(t, (request, response) => {
    authorized = request.headers.authorization === `Bearer ${token}`;
    json(response, fixtures);
  });
  const posts = [];
  let publicKey;
  const appOrigin = await server(t, async (request, response) => {
    const raw = await body(request);
    const canonical = `POST\n${request.url}\n${request.headers['x-host-timestamp']}\n${request.headers['x-host-nonce']}\n${createHash('sha256').update(raw).digest('hex')}`;
    assert(verify(null, Buffer.from(canonical), publicKey, Buffer.from(request.headers['x-host-signature'], 'base64')));
    posts.push({ path: request.url, body: JSON.parse(raw) });
    json(response, { ok: true });
  });
  await saveConfig(path, { ...base, appOrigin, gpuEnabled: false, models: [] });
  const config = await readConfig(path);
  const identity = await loadIdentity(config);
  identity.state.hostId = 'fixture-home';
  await identity.save();
  publicKey = createPublicKey(identity.privateKey);
  const node = new HomeNode(config, identity, { configPath: path, log: () => {} });
  const connected = await callTool('connect_home_assistant', { url: haOrigin, token, allowPlaintextLan: true, powerSensor: 'sensor.solar_power', energyTodaySensor: 'sensor.solar_today' }, path);
  await callTool('add_validator', { id: 'solana:public_fixture' }, path);
  await node.heartbeat();
  assert(authorized);
  assert.deepEqual(posts.find(post => post.path.endsWith('/capabilities')).body, { gpuModels: [], solarSensors: ['sensor.solar_power', 'sensor.solar_today'], validatorIds: ['solana:public_fixture'] });
  const reading = posts.find(post => post.path.endsWith('/readings')).body;
  assert.equal(reading.powerW, 1250);
  assert.equal(reading.energyTodayKwh, 2.5);
  assert.equal((await stat(join(directory, 'state', 'home-assistant-token'))).mode & 0o777, 0o600);
  const visible = JSON.stringify([connected, await nodeStatus(path), await callTool('list_home_assistant_sensors', {}, path), posts]);
  assert(!visible.includes(token));
  assert(!visible.includes('Not shared'));
  assert(!visible.includes('do-not-share'));
  assert(!JSON.stringify(await readConfig(path)).includes(token));
  assert.throws(() => validateConfig({ ...base, validators: ['a secret phrase'] }));
});

test('current MCP requests work without initialization, reject unsupported versions, and preserve fragmented UTF-8 configuration', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'config.json');
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = '';
  output.on('data', chunk => { raw += chunk; });
  const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: metadata } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: metadata, name: 'configure_gpu', arguments: { enabled: false, models: [], name: 'Résumé GPU' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { ...metadata, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
  ];
  const serving = serveMcp(input, output, { configPath: path });
  const bytes = Buffer.from(requests.map(request => JSON.stringify(request)).join('\n') + '\n');
  for (const byte of bytes) {
    input.write(Buffer.from([byte]));
    await new Promise(done => setImmediate(done));
  }
  input.end();
  await serving;
  const replies = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].result.supportedVersions[0], '2026-07-28');
  assert.equal(replies[0].result.resultType, 'complete');
  assert.equal(replies[1].result.resultType, 'complete');
  assert.equal(replies[1].result.isError, undefined);
  assert.equal((await readConfig(path)).name, 'Résumé GPU');
  assert.equal(replies[2].error.code, -32022);
  assert.deepEqual(replies[2].error.data.supported, ['2026-07-28']);
  assert.equal(replies[3].error.code, -32602);
});

test('daily readings follow sensor-local midnight rather than UTC, including DST boundaries', () => {
  const sensors = { energyToday: 'sensor.solar_today' };
  assert.equal(selectedReading(fixtures, sensors, new Date('2026-10-02T21:59:59Z'), 'Europe/Berlin').localDate, '2026-10-02');
  const midnight = selectedReading(fixtures, sensors, new Date('2026-10-02T22:00:00Z'), 'Europe/Berlin');
  assert.equal(midnight.localDate, '2026-10-03');
  assert.equal(midnight.timestamp, '2026-10-02T22:00:00.000Z');
  assert.equal(midnight.timezone, 'Europe/Berlin');
  assert.equal(selectedReading(fixtures, sensors, new Date('2026-10-25T22:59:59Z'), 'Europe/Berlin').localDate, '2026-10-25');
  assert.equal(selectedReading(fixtures, sensors, new Date('2026-10-25T23:00:00Z'), 'Europe/Berlin').localDate, '2026-10-26');
  assert.equal(selectedReading(fixtures, sensors, new Date('2026-10-03T01:00:00Z'), 'America/Los_Angeles').localDate, '2026-10-02');
  assert.throws(() => selectedReading(fixtures, sensors, new Date(), 'invalid/timezone'), RangeError);
});

async function cli(command, path) {
  const child = spawn(process.execPath, [new URL('./home-node.mjs', import.meta.url).pathname, command, '--config', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

test('MCP refuses caller-selected secret paths and public device URLs before contacting anything', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'config.json');
  const unrelated = join(directory, 'unrelated-secret');
  await writeFile(unrelated, 'unrelated-owner-only-token', { mode: 0o600 });
  let contacts = 0;
  const target = await server(t, (request, response) => { contacts++; json(response, fixtures); });
  await assert.rejects(callTool('connect_home_assistant', { url: target, tokenFile: unrelated, allowPlaintextLan: true }, path), /Invalid tool arguments/);
  await assert.rejects(callTool('connect_home_assistant', { url: 'https://attacker.example', token: 'supplied-secret' }, path), /MCP device URLs/);
  await assert.rejects(callTool('detect_devices', { ollamaUrl: 'https://attacker.example' }, path), /MCP device URLs/);
  await assert.rejects(callTool('configure_gpu', { models: [], enabled: false, ollamaUrl: 'https://attacker.example' }, path), /MCP device URLs/);
  await assert.rejects(callTool('pair_home_node', { code: 'ABCDEFGH2345', appOrigin: 'https://attacker.example' }, path), /interactive local setup/);
  assert.equal(contacts, 0);
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated-owner-only-token');
  for (const allowed of ['http://localhost:8123', 'https://127.0.0.2', 'https://10.0.0.1', 'https://172.16.0.1', 'https://172.31.255.255', 'https://192.168.1.2', 'https://169.254.1.2', 'https://[::1]', 'https://[fe80::1]', 'https://ha.local', 'https://ha.home.arpa']) assert.equal(localDeviceOrigin(allowed), new URL(allowed).origin);
  for (const denied of ['https://172.15.1.1', 'https://172.32.1.1', 'https://192.169.1.1', 'https://169.255.1.1', 'https://[2001:db8::1]', 'https://ha.local.attacker.example', 'https://user:password@ha.local', 'https://ha.local/api']) assert.throws(() => localDeviceOrigin(denied));
});

test('HA credentials use a fixed contained file and never follow an old origin after reconfiguration', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'config.json');
  const receivedA = [];
  const receivedB = [];
  const originA = await server(t, (request, response) => { receivedA.push(request.headers.authorization); json(response, fixtures); });
  const originB = await server(t, (request, response) => { receivedB.push(request.headers.authorization); json(response, fixtures); });
  await saveConfig(path, { ...base, gpuEnabled: false, models: [] });
  await callTool('connect_home_assistant', { url: originA, token: 'token-A', allowPlaintextLan: true, energyTodaySensor: 'sensor.solar_today' }, path);
  const oldConfig = await readConfig(path);
  const identity = await loadIdentity(oldConfig);
  identity.state.hostId = 'fixture-bound-origin';
  await identity.save();
  const oldService = new HomeNode(oldConfig, identity, { log: () => {} });
  await callTool('connect_home_assistant', { url: originB, token: 'token-B', allowPlaintextLan: true, energyTodaySensor: 'sensor.solar_today' }, path);
  await assert.rejects(oldService.pushReadings(), /different configured origin/);
  assert.deepEqual(receivedA, ['Bearer token-A']);
  assert.deepEqual(receivedB, ['Bearer token-B']);
  const current = await readConfig(path);
  assert.equal(current.homeAssistant.tokenFile, join(directory, 'state', 'home-assistant-token'));
  assert.equal((await stat(current.homeAssistant.tokenFile)).mode & 0o777, 0o600);
  const forged = { ...current, homeAssistant: { ...current.homeAssistant, tokenFile: join(directory, 'unrelated-secret') } };
  await assert.rejects(saveConfig(path, forged), /contained within/);
});

test('permission migration safely upgrades legacy config/key/token paths without replacing the identity', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'config.json');
  await saveConfig(path, base);
  const config = await readConfig(path);
  const identity = await loadIdentity(config);
  identity.state.hostId = 'legacy-permission-host';
  await identity.save();
  const keyPath = join(config.stateDirectory, 'private-key.pem');
  const statePath = join(config.stateDirectory, 'host-state.json');
  const pem = await readFile(keyPath, 'utf8');
  const legacyToken = join(directory, 'legacy-ha-token');
  await writeFile(legacyToken, 'legacy-token-value', { mode: 0o644 });
  await writeFile(path, JSON.stringify({ ...base, homeAssistant: { url: 'https://ha.local', tokenFile: legacyToken } }));
  for (const file of [path, keyPath, statePath, legacyToken]) await chmod(file, 0o644);
  await chmod(config.stateDirectory, 0o755);
  await chmod(directory, 0o755);
  for (const command of ['run', 'status', 'mcp']) {
    const result = await cli(command, path);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /migrate-permissions --config/);
    assert(!result.stderr.includes('legacy-token-value'));
  }
  const migration = await cli('migrate-permissions', path);
  assert.equal(migration.code, 0);
  assert.equal(JSON.parse(migration.stdout).migrated, true);
  const migrated = await readConfig(path);
  assert.equal(await readFile(keyPath, 'utf8'), pem);
  assert.equal((await loadIdentity(migrated)).state.hostId, 'legacy-permission-host');
  assert.equal(migrated.homeAssistant.tokenFile, join(config.stateDirectory, 'home-assistant-token'));
  for (const file of [path, keyPath, statePath, legacyToken, migrated.homeAssistant.tokenFile]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  for (const dir of [directory, config.stateDirectory]) assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(migrated.homeAssistant.tokenFile, 'utf8')), { origin: 'https://ha.local', token: 'legacy-token-value' });
  await migratePermissions(path);
  assert.equal(JSON.parse(await readFile(migrated.homeAssistant.tokenFile, 'utf8')).token, 'legacy-token-value');
  const status = await cli('status', path);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).hostId, 'legacy-permission-host');
  assert(!status.stdout.includes('legacy-token-value'));
});

test('runtime refuses permissive and symlink configs, keys, tokens and their private directories', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'config.json');
  await saveConfig(path, base);
  const config = await readConfig(path);
  await loadIdentity(config);
  await chmod(path, 0o644);
  await assert.rejects(readConfig(path), /owner-only.*0600.*migrate-permissions/);
  await chmod(path, 0o600);
  await chmod(directory, 0o755);
  await assert.rejects(nodeStatus(path), /owner-only directory/);
  await chmod(directory, 0o700);
  const savedConfig = join(directory, 'saved-config.json');
  await rename(path, savedConfig);
  await symlink(savedConfig, path);
  await assert.rejects(readConfig(path), /owner-only file/);
  await assert.rejects(migratePermissions(path), /refuses symlinks/);
  await rm(path);
  await rename(savedConfig, path);
  const key = join(config.stateDirectory, 'private-key.pem');
  await chmod(key, 0o644);
  await assert.rejects(nodeStatus(path), /owner-only file/);
  await chmod(key, 0o600);
  const backupKey = join(config.stateDirectory, 'saved-key.pem');
  await rename(key, backupKey);
  await symlink(backupKey, key);
  await assert.rejects(readConfig(path), /owner-only file/);
  await assert.rejects(migratePermissions(path), /refuses symlinks/);
  await rm(key);
  await rename(backupKey, key);
  const ha = await server(t, (request, response) => json(response, fixtures));
  await connectHomeAssistant(path, { url: ha, token: 'fixture-token', allowPlaintextLan: true });
  const token = (await readConfig(path)).homeAssistant.tokenFile;
  await chmod(token, 0o644);
  await assert.rejects(nodeStatus(path), /owner-only file/);
  await chmod(token, 0o600);
  const backupToken = join(config.stateDirectory, 'saved-token');
  await rename(token, backupToken);
  await symlink(backupToken, token);
  await assert.rejects(readConfig(path), /owner-only file/);
  await rm(token);
  await rename(backupToken, token);
  await chmod(config.stateDirectory, 0o755);
  await assert.rejects(readConfig(path), /owner-only directory/);
});

test('migration refuses foreign-owned paths before modifying or reading them', { skip: !process.getuid || process.getuid() === 0 }, async () => {
  await assert.rejects(migratePermissions(await realpath('/etc/hosts')), /foreign-owned/);
});

test('a wake racing HA reconfiguration cannot send a cached token to the new origin', { timeout: 8000 }, async t => {
  const directory = await temporary(t);
  const path = join(directory, 'config.json');
  let awake = false;
  let wakeAuthorization = null;
  const originA = await server(t, (request, response) => json(response, fixtures));
  const originB = await server(t, (request, response) => {
    if (request.url.startsWith('/api/services/')) {
      wakeAuthorization = request.headers.authorization;
      awake = true;
      json(response, []);
    } else json(response, fixtures);
  });
  const model = base.models[0];
  const ollamaUrl = await server(t, (request, response) => {
    if (!awake) return json(response, {}, 503);
    if (request.url === '/api/tags') return json(response, { models: [{ name: model }] });
    if (request.url === '/api/generate') return json(response, { model, done: true, done_reason: 'load', response: '' });
    json(response, { model, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'Completed after reconfiguration.' } });
  });
  let savedResult;
  const appOrigin = await server(t, async (request, response) => {
    if (request.url.endsWith('/result')) savedResult = JSON.parse(await body(request));
    json(response, {});
  });
  await saveConfig(path, { ...base, appOrigin, ollamaUrl });
  await callTool('connect_home_assistant', { url: originA, token: 'origin-A-token', allowPlaintextLan: true, wake: true }, path);
  const originalConfig = await readConfig(path);
  const identity = await loadIdentity(originalConfig);
  identity.state.hostId = 'race-host';
  await identity.save();
  let pause = false;
  let resume;
  let entered;
  const initializationGate = new Promise(done => { resume = done; });
  const initializing = new Promise(done => { entered = done; });
  class PausedReloadNode extends HomeNode {
    async initialize() {
      if (pause) { entered(); await initializationGate; }
      return super.initialize();
    }
  }
  const node = new PausedReloadNode(originalConfig, identity, { configPath: path, log: () => {} });
  await node.initialize();
  await callTool('connect_home_assistant', { url: originB, token: 'origin-B-token', allowPlaintextLan: true, wake: true }, path);
  pause = true;
  const reloading = node.reload();
  await initializing;
  try {
    await node.execute({ id: 'race-job', model, messages: [{ role: 'user', content: 'A bounded fixture question' }], options: { num_ctx: 512, num_predict: 16, temperature: 0 }, expiresAt: new Date(Date.now() + 6000).toISOString() });
    assert.equal(wakeAuthorization, 'Bearer origin-B-token');
    assert.equal(savedResult.response.message.content, 'Completed after reconfiguration.');
  } finally { resume(); await reloading; }
});
