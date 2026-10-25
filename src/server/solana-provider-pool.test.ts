import assert from 'node:assert/strict';
import test from 'node:test';
import { getBase58Decoder } from '@solana/kit';
import { SOLANA_DEVNET_MANIFEST, SOLANA_MAINNET_MANIFEST } from '../finance/solana/manifest.ts';
import { createBaseSolanaGateway } from './solana-rpc.ts';
import { createPooledSolanaRpc, SolanaProviderPool, solanaRpcConfiguration } from './solana-provider-pool.ts';

const config = { rpcUrl: 'https://primary.example/', rpcFallbackUrls: ['https://secondary.example/', 'https://public.example/'], genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash };
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(1));

test('ordered quota failover is shared by gateways, has no polling and half-opens on a real request', async t => {
  let now = 1_000_000, recovered = false;
  t.mock.method(Date, 'now', () => now);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    const host = new URL(String(url)).hostname, { method } = JSON.parse(String(options?.body));
    calls.push(`${host}:${method}`);
    if (host === 'primary.example' && !recovered) return new Response(null, { status: 429 });
    if (host === 'secondary.example' && !recovered) return Response.json({ error: { code: -32000, message: 'Monthly credits exhausted' } });
    return Response.json({ result: method === 'getGenesisHash' ? config.genesisHash : 42 });
  };
  const a = new SolanaProviderPool(config, fetcher), b = new SolanaProviderPool(config, fetcher);
  assert.equal(await a.rpc('getBlockHeight', []), 42);
  assert.deepEqual(calls, ['primary.example:getGenesisHash', 'secondary.example:getGenesisHash', 'public.example:getGenesisHash', 'public.example:getBlockHeight']);
  calls.length = 0;
  assert.equal(await b.rpc('getBlockHeight', []), 42);
  assert.deepEqual(calls, ['public.example:getBlockHeight']);
  now += 300_001; recovered = true; calls.length = 0;
  assert.equal(await b.rpc('getBlockHeight', []), 42);
  assert.deepEqual(calls, ['primary.example:getGenesisHash', 'primary.example:getBlockHeight']);
});

test('genesis validation is single-flight without caching account responses across requests', async () => {
  const pending = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let genesisCalls = 0, reads = 0;
  const fetcher: typeof fetch = async (_, options) => {
    const { method } = JSON.parse(String(options?.body));
    if (method === 'getGenesisHash') { genesisCalls++; pending.resolve(); await release.promise; return Response.json({ result: config.genesisHash }); }
    return Response.json({ result: ++reads });
  };
  const a = new SolanaProviderPool(config, fetcher), b = new SolanaProviderPool(config, fetcher);
  const first = a.rpc('getBlockHeight', []);
  await pending.promise;
  const second = b.rpc('getBlockHeight', []);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(genesisCalls, 1);
});

test('only one request half-opens while concurrent traffic uses the next healthy provider', async t => {
  let now = 1_000_000, failing = true, primaryCalls = 0;
  t.mock.method(Date, 'now', () => now);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fetcher: typeof fetch = async (url, options) => {
    const { method } = JSON.parse(String(options?.body));
    if (String(url) === config.rpcUrl) {
      primaryCalls++;
      if (failing) return new Response(null, { status: 503 });
      if (method === 'getGenesisHash') { entered.resolve(); await release.promise; }
    }
    return Response.json({ result: method === 'getGenesisHash' ? config.genesisHash : 7 });
  };
  const pool = new SolanaProviderPool(config, fetcher);
  await pool.rpc('getBlockHeight', []);
  now += 15_001; failing = false;
  const recovering = pool.rpc('getBlockHeight', []);
  await entered.promise;
  assert.equal(await new SolanaProviderPool(config, fetcher).rpc('getBlockHeight', []), 7);
  assert.equal(primaryCalls, 2);
  release.resolve(); await recovering;
  assert.equal(primaryCalls, 3);
});

test('all unavailable fails closed and cooldown prevents repeated calls; auth has a separate bounded cooldown', async t => {
  let now = 1_000_000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const fetcher: typeof fetch = async () => { calls++; return new Response('private diagnostics', { status: 401 }); };
  const pool = new SolanaProviderPool(config, fetcher);
  await assert.rejects(pool.rpc('getBlockHeight', []), { message: 'RPC unavailable' });
  assert.equal(calls, 3);
  await assert.rejects(pool.rpc('getBlockHeight', []), { message: 'RPC unavailable' });
  assert.equal(calls, 3);
  now += 60_001;
  await assert.rejects(pool.rpc('getBlockHeight', []));
  assert.equal(calls, 6);
});

test('every selected endpoint validates genesis; wrong network never tries a third provider', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push(new URL(String(url)).hostname);
    assert.equal(JSON.parse(String(options?.body)).method, 'getGenesisHash');
    return String(url) === config.rpcUrl ? new Response(null, { status: 429 }) : Response.json({ result: SOLANA_MAINNET_MANIFEST.genesisHash });
  };
  await assert.rejects(new SolanaProviderPool(config, fetcher).rpc('getMultipleAccounts', [[]]), /genesis mismatch/);
  assert.deepEqual(calls, ['primary.example', 'secondary.example']);
  assert.throws(() => new SolanaProviderPool({ ...config, genesisHash: SOLANA_MAINNET_MANIFEST.genesisHash }, fetcher), /Mainnet/);
});

test('localnet ignores devnet fallbacks and endpoint genesis state cannot cross networks', async () => {
  const environment = { SOLANA_RPC_URL: config.rpcUrl, SOLANA_RPC_FALLBACK_URLS: JSON.stringify(config.rpcFallbackUrls) };
  assert.deepEqual(solanaRpcConfiguration(environment, { cluster: 'localnet', genesisHash: config.genesisHash }).rpcFallbackUrls, []);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push(new URL(String(url)).hostname);
    const { method } = JSON.parse(String(options?.body));
    return Response.json({ result: method === 'getGenesisHash' ? config.genesisHash : 8 });
  };
  await new SolanaProviderPool(config, fetcher).rpc('getBlockHeight', []);
  await assert.rejects(new SolanaProviderPool({ ...config, genesisHash: 'local-genesis' }, fetcher).rpc('getBlockHeight', []), /genesis mismatch/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(host => host === 'primary.example'));
});

test('malformed envelopes, simulation errors and unrecognized RPC errors do not trigger failover', async () => {
  for (const response of [() => new Response('{bad'), () => Response.json([]), () => Response.json({}),
    () => Response.json({ error: { code: -32002, message: 'Transaction simulation failed' } })]) {
    const hosts: string[] = [];
    const fetcher: typeof fetch = async (url, options) => {
      hosts.push(new URL(String(url)).hostname);
      return JSON.parse(String(options?.body)).method === 'getGenesisHash' ? Response.json({ result: config.genesisHash }) : response();
    };
    await assert.rejects(new SolanaProviderPool(config, fetcher).rpc('simulateTransaction', ['signed-bytes']));
    assert.deepEqual(hosts, ['primary.example', 'primary.example']);
  }
});

test('HTTP payment-required credit exhaustion is recognized without exposing provider diagnostics', async () => {
  const fetcher: typeof fetch = async (url, options) => String(url) === config.rpcUrl
    ? Response.json({ error: { message: 'Credits exhausted for private credential' } }, { status: 402 })
    : Response.json({ result: JSON.parse(String(options?.body)).method === 'getGenesisHash' ? config.genesisHash : 9 });
  assert.equal(await new SolanaProviderPool(config, fetcher).rpc('getBlockHeight', []), 9);
});

test('a stalled response body is bounded even when the transport ignores cancellation', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers<void>();
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++; entered.resolve();
    return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }));
  };
  const request = new SolanaProviderPool(config, fetcher).rpc('getBlockHeight', [], controller.signal, 3_000);
  await entered.promise;
  controller.abort(new DOMException('private upstream details', 'TimeoutError'));
  await assert.rejects(request, { name: 'TimeoutError', message: 'Solana RPC deadline exceeded' });
  assert.equal(calls, 1);
});

test('ambiguous send is not replayed by the pool; reconciliation uses the saved signature on a healthy provider', async () => {
  const signed = new Uint8Array([1, 2, 3]), sends: string[] = [], methods: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body)); methods.push(body.method);
    if (body.method === 'getGenesisHash') return Response.json({ result: config.genesisHash });
    if (body.method === 'sendTransaction') { sends.push(body.params[0]); throw new Error('private transport diagnostics'); }
    assert.notEqual(String(url), config.rpcUrl);
    if (body.method === 'getSignatureStatuses') { assert.deepEqual(body.params[0], [signature]); return Response.json({ result: { value: [null] } }); }
    assert.equal(body.method, 'getTransaction'); assert.equal(body.params[0], signature);
    return Response.json({ result: null });
  };
  const gateway = createBaseSolanaGateway({ ...config, maximumSponsorLamports: '10000000' }, fetcher);
  await assert.rejects(gateway.broadcast(signed), { message: 'Broadcast response ambiguous' });
  assert.deepEqual(sends, [Buffer.from(signed).toString('base64')]);
  const observation = await gateway.reconcile(signature, 'a'.repeat(64), []);
  assert.equal(observation.status, 'unknown');
  assert.equal(sends.length, 1);
  assert.ok(!methods.includes('getLatestBlockhash'));
  assert.deepEqual([...signed], [1, 2, 3]);
});

test('Kit transport retains exact u64 numeric response values and shares provider policy', async () => {
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url) === config.rpcUrl) return new Response(null, { status: 429 });
    return JSON.parse(String(options?.body)).method === 'getGenesisHash'
      ? Response.json({ result: config.genesisHash }) : new Response('{"jsonrpc":"2.0","id":1,"result":9007199254740993}');
  };
  assert.equal(await createPooledSolanaRpc(config, fetcher).getBlockHeight().send(), 9007199254740993n);
});

test('transport failures cool briefly while Retry-After is clamped to fifteen minutes', async t => {
  let now = 1_000_000, failures = true;
  t.mock.method(Date, 'now', () => now);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    const host = new URL(String(url)).hostname;
    calls.push(host);
    if (failures && host === 'primary.example') throw new Error('private upstream diagnostic');
    if (failures && host === 'secondary.example') return new Response(null, { status: 429, headers: { 'retry-after': '9999999' } });
    return Response.json({ result: JSON.parse(String(options?.body)).method === 'getGenesisHash' ? config.genesisHash : 10 });
  };
  const pool = new SolanaProviderPool(config, fetcher);
  await pool.rpc('getBlockHeight', []);
  now += 5_001; failures = false; calls.length = 0;
  await pool.rpc('getBlockHeight', []);
  assert.deepEqual(calls, ['primary.example', 'primary.example']);
  // A separately configured subset cannot silently borrow the first pool's public endpoint.
  const subset = new SolanaProviderPool({ ...config, rpcUrl: config.rpcFallbackUrls[0], rpcFallbackUrls: [] }, fetcher);
  calls.length = 0;
  await assert.rejects(subset.rpc('getBlockHeight', []), /unavailable/);
  assert.equal(calls.length, 0);
  now += 900_001;
  assert.equal(await subset.rpc('getBlockHeight', []), 10);
  assert.deepEqual(calls, ['secondary.example', 'secondary.example']);
});
