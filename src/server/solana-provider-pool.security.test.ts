import assert from 'node:assert/strict';
import test from 'node:test';
import { SOLANA_DEVNET_MANIFEST } from '../finance/solana/manifest.ts';
import { SolanaProviderPool } from './solana-provider-pool.ts';

const config = { rpcUrl: 'https://primary.example/', rpcFallbackUrls: ['https://secondary.example/'], genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash };

for (const cancelledCaller of ['leader', 'follower'] as const) {
  test(`aborting a shared genesis ${cancelledCaller} neither cancels a surviving financial caller nor cools the endpoint`, async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const calls: string[] = [];
    let probeSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (url, options) => {
      assert.equal(String(url), config.rpcUrl);
      const { method } = JSON.parse(String(options?.body)); calls.push(method);
      if (method === 'getGenesisHash') {
        probeSignal = options?.signal; entered.resolve(); await release.promise;
        return Response.json({ result: config.genesisHash });
      }
      return Response.json({ result: 7 });
    };
    const pool = new SolanaProviderPool(config, fetcher);
    const leader = pool.rpc('getBlockHeight', [], cancelledCaller === 'leader' ? controller.signal : undefined);
    await entered.promise;
    const follower = new SolanaProviderPool(config, fetcher).rpc('getBlockHeight', [], cancelledCaller === 'follower' ? controller.signal : undefined);
    controller.abort();
    await assert.rejects(cancelledCaller === 'leader' ? leader : follower, { name: 'AbortError' });
    assert.equal(probeSignal?.aborted, false);
    release.resolve();
    assert.equal(await (cancelledCaller === 'leader' ? follower : leader), 7);
    assert.equal(await new SolanaProviderPool(config, fetcher).rpc('getBlockHeight', []), 7);
    assert.deepEqual(calls, ['getGenesisHash', 'getBlockHeight', 'getBlockHeight']);
  });
}

test('quota-looking simulation, preflight, invalid-parameter and transaction-log errors are terminal', async () => {
  for (const method of ['simulateTransaction', 'sendTransaction']) {
    for (const error of [
      { code: -32002, message: 'Credits exhausted' },
      { code: -32602, message: 'Rate limit exceeded' },
      { code: -32000, message: 'Transaction simulation failed: quota exceeded' },
      { code: -32000, message: 'Credits exhausted', data: { logs: ['program quota exceeded'] } },
    ]) {
      const calls: string[] = [];
      const fetcher: typeof fetch = async (url, options) => {
        assert.equal(String(url), config.rpcUrl);
        const request = JSON.parse(String(options?.body)); calls.push(request.method);
        return request.method === 'getGenesisHash' ? Response.json({ result: config.genesisHash }) : Response.json({ error });
      };
      await assert.rejects(new SolanaProviderPool(config, fetcher).rpc(method, ['AQID']), { message: 'RPC request failed' });
      assert.deepEqual(calls, ['getGenesisHash', method]);
    }
  }
});

test('a late transport failure cannot shorten an already recorded quota cooldown', async t => {
  let now = 1_000_000, primaryReads = 0;
  t.mock.method(Date, 'now', () => now);
  const quota = Promise.withResolvers<Response>(), transport = Promise.withResolvers<Response>();
  const fetcher: typeof fetch = async (url, options) => {
    const { method } = JSON.parse(String(options?.body));
    if (method === 'getGenesisHash') return Response.json({ result: config.genesisHash });
    if (String(url) !== config.rpcUrl) return Response.json({ result: 7 });
    primaryReads++;
    return primaryReads === 1 ? quota.promise : transport.promise;
  };
  const pool = new SolanaProviderPool(config, fetcher);
  await pool.rpc('getGenesisHash', []);
  const first = pool.rpc('getBlockHeight', []), second = pool.rpc('getBlockHeight', []);
  quota.resolve(new Response(null, { status: 429 })); await first;
  transport.reject(new Error('connection lost')); await second;
  now += 5_001;
  assert.equal(await pool.rpc('getBlockHeight', []), 7);
  assert.equal(primaryReads, 2);
});

test('half-open success cannot erase a newer failure from an older admitted request', async t => {
  let now = 1_000_000, primaryReads = 0;
  t.mock.method(Date, 'now', () => now);
  const first = Promise.withResolvers<Response>(), old = Promise.withResolvers<Response>(), recovery = Promise.withResolvers<Response>();
  const recovering = Promise.withResolvers<void>();
  const fetcher: typeof fetch = async (url, options) => {
    const { method } = JSON.parse(String(options?.body));
    if (method === 'getGenesisHash') return Response.json({ result: config.genesisHash });
    if (String(url) !== config.rpcUrl) return Response.json({ result: 7 });
    primaryReads++;
    if (primaryReads === 1) return first.promise;
    if (primaryReads === 2) return old.promise;
    recovering.resolve(); return recovery.promise;
  };
  const pool = new SolanaProviderPool(config, fetcher);
  await pool.rpc('getGenesisHash', []);
  const failed = pool.rpc('getBlockHeight', []), older = pool.rpc('getBlockHeight', []);
  first.reject(new Error('connection lost')); await failed;
  now += 5_001;
  const halfOpen = pool.rpc('getBlockHeight', []); await recovering.promise;
  old.resolve(new Response(null, { status: 429 })); await older;
  recovery.resolve(Response.json({ result: 7 })); await halfOpen;
  now += 5_001;
  assert.equal(await pool.rpc('getBlockHeight', []), 7);
  assert.equal(primaryReads, 3);
});

test('method-preserving redirects are refused rather than forwarded or treated as configured fallback', async () => {
  const methods: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(String(url), config.rpcUrl);
    assert.equal(options?.redirect, 'manual');
    const { method } = JSON.parse(String(options?.body)); methods.push(method);
    return method === 'getGenesisHash' ? Response.json({ result: config.genesisHash })
      : new Response(null, { status: 307, headers: { location: 'https://unconfigured.example/' } });
  };
  await assert.rejects(new SolanaProviderPool(config, fetcher).rpc('sendTransaction', ['AQID']), { message: 'RPC redirect refused' });
  assert.deepEqual(methods, ['getGenesisHash', 'sendTransaction']);
});

test('oversized streamed evidence is cancelled before JSON parsing and never triggers fallback', async () => {
  let cancelled = false, pulled = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(32);
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(String(url), config.rpcUrl);
    if (JSON.parse(String(options?.body)).method === 'getGenesisHash') return Response.json({ result: config.genesisHash });
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
  };
  await assert.rejects(new SolanaProviderPool(config, fetcher).rpc('getMultipleAccounts', [[]]), { message: 'RPC response exceeds size limit' });
  assert.equal(cancelled, true);
  assert.equal(pulled, 33);
});

test('aggregate response limit still accepts supported large program account evidence', async () => {
  const program = Buffer.alloc(2_000_045).toString('base64');
  const fetcher: typeof fetch = async (_, options) => Response.json({ result:
    JSON.parse(String(options?.body)).method === 'getGenesisHash' ? config.genesisHash
      : { context: { slot: 50 }, value: [{ data: [program, 'base64'] }] } });
  const result = await new SolanaProviderPool(config, fetcher).rpc('getMultipleAccounts', [[]]) as { value: { data: string[] }[] };
  assert.equal(result.value[0].data[0], program);
});

test('stream reading preserves the caller deadline and cancellation does not poison subsequent calls', async () => {
  const entered = Promise.withResolvers<void>(), controller = new AbortController();
  let hanging = true, cancelled = false;
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(String(url), config.rpcUrl);
    if (JSON.parse(String(options?.body)).method === 'getGenesisHash') return Response.json({ result: config.genesisHash });
    if (!hanging) return Response.json({ result: 7 });
    let prefix = true;
    return new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        if (prefix) { prefix = false; stream.enqueue(new TextEncoder().encode('{"result":')); }
        else entered.resolve();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
  };
  const pool = new SolanaProviderPool(config, fetcher);
  const request = pool.rpc('getBlockHeight', [], controller.signal, 3_000);
  await entered.promise;
  controller.abort(new DOMException('Caller deadline', 'TimeoutError'));
  await assert.rejects(request, { name: 'TimeoutError' });
  assert.equal(cancelled, true);
  hanging = false;
  assert.equal(await pool.rpc('getBlockHeight', []), 7);
});
