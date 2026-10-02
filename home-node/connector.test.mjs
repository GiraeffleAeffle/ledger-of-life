import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Connector, checkPrivatePath, endpointOrigin, jobDeadline, loadIdentity, validateConfig, validateJob, validateAnswer } from './home-node.mjs';

const model = 'fixture:tiny';
const configInput = { appOrigin: 'http://localhost:3000', ollamaUrl: 'http://localhost:11434', name: 'Fixture GPU', models: [model], stateDirectory: './state' };
const job = (extra = {}) => ({ id: 'job-fixture', model, messages: [{ role: 'user', content: 'A fixture question' }], options: { num_ctx: 8192, num_predict: 96, temperature: 0.2 }, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...extra });
const answer = (extra = {}) => ({ model, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'A complete fixture answer.' }, prompt_eval_count: 4, eval_count: 5, ...extra });
const preload = (extra = {}) => ({ model, done: true, done_reason: 'load', response: '', ...extra });
const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'home-node-connector-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function server(t, handler) {
  const instance = createServer((request, response) => Promise.resolve(handler(request, response)).catch((error) => { response.destroy(error); }));
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); return new Promise((done) => instance.close(done)); });
  return `http://localhost:${instance.address().port}`;
}
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); }
async function runtime(t, options = {}) {
  const directory = await temporary(t);
  const results = [];
  const heartbeats = [];
  const appOrigin = await server(t, async (request, response) => {
    const input = JSON.parse(await body(request));
    if (request.url.endsWith('/result')) results.push(input);
    if (request.url.endsWith('/heartbeat')) heartbeats.push(input);
    json(response, {});
  });
  const ollamaUrl = await server(t, options.ollama ?? ((request, response) => request.url === '/api/tags' ? json(response, { models: [{ name: model }, { name: 'unconfigured:huge' }] }) : json(response, request.url === '/api/generate' ? preload() : answer())));
  const config = validateConfig({ ...configInput, appOrigin, ollamaUrl, stateDirectory: options.config?.homeAssistant ? dirname(options.config.homeAssistant.tokenFile) : directory, ...options.config });
  if (config.homeAssistant) await checkPrivatePath(config.homeAssistant.tokenFile);
  const identity = await loadIdentity(config);
  identity.state.hostId = 'host-fixture';
  identity.state.advertisedModels = [model];
  await identity.save();
  const connector = new Connector(config, identity, { log: () => {}, signal: options.signal });
  if (config.homeAssistant) await connector.initialize();
  return { connector, results, heartbeats, identity, directory };
}

test('app origin cannot downgrade, redirect credentials through URL syntax, or embed endpoints', () => {
  assert.equal(endpointOrigin('https://app.example/', true), 'https://app.example');
  assert.equal(endpointOrigin('http://localhost:3000', true), 'http://localhost:3000');
  for (const url of ['http://app.example', 'http://127.0.0.1', 'http://localhost.example', 'https://user:secret@app.example', 'https://app.example/api', 'https://app.example/?x=1', 'https://app.example/#fragment', 'file:///etc/passwd']) assert.throws(() => endpointOrigin(url, true));
  assert.throws(() => validateConfig({ ...configInput, tools: ['shell'] }));
  assert.throws(() => validateConfig({ ...configInput, models: Array(17).fill(model) }));
  assert.throws(() => validateConfig({ ...configInput, homeAssistant: { url: 'http://localhost', token: 'must-not-be-inline' } }));
});

test('plain HTTP to an Ollama beyond this device needs the explicit trusted-LAN opt-in', () => {
  const lan = { ...configInput, ollamaUrl: 'http://192.168.178.72:11434' };
  assert.throws(() => validateConfig(lan), /DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN/);
  assert.throws(() => validateConfig({ ...lan, DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN: 'yes' }));
  assert.equal(validateConfig({ ...lan, DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN: true }).ollamaUrl, 'http://192.168.178.72:11434');
  assert.equal(validateConfig({ ...configInput, ollamaUrl: 'https://gpu.lan.example' }).ollamaUrl, 'https://gpu.lan.example');
  assert.equal(validateConfig({ ...configInput, ollamaUrl: 'http://127.0.0.1:11434' }).ollamaUrl, 'http://127.0.0.1:11434');
});

test('job validation rejects extra capabilities, unsafe options, oversized text and elapsed deadlines', () => {
  const valid = validateJob(job(), [model]);
  assert.equal(valid.stream, false);
  assert.equal(valid.think, false);
  for (const invalid of [
    job({ tools: [{ type: 'function' }] }), job({ stream: true }), job({ think: true }), job({ model: 'unconfigured:huge' }),
    job({ messages: [{ role: 'user', content: 'hi', images: ['base64'] }] }),
    job({ messages: [{ role: 'tool', content: 'hi' }] }), job({ messages: [{ role: 'user', content: 'x'.repeat(4001) }] }),
    job({ messages: Array.from({ length: 4 }, () => ({ role: 'user', content: 'x'.repeat(4000) })) }),
    job({ messages: Array.from({ length: 9 }, () => ({ role: 'user', content: 'hi' })) }),
    job({ options: { num_ctx: 8193, num_predict: 96, temperature: 0 } }),
    job({ options: { num_ctx: 8192, num_predict: 193, temperature: 0 } }),
    job({ options: { num_ctx: 8192, num_predict: 15, temperature: 0 } }),
    job({ options: { num_ctx: 8192, num_predict: 96, temperature: 1.1 } }),
    job({ options: { num_ctx: 8192, num_predict: 96, temperature: 0, seed: 1 } }),
    job({ expiresAt: new Date(Date.now() - 1).toISOString() }), job({ expiresAt: 'not-a-date' }), job({ expiresAt: undefined }),
  ]) assert.throws(() => validateJob(invalid, [model]));
});

test('future server deadlines tolerate clock skew but never extend the local four-minute bound', async (t) => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const skewed = job({ expiresAt: new Date(now + 245_000).toISOString() });
  validateJob(skewed, [model], now);
  assert.equal(jobDeadline(skewed, now), now + 240_000);
  assert.equal(jobDeadline(job({ expiresAt: new Date(now + 20_000).toISOString() }), now), now + 20_000);
  assert.equal(jobDeadline(job({ expiresAt: new Date(now + 86_400_000).toISOString() }), now), now + 240_000);
  const { connector, results } = await runtime(t);
  await connector.execute(job({ expiresAt: new Date(Date.now() + 245_000).toISOString() }));
  assert.equal(results[0].response.message.content, 'A complete fixture answer.');
});

test('wake configuration rejects ambiguous modes, malformed UDP targets and implicit plaintext HA', () => {
  const wakeOnLan = { mac: '34:5A:60:69:E2:73', broadcastAddress: '192.168.178.255' };
  assert.equal(validateConfig({ ...configInput, wakeOnLan }).wakeOnLan.port, 9);
  for (const invalid of [
    { mac: '34:5A:60:69:E2', broadcastAddress: '192.168.178.255' },
    { mac: 'ff:ff:ff:ff:ff:ff', broadcastAddress: '192.168.178.255' },
    { mac: '00:00:00:00:00:00', broadcastAddress: '192.168.178.255' },
    { ...wakeOnLan, broadcastAddress: 'gpu.example' }, { ...wakeOnLan, broadcastAddress: '::1' },
    { ...wakeOnLan, broadcastAddress: '0.0.0.0' }, { ...wakeOnLan, broadcastAddress: '224.0.0.1' },
    { ...wakeOnLan, port: 0 }, { ...wakeOnLan, port: 65536 }, { ...wakeOnLan, port: 9.5 },
    { ...wakeOnLan, token: 'not-a-capability' },
  ]) assert.throws(() => validateConfig({ ...configInput, wakeOnLan: invalid }));
  const homeAssistant = { url: 'http://localhost:8123', tokenFile: './token' };
  assert.throws(() => validateConfig({ ...configInput, homeAssistant }), /HTTPS/);
  assert.throws(() => validateConfig({ ...configInput, homeAssistant: { ...homeAssistant, DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN: false } }), /HTTPS/);
  assert.throws(() => validateConfig({ ...configInput, homeAssistant: { ...homeAssistant, DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN: 'true' } }), /boolean/);
  assert.equal(validateConfig({ ...configInput, homeAssistant: { url: 'https://ha.example', tokenFile: './token' } }).homeAssistant.url, 'https://ha.example');
  validateConfig({ ...configInput, homeAssistant: { ...homeAssistant, DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN: true } });
  assert.throws(() => validateConfig({ ...configInput, wakeOnLan, homeAssistant }), /one wake mode/);
  for (const pairingCode of ['ABCDEFGH', 'ABCDEFGHIJKL', 'abcdefgh2345', 'ABCDEFGH234!']) assert.throws(() => validateConfig({ ...configInput, pairingCode }));
});

test('tokenless WoL sends exactly one magic packet to a synthetic loopback UDP receiver and resumes inference', { timeout: 5000 }, async (t) => {
  const receiver = createSocket('udp4');
  receiver.bind(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => new Promise((done) => receiver.close(done)));
  const packet = once(receiver, 'message');
  let awake = false;
  receiver.on('message', () => { awake = true; });
  const { connector, results, heartbeats } = await runtime(t, {
    config: { wakeOnLan: { mac: '34:5A:60:69:E2:73', broadcastAddress: '127.0.0.1', port: receiver.address().port } },
    ollama: (request, response) => !awake ? json(response, {}, 503) : request.url === '/api/tags' ? json(response, { models: [{ name: model }] }) : json(response, request.url === '/api/generate' ? preload() : answer()),
  });
  await connector.heartbeat();
  assert.equal(heartbeats[0].canWake, true);
  assert.equal(heartbeats[0].ollamaReachable, false);
  await connector.execute(job());
  const [received] = await packet;
  assert.deepEqual(received, Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => Buffer.from('345a6069e273', 'hex'))]));
  assert.equal(results[0].response.message.content, 'A complete fixture answer.');
});

test('the first sleeping-host answer survives delayed reachability and a cold load beyond the old budget', { timeout: 5000 }, async (t) => {
  const receiver = createSocket('udp4');
  receiver.bind(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => new Promise((done) => receiver.close(done)));
  let awake = false;
  let offset = 0;
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + offset);
  receiver.on('message', () => { awake = true; });
  let cold = true;
  let loading;
  const loadStarted = new Promise((resolve) => { loading = resolve; });
  let finishLoad;
  const loaded = new Promise((resolve) => { finishLoad = resolve; });
  let chatRequested = false;
  const { connector, results, heartbeats } = await runtime(t, {
    config: { wakeOnLan: { mac: '34:5A:60:69:E2:73', broadcastAddress: '127.0.0.1', port: receiver.address().port } },
    ollama: async (request, response) => {
      if (!awake) return json(response, {}, 503);
      if (request.url === '/api/tags') {
        if (cold) { offset += 70_000; cold = false; }
        return json(response, { models: [{ name: model }] });
      }
      if (request.url === '/api/generate') {
        loading();
        await loaded;
        offset += 80_000;
        return json(response, preload());
      }
      chatRequested = true;
      json(response, answer());
    },
  });
  const execution = connector.execute(job({ expiresAt: new Date(Date.now() + 240_000).toISOString() }));
  await loadStarted;
  await connector.heartbeat();
  assert.equal(heartbeats[0].ollamaReachable, true);
  assert.equal(chatRequested, false, 'the question must wait for cold loading');
  finishLoad();
  await execution;
  assert.equal(results[0].response.message.content, 'A complete fixture answer.');
});

test('failed or incomplete preloads never send the question to chat', async (t) => {
  let load = preload();
  let chats = 0;
  const { connector, results } = await runtime(t, { ollama: (request, response) => {
    if (request.url === '/api/tags') return json(response, { models: [{ name: model }] });
    if (request.url === '/api/generate') return json(response, load);
    chats++;
    json(response, answer());
  } });
  for (const invalid of [null, preload({ model: 'wrong' }), preload({ done: false }), preload({ done_reason: 'length' }), preload({ error: 'load failed' }), preload({ response: 'unexpected generation' }), preload({ response: undefined })]) {
    load = invalid;
    await connector.execute(job());
    assert.deepEqual(results.at(-1), { jobId: 'job-fixture', error: 'Connector could not produce a complete bounded answer' });
  }
  assert.equal(chats, 0);
  for (const reason of ['stop', undefined]) {
    load = preload({ done_reason: reason });
    await connector.execute(job());
    assert.equal(results.at(-1).response.message.content, 'A complete fixture answer.');
  }
});

test('a stalled preload exhausts remaining time without sending the question', async (t) => {
  let chats = 0;
  const { connector, results } = await runtime(t, { ollama: (request, response) => {
    if (request.url === '/api/tags') return json(response, { models: [{ name: model }] });
    if (request.url === '/api/generate') return;
    chats++;
    json(response, answer());
  } });
  await connector.execute(job({ expiresAt: new Date(Date.now() + 150).toISOString() }));
  assert.equal(chats, 0);
  assert.deepEqual(results[0], { jobId: 'job-fixture', error: 'Connector could not produce a complete bounded answer' });
});

test('chat has its own 90-second ceiling even when the total job has time left', async (t) => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms) => timeout(ms === 90_000 ? 100 : ms));
  let chatStarted = false;
  const { connector, results } = await runtime(t, { ollama: (request, response) => {
    if (request.url === '/api/tags') return json(response, { models: [{ name: model }] });
    if (request.url === '/api/generate') return json(response, preload());
    chatStarted = true;
  } });
  const expiresAt = new Date(Date.now() + 240_000).toISOString();
  await connector.execute(job({ expiresAt }));
  assert.equal(chatStarted, true);
  assert(Date.now() < Date.parse(expiresAt));
  assert.deepEqual(results[0], { jobId: 'job-fixture', error: 'Connector could not produce a complete bounded answer' });
});

test('only a complete matching-model assistant answer can settle a job', () => {
  assert.equal(validateAnswer(answer(), model).message.content, 'A complete fixture answer.');
  for (const invalid of [answer({ done: false }), answer({ done_reason: 'length' }), answer({ error: 'runner failure' }), answer({ model: 'wrong' }), answer({ message: { role: 'assistant', content: '  ' } }), answer({ message: { role: 'assistant', content: 'x'.repeat(16001) } }), answer({ message: { role: 'user', content: 'hi' } }), answer({ message: { role: 'assistant', content: 'hi', tool_calls: [{}] } })]) assert.throws(() => validateAnswer(invalid, model));
});

test('identity is persistent Ed25519 with owner-only files; permissive/symlink keys and foreign app state fail closed', async (t) => {
  const directory = await temporary(t);
  const config = validateConfig({ ...configInput, stateDirectory: directory });
  const first = await loadIdentity(config);
  assert.equal(createPublicKey({ key: Buffer.from(first.publicKey, 'base64'), type: 'spki', format: 'der' }).asymmetricKeyType, 'ed25519');
  assert.match(await readFile(join(directory, 'private-key.pem'), 'utf8'), /^-----BEGIN PRIVATE KEY-----/);
  for (const file of ['private-key.pem', 'host-state.json']) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
  assert.equal((await loadIdentity(config)).publicKey, first.publicKey);
  await assert.rejects(loadIdentity({ ...config, appOrigin: 'https://different.example' }), /does not match/);
  await chmod(join(directory, 'private-key.pem'), 0o644);
  await assert.rejects(loadIdentity(config), /owner-only/);
  await chmod(join(directory, 'private-key.pem'), 0o600);
  await chmod(join(directory, 'host-state.json'), 0o640);
  await assert.rejects(loadIdentity(config), /owner-only/);
  const otherDirectory = join(directory, 'symlink-state');
  const other = await loadIdentity({ ...config, stateDirectory: otherDirectory });
  await rm(join(otherDirectory, 'private-key.pem'));
  await symlink(join(directory, 'private-key.pem'), join(otherDirectory, 'private-key.pem'));
  await assert.rejects(loadIdentity({ ...config, stateDirectory: otherDirectory }), error => error.code === 'HOME_NODE_PERMISSIONS');
  assert.equal(other.privateKey.asymmetricKeyType, 'ed25519');
});

test('advertised models are the configured discovered subset and survive an asleep heartbeat', async (t) => {
  let asleep = false;
  const { connector, heartbeats, directory, identity } = await runtime(t, { ollama: (request, response) => asleep ? json(response, { error: 'asleep' }, 503) : json(response, { models: [{ name: model }, { name: 'unconfigured:huge' }] }) });
  await connector.heartbeat();
  asleep = true;
  await connector.heartbeat();
  assert.deepEqual(heartbeats, [
    { models: [model], ollamaReachable: true, awake: true, canWake: false },
    { models: [model], ollamaReachable: false, awake: false, canWake: false },
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'host-state.json'), 'utf8')).advertisedModels, [model]);
  const restarted = new Connector(connector.config, await loadIdentity(connector.config));
  assert.deepEqual(restarted.models, identity.state.advertisedModels);
});

test('unsafe jobs never reach Ollama; truncated generation reports failure instead of an answer', async (t) => {
  const chats = [];
  const { connector, results } = await runtime(t, { ollama: async (request, response) => {
    if (request.url === '/api/tags') return json(response, { models: [{ name: model }] });
    if (request.url === '/api/generate') return json(response, preload());
    chats.push(JSON.parse(await body(request)));
    json(response, answer({ done_reason: 'length' }));
  } });
  await connector.execute(job({ tools: [{}] }));
  assert.equal(chats.length, 0);
  assert.deepEqual(results[0], { jobId: 'job-fixture', error: 'Connector could not produce a complete bounded answer' });
  await connector.execute(job());
  assert.deepEqual(chats[0], { model, messages: [{ role: 'user', content: 'A fixture question' }], options: { num_ctx: 8192, num_predict: 96, temperature: 0.2 }, stream: false, think: false });
  assert.deepEqual(results[1], results[0]);
});

test('a first-boot asleep host offers configured wake models, then narrows to installed models', async (t) => {
  const directory = await temporary(t);
  const tokenFile = join(directory, 'ha-token');
  await writeFile(tokenFile, 'fixture-private-token', { mode: 0o600 });
  const heartbeats = [];
  let asleep = true;
  const appOrigin = await server(t, async (request, response) => { heartbeats.push(JSON.parse(await body(request))); json(response, {}); });
  const ollamaUrl = await server(t, (request, response) => asleep ? json(response, {}, 503) : json(response, { models: [{ name: model }] }));
  const config = validateConfig({ ...configInput, appOrigin, ollamaUrl, models: [model, 'not-installed:tiny'], stateDirectory: directory, homeAssistant: { url: 'http://localhost:8123', tokenFile, DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN: true } });
  const identity = await loadIdentity(config);
  identity.state.hostId = 'host-new';
  await identity.save();
  const connector = new Connector(config, identity, { log: () => {} });
  await connector.initialize();
  await connector.heartbeat();
  assert.deepEqual(heartbeats[0], { models: [model, 'not-installed:tiny'], ollamaReachable: false, awake: false, canWake: true });
  asleep = false;
  await connector.heartbeat();
  assert.deepEqual(heartbeats[1].models, [model]);
  asleep = true;
  await connector.heartbeat();
  assert.deepEqual(heartbeats[2], { models: [model], ollamaReachable: false, awake: false, canWake: true });
});

test('redirects never receive an app signature, HA token, or forwarded inference', async (t) => {
  const received = [];
  const target = await server(t, async (request, response) => { received.push({ headers: request.headers, body: await body(request) }); json(response, answer()); });
  const { connector, results } = await runtime(t, { ollama: (request, response) => {
    if (request.url === '/api/tags') return json(response, { models: [{ name: model }] });
    response.writeHead(307, { location: target }); response.end();
  } });
  await connector.execute(job());
  assert.deepEqual(results[0], { jobId: 'job-fixture', error: 'Connector could not produce a complete bounded answer' });
  const appRedirect = await server(t, (request, response) => { response.writeHead(307, { location: target }); response.end(); });
  connector.config.appOrigin = appRedirect;
  await assert.rejects(connector.app('poll', {}));
  const tokenFile = join(await temporary(t), 'ha-token');
  await writeFile(tokenFile, 'fixture-ha-secret', { mode: 0o600 });
  const ha = await server(t, (request, response) => { response.writeHead(307, { location: target }); response.end(); });
  const asleep = await runtime(t, { config: { homeAssistant: { url: ha, tokenFile, DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN: true } }, ollama: (request, response) => json(response, {}, 503) });
  await asleep.connector.execute(job());
  assert.deepEqual(received, []);
});

test('HA reads only an owner-private token file and invokes only the verified wake script', async (t) => {
  const tokenFile = join(await temporary(t), 'token');
  await writeFile(tokenFile, 'fixture-ha-secret\n', { mode: 0o644 });
  await chmod(tokenFile, 0o644);
  const requests = [];
  let awake = false;
  const ha = await server(t, async (request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization, body: await body(request) });
    awake = true;
    json(response, []);
  });
  await assert.rejects(runtime(t, { config: { homeAssistant: { url: ha, tokenFile, DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN: true } } }), /owner-only/);
  await chmod(tokenFile, 0o600);
  const { connector, results, heartbeats } = await runtime(t, { config: { homeAssistant: { url: ha, tokenFile, DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN: true } }, ollama: (request, response) => !awake ? json(response, {}, 503) : request.url === '/api/tags' ? json(response, { models: [{ name: model }] }) : json(response, request.url === '/api/generate' ? preload() : answer()) });
  await connector.heartbeat();
  assert.equal(heartbeats[0].canWake, true);
  assert.equal(heartbeats[0].ollamaReachable, false);
  await connector.execute(job());
  assert.deepEqual(requests, [{ path: '/api/services/script/desktop_ai_wake_gpu_host', authorization: 'Bearer fixture-ha-secret', body: '{}' }]);
  assert.equal(results[0].response.message.content, 'A complete fixture answer.');
});

test('a stalled wake is aborted at the job deadline before any prompt reaches Ollama', { timeout: 3000 }, async (t) => {
  const tokenFile = join(await temporary(t), 'ha-token');
  await writeFile(tokenFile, 'fixture-ha-secret', { mode: 0o600 });
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const ha = await server(t, (request, response) => { response.on('close', disconnected); });
  let chatRequested = false;
  const { connector, results } = await runtime(t, {
    config: { homeAssistant: { url: ha, tokenFile, DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN: true } },
    ollama: (request, response) => { if (request.url === '/api/chat') chatRequested = true; json(response, {}, 503); },
  });
  await connector.execute(job({ expiresAt: new Date(Date.now() + 300).toISOString() }));
  await closed;
  assert.equal(chatRequested, false);
  assert.deepEqual(results[0], { jobId: 'job-fixture', error: 'Connector could not produce a complete bounded answer' });
});

test('job expiry aborts local inference and shutdown cancels it without submitting a result', async (t) => {
  let disconnected;
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const { connector, results } = await runtime(t, { ollama: (request, response) => {
    if (request.url === '/api/tags') return json(response, { models: [{ name: model }] });
    if (request.url === '/api/generate') return json(response, preload());
    response.on('close', disconnected);
    started();
  } });
  await connector.execute(job({ expiresAt: new Date(Date.now() + 150).toISOString() }));
  await closed;
  assert.deepEqual(results[0], { jobId: 'job-fixture', error: 'Connector could not produce a complete bounded answer' });
  await start;
  const controller = new AbortController();
  let chatStarted;
  const chat = new Promise((resolve) => { chatStarted = resolve; });
  const canceled = await runtime(t, { signal: controller.signal, ollama: (request, response) => request.url === '/api/tags' ? json(response, { models: [{ name: model }] }) : request.url === '/api/generate' ? json(response, preload()) : chatStarted() });
  const execution = canceled.connector.execute(job());
  await chat;
  controller.abort(new Error('fixture shutdown'));
  await assert.rejects(execution, /fixture shutdown/);
  assert.deepEqual(canceled.results, []);
});

test('executable consumes an owner invitation, signs exact bytes and keeps heartbeats fresh during preload and chat', { timeout: 55_000 }, async (t) => {
  const directory = await temporary(t);
  let publicKey;
  const nonces = new Set();
  let heartbeats = 0;
  let chatResponse;
  let preloadResponse;
  let pickedUp = false;
  let complete;
  let failure;
  const completed = new Promise((resolve, reject) => { complete = resolve; failure = reject; });
  const appOrigin = await server(t, async (request, response) => {
    try {
      const raw = await body(request);
      const input = JSON.parse(raw);
      if (request.url.endsWith('/pair')) {
        publicKey = createPublicKey({ key: Buffer.from(input.publicKey, 'base64'), format: 'der', type: 'spki' });
        assert.equal(input.name, 'Fixture GPU');
        assert.equal(input.code, 'ABCDEFGH2345');
        assert.deepEqual(Object.keys(input).sort(), ['code', 'name', 'publicKey']);
        return json(response, { hostId: 'host-executable' });
      }
      assert.equal(request.headers['x-host-id'], 'host-executable');
      const nonce = request.headers['x-host-nonce'];
      assert.match(nonce, /^[a-f0-9]{32}$/);
      assert(!nonces.has(nonce)); nonces.add(nonce);
      const timestamp = request.headers['x-host-timestamp'];
      assert(Math.abs(Date.now() - Number(timestamp)) < 60_000);
      const canonical = `POST\n${request.url}\n${timestamp}\n${nonce}\n${createHash('sha256').update(raw).digest('hex')}`;
      assert(verify(null, Buffer.from(canonical), publicKey, Buffer.from(request.headers['x-host-signature'], 'base64')));
      if (request.url === '/api/home-node/capabilities') {
        assert.deepEqual(input, { gpuModels: [model], solarSensors: [], validatorIds: [] });
        return json(response, { ok: true });
      }
      if (request.url.endsWith('/heartbeat')) {
        heartbeats++;
        assert.deepEqual(input.models, [model]);
        assert.equal(input.ollamaReachable, true);
        if (heartbeats >= 2 && preloadResponse && !preloadResponse.writableEnded) json(preloadResponse, preload());
        if (heartbeats >= 3 && chatResponse && !chatResponse.writableEnded) json(chatResponse, answer());
        return json(response, {});
      }
      if (request.url.endsWith('/poll')) {
        assert.deepEqual(input, {});
        if (!pickedUp && heartbeats) { pickedUp = true; return json(response, { job: job() }); }
        return json(response, { job: null });
      }
      if (request.url.endsWith('/result')) {
        assert.equal(heartbeats >= 3, true, 'heartbeat was delayed by loading or generation');
        assert.equal(input.response.message.content, 'A complete fixture answer.');
        json(response, {});
        complete();
      }
    } catch (error) { failure(error); response.destroy(error); }
  });
  const ollamaUrl = await server(t, async (request, response) => {
    if (request.url === '/api/tags') return json(response, { models: [{ name: model }, { name: 'unconfigured:huge' }] });
    const input = JSON.parse(await body(request));
    if (request.url === '/api/generate') {
      assert.deepEqual(input, { model, keep_alive: '5m', stream: false });
      preloadResponse = response;
      return;
    }
    assert.equal(input.stream, false);
    assert.equal(input.think, false);
    chatResponse = response;
  });
  const configFile = join(directory, 'config.json');
  await writeFile(configFile, JSON.stringify({ ...configInput, appOrigin, ollamaUrl, stateDirectory: join(directory, 'state'), pairingCode: 'ABCDEFGH2345' }), { mode: 0o600 });
  const child = spawn(process.execPath, [new URL('./home-node.mjs', import.meta.url).pathname, '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exit; });
  await Promise.race([completed, exit.then(([code]) => { throw new Error(`Connector exited before completion (${code}): ${output}`); })]);
  child.kill('SIGTERM');
  assert.equal((await exit)[0], 0);
  assert(!output.includes('ABCDEFGH2345'));
  assert(!output.includes('PRIVATE KEY'));
  assert(!output.includes('A fixture question'));
  const state = JSON.parse(await readFile(join(directory, 'state', 'host-state.json'), 'utf8'));
  assert.equal(state.hostId, 'host-executable');
  assert.deepEqual(Object.keys(state).sort(), ['advertisedModels', 'appOrigin', 'hostId', 'publicKey']);
  await writeFile(configFile, JSON.stringify({ ...configInput, appOrigin, ollamaUrl, stateDirectory: join(directory, 'state') }));
  const restartConfig = validateConfig(JSON.parse(await readFile(configFile, 'utf8')));
  const restarted = new Connector(restartConfig, await loadIdentity(restartConfig), { log: () => {} });
  await restarted.initialize();
  await restarted.heartbeat();
});
