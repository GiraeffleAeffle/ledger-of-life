import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

process.umask(0o077);
const directory = '/backups';
// VACUUM may spill temporary pages; the image's root filesystem (including /tmp) is read-only.
process.env.SQLITE_TMPDIR = directory;
const snapshotPattern = /^rental-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.sqlite$/;
// Forbid concurrency means these can only belong to an interrupted previous run.
for (const name of readdirSync(directory)) {
  if (name.endsWith('.partial') && snapshotPattern.test(name.slice(0, -8))) rmSync(join(directory, name));
}
const name = `rental-${new Date().toISOString().replaceAll(':', '-').replace('.', '-')}-${randomUUID()}.sqlite`;
const temporary = join(directory, `${name}.partial`);
const source = new DatabaseSync('/data/rental.sqlite', { readOnly: true });
try {
  source.exec('PRAGMA busy_timeout=5000');
  // SQLite's online backup API includes committed WAL pages and tolerates concurrent app writes.
  await backup(source, temporary);
  const snapshot = new DatabaseSync(temporary);
  try {
    // Match purged() in src/server/local-ai-retention.ts, for every desk record regardless of age/state.
    // Backups must not extend the live desk's text-retention window.
    snapshot.exec('PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON');
    snapshot.prepare(`
      UPDATE rental_records
      SET body = json_set(body, '$.request.prompt', '', '$.request.answer', NULL, '$.request.purgedAt', ?)
      WHERE key GLOB 'local-ai:request:*'
    `).run(new Date().toISOString());
    // Rebuild the scrubbed copy so old text cannot survive in free pages. Never alter the live database.
    snapshot.exec('VACUUM');
    const rows = snapshot.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('Snapshot integrity_check failed');
  } finally {
    snapshot.close();
  }
  chmodSync(temporary, 0o600);
  // Only verified, closed snapshots become eligible for retention or restore.
  renameSync(temporary, join(directory, name));
  const snapshots = readdirSync(directory).filter((entry) => snapshotPattern.test(entry)).sort().reverse();
  for (const expired of snapshots.slice(28)) rmSync(join(directory, expired));
  console.log(`Verified snapshot ${name}; retained ${Math.min(snapshots.length, 28)}`);
} finally {
  source.close();
  rmSync(temporary, { force: true });
}
