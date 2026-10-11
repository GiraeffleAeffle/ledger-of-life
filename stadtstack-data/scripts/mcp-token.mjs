#!/usr/bin/env node
import { constants as C, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, parse } from 'node:path';
import { MAX_TOKEN_LIMITS, validateTokenRecords } from '../src/mcp-token-config.mjs';

const uid = process.getuid?.();
const personPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const [command, person, ...extra] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
const home = resolve(homedir());
const directory = join(home, '.config', 'stadtstack', 'mcp-tokens');
const hashes = join(directory, 'token-hashes.json');

function inspectDirectory(path, privateDirectory = false) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022) ||
      (privateDirectory && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700))) {
    fail('Unsafe directory ownership, permissions, or symlink.');
  }
}

function prepareDirectory() {
  let current = parse(home).root;
  inspectDirectory(current);
  for (const component of home.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    inspectDirectory(current);
  }
  if (lstatSync(home).uid !== uid) fail('Home directory must belong to the current user.');
  for (const component of ['.config', 'stadtstack', 'mcp-tokens']) {
    current = join(current, component);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    inspectDirectory(current, component !== '.config');
  }
}

function inspectFile(stat) {
  if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    fail('Unsafe file ownership, permissions, or hard link.');
  }
}

function readState() {
  let descriptor;
  try {
    const stat = lstatSync(hashes);
    inspectFile(stat);
    descriptor = openSync(hashes, C.O_RDONLY | C.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    inspectFile(opened);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 1024 * 1024) fail('Unsafe hash state.');
    let state;
    try { state = JSON.parse(readFileSync(descriptor, 'utf8')); }
    catch { fail('Malformed hash state; refusing to change it.'); }
    try { return validateTokenRecords(state, { allowEmpty: true }); }
    catch { fail('Malformed hash state; refusing to change it.'); }
  } catch (error) {
    if (error.code === 'ENOENT' && descriptor === undefined) return [];
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function saveState(state) {
  validateTokenRecords(state, { allowEmpty: true });
  const temporary = join(directory, `.hashes-${randomBytes(16).toString('hex')}.tmp`);
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(temporary, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    created = true;
    inspectFile(fstatSync(descriptor));
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    // Check any destination again before replacement; cooperating writers hold the lock.
    try { inspectFile(lstatSync(hashes)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    renameSync(temporary, hashes); created = false;
    const parent = openSync(directory, C.O_RDONLY | C.O_NOFOLLOW | C.O_DIRECTORY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) unlinkSync(temporary);
  }
}

let locked = false;
const lock = join(directory, '.token-lock');
try {
  if (uid === undefined || !C.O_NOFOLLOW || !C.O_DIRECTORY) fail('A POSIX platform with no-follow support is required.');
  const validPerson = command === 'set-limits'
    ? /^[a-z0-9][a-z0-9_-]{0,63}$/.test(person ?? '')
    : personPattern.test(person ?? '');
  if (!['issue', 'revoke', 'hashes', 'set-limits'].includes(command) ||
      (command === 'set-limits' ? extra.length !== 2 : extra.length !== 0) ||
      (command === 'hashes' ? person !== undefined : !validPerson)) {
    fail('Usage: mcp-token.mjs issue <person> | revoke <person> | hashes | set-limits <person> <requestsPerMinute> <maxConcurrent>.');
  }
  let limits;
  if (command === 'set-limits') {
    const [requestsPerMinute, maxConcurrent] = extra.map(Number);
    if (!extra.every((value) => /^[1-9][0-9]*$/.test(value)) ||
        !Number.isSafeInteger(requestsPerMinute) || requestsPerMinute > MAX_TOKEN_LIMITS.requestsPerMinute ||
        !Number.isSafeInteger(maxConcurrent) || maxConcurrent > MAX_TOKEN_LIMITS.maxConcurrent) {
      fail('Limits must be positive decimal integers: requestsPerMinute 1..300, maxConcurrent 1..8.');
    }
    limits = { requestsPerMinute, maxConcurrent };
  }
  process.umask(0o077);
  prepareDirectory();
  try { mkdirSync(lock, { mode: 0o700 }); locked = true; }
  catch { fail('Token state is locked; stop other token commands before inspecting a stale lock.'); }
  inspectDirectory(lock, true);
  const state = readState();
  if (command === 'issue') {
    if (state.some((entry) => entry.id === person)) fail('Person already has an active token.');
    const tokenPath = join(directory, `${person}.token`);
    const token = randomBytes(32).toString('base64url');
    let descriptor;
    try {
      descriptor = openSync(tokenPath, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      inspectFile(fstatSync(descriptor));
      writeFileSync(descriptor, `${token}\n`);
      fsyncSync(descriptor);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
    // On a failed publication retain the private file: never reuse or overwrite it.
    saveState([...state, { id: person, sha256: createHash('sha256').update(token).digest('hex') }]);
    console.log(tokenPath);
    console.log(hashes);
  } else if (command === 'revoke') {
    // Do not touch the plaintext file, even when it has been removed or replaced.
    saveState(state.filter((entry) => entry.id !== person));
    console.log(hashes);
  } else if (command === 'set-limits') {
    const record = state.find((entry) => entry.id === person);
    if (!record) fail('Person has no active token.');
    record.limits = limits;
    saveState(state);
    console.log(hashes);
  } else {
    // Create an empty, validated manifest on first use, never print its contents.
    try { lstatSync(hashes); } catch (error) { if (error.code === 'ENOENT') saveState(state); else throw error; }
    console.log(hashes);
  }
} catch (error) {
  // Filesystem messages can include sensitive input/state. Emit only a fixed code or our safe diagnostics.
  console.error(error.code ? `Token operation failed (${error.code}).` : error.message);
  process.exitCode = 1;
} finally {
  if (locked) {
    try { rmdirSync(lock); }
    catch { console.error('Could not release token-state lock.'); process.exitCode = 1; }
  }
}
