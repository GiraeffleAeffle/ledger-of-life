import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedReads } from './shared-reads.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('components asking at the same time with the same request share one read', async () => {
  const reads = sharedReads<object, string>();
  const owner = {};
  const pending = deferred<string>();
  let started = 0;
  const first = reads.read(owner, 'city', () => { started++; return pending.promise; });
  const second = reads.read(owner, 'city', () => { started++; return pending.promise; });
  assert.equal(first, second);
  assert.equal(started, 1);
  pending.resolve('strausberg');
  assert.equal(await second, 'strausberg');
});

test('a read started for one signed-in account is never handed to the next one', async () => {
  // Right after sign-up the request function is replaced; its old in-flight read rejects with "Account changed".
  const reads = sharedReads<object, string>();
  const before = {}, after = {};
  const old = deferred<string>();
  const stale = reads.read(before, 'city', () => old.promise);
  const fresh = reads.read(after, 'city', async () => 'choose');
  assert.notEqual(stale, fresh);
  old.reject(new Error('Account changed. Refresh and try again.'));
  await assert.rejects(stale, /Account changed/);
  assert.equal(await fresh, 'choose');
});

test('a finished or failed read is not reused, and clearing forgets reads still in flight', async () => {
  const reads = sharedReads<object, string>();
  const owner = {};
  let started = 0;
  await reads.read(owner, 'city', async () => { started++; return 'a'; });
  await assert.rejects(reads.read(owner, 'city', async () => { started++; throw new Error('offline'); }), /offline/);
  assert.equal(await reads.read(owner, 'city', async () => { started++; return 'b'; }), 'b');
  const inFlight = deferred<string>();
  const kept = reads.read(owner, 'city', () => { started++; return inFlight.promise; });
  reads.clear();
  const newer = deferred<string>();
  const after = reads.read(owner, 'city', () => { started++; return newer.promise; });
  assert.notEqual(kept, after);
  // A late answer from before the clear must not evict the newer read's slot: a third caller still shares it.
  inFlight.resolve('late');
  await kept;
  const third = reads.read(owner, 'city', () => { started++; return Promise.resolve('d'); });
  assert.equal(third, after);
  newer.resolve('c');
  assert.equal(await third, 'c');
  assert.equal(started, 5);
});
