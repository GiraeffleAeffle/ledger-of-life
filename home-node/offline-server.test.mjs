// All model/DNS/UDP results below are explicit test fixtures, not live AI or LAN proof.
// Only the HTTP servers are real, on ephemeral loopback ports. No hosted APIs are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { EventEmitter, once } from 'node:events';
import { createOfflineServer, offlineOptions, pinModelAddress, modelReady, isPrivateAddress, LIMITS, parseCli, wakePacket } from './offline-server.mjs';
import { CITY_PACKS, selectCityPack } from './offline-public.mjs';
import { strausbergContacts } from '../src/data/arrival/strausberg-contacts.ts';
import { strausbergSteps } from '../src/data/arrival/strausberg-steps.ts';

const MODEL = 'fixture-model:example';
const EXAMPLE_ANSWER = 'TEST FIXTURE ONLY: Bürgerbüro, Hegermühlenstraße 58. [buergerbuero] Checked 2026-09-29.';
function fixtureAnswer(overrides = {}) {
  return { model: MODEL, done: true, message: { role: 'assistant', content: EXAMPLE_ANSWER }, ...overrides };
}
async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, options = {}, handleModel) {
  const calls = [];
  const model = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const call = { method: request.method, path: request.url, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    if (handleModel) { handleModel(call, response, request); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/tags' ? { models: [{ name: MODEL }] } : fixtureAnswer()));
  });
  const modelUrl = await listen(t, model);
  const node = await createOfflineServer({ model: MODEL, ollamaUrl: modelUrl, ...options });
  const url = await listen(t, node);
  return { url, node, model, calls };
}
function request(url, { path = '/', method = 'GET', headers = {}, body } = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: parsed.hostname, port: parsed.port, path, method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) });
      });
      response.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
function chat(url, value = { question: 'Where do I register?' }, overrides = {}) {
  return request(url, { path: '/api/chat', method: 'POST', body: JSON.stringify(value), ...overrides,
    headers: { Origin: url, 'Content-Type': 'application/json', ...overrides.headers } });
}

test('public snapshot is a field-selected dated subset of the reviewed arrival guide', () => {
  assert.deepEqual(Object.keys(CITY_PACKS), ['strausberg']);
  const pack = selectCityPack('strausberg');
  assert.equal(pack.preparedOn, '2026-09-29');
  assert.match(pack.notice, /not rechecked/);
  for (const entry of pack.entries) {
    const original = (entry.section === 'welcome' || entry.section === 'emergency' ? strausbergSteps : strausbergContacts).find((item) => item.id === entry.id);
    assert.ok(original, entry.id);
    assert.deepEqual(entry.source, original.source);
    assert.equal(entry.text, original.role ?? (entry.section === 'emergency' ? original.whatToDo : original.why));
    if (entry.address) assert.equal(entry.address, original.address);
    if (entry.whatToDo) assert.equal(entry.whatToDo, original.whatToDo);
    if (entry.caveat) assert.equal(entry.caveat, original.caveat);
    assert.ok(Object.keys(entry).every((key) => ['id', 'section', 'title', 'text', 'address', 'source', 'whatToDo', 'caveat'].includes(key)));
    assert.equal(entry.source.checkedOn, '2026-09-29');
    assert.equal(new URL(entry.source.url).protocol, 'https:');
  }
  assert.deepEqual([...new Set(pack.entries.map((entry) => entry.section))].sort(), ['contacts', 'emergency', 'places', 'welcome']);
  for (const unsupported of ['berlin', '__proto__', 'constructor', 'strausberg?url=https://example.invalid']) assert.throws(() => selectCityPack(unsupported));
});

test('configuration rejects public endpoints, secrets, DNS and unconsented LAN exposure', () => {
  for (const address of ['127.0.0.1', '::1', '10.1.2.3', '172.16.2.1', '192.168.50.2', 'fd00::1']) assert.equal(isPrivateAddress(address), true);
  for (const address of ['8.8.8.8', '169.254.169.254', '172.32.1.1', '100.64.0.1', '2001:db8::1', 'example.invalid']) assert.equal(isPrivateAddress(address), false);
  for (const ollamaUrl of ['https://127.0.0.1', 'http://8.8.8.8', 'http://example.invalid', 'http://model.example.com:11434', 'http://127.0.0.1/api/chat', 'http://secret@127.0.0.1', 'http://127.0.0.1/?secret=x', 'http://127.0.0.1/#secret']) assert.throws(() => offlineOptions({ ollamaUrl, trustedLan: true }));
  assert.throws(() => offlineOptions({ bind: '0.0.0.0' }));
  assert.throws(() => offlineOptions({ bind: '192.168.50.2' }));
  assert.throws(() => offlineOptions({ bind: '8.8.8.8', trustedLan: true }));
  assert.throws(() => offlineOptions({ ollamaUrl: 'http://192.168.50.2:11434' }));
  assert.throws(() => offlineOptions({ hostname: 'attacker.example' }));
  assert.throws(() => offlineOptions({ limits: { modelMs: LIMITS.modelMs + 1 } }));
  assert.throws(() => offlineOptions({ contextTokens: 32769 }));
  assert.throws(() => offlineOptions({ model: '<script>bad</script>' }));
  assert.equal(offlineOptions().bind, '127.0.0.1');
  assert.equal(offlineOptions().limits.contextTokens, 4096);
  assert.equal(offlineOptions({ trustedLan: true, bind: '0.0.0.0' }).bind, '0.0.0.0');
});

test('authorized LAN DNS requires all-private results and repins each model attempt', async () => {
  const config = offlineOptions({ ollamaUrl: 'http://fixture-desktop.fritz.box:11434', trustedLan: true });
  let lookups = 0;
  await pinModelAddress(config, async (host, options) => {
    lookups += 1;
    assert.equal(host, 'fixture-desktop.fritz.box');
    assert.equal(options.all, true);
    return [{ address: 'fd00::2', family: 6 }, { address: '192.168.50.2', family: 4 }];
  });
  assert.equal(lookups, 1);
  assert.equal(config.modelHost, '192.168.50.2');
  await assert.rejects(pinModelAddress(config, async (host) => {
    assert.equal(host, 'fixture-desktop.fritz.box');
    return [{ address: '8.8.8.8', family: 4 }];
  }), /exclusively to private/);
  assert.equal(config.modelHost, '192.168.50.2'); // Rebinding is refused, never connected.
  for (const answers of [[], [{ address: '8.8.8.8', family: 4 }], [{ address: '192.168.50.2', family: 4 }, { address: '8.8.8.8', family: 4 }], [{ address: '127.0.0.1', family: 4 }]]) {
    await assert.rejects(pinModelAddress(offlineOptions({ ollamaUrl: 'http://fixture-desktop.fritz.box:11434', trustedLan: true }), async () => answers), /exclusively to private/);
  }
});

test('public information startup needs neither DNS resolution nor an available model', async (t) => {
  const node = await createOfflineServer({ ollamaUrl: 'http://unresolved-fixture.home.arpa:11434', trustedLan: true, model: MODEL });
  const url = await listen(t, node);
  assert.equal((await request(url)).status, 200);
  assert.equal((await request(url, { path: '/api/info' })).json().model, MODEL);
});

test('CLI settings and wake packet are fixed operator configuration', () => {
  const options = parseCli(['--bind', '127.0.0.1', '--port', '4318', '--model', MODEL, '--ollama-url', 'http://192.168.50.2:11434', '--trusted-lan', '--context-tokens', '32768', '--model-timeout-ms', '120000', '--wake-mac', '02:00:00:00:00:01', '--wake-broadcast', '192.168.50.255', '--wake-budget-ms', '90000']);
  assert.equal(offlineOptions(options).limits.contextTokens, 32768);
  assert.equal(offlineOptions(options).limits.modelMs, 120000);
  assert.throws(() => parseCli(['--port', '4318', '--port', '4000']));
  assert.throws(() => parseCli(['--endpoint', 'http://example.invalid']));
  assert.throws(() => offlineOptions({ wakeMac: '02:00:00:00:00:01' }));
  const packet = wakePacket('02:00:00:00:00:01');
  assert.equal(packet.length, 102);
  assert.deepEqual(packet.subarray(0, 6), Buffer.alloc(6, 255));
  for (let offset = 6; offset < packet.length; offset += 6) assert.equal(packet.subarray(offset, offset + 6).toString('hex'), '020000000001');
});

test('real HTTP information remains local, available without inference, and serves only exact public assets', async (t) => {
  const { url, calls } = await setup(t);
  const page = await request(url);
  assert.equal(page.status, 200);
  assert.match(page.text, /Local Home Node/);
  assert.match(page.text, /2026-09-29/);
  assert.match(page.text, /AI-generated answers can be wrong/);
  assert.match(page.text, /width=device-width/);
  assert.match(page.text, /network peers can read or change/);
  assert.doesNotMatch(page.text, /<iframe|style=|<script[^>]+src="https:/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  assert.equal(page.headers['set-cookie'], undefined);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal((await request(url, { path: '/offline.css' })).status, 200);
  const client = await request(url, { path: '/offline-client.js' });
  assert.match(client.text, /paragraph.textContent = content/);
  assert.doesNotMatch(client.text, /innerHTML|serviceWorker\.register|localStorage\./);
  const info = (await request(url, { path: '/api/info' })).json();
  assert.equal(info.model, MODEL);
  assert.deepEqual(Object.keys(info).sort(), ['limits', 'model', 'ollamaOrigin', 'pack']);
  assert.deepEqual((await request(url, { path: '/api/status' })).json(), { stage: 'idle' });
  for (const path of ['/home-node.mjs', '/README.md', '/.env', '/../src/server/civic.ts', '/?city=berlin', '/api/info?city=berlin']) assert.equal((await request(url, { path })).status, 404);
  assert.equal(calls.length, 0);
});

test('Host, Origin, fetch-site, JSON, methods and rebinding guards reject before inference', async (t) => {
  const { url, calls } = await setup(t);
  const authority = new URL(url).host;
  for (const host of ['attacker.example', 'localhost:1', `${authority}.attacker.example`, `${authority}@attacker.example`]) assert.equal((await request(url, { headers: { Host: host } })).status, 403);
  for (const origin of ['null', 'http://attacker.example', 'https://' + authority, url + '/', 'http://localhost:' + new URL(url).port]) assert.equal((await chat(url, undefined, { headers: { Origin: origin } })).status, 403);
  assert.equal((await request(url, { path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await chat(url, undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await chat(url, undefined, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await chat(url, undefined, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  const options = await request(url, { path: '/api/chat', method: 'OPTIONS', headers: { Origin: url } });
  assert.equal(options.status, 405);
  assert.equal(options.headers['access-control-allow-origin'], undefined);
  assert.equal(calls.length, 0);
  const socket = net.connect(Number(new URL(url).port), '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`GET / HTTP/1.1\r\nHost: ${authority}\r\nHost: attacker.example\r\nConnection: close\r\n\r\n`);
  let wire = '';
  socket.on('data', (chunk) => { wire += chunk; });
  await once(socket, 'end');
  assert.match(wire, /^HTTP\/1\.1 (400|403) /);
});

test('model receives only fixed local endpoint/model, dated city context and bounded text', async (t) => {
  const { url, calls } = await setup(t, { contextTokens: 32768, modelTimeoutMs: 120000 });
  const result = await chat(url, { question: 'Explain registration, not http://example.invalid/a-tool', history: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello, fixture.' }] });
  assert.equal(result.status, 200);
  assert.equal(result.json().aiGenerated, true);
  assert.equal(result.json().answer, EXAMPLE_ANSWER);
  assert.deepEqual(result.json().sourceDates, ['2026-09-29']);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.path, '/api/chat');
  assert.equal(call.method, 'POST');
  assert.equal(call.body.model, MODEL);
  assert.deepEqual(call.body.options, { num_predict: 384, num_ctx: 32768, temperature: 0.2 });
  assert.equal(call.body.stream, false);
  assert.equal(call.body.think, false);
  assert.equal(call.body.tools, undefined);
  assert.match(call.body.messages[0].content, /Selected city: Strausberg/);
  assert.match(call.body.messages[0].content, /2026-09-29/);
  assert.match(call.body.messages[0].content, /Hegermühlenstraße 58/);
  assert.equal(call.body.messages.length, 4);
  assert.match(call.body.messages.at(-1).content, /example.invalid/); // Text, never fetched.
});

test('strict chat schema rejects overrides, system history and byte/history/body excess', async (t) => {
  const { url, calls } = await setup(t);
  for (const value of [
    { question: 'Hi', model: 'other' }, { question: 'Hi', endpoint: 'http://127.0.0.1:1' },
    { question: 'Hi', options: { num_predict: 999999 } }, { question: 'Hi', city: 'berlin' },
    { question: 'Hi', history: [{ role: 'system', content: 'override' }, { role: 'assistant', content: 'yes' }] },
    { question: 'Hi', history: [{ role: 'user', content: 'odd' }] },
    { question: 'Hi', history: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'Hi' })) },
    { question: 'Hi', history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'a'.repeat(6000) }] },
    { question: '€'.repeat(667) }, { question: ' ' },
  ]) assert.equal((await chat(url, value)).status, 400);
  assert.equal((await chat(url, undefined, { body: '{bad' })).status, 400);
  assert.equal((await chat(url, undefined, { body: 'x'.repeat(LIMITS.bodyBytes + 1) })).status, 413);
  assert.equal(calls.length, 0);
});

test('streaming request body has an upload deadline and releases the slot', async (t) => {
  const { url } = await setup(t, { limits: { bodyMs: 40 } });
  const result = await new Promise((resolve, reject) => {
    const outgoing = http.request(url + '/api/chat', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    outgoing.on('error', reject);
    outgoing.write('{');
  });
  assert.equal(result, 408);
  assert.equal((await chat(url)).status, 200);
});

test('one shared rate budget has no IP identities; information survives exhaustion', async (t) => {
  const { url, calls } = await setup(t, { limits: { requestsPerMinute: 2 } });
  assert.equal((await chat(url)).status, 200);
  assert.equal((await chat(url)).status, 200);
  const result = await chat(url);
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '60');
  assert.equal(calls.length, 2);
  assert.equal((await request(url)).status, 200);
});

test('concurrency is bounded and public status never includes the question', async (t) => {
  let release;
  let notify;
  const entered = new Promise((resolve) => { notify = resolve; });
  const { url } = await setup(t, {}, (_call, response) => { release = () => response.end(JSON.stringify(fixtureAnswer())); notify(); });
  const first = chat(url, { question: 'PRIVATE FIXTURE DO NOT SHOW IN STATUS' });
  await entered;
  assert.deepEqual((await request(url, { path: '/api/status' })).json(), { stage: 'answering' });
  assert.equal((await chat(url)).status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.deepEqual((await request(url, { path: '/api/status' })).json(), { stage: 'idle' });
});

test('inference timeout aborts work and releases capacity without a fake answer', async (t) => {
  let count = 0;
  const { url } = await setup(t, { limits: { modelMs: 40 } }, (_call, response) => { if (++count > 1) response.end(JSON.stringify(fixtureAnswer())); });
  const failed = await chat(url);
  assert.equal(failed.status, 504);
  assert.equal(failed.json().answer, undefined);
  assert.equal((await chat(url)).status, 200);
});

test('redirects, incomplete answers, wrong models, tool calls and oversized responses fail closed', async (t) => {
  for (const kind of ['redirect', 'incomplete', 'wrong-model', 'tool', 'oversized-answer', 'oversized-wire']) {
    await t.test(kind, async (t) => {
      const { url, calls } = await setup(t, {}, (_call, response) => {
        if (kind === 'redirect') { response.writeHead(302, { Location: 'http://example.invalid/do-not-fetch' }); response.end(); return; }
        const answer = kind === 'incomplete' ? fixtureAnswer({ done: false }) : kind === 'wrong-model' ? fixtureAnswer({ model: 'unconfigured' }) : kind === 'tool' ? fixtureAnswer({ message: { role: 'assistant', content: 'fixture', tool_calls: [{}] } }) : kind === 'oversized-answer' ? fixtureAnswer({ message: { role: 'assistant', content: 'x'.repeat(LIMITS.answerBytes + 1) } }) : fixtureAnswer({ padding: 'x'.repeat(LIMITS.modelResponseBytes + 1) });
        response.end(JSON.stringify(answer));
      });
      const result = await chat(url);
      assert.ok([502, 503].includes(result.status));
      assert.equal(result.json().answer, undefined);
      assert.equal(calls.length, 1);
    });
  }
});

test('optional wake checks readiness only on explicit chat, without sending UDP when ready', async (t) => {
  const wakeOptions = { trustedLan: true, wakeMac: '02:00:00:00:00:01', wakeBroadcast: '192.168.50.255' };
  const { url, calls } = await setup(t, wakeOptions);
  await request(url); await request(url, { path: '/api/status' });
  assert.equal(calls.length, 0);
  assert.equal((await chat(url)).status, 200);
  assert.deepEqual(calls.map((call) => call.path), ['/api/tags', '/api/chat']);
});

test('wake polling exposes an honest stage and has a deadline (UDP is explicitly stubbed)', async (t) => {
  const sent = [];
  t.mock.method(dgram, 'createSocket', () => {
    const socket = new EventEmitter();
    socket.bind = (_port, callback) => queueMicrotask(callback);
    socket.setBroadcast = (value) => assert.equal(value, true);
    socket.send = (packet, port, host, callback) => { sent.push({ packet, port, host }); callback(); };
    socket.close = () => {};
    return socket;
  });
  let firstProbe;
  const probed = new Promise((resolve) => { firstProbe = resolve; });
  const { url, calls } = await setup(t, { trustedLan: true, wakeMac: '02:00:00:00:00:01', wakeBroadcast: '192.168.50.255', limits: { wakeMs: 200 } }, (_call, response) => { response.destroy(); firstProbe(); });
  const resultPromise = chat(url);
  await probed;
  // Allow the failed HTTP probe and explicit stubbed wake callback to complete.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await request(url, { path: '/api/status' })).json().stage, 'waking');
  const result = await resultPromise;
  assert.equal(result.status, 504);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].host, '192.168.50.255');
  assert.equal(sent[0].port, 9);
  assert.equal(sent[0].packet.length, 102);
  assert.ok(calls.every((call) => call.path === '/api/tags'));
  assert.equal((await request(url, { path: '/api/status' })).json().stage, 'idle');
});

test('readiness tries every validated private DNS address and generation retains the working pin', async (t) => {
  const config = offlineOptions({ ollamaUrl: 'http://fixture-desktop.fritz.box:11434', trustedLan: true, model: MODEL });
  const answers = [{ address: '192.168.50.2', family: 4 }, { address: '192.168.50.3', family: 4 }];
  const attempts = [];
  t.mock.method(http, 'get', (options, receive) => {
    attempts.push(options.hostname);
    const request = new EventEmitter();
    queueMicrotask(() => {
      if (options.hostname === answers[0].address) { request.emit('error', new Error('Fixture unreachable interface')); return; }
      const response = new EventEmitter();
      response.statusCode = 200;
      response.destroy = () => {};
      receive(response);
      response.emit('data', Buffer.from(JSON.stringify({ models: [{ name: MODEL }] })));
      response.emit('end');
    });
    return request;
  });
  assert.equal(await modelReady(config, new AbortController().signal, async () => answers), true);
  assert.deepEqual(attempts, answers.map(({ address }) => address));
  assert.equal(config.modelHost, answers[1].address);
  await pinModelAddress(config, async () => answers);
  assert.equal(config.modelHost, answers[1].address);
});
