import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import {
  MAX_REVOCATION_BYTES, MAX_REVOCATION_TARGETS, REVOCATION_SIGNATURE_DOMAIN,
  RevocationTargetSchema, RevocationPayloadSchema, SignedRevocationSchema, RevocationTrustSchema,
  compareRevocationTargets, revocationHostFromUrl, revocationKeyId,
  signRevocations, verifyRevocations, isRecordRevoked, isSourceRevoked,
  type RevocationPayload, type RevocationTarget, type RevocationTrust, type VerifiedRevocations,
} from '../src/civic-revocations.ts';

// All keys are synthetic, generated in memory. No source/model/network/filesystem calls.
const releaseId = 'a'.repeat(64), otherReleaseId = 'b'.repeat(64);
const mcpSourceId = `source:${'c'.repeat(64)}`;
function payload(targets: RevocationTarget[] = []): RevocationPayload {
  return { schemaVersion: 'stadtstack-revocations-v1', releaseId, issuedAt: '2020-01-01T00:00:00Z', sequence: 1, targets: [...targets].sort(compareRevocationTargets) };
}
function canonicalFixture(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalFixture(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function trustFor(bytes: Uint8Array, publicKey: KeyObject): RevocationTrust {
  return {
    schemaVersion: 'stadtstack-revocation-trust-v1', releaseId,
    expectedArtifactSha256: createHash('sha256').update(bytes).digest('hex'),
    keys: [{ keyId: revocationKeyId(publicKey), publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }],
  };
}
function fixture(targets: RevocationTarget[] = []) {
  const keys = generateKeyPairSync('ed25519');
  const keyId = revocationKeyId(keys.publicKey);
  const bytes = signRevocations(payload(targets), keyId, keys.privateKey);
  const trust = trustFor(bytes, keys.publicKey);
  return { ...keys, keyId, bytes, trust, state: verifyRevocations(bytes, trust, releaseId) };
}
// Independent Node-crypto signing permits correctly signed but schema-invalid fixtures.
function rawSigned(unsigned: object, privateKey: KeyObject, domain = REVOCATION_SIGNATURE_DOMAIN): Uint8Array {
  const signature = sign(null, Buffer.from(domain + canonicalFixture(unsigned)), privateKey).toString('base64');
  return Buffer.from(canonicalFixture({ ...unsigned, signature }));
}

test('genuine signed empty masks remain explicit verified state without expiry-driven changes', () => {
  const f = fixture();
  assert.equal(f.state.releaseId, releaseId);
  assert.equal(f.state.artifactSha256, f.trust.expectedArtifactSha256);
  assert.equal(f.state.issuedAt, '2020-01-01T00:00:00Z');
  assert.equal(f.state.sequence, 1);
  assert.equal(f.state.keyId, f.keyId);
  assert.deepEqual(f.state.targets, []);
  assert.equal(isRecordRevoked(f.state, { recordId: 'record:1', sources: [] }), false);
  assert.equal(isSourceRevoked(f.state, { mcpSourceId, municipalityId: 'town-a', registrySourceId: 'council' }), false);
  assert.equal(SignedRevocationSchema.parse(JSON.parse(Buffer.from(f.bytes).toString())).algorithm, 'Ed25519');
  assert.deepEqual(RevocationTrustSchema.parse(f.trust), f.trust);
});

test('signer binds canonical unsigned envelope and fixed domain using real detached Ed25519', () => {
  const f = fixture([{ type: 'record', recordId: 'record:1' }]);
  const { signature, ...unsigned } = JSON.parse(Buffer.from(f.bytes).toString());
  assert.equal(Buffer.from(f.bytes).toString(), canonicalFixture({ ...unsigned, signature }));
  assert.equal(Buffer.from(f.bytes).toString().endsWith('\n'), false);
  assert.equal(Buffer.from(signature, 'base64').length, 64);
  assert.equal(verify(null, Buffer.from(REVOCATION_SIGNATURE_DOMAIN + canonicalFixture(unsigned)), f.publicKey, Buffer.from(signature, 'base64')), true);
  assert.equal(verify(null, Buffer.from(canonicalFixture(unsigned)), f.publicKey, Buffer.from(signature, 'base64')), false);
  assert.equal(verify(null, Buffer.from(REVOCATION_SIGNATURE_DOMAIN + canonicalFixture(unsigned.payload)), f.publicKey, Buffer.from(signature, 'base64')), false);
  assert.equal(isRecordRevoked(f.state, { recordId: 'record:1', sources: [] }), true);
  assert.equal(isRecordRevoked(f.state, { recordId: 'record:2', sources: [] }), false);
  assert.deepEqual(signRevocations(payload([{ type: 'record', recordId: 'record:1' }]), f.keyId, f.privateKey), f.bytes);
});

test('tampering fails hash pin and fails real signature even under a matching changed-byte pin', () => {
  const f = fixture([{ type: 'record', recordId: 'record:1' }]);
  const envelope = JSON.parse(Buffer.from(f.bytes).toString());
  envelope.payload.targets = [];
  const tampered = Buffer.from(canonicalFixture(envelope));
  assert.throws(() => verifyRevocations(tampered, f.trust, releaseId), /hash mismatch/);
  assert.throws(() => verifyRevocations(tampered, trustFor(tampered, f.publicKey), releaseId), /signature/);
  const signature = Buffer.from(envelope.signature, 'base64');
  signature[0] ^= 1;
  envelope.signature = signature.toString('base64');
  const forged = Buffer.from(canonicalFixture(envelope));
  assert.throws(() => verifyRevocations(forged, trustFor(forged, f.publicKey), releaseId), /signature/);
});

test('new governed raw artifact pin rejects replay of a formerly valid empty or older mask', () => {
  const f = fixture();
  const updatedPayload = { ...payload([{ type: 'record', recordId: 'record:1' }]), sequence: 2, issuedAt: '2020-01-02T00:00:00Z' };
  const updated = signRevocations(updatedPayload, f.keyId, f.privateKey);
  const updatedTrust = trustFor(updated, f.publicKey);
  assert.throws(() => verifyRevocations(f.bytes, updatedTrust, releaseId), /hash mismatch/);
  assert.equal(isRecordRevoked(verifyRevocations(updated, updatedTrust, releaseId), { recordId: 'record:1', sources: [] }), true);
  // Even unchanged sequence/issuedAt cannot evade the exact artifact pin.
  const sameAdministrativeMetadata = signRevocations(payload([{ type: 'record', recordId: 'record:2' }]), f.keyId, f.privateKey);
  assert.throws(() => verifyRevocations(f.bytes, trustFor(sameAdministrativeMetadata, f.publicKey), releaseId), /hash mismatch/);
});

test('serving manifest, trust release and signed payload release must all match', () => {
  const f = fixture();
  assert.throws(() => verifyRevocations(f.bytes, f.trust, otherReleaseId), /trust release mismatch/);
  assert.throws(() => verifyRevocations(f.bytes, { ...f.trust, releaseId: otherReleaseId }, otherReleaseId), /payload release mismatch/);
  const foreign = signRevocations({ ...payload(), releaseId: otherReleaseId }, f.keyId, f.privateKey);
  assert.throws(() => verifyRevocations(foreign, trustFor(foreign, f.publicKey), releaseId), /payload release mismatch/);
});

test('wrong signer, claimed algorithm and signing domain are rejected without envelope trust', () => {
  const f = fixture(), other = generateKeyPairSync('ed25519');
  const envelope = JSON.parse(Buffer.from(f.bytes).toString());
  const { signature: _signature, ...unsigned } = envelope;
  assert.throws(() => verifyRevocations(f.bytes, trustFor(f.bytes, other.publicKey), releaseId), /Untrusted/);
  const forgedSigner = rawSigned(unsigned, other.privateKey);
  assert.throws(() => verifyRevocations(forgedSigner, trustFor(forgedSigner, f.publicKey), releaseId), /signature/);
  const wrongDomain = rawSigned(unsigned, f.privateKey, 'other-protocol\n');
  assert.throws(() => verifyRevocations(wrongDomain, trustFor(wrongDomain, f.publicKey), releaseId), /signature/);
  const wrongAlgorithm = rawSigned({ ...unsigned, algorithm: 'ES256' }, f.privateKey);
  assert.throws(() => verifyRevocations(wrongAlgorithm, trustFor(wrongAlgorithm, f.publicKey), releaseId));
  for (const injected of [
    { ...unsigned, publicKeySpki: f.trust.keys[0].publicKeySpki },
    { ...unsigned, keys: f.trust.keys },
    { ...unsigned, trust: f.trust },
  ]) {
    const bytes = rawSigned(injected, f.privateKey);
    assert.throws(() => verifyRevocations(bytes, trustFor(bytes, f.publicKey), releaseId));
  }
});

test('strict trust rejects private, malformed, foreign-algorithm and mislabeled keys', () => {
  const f = fixture(), ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const key of [
    { ...f.trust.keys[0], privateKey: 'not-permitted' },
    { ...f.trust.keys[0], publicKeySpki: f.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') },
    { ...f.trust.keys[0], publicKeySpki: ec.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    { ...f.trust.keys[0], publicKeySpki: f.trust.keys[0].publicKeySpki.trimEnd().replace(/=$/, '') },
    { ...f.trust.keys[0], publicKeySpki: '!'.repeat(60) },
    { ...f.trust.keys[0], keyId: `ed25519:${'0'.repeat(64)}` },
  ]) assert.throws(() => verifyRevocations(f.bytes, { ...f.trust, keys: [key] }, releaseId));
  for (const trust of [undefined, null, {}, { ...f.trust, keys: [] }, { ...f.trust, keys: [f.trust.keys[0], f.trust.keys[0]] }, { ...f.trust, privateKey: 'forbidden' }]) {
    assert.throws(() => verifyRevocations(f.bytes, trust, releaseId));
  }
  assert.throws(() => signRevocations(payload(), f.keyId, f.publicKey), /private key/);
  assert.throws(() => signRevocations(payload(), f.keyId, ec.privateKey), /Ed25519/);
  assert.throws(() => signRevocations(payload(), `ed25519:${'0'.repeat(64)}`, f.privateKey), /key ID mismatch/);
  assert.throws(() => revocationKeyId(f.privateKey), /public key/);
});

test('typed source identities do not cross MCP, registry, municipality or record namespaces', () => {
  const f = fixture([
    { type: 'mcp_source', mcpSourceId },
    { type: 'registry_source', municipalityId: 'town-a', registrySourceId: 'council' },
    { type: 'record', recordId: 'record:1' },
  ]);
  assert.equal(isSourceRevoked(f.state, { mcpSourceId }), true);
  assert.equal(isSourceRevoked(f.state, { municipalityId: 'town-a', registrySourceId: mcpSourceId }), false);
  assert.equal(isSourceRevoked(f.state, { mcpSourceId: 'council' }), false);
  assert.equal(isSourceRevoked(f.state, { registrySourceId: 'council' }), false);
  assert.equal(isSourceRevoked(f.state, { municipalityId: 'town-b', registrySourceId: 'council' }), false);
  assert.equal(isSourceRevoked(f.state, { municipalityId: 'town-a', registrySourceId: 'council' }), true);
  assert.equal(isSourceRevoked(f.state, { registrySourceId: 'record:1', municipalityId: 'town-a' }), false);
  assert.equal(isRecordRevoked(f.state, { recordId: mcpSourceId, sources: [] }), false);
  assert.equal(isRecordRevoked(f.state, { recordId: 'record:2', municipalityId: 'town-a', sources: [{ registrySourceId: 'council' }] }), true);
  assert.equal(isRecordRevoked(f.state, { recordId: 'record:2', municipalityId: 'town-a', sources: [{ municipalityId: 'town-b', registrySourceId: 'council' }] }), false);
  assert.equal(isRecordRevoked(f.state, { recordId: 'record:2', sources: [{ url: 'https://unrelated.example/' }, { mcpSourceId }] }), true);
});

test('exact normalized hosts cover IDNA, case and DNS root dot but never subdomains or suffixes', () => {
  const f = fixture([{ type: 'host', host: 'example.com' }, { type: 'host', host: 'xn--bcher-kva.example' }]);
  for (const url of ['https://example.com/a', 'https://EXAMPLE.COM.:443/a', 'http://example.com:8080/a', 'https://bücher.example/a']) {
    assert.equal(isSourceRevoked(f.state, { url }), true, url);
  }
  for (const url of ['https://sub.example.com/a', 'https://example.com.evil.test/a', 'https://notexample.com/a', 'https://example.com@unrelated.example/a']) {
    assert.equal(isSourceRevoked(f.state, { url }), false, url);
  }
  assert.equal(revocationHostFromUrl('https://BÜCHER.example./'), 'xn--bcher-kva.example');
  assert.throws(() => isSourceRevoked(f.state, { url: 'not a URL' }));
  assert.throws(() => isSourceRevoked(f.state, { url: 'file:///example.com' }));
  for (const host of ['EXAMPLE.com', 'example.com.', '*.example.com', '.example.com', 'example.com:443', 'https://example.com', 'example.com/a', 'bücher.example', 'example..com', '-bad.example']) {
    assert.equal(RevocationTargetSchema.safeParse({ type: 'host', host }).success, false, host);
  }
  assert.equal(RevocationTargetSchema.safeParse({ type: 'host', host: '[2001:db8::1]' }).success, true);
});

test('opaque record and registry IDs retain URL punctuation, Unicode and literal whitespace', () => {
  const ids = [
    'council:https://example.test/vorlage?id=Grün+1#Beschluss',
    'dokument:Öffentliche Sitzung 東京',
    'record:é',
    ' record:padding ',
    `record:${'x'.repeat(1024)}`,
  ];
  const f = fixture(ids.flatMap((id): RevocationTarget[] => [
    { type: 'record', recordId: id },
    { type: 'registry_source', municipalityId: 'town-a', registrySourceId: id },
  ]));
  for (const id of ids) {
    assert.equal(isRecordRevoked(f.state, { recordId: id, sources: [] }), true);
    assert.equal(isSourceRevoked(f.state, { municipalityId: 'town-a', registrySourceId: id }), true);
    assert.equal(isSourceRevoked(f.state, { municipalityId: 'town-b', registrySourceId: id }), false);
    assert.equal(isRecordRevoked(f.state, { recordId: id.toUpperCase(), sources: [] }), false);
  }
  for (const id of ['record:e\u0301', 'record:padding', 'record:é ', 'council:https://example.test/vorlage?id=Gr%C3%BCn+1#Beschluss']) {
    assert.equal(isRecordRevoked(f.state, { recordId: id, sources: [] }), false);
    assert.equal(isSourceRevoked(f.state, { municipalityId: 'town-a', registrySourceId: id }), false);
  }
  for (const id of ['record:\n1', 'record:\u00001', 'registry:\u0085id', '']) {
    assert.equal(RevocationTargetSchema.safeParse({ type: 'record', recordId: id }).success, false);
    assert.equal(RevocationTargetSchema.safeParse({ type: 'registry_source', municipalityId: 'town-a', registrySourceId: id }).success, false);
  }
});

test('strict signed schemas reject unsorted, duplicate, ambiguous and uncontrolled fields', () => {
  const f = fixture(), envelope = JSON.parse(Buffer.from(f.bytes).toString());
  const { signature: _signature, ...unsigned } = envelope;
  const invalidPayloads = [
    { ...payload(), targets: [{ type: 'record', recordId: 'b' }, { type: 'record', recordId: 'a' }] },
    { ...payload(), targets: [{ type: 'record', recordId: 'a' }, { type: 'record', recordId: 'a' }] },
    { ...payload(), targets: [{ type: 'registry_source', registrySourceId: 'council' }] },
    { ...payload(), targets: [{ type: 'mcp_source', mcpSourceId: 'registry-label' }] },
    { ...payload(), targets: [{ type: 'host', host: '*.example.com' }] },
    { ...payload(), targets: [{ type: 'record', recordId: 'a', reason: 'private legal assertion' }] },
    { ...payload(), reason: 'private legal assertion' },
    { ...payload(), expiresAt: '2020-01-02T00:00:00Z' },
    { ...payload(), sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...payload(), sequence: -1 },
    { ...payload(), issuedAt: '2020-02-30T00:00:00Z' },
    { ...payload(), releaseId: releaseId.toUpperCase() },
  ];
  for (const invalid of invalidPayloads) {
    assert.equal(RevocationPayloadSchema.safeParse(invalid).success, false);
    const bytes = rawSigned({ ...unsigned, payload: invalid }, f.privateKey);
    assert.throws(() => verifyRevocations(bytes, trustFor(bytes, f.publicKey), releaseId));
  }
  assert.equal(RevocationPayloadSchema.safeParse({ ...payload(), issuedAt: '2020-01-01T00:00:00.123Z' }).success, true);
});

test('artifact bounds, canonical bytes, signature encoding and duplicate object keys fail closed', () => {
  const f = fixture(), text = Buffer.from(f.bytes).toString(), envelope = JSON.parse(text);
  const malformed = [
    Buffer.from(text + '\n'),
    Buffer.from(JSON.stringify(envelope, null, 2)),
    Buffer.from(text.replace('{', '{"algorithm":"Ed25519",')),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), f.bytes]),
    Buffer.from([0xff]),
    Buffer.from(canonicalFixture({ ...envelope, signature: '' })),
    Buffer.from(canonicalFixture({ ...envelope, signature: '!'.repeat(88) })),
    Buffer.from(canonicalFixture({ ...envelope, signature: envelope.signature.replace(/=+$/, '') })),
  ];
  for (const bytes of malformed) assert.throws(() => verifyRevocations(bytes, trustFor(bytes, f.publicKey), releaseId));
  assert.throws(() => verifyRevocations(new Uint8Array(), f.trust, releaseId), /byte length/);
  assert.throws(() => verifyRevocations(new Uint8Array(MAX_REVOCATION_BYTES + 1), f.trust, releaseId), /byte length/);
  const tooMany = Array.from({ length: MAX_REVOCATION_TARGETS + 1 }, (_, i): RevocationTarget => ({ type: 'record', recordId: `record:${String(i).padStart(5, '0')}` }));
  assert.throws(() => signRevocations(payload(tooMany), f.keyId, f.privateKey));
  const tooLarge = tooMany.slice(0, MAX_REVOCATION_TARGETS).map((target, i): RevocationTarget => ({ type: 'record', recordId: `${String(i).padStart(5, '0')}${'x'.repeat(500)}` }));
  assert.throws(() => signRevocations(payload(tooLarge), f.keyId, f.privateKey), /byte limit/);
});

test('verified states and targets are immutable and cannot be forged by structural copies', () => {
  const f = fixture([{ type: 'record', recordId: 'record:1' }]);
  assert.equal(Object.isFrozen(f.state), true);
  assert.equal(Object.isFrozen(f.state.targets), true);
  assert.equal(Object.isFrozen(f.state.targets[0]), true);
  assert.throws(() => Object.assign(f.state, { releaseId: otherReleaseId }));
  assert.throws(() => Object.assign(f.state.targets[0], { recordId: 'record:2' }));
  assert.throws(() => (f.state.targets as RevocationTarget[]).push({ type: 'record', recordId: 'record:2' }));
  for (const fake of [{ ...f.state }, {}, undefined, null]) {
    assert.throws(() => isSourceRevoked(fake as VerifiedRevocations, {}), /verified revocation state/);
    assert.throws(() => isRecordRevoked(fake as VerifiedRevocations, { recordId: 'record:1', sources: [] }), /verified revocation state/);
  }
  f.bytes.fill(0);
  f.trust.keys.length = 0;
  assert.equal(isRecordRevoked(f.state, { recordId: 'record:1', sources: [] }), true);
});
