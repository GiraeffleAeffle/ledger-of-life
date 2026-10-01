import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface Store {
  get<T>(key: string): Promise<T | null>;
  create<T>(key: string, value: T): Promise<void>;
  update<T>(key: string, change: (value: T) => T): Promise<T>;
  scan<T>(prefix: string, after?: string, limit?: number): Promise<{ key: string; value: T }[]>;
  close(): Promise<void>;
  /**
   * Physically drops what an update or delete already removed logically. Only file-backed stores need it, so it is optional.
   * Call it after removing personal text; it is not needed for ordinary writes.
   */
  reclaim?(): Promise<void>;
}

export class LocalStore implements Store {
  private database: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    // secure_delete zeroes freed content, and rewriting a record otherwise leaves its old bytes in the file; reclaim() below
    // truncates the write-ahead log, which still holds old page images. Both are needed to make removed text unrecoverable.
    this.database.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS rental_records (key TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;',
    );
    // Clean cutover: remove obsolete recovery/browser records and durable network-source buckets.
    const removed = this.database.prepare("DELETE FROM rental_records WHERE key LIKE 'identity-recovery:%' OR key LIKE 'identity-browser:%'").run();
    const scrubbed = this.database.prepare("UPDATE rental_records SET body = json_remove(body, '$.rate') WHERE key = 'local-ai:connector-registry' AND json_type(body, '$.rate') IS NOT NULL").run();
    if (removed.changes || scrubbed.changes) this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  async reclaim() {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  async get<T>(key: string): Promise<T | null> {
    const row = this.database.prepare('SELECT body FROM rental_records WHERE key = ?').get(key) as
      { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : null;
  }
  async create<T>(key: string, value: T) {
    this.database
      .prepare('INSERT INTO rental_records(key, body) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }
  async scan<T>(prefix: string, after = '', limit = 100): Promise<{ key: string; value: T }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid page size.');
    const rows = this.database
      .prepare(
        'SELECT key, body FROM rental_records WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?',
      )
      .all(prefix, prefix + '\uffff', after, limit) as { key: string; body: string }[];
    return rows.map((row) => ({ key: row.key, value: JSON.parse(row.body) as T }));
  }
  async update<T>(key: string, change: (value: T) => T): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database
        .prepare('SELECT body FROM rental_records WHERE key = ?')
        .get(key) as { body: string } | undefined;
      if (!row) throw new Error('Record not found.');
      const next = change(JSON.parse(row.body) as T);
      this.database
        .prepare('UPDATE rental_records SET body = ? WHERE key = ?')
        .run(JSON.stringify(next), key);
      this.database.exec('COMMIT');
      return next;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  async close() {
    this.database.close();
  }
}

type PgClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: { key?: string; body: unknown }[] }>;
  release(): void;
};
type PgPool = {
  query(text: string, values?: unknown[]): Promise<{ rows: { key?: string; body: unknown }[] }>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
};

export class PostgresStore implements Store {
  private pool: PgPool;
  constructor(pool: PgPool) {
    this.pool = pool;
  }
  async initialize() {
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS rental_records (key text PRIMARY KEY, body jsonb NOT NULL)',
    );
    await this.pool.query("DELETE FROM rental_records WHERE starts_with(key, 'identity-recovery:') OR starts_with(key, 'identity-browser:')");
    await this.pool.query("UPDATE rental_records SET body = body - 'rate' WHERE key = 'local-ai:connector-registry' AND body ? 'rate'");
  }
  async get<T>(key: string): Promise<T | null> {
    const result = await this.pool.query('SELECT body FROM rental_records WHERE key = $1', [key]);
    return result.rows.length ? (result.rows[0].body as T) : null;
  }
  async create<T>(key: string, value: T) {
    await this.pool.query('INSERT INTO rental_records(key, body) VALUES ($1, $2::jsonb)', [
      key,
      JSON.stringify(value),
    ]);
  }
  async scan<T>(prefix: string, after = '', limit = 100): Promise<{ key: string; value: T }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid page size.');
    const result = await this.pool.query(
      'SELECT key, body FROM rental_records WHERE starts_with(key, $1) AND key > $2 ORDER BY key LIMIT $3',
      [prefix, after, limit],
    );
    return result.rows.map((row) => ({ key: row.key!, value: row.body as T }));
  }
  async update<T>(key: string, change: (value: T) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'SELECT body FROM rental_records WHERE key = $1 FOR UPDATE',
        [key],
      );
      if (!result.rows.length) throw new Error('Record not found.');
      const next = change(result.rows[0].body as T);
      await client.query('UPDATE rental_records SET body = $1::jsonb WHERE key = $2', [
        JSON.stringify(next),
        key,
      ]);
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

// Route bundles and development reloads must share leases and the process-local connector queue.
const storeRuntime = globalThis as typeof globalThis & { __ledgerStore?: Promise<Store> };
export function getStore(): Promise<Store> {
  storeRuntime.__ledgerStore ??= (async () => {
    if (process.env.DATABASE_URL) {
      const { Pool } = await import('pg');
      const store = new PostgresStore(
        new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }) as PgPool,
      );
      await store.initialize();
      return store;
    }
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_STORE !== '1')
      throw new Error('DATABASE_URL is required for a hosted deployment.');
    return new LocalStore(resolve(/* turbopackIgnore: true */ process.env.LOCAL_DATABASE_PATH || '.data/rental.sqlite'));
  })().catch((error) => {
    storeRuntime.__ledgerStore = undefined;
    throw error;
  });
  return storeRuntime.__ledgerStore;
}
