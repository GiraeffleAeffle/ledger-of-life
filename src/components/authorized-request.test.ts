import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizedRequest } from './authorized-request.ts';
import { boundedBuildingRead, BUILDING_READ_TIMEOUT_MS } from './building-read.ts';

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

test('a bounded authenticated GET aborts the actual browser fetch', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers<AbortSignal>();
  context.mock.method(globalThis, 'fetch', (_path: unknown, options?: RequestInit) => {
    assert.ok(options?.signal);
    const signal = options.signal;
    started.resolve(signal);
    const pending = Promise.withResolvers<Response>();
    signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true });
    return pending.promise;
  });
  const current = () => ({ identity: 'wallet', generation: 1, getAccessToken: async () => 'token' });
  const failure = assert.rejects(boundedBuildingRead(signal => authorizedRequest('/api/building/claims', undefined, 'wallet', current, { signal })));
  const signal = await started.promise;
  context.mock.timers.tick(BUILDING_READ_TIMEOUT_MS);
  await failure;
  assert.equal(signal.aborted, true);
});

test('a read cancelled during authentication never starts a late fetch', async context => {
  const controller = new AbortController();
  const token = Promise.withResolvers<string | null>();
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Late fetch is forbidden'); });
  const current = () => ({ identity: 'wallet', generation: 1, getAccessToken: () => token.promise });
  const failure = assert.rejects(authorizedRequest('/api/building/claims', undefined, 'wallet', current, { signal: controller.signal }), { name: 'AbortError' });
  controller.abort(); token.resolve('token');
  await failure;
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a display cancellation never aborts or replays a signed mutation', async context => {
  const controller = new AbortController();
  controller.abort();
  const body = { action: 'submit', planId: 'saved-plan', signedTransaction: 'exact-stored-bytes' };
  const fetchMock = context.mock.method(globalThis, 'fetch', async (_path: unknown, options?: RequestInit) => {
    assert.equal(options?.method, 'POST');
    assert.equal(options?.signal, undefined);
    assert.deepEqual(JSON.parse(String(options?.body)), body);
    return Response.json({ state: 'pending' });
  });
  const current = () => ({ identity: 'wallet', generation: 1, getAccessToken: async () => 'token' });
  assert.deepEqual(await authorizedRequest('/api/building/claims', body, 'wallet', current, { signal: controller.signal }), { state: 'pending' });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('pending Home journey times out and aborts without withholding healthy listings', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const journeyStarted = Promise.withResolvers<AbortSignal>();
  context.mock.method(globalThis, 'fetch', (path: unknown, options?: RequestInit) => {
    if (path === '/api/listings') return Promise.resolve(Response.json({ listings: [{ id: 'healthy-listing', title: 'Available home' }] }));
    assert.equal(path, '/api/journey');
    assert.ok(options?.signal);
    const signal = options.signal;
    journeyStarted.resolve(signal);
    const pending = Promise.withResolvers<Response>();
    signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true });
    return pending.promise;
  });
  const current = () => ({ identity: 'wallet', generation: 1, getAccessToken: async () => 'token' });
  const state: { journeyError?: string; listings?: { id: string; title: string }[] } = {};
  const journey = boundedBuildingRead(signal => authorizedRequest('/api/journey', undefined, 'wallet', current, { signal }))
    .catch((error: Error) => { state.journeyError = error.message; });
  const listings = boundedBuildingRead(signal => authorizedRequest<{ listings: { id: string; title: string }[] }>('/api/listings', undefined, 'wallet', current, { signal }))
    .then(value => { state.listings = value.listings; });
  const signal = await journeyStarted.promise;
  await listings;
  assert.equal(state.listings?.[0].title, 'Available home');
  assert.equal(state.journeyError, undefined, 'The healthy sibling publishes before the slow card settles');
  context.mock.timers.tick(BUILDING_READ_TIMEOUT_MS);
  await journey;
  assert.equal(signal.aborted, true);
  assert.equal(state.journeyError, 'Testnetz-RPC derzeit nicht erreichbar');
  assert.equal(state.listings?.[0].id, 'healthy-listing');
});
