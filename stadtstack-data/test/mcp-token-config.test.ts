import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TOKEN_LIMITS, MAX_TOKEN_LIMITS, validateTokenRecords } from '../src/mcp-token-config.mjs';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const legacy = () => [{ id: 'max', sha256: digestA }, { id: 'buzz', sha256: digestB }];
const cli = fileURLToPath(new URL('../scripts/mcp-token.mjs', import.meta.url));

// Never use the real HOME, OS temporary directory (often world-writable), or private token state.
// Fixtures live in a private disposable HOME under the canonical, owner-controlled checkout.
function fixture(state: unknown = legacy()) {
  const parent = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  const uid = process.getuid?.();
  assert.notEqual(uid, undefined, 'Token CLI fixtures require POSIX ownership support');
  assert.equal(lstatSync(parent).uid, uid, 'Fixture parent must belong to the current user');
  for (let path = parent; ; path = dirname(path)) {
    const stat = lstatSync(path);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.ok(stat.uid === uid || stat.uid === 0);
    assert.equal(stat.mode & 0o022, 0, 'Fixture ancestry must not be group/world writable');
    if (path === parse(path).root) break;
  }
  const home = mkdtempSync(join(parent, '.mcp-token-test-'));
  chmodSync(home, 0o700);
  const directory = join(home, '.config', 'stadtstack', 'mcp-tokens');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const hashes = join(directory, 'token-hashes.json');
  writeFileSync(hashes, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  return {
    home, directory, hashes,
    run(...args: string[]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        // Do not inherit NODE_OPTIONS, real HOME, or operator credentials.
        env: { HOME: home, PATH: process.env.PATH ?? '' },
        cwd: home, encoding: 'utf8', timeout: 15000,
      });
      assert.ifError(result.error);
      return result;
    },
    bytes: () => readFileSync(hashes, 'utf8'),
    state: () => JSON.parse(readFileSync(hashes, 'utf8')),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('legacy records retain implicit 60/4 defaults without mutation or name-based elevation', () => {
  assert.deepEqual(DEFAULT_TOKEN_LIMITS, { requestsPerMinute: 60, maxConcurrent: 4 });
  assert.deepEqual(MAX_TOKEN_LIMITS, { requestsPerMinute: 300, maxConcurrent: 8 });
  const records = Object.freeze(legacy().map((record) => Object.freeze(record)));
  assert.equal(validateTokenRecords(records), records);
  for (const record of records) assert.equal(Object.hasOwn(record, 'limits'), false);
  assert.throws(() => validateTokenRecords([]), /Invalid token hash configuration/);
  const empty: unknown[] = [];
  assert.equal(validateTokenRecords(empty, { allowEmpty: true }), empty);
});

test('explicit max/buzz profiles and minimum limits validate without materializing or copying records', () => {
  const records = legacy().map((record) => Object.freeze({ ...record, limits: MAX_TOKEN_LIMITS }));
  Object.freeze(records);
  assert.equal(validateTokenRecords(records), records);
  const minimum = [{ id: '1operator', sha256: digestA, limits: { requestsPerMinute: 1, maxConcurrent: 1 } }];
  assert.equal(validateTokenRecords(minimum), minimum);
});

test('shared validation rejects malformed, partial, extra, fractional and out-of-range limits safely', () => {
  const invalidLimits: unknown[] = [
    undefined, null, false, [], '300/8', {}, { requestsPerMinute: 60 }, { maxConcurrent: 4 },
    { requestsPerMinute: 60, maxConcurrent: 4, extra: true },
  ];
  for (const requestsPerMinute of [0, -1, 301, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '60', null]) {
    invalidLimits.push({ requestsPerMinute, maxConcurrent: 4 });
  }
  for (const maxConcurrent of [0, -1, 9, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4', null]) {
    invalidLimits.push({ requestsPerMinute: 60, maxConcurrent });
  }
  for (const limits of invalidLimits) {
    assert.throws(() => validateTokenRecords([{ id: 'max', sha256: digestA, limits }]), {
      message: 'Invalid token hash configuration',
    });
  }
});

test('shared validation rejects duplicate identities/digests and invalid record shapes', () => {
  for (const value of [
    null, {}, [null], [[]], [{ id: 'max' }], [{ id: 'max', sha256: digestA, extra: true }],
    [{ id: 'MAX', sha256: digestA }], [{ id: 'max', sha256: 'not-a-digest' }],
    [{ id: 'max', sha256: digestA }, { id: 'max', sha256: digestB }],
    [{ id: 'max', sha256: digestA }, { id: 'buzz', sha256: digestA }],
  ]) assert.throws(() => validateTokenRecords(value), { message: 'Invalid token hash configuration' });
});

test('set-limits changes only the selected limits, preserves digests, and emits only the hash path', () => {
  const f = fixture();
  try {
    const before = f.bytes();
    const hashes = f.run('hashes');
    assert.equal(hashes.status, 0);
    assert.equal(hashes.stdout, `${f.hashes}\n`);
    assert.equal(f.bytes(), before, 'hashes must not materialize name-based limits');
    for (const person of ['max', 'buzz']) {
      const previous = f.state();
      const result = f.run('set-limits', person, '300', '8');
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, `${f.hashes}\n`);
      assert.deepEqual(f.state(), previous.map((record: { id: string }) => record.id === person
        ? { ...record, limits: { requestsPerMinute: 300, maxConcurrent: 8 } } : record));
    }
    assert.equal(f.run('set-limits', 'max', '1', '1').status, 0);
    assert.deepEqual(f.state()[0], { id: 'max', sha256: digestA, limits: { requestsPerMinute: 1, maxConcurrent: 1 } });
    assert.equal(lstatSync(f.hashes).mode & 0o777, 0o600);
    for (const path of [f.home, join(f.home, '.config'), dirname(f.directory), f.directory]) {
      assert.equal(lstatSync(path).mode & 0o777, 0o700);
    }
    assert.deepEqual(readdirSync(f.directory), ['token-hashes.json'], 'No plaintext token, lock or temporary write remains');
  } finally { f.cleanup(); }
});

test('set-limits supports every valid shared identity and refuses unknown identities without writing', () => {
  const f = fixture([{ id: '1operator', sha256: digestA }]);
  try {
    assert.equal(f.run('set-limits', '1operator', '60', '4').status, 0);
    const before = f.bytes();
    const result = f.run('set-limits', 'missing', '300', '8');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Person has no active token.\n');
    assert.equal(f.bytes(), before);
    assert.equal(existsSync(join(f.directory, '.token-lock')), false);
  } finally { f.cleanup(); }
});

test('set-limits rejects invalid argument syntax and bounds without changing fake state', () => {
  const f = fixture();
  try {
    const before = f.bytes();
    for (const args of [[], ['60'], ['60', '4', 'extra'], ['0', '4'], ['301', '4'], ['60', '0'], ['60', '9'],
      ['-1', '4'], ['1.5', '4'], ['60', '1.5'], ['1e2', '4'], ['+60', '4'], [' 60', '4'], ['060', '4'],
      ['NaN', '4'], ['Infinity', '4'], ['9007199254740992', '4']]) {
      const result = f.run('set-limits', 'max', ...args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(f.bytes(), before);
      assert.equal(existsSync(join(f.directory, '.token-lock')), false);
    }
  } finally { f.cleanup(); }
});

test('issue and revoke retain their API without automatic max/buzz elevation', () => {
  const f = fixture([]);
  try {
    for (const person of ['max', 'buzz']) {
      const result = f.run('issue', person);
      const tokenPath = join(f.directory, `${person}.token`);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, `${tokenPath}\n${f.hashes}\n`);
      assert.equal(lstatSync(tokenPath).mode & 0o777, 0o600);
      // Inspect only the disposable hash manifest; never read even the fixture plaintext tokens.
      assert.equal(Object.hasOwn(f.state().find((record: { id: string }) => record.id === person), 'limits'), false);
    }
    assert.equal(f.run('set-limits', 'buzz', '300', '8').status, 0);
    const buzz = f.state()[1];
    const result = f.run('revoke', 'max');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${f.hashes}\n`);
    assert.deepEqual(f.state(), [buzz]);
    assert.equal(existsSync(join(f.directory, 'max.token')), true);
  } finally { f.cleanup(); }
});

test('CLI refuses invalid manifests without exposing or replacing their fake contents', () => {
  for (const state of [
    [{ id: 'max', sha256: digestA, limits: { requestsPerMinute: 300 } }],
    [{ id: 'max', sha256: digestA }, { id: 'max', sha256: digestB }],
    [{ id: 'max', sha256: digestA }, { id: 'buzz', sha256: digestA }],
  ]) {
    const f = fixture(state);
    try {
      const before = f.bytes();
      const result = f.run('set-limits', 'max', '300', '8');
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Malformed hash state; refusing to change it.\n');
      assert.equal(f.bytes(), before);
    } finally { f.cleanup(); }
  }
});

test('CLI refuses unsafe permissions, symlinks, hard links and existing locks', () => {
  for (const unsafe of ['file-mode', 'directory-mode', 'home-mode', 'file-symlink', 'directory-symlink', 'hard-link', 'lock']) {
    const f = fixture();
    try {
      const before = f.bytes();
      const target = join(f.home, 'fake-state.json');
      if (unsafe === 'file-mode') chmodSync(f.hashes, 0o644);
      if (unsafe === 'directory-mode') chmodSync(f.directory, 0o755);
      if (unsafe === 'home-mode') chmodSync(f.home, 0o777);
      if (unsafe === 'file-symlink') {
        writeFileSync(target, before, { mode: 0o600 });
        unlinkSync(f.hashes);
        symlinkSync(target, f.hashes);
      }
      if (unsafe === 'directory-symlink') {
        const redirected = join(f.home, 'fake-directory');
        mkdirSync(redirected, { mode: 0o700 });
        writeFileSync(join(redirected, 'token-hashes.json'), before, { mode: 0o600 });
        rmSync(f.directory, { recursive: true });
        symlinkSync(redirected, f.directory);
      }
      if (unsafe === 'hard-link') linkSync(f.hashes, target);
      if (unsafe === 'lock') mkdirSync(join(f.directory, '.token-lock'), { mode: 0o700 });
      const result = f.run('set-limits', 'max', '300', '8');
      assert.equal(result.status, 1, unsafe);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.length > 0);
      assert.equal(result.stderr.includes(digestA), false);
      assert.equal(f.bytes(), before);
      assert.equal(existsSync(join(f.directory, '.token-lock')), unsafe === 'lock');
    } finally { f.cleanup(); }
  }
});

test('first-use hashes creates only private empty state; set-limits never creates an identity', () => {
  const f = fixture();
  try {
    unlinkSync(f.hashes);
    const missing = f.run('set-limits', 'max', '300', '8');
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.equal(missing.stderr, 'Person has no active token.\n');
    assert.equal(existsSync(f.hashes), false);
    const result = f.run('hashes');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${f.hashes}\n`);
    assert.equal(result.stderr, '');
    assert.deepEqual(f.state(), []);
    assert.equal(lstatSync(f.hashes).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(f.directory), ['token-hashes.json']);
  } finally { f.cleanup(); }
});
