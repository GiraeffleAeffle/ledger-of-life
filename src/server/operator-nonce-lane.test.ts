import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from './store.ts';
import { acquireOperatorNonceLane, releaseOperatorNonceLane, releaseOperatorNonceLaneIfOwned } from './operator-nonce-lane.ts';

const signer = '0x1111111111111111111111111111111111111111';

test('shared signer lane survives restart and prevents another account from reserving its nonce', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'operator-lane-'));
  const filename = join(folder, 'state.sqlite');
  const first = new LocalStore(filename);
  const second = new LocalStore(filename);
  try {
    await acquireOperatorNonceLane(first, signer, 'example:alice');
    await assert.rejects(acquireOperatorNonceLane(second, signer, 'example:bob'), /unresolved testnet operation/);
    await first.close();
    const recovered = new LocalStore(filename);
    try {
      await acquireOperatorNonceLane(recovered, signer, 'example:alice');
      await releaseOperatorNonceLaneIfOwned(recovered, signer, 'example:bob');
      await assert.rejects(acquireOperatorNonceLane(second, signer, 'example:bob'), /unresolved testnet operation/);
      await releaseOperatorNonceLane(recovered, signer, 'example:alice');
      await acquireOperatorNonceLane(second, signer, 'example:bob');
      await assert.rejects(releaseOperatorNonceLane(recovered, signer, 'example:alice'), /reservation changed/);
      await releaseOperatorNonceLane(second, signer, 'example:bob');
    } finally { await recovered.close(); }
  } finally { await second.close(); await rm(folder, { recursive: true, force: true }); }
});
