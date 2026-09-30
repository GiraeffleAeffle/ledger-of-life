import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizedRequest } from './authorized-request.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a token that arrives after sign-out never sends the old account request', async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { ++calls; throw new Error('should not fetch'); }) as typeof fetch;
  try {
    const token = deferred<string | null>();
    let current: { identity: string | null; getAccessToken: () => Promise<string | null>; generation: number } | null = {
      identity: 'old-wallet', getAccessToken: () => token.promise, generation: 1,
    };
    const pending = authorizedRequest('/api/portfolio', undefined, 'old-wallet', () => current);
    current = { identity: null, getAccessToken: async () => null, generation: 2 };
    token.resolve('old-token');
    await assert.rejects(pending, /Sign in again/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('a slower former-wallet response cannot be used after switching wallets', async () => {
  const oldFetch = globalThis.fetch;
  const oldResponse = deferred<Response>();
  const calls: string[] = [];
  globalThis.fetch = (async (_path, init) => {
    calls.push(String(init?.headers && (init.headers as Record<string, string>).Authorization));
    if (calls.length === 1) return oldResponse.promise;
    return Response.json({ portfolio: { available: true, testUsdcAtomic: '9000000' } });
  }) as typeof fetch;
  try {
    let current = { identity: 'old-wallet', getAccessToken: async () => 'old-token', generation: 1 };
    const first = authorizedRequest('/api/portfolio', undefined, 'old-wallet', () => current);
    await Promise.resolve();
    current = { identity: 'new-wallet', getAccessToken: async () => 'new-token', generation: 2 };
    const second = await authorizedRequest<{ portfolio: { testUsdcAtomic: string } }>('/api/portfolio', undefined, 'new-wallet', () => current);
    oldResponse.resolve(Response.json({ portfolio: { available: true, testUsdcAtomic: '1000000' } }));
    await assert.rejects(first, /Account changed/);
    assert.equal(second.portfolio.testUsdcAtomic, '9000000');
    assert.deepEqual(calls, ['Bearer old-token', 'Bearer new-token']);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('an old response is discarded even when the person signs back into the same wallet', async () => {
  const oldFetch = globalThis.fetch;
  const response = deferred<Response>();
  globalThis.fetch = (async () => response.promise) as typeof fetch;
  try {
    let current = { identity: 'same-wallet', getAccessToken: async () => 'old-token', generation: 1 };
    const pending = authorizedRequest('/api/portfolio', undefined, 'same-wallet', () => current);
    await Promise.resolve();
    current = { identity: 'same-wallet', getAccessToken: async () => 'new-token', generation: 3 };
    response.resolve(Response.json({ portfolio: { available: true, testUsdcAtomic: '1000000' } }));
    await assert.rejects(pending, /Account changed/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
