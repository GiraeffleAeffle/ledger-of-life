import test from 'node:test';
import assert from 'node:assert/strict';
import { clearShareControl, readPendingShareControl, reserveShareControl } from './share-control-intent.ts';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}
const idA = '11111111-1111-4111-8111-111111111111';
const idB = '22222222-2222-4222-8222-222222222222';

test('reload restores exact reserved control request and does not start a different action or account', () => {
  const persistent = storage();
  const reserved = reserveShareControl(persistent, 'alice:wallet-a', 'price_down_30', () => idA);
  assert.deepEqual(readPendingShareControl(persistent, 'alice:wallet-a'), reserved);
  assert.deepEqual(reserveShareControl(persistent, 'alice:wallet-a', 'price_down_30', () => { throw new Error('must not allocate a second request'); }), reserved);
  assert.throws(() => reserveShareControl(persistent, 'alice:wallet-a', 'price_reset', () => idB), /Resume the reserved/);
  const other = reserveShareControl(persistent, 'bob:wallet-b', 'price_reset', () => idB);
  clearShareControl(persistent, 'alice:wallet-a', { ...reserved, requestId: idB });
  assert.deepEqual(readPendingShareControl(persistent, 'alice:wallet-a'), reserved);
  clearShareControl(persistent, 'alice:wallet-a', reserved);
  assert.equal(readPendingShareControl(persistent, 'alice:wallet-a'), null);
  assert.deepEqual(readPendingShareControl(persistent, 'bob:wallet-b'), other);
});
