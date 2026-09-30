import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalStore } from './store.ts';

const sentinel = 'PRIVATE-QUESTION-TEXT-9d1f2c7a';

/** Every byte the store has on disk: the database, its write-ahead log and anything else beside them. */
async function diskBytes(directory: string) {
  const files = await readdir(directory);
  return Buffer.concat(await Promise.all(files.map((name) => readFile(join(directory, name)))));
}

test('text that an update removed cannot be recovered from the database files once the store is reclaimed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-store-'));
  const store = new LocalStore(join(directory, 'records.sqlite'));
  try {
    // A record longer than a database page, so old content spills into overflow pages as real answers do.
    const padding = 'x'.repeat(6000);
    await store.create('request:1', { prompt: `${sentinel} ${padding}`, answer: `Answer to ${sentinel} ${padding}`, usage: { outputTokens: 7 } });
    await store.create('request:2', { prompt: 'another person\'s question', answer: 'still wanted', usage: { outputTokens: 3 } });
    assert.ok((await diskBytes(directory)).includes(sentinel), 'the text is on disk before it is removed');

    await store.update('request:1', (value: { usage: unknown }) => ({ prompt: '', answer: null, usage: value.usage }));
    await store.reclaim?.();

    assert.equal((await diskBytes(directory)).includes(sentinel), false, 'removed text is gone from the database and the log');
    assert.deepEqual(await store.get('request:1'), { prompt: '', answer: null, usage: { outputTokens: 7 } });
    assert.equal((await store.get<{ answer: string }>('request:2'))?.answer, 'still wanted');
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
