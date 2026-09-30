import assert from 'node:assert/strict';
import test from 'node:test';
import { settleShareAction } from './share-action.ts';

test('a confirmed share transaction remains confirmed when its balance read fails', async () => {
  const events: string[] = [];
  const settled = await settleShareAction(
    async () => { events.push('confirmed'); return '0xtest-confirmed'; },
    () => { events.push('invalidate holdings'); },
    async () => { events.push('read failed'); throw new Error('RPC unavailable'); },
  );
  assert.deepEqual(events, ['confirmed', 'invalidate holdings', 'read failed']);
  assert.equal(settled.confirmation, '0xtest-confirmed');
  assert.equal(settled.actionError, null);
  assert.match((settled.refreshError as Error).message, /RPC unavailable/);
});

test('a failed later step still invalidates possibly changed holdings', async () => {
  const events: string[] = [];
  const settled = await settleShareAction(
    async () => { events.push('first signed step'); throw new Error('second step unavailable'); },
    () => { events.push('invalidate holdings'); },
    async () => { events.push('read succeeded'); },
  );
  assert.deepEqual(events, ['first signed step', 'invalidate holdings', 'read succeeded']);
  assert.equal(settled.confirmation, null);
  assert.match((settled.actionError as Error).message, /second step unavailable/);
  assert.equal(settled.refreshError, null);
});
