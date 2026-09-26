import assert from 'node:assert/strict';
import test from 'node:test';
import { ReferencePriceUnavailable, referencePrice } from './reference-price.ts';

test('concurrent reads share one per-mint price, then retain its timestamp through a plain-text 429', async () => {
  const fetchOriginal = globalThis.fetch;
  const nowOriginal = Date.now;
  let now = nowOriginal();
  let calls = 0;
  let finish!: (response: Response) => void;
  Date.now = () => now;
  globalThis.fetch = async () => {
    calls++;
    return new Promise<Response>((resolve) => { finish = resolve; });
  };
  try {
    const first = referencePrice('test-mint-shared');
    const second = referencePrice('test-mint-shared');
    assert.strictEqual(first, second);
    assert.equal(calls, 1);
    finish(Response.json({ 'test-mint-shared': { usdPrice: 207.32 } }));
    const quote = await first;
    assert.deepEqual(await second, quote);
    assert.equal(quote.stale, false);
    assert.equal(quote.usdPrice, 207.32);
    assert.strictEqual(await referencePrice('test-mint-shared'), quote);
    now += 60_001;
    globalThis.fetch = async () => { calls++; return new Response('Rate limit', { status: 429 }); };
    const stale = await referencePrice('test-mint-shared');
    assert.deepEqual(stale, { ...quote, stale: true });
    assert.strictEqual(await referencePrice('test-mint-shared'), stale);
    assert.equal(calls, 2);
    now += 60_001;
    globalThis.fetch = async () => { calls++; return Response.json({ 'test-mint-shared': { usdPrice: 208.1 } }); };
    const recovered = await referencePrice('test-mint-shared');
    assert.equal(recovered.stale, false);
    assert.equal(recovered.usdPrice, 208.1);
    assert.notEqual(recovered.observedAt, quote.observedAt);
    assert.equal(calls, 3);
  } finally {
    Date.now = nowOriginal;
    globalThis.fetch = fetchOriginal;
  }
});

test('a plain-text 429 without a last good price is a temporary failure, backed off for a minute', async () => {
  const fetchOriginal = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('Rate limit', { status: 429 }); };
  try {
    await assert.rejects(referencePrice('test-mint-empty'), ReferencePriceUnavailable);
    await assert.rejects(referencePrice('test-mint-empty'), ReferencePriceUnavailable);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('prices for different mints do not share a cached quote', async () => {
  const fetchOriginal = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    const mint = new URL(String(url)).searchParams.get('ids')!;
    calls.push(mint);
    return Response.json({ [mint]: { usdPrice: mint === 'test-mint-solana' ? 101 : 202 } });
  };
  try {
    const [solana, robinhood] = await Promise.all([
      referencePrice('test-mint-solana'), referencePrice('test-mint-robinhood'),
    ]);
    assert.equal(solana.usdPrice, 101);
    assert.equal(robinhood.usdPrice, 202);
    assert.deepEqual(calls, ['test-mint-solana', 'test-mint-robinhood']);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
