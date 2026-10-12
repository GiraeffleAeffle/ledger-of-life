import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { constants, openSync, closeSync, lstatSync, fstatSync, readSync, writeFileSync, fsyncSync, fchmodSync, chmodSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { signRevocations, revocationKeyId, verifyRevocations } from '../../stadtstack-data/src/civic-revocations.ts';
import { GOVERNED_REVOCATION_SIGNER_PINS, requireGovernedRevocationSignerPins, loadGovernedRevocations } from '../../stadtstack-data/src/mcp-revocation-config.ts';
import { verifyDataRelease } from '../../stadtstack-data/src/data-release.ts';

const VM_KEY_ID = 'ed25519:8393ad2b0087229073c57103c2e47a1b6f6e987c781b00bcbbaae060aa5ceebd';
const KEY_DIRECTORY = '/var/lib/stadtstack-signer';
const KEY_PATH = join(KEY_DIRECTORY, 'revocation-signer.pem');
const OUTPUT_BASE = '/var/lib/stadtstack-cohorts/0.3.2';
const STAGE_BASE = '/var/lib/stadtstack-signer-stages';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Explicit test injection only. Production main supplies a lazy, custody-checked key reader. */
export async function buildEmptyRevocationCohort({ releaseDir, packageVersion, privateKey, getPrivateKey = () => privateKey, pins, signingKeyId, sequence, issuedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }) {
  if (packageVersion !== '0.3.2') throw Error('Expected package version 0.3.2');
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw Error('Invalid sequence');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(issuedAt) || new Date(issuedAt).toISOString() !== issuedAt.replace('Z', '.000Z')) throw Error('Invalid UTC seconds timestamp');
  const { id: releaseId } = await verifyDataRelease(releaseDir);
  if (!Array.isArray(pins) || pins.length !== 2) throw Error('Exactly two signer pins required');
  const key = getPrivateKey(); // No key access or signing before complete release verification.
  const keyId = revocationKeyId(createPublicKey(key));
  if (keyId !== signingKeyId) throw Error('Unexpected signing key');
  const artifactBytes = Buffer.from(signRevocations({ schemaVersion: 'stadtstack-revocations-v1', releaseId, issuedAt, sequence, targets: [] }, keyId, key));
  const trust = { schemaVersion: 'stadtstack-revocation-trust-v1', releaseId, expectedArtifactSha256: sha256(artifactBytes), keys: pins };
  verifyRevocations(artifactBytes, trust, releaseId);
  return { artifactBytes, trustBytes: Buffer.from(JSON.stringify(trust)), releaseId, issuedAt, sequence, keyId };
}

function trustedChain(path, exactMode) {
  let current = sep;
  for (const component of ['', ...resolve(path).split(sep).filter(Boolean)]) {
    if (component) current = join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw Error('Unsafe directory custody');
  }
  if (exactMode !== undefined && (lstatSync(path).mode & 0o7777) !== exactMode) throw Error('Unexpected directory mode');
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':');
}
function readProductionKey() {
  trustedChain(KEY_DIRECTORY, 0o700);
  const fd = openSync(KEY_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let pem;
  try {
    const initial = fstatSync(fd, { bigint: true });
    if (!initial.isFile() || initial.uid !== 0n || (initial.mode & 0o7777n) !== 0o600n || initial.nlink !== 1n || initial.size <= 0n || initial.size > 4096n) throw Error('Unsafe signer key custody');
    pem = Buffer.alloc(Number(initial.size) + 1);
    let length = 0;
    while (length < pem.length) {
      const count = readSync(fd, pem, length, pem.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== Number(initial.size) || identity(initial) !== identity(fstatSync(fd, { bigint: true })) || identity(initial) !== identity(lstatSync(KEY_PATH, { bigint: true }))) throw Error('Signer key changed');
    return createPrivateKey(pem.subarray(0, length));
  } finally {
    pem?.fill(0);
    closeSync(fd);
  }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writePublicFile(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, 0o444);
    fsyncSync(fd);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.uid !== 0n || (stat.mode & 0o7777n) !== 0o444n || stat.size !== BigInt(bytes.length) || identity(stat) !== identity(lstatSync(path, { bigint: true }))) throw Error('Public file custody mismatch');
  } finally { closeSync(fd); }
}
function publishAbsent(temporary, destination) {
  // Linux renameat2(RENAME_NOREPLACE): never overwrite even an empty existing directory.
  const program = 'import ctypes,os,sys\nc=ctypes.CDLL(None,use_errno=True)\nr=c.renameat2(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1)\nif r: raise OSError(ctypes.get_errno(),"Atomic cohort publication failed")\n';
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', program, temporary, destination], { env: {}, stdio: 'pipe' });
  if (result.error || result.status !== 0) throw Error('Atomic cohort publication failed');
}
async function main() {
  if (process.getuid?.() !== 0 || process.argv.length !== 6 || process.argv[2] !== '--source-sha' || process.argv[4] !== '--sequence') throw Error('Root-only fixed-purpose invocation required');
  const sourceSha = process.argv[3], sequenceText = process.argv[5];
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^(0|[1-9][0-9]*)$/.test(sequenceText) || !Number.isSafeInteger(Number(sequenceText))) throw Error('Invalid source or sequence');
  const sequence = Number(sequenceText);
  const stage = join(STAGE_BASE, `${sourceSha}-s${sequenceText}`);
  const repo = join(stage, 'repo');
  if (fileURLToPath(import.meta.url) !== join(repo, 'deploy/mcp/sign-revocation-cohort.mjs') || process.cwd() !== stage) throw Error('Expected approved root stage');
  trustedChain(stage);
  trustedChain(OUTPUT_BASE, 0o755);
  const metadata = JSON.parse(readFileSync(join(stage, 'stage.json'), 'utf8'));
  if (metadata.sourceSha !== sourceSha || metadata.sequence !== sequence || metadata.version !== '0.3.2') throw Error('Stage identity mismatch');
  const packageVersion = JSON.parse(readFileSync(join(repo, 'stadtstack-data/package.json'), 'utf8')).version;
  const cohort = await buildEmptyRevocationCohort({ releaseDir: join(repo, 'stadtstack-data/release'), packageVersion, getPrivateKey: readProductionKey, pins: GOVERNED_REVOCATION_SIGNER_PINS, signingKeyId: VM_KEY_ID, sequence });
  requireGovernedRevocationSignerPins(JSON.parse(cohort.trustBytes.toString('utf8')));
  const destination = join(OUTPUT_BASE, cohort.releaseId);
  let temporary = mkdtempSync(join(OUTPUT_BASE, '.pending-'));
  try {
    chmodSync(temporary, 0o700);
    writePublicFile(join(temporary, 'revocations.json'), cohort.artifactBytes);
    writePublicFile(join(temporary, 'trust.json'), cohort.trustBytes);
    chmodSync(temporary, 0o755);
    await loadGovernedRevocations(cohort.releaseId, { STADTSTACK_MCP_REVOCATION_TRUST_FILE: join(temporary, 'trust.json'), STADTSTACK_MCP_REVOCATIONS_FILE: join(temporary, 'revocations.json') });
    syncDirectory(temporary);
    publishAbsent(temporary, destination);
    temporary = undefined;
    syncDirectory(OUTPUT_BASE);
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ releaseId: cohort.releaseId, artifactSha256: sha256(cohort.artifactBytes), trustSha256: sha256(cohort.trustBytes), issuedAt: cohort.issuedAt, sequence, keyIds: GOVERNED_REVOCATION_SIGNER_PINS.map(pin => pin.keyId), directory: destination, sourceSha }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Cohort signing failed; no unsigned fallback.'); process.exitCode = 1; });
}
