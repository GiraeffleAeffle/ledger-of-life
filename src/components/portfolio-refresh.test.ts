import assert from 'node:assert/strict';
import test from 'node:test';
import { createPortfolioRefresh, type PortfolioSnapshot } from './portfolio-refresh.ts';

type Holdings = { available: true; testUsdcAtomic: string; shares: number; valueUsd: number | null };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('initially neutral, then failed and unavailable reads preserve the last real balances and as-of time', async () => {
  const requests: Deferred<Holdings | { available: false }>[] = [];
  const snapshots: PortfolioSnapshot<Holdings>[] = [];
  let clock = 100;
  const reader = createPortfolioRefresh<Holdings>(
    () => { const request = deferred<Holdings | { available: false }>(); requests.push(request); return request.promise; },
    (snapshot) => snapshots.push(snapshot),
    () => clock,
  );
  const initial = reader.refresh();
  assert.equal(snapshots.length, 0); // No fictitious zero while a wallet read is in flight.
  requests[0].resolve({ available: true, testUsdcAtomic: '12000000', shares: 2, valueUsd: 480 });
  assert.equal(await initial, true);
  assert.deepEqual(snapshots.at(-1), { view: { available: true, testUsdcAtomic: '12000000', shares: 2, valueUsd: 480 }, checkedAt: 100, unavailable: false });

  clock = 200;
  const failed = reader.refresh();
  requests[1].reject(new Error('RPC temporarily unavailable'));
  await assert.rejects(failed, /temporarily unavailable/);
  assert.equal(snapshots.at(-1)?.view?.testUsdcAtomic, '12000000');
  assert.equal(snapshots.at(-1)?.checkedAt, 100);
  assert.equal(snapshots.at(-1)?.unavailable, true);

  const missing = reader.refresh();
  requests[2].resolve({ available: false });
  assert.equal(await missing, false);
  assert.equal(snapshots.at(-1)?.view?.shares, 2);
  assert.equal(snapshots.at(-1)?.checkedAt, 100);
  assert.equal(snapshots.at(-1)?.unavailable, true);

  clock = 300;
  const partial = reader.refresh();
  requests[3].resolve({ available: true, testUsdcAtomic: '8000000', shares: 3, valueUsd: null });
  assert.equal(await partial, true);
  assert.deepEqual(snapshots.at(-1), {
    view: { available: true, testUsdcAtomic: '8000000', shares: 3, valueUsd: null }, checkedAt: 300, unavailable: false,
  });
});

test('delayed older successful or failed reads cannot replace newer wallet holdings or error status', async () => {
  const requests: Deferred<Holdings | { available: false }>[] = [];
  const snapshots: PortfolioSnapshot<Holdings>[] = [];
  const reader = createPortfolioRefresh<Holdings>(
    () => { const request = deferred<Holdings | { available: false }>(); requests.push(request); return request.promise; },
    (snapshot) => snapshots.push(snapshot),
    () => 500,
  );
  const old = reader.refresh();
  const fresh = reader.refresh();
  requests[1].resolve({ available: true, testUsdcAtomic: '4000000', shares: 9, valueUsd: null });
  assert.equal(await fresh, true);
  requests[0].resolve({ available: true, testUsdcAtomic: '11000000', shares: 1, valueUsd: 100 });
  assert.equal(await old, null);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].view?.testUsdcAtomic, '4000000');
  const lateFailure = reader.refresh();
  const next = reader.refresh();
  requests[3].resolve({ available: true, testUsdcAtomic: '3000000', shares: 10, valueUsd: 250 });
  assert.equal(await next, true);
  requests[2].reject(new Error('outdated failure'));
  assert.equal(await lateFailure, null);
  assert.equal(snapshots.at(-1)?.unavailable, false);
  reader.dispose();
  const disposed = reader.refresh();
  reader.dispose();
  requests[4].resolve({ available: false });
  assert.equal(await disposed, null);
  assert.equal(snapshots.length, 2);
});
