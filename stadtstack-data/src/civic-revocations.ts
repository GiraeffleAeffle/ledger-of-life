import { createHash, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { z } from 'zod';

// Administrative withholding only: these timestamps/targets are not civic events.
export const MAX_REVOCATION_BYTES = 1024 * 1024;
export const MAX_REVOCATION_TARGETS = 4096;
export const REVOCATION_SIGNATURE_DOMAIN = 'stadtstack:civic-revocations:ed25519:v1\n';
const domain = Buffer.from(REVOCATION_SIGNATURE_DOMAIN, 'utf8');
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const keyIdSchema = z.string().regex(/^ed25519:[a-f0-9]{64}$/);
// Published record/registry IDs are opaque. Preserve spelling and whitespace;
// the artifact byte bound, not a new ID grammar, limits their signed representation.
const identifierSchema = z.string().min(1).max(MAX_REVOCATION_BYTES).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u);
const municipalitySchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
const mcpSourceSchema = z.string().regex(/^source:[a-f0-9]{64}$/);

/** Canonical HTTP(S) hostname, including IDNA and removal of a DNS root dot. */
export function revocationHostFromUrl(value: string): string {
  if (value.length > 8192 || value !== value.trim()) throw Error('Invalid revocation source URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw Error('Invalid revocation source URL');
  return url.hostname.toLowerCase().replace(/\.$/, '');
}
const hostSchema = z.string().min(1).max(253).refine(value => {
  try {
    const normalized = revocationHostFromUrl(`https://${value}/`);
    return normalized === value && (value.startsWith('[') || value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)));
  } catch { return false; }
}, 'Expected an exact normalized host, without wildcard, port or path');

export const RevocationTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('record'), recordId: identifierSchema }).strict(),
  z.object({ type: z.literal('host'), host: hostSchema }).strict(),
  z.object({ type: z.literal('mcp_source'), mcpSourceId: mcpSourceSchema }).strict(),
  z.object({ type: z.literal('registry_source'), municipalityId: municipalitySchema, registrySourceId: identifierSchema }).strict(),
]);
export type RevocationTarget = z.infer<typeof RevocationTargetSchema>;

// Versioned wire canonicalization: ASCII key order, JSON primitives, no whitespace.
// Do not import MCP pagination: it initializes a process-local random cursor key.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function targetKey(target: RevocationTarget): string {
  switch (target.type) {
    case 'record': return JSON.stringify([target.type, target.recordId]);
    case 'host': return JSON.stringify([target.type, target.host]);
    case 'mcp_source': return JSON.stringify([target.type, target.mcpSourceId]);
    case 'registry_source': return JSON.stringify([target.type, target.municipalityId, target.registrySourceId]);
  }
}
/** Strict ascending lexical order of JSON tuples [type, ...identity fields]. */
export function compareRevocationTargets(left: RevocationTarget, right: RevocationTarget): number {
  const a = targetKey(left), b = targetKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
const issuedAtSchema = z.string().max(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/).refine(value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === (value.length === 20 ? value.replace('Z', '.000Z') : value);
}, 'Expected a valid UTC administrative timestamp');
export const RevocationPayloadSchema = z.object({
  schemaVersion: z.literal('stadtstack-revocations-v1'),
  releaseId: hashSchema,
  issuedAt: issuedAtSchema,
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  targets: z.array(RevocationTargetSchema).max(MAX_REVOCATION_TARGETS),
}).strict().superRefine((payload, context) => {
  for (let index = 1; index < payload.targets.length; index++) {
    if (compareRevocationTargets(payload.targets[index - 1], payload.targets[index]) >= 0) {
      context.addIssue({ code: 'custom', path: ['targets', index], message: 'Targets must be unique and strictly sorted' });
    }
  }
});
export type RevocationPayload = z.infer<typeof RevocationPayloadSchema>;
const signatureSchema = z.string().length(88).refine(value => {
  if (value.length !== 88) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 64 && bytes.toString('base64') === value;
}, 'Expected a canonical base64 Ed25519 signature');
export const SignedRevocationSchema = z.object({
  schemaVersion: z.literal('stadtstack-signed-revocations-v1'),
  algorithm: z.literal('Ed25519'),
  keyId: keyIdSchema,
  payload: RevocationPayloadSchema,
  signature: signatureSchema,
}).strict();
export type SignedRevocation = z.infer<typeof SignedRevocationSchema>;
const publicKeySchema = z.string().length(60).refine(value => {
  if (value.length !== 60) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 44 && bytes.toString('base64') === value && bytes.subarray(0, spkiPrefix.length).equals(spkiPrefix);
}, 'Expected canonical base64 Ed25519 public SPKI DER, never private key material');
const trustedKeySchema = z.object({ keyId: keyIdSchema, publicKeySpki: publicKeySchema }).strict().refine(key =>
  key.publicKeySpki.length === 60 && key.keyId === `ed25519:${createHash('sha256').update(Buffer.from(key.publicKeySpki, 'base64')).digest('hex')}`,
'Key ID must identify the exact public SPKI DER');
export const RevocationTrustSchema = z.object({
  schemaVersion: z.literal('stadtstack-revocation-trust-v1'),
  releaseId: hashSchema,
  expectedArtifactSha256: hashSchema,
  keys: z.array(trustedKeySchema).min(1).max(16),
}).strict().refine(trust => new Set(trust.keys.map(key => key.keyId)).size === trust.keys.length, 'Duplicate trusted key');
export type RevocationTrust = z.infer<typeof RevocationTrustSchema>;

/** Public-key identity only; callers retain custody of private signing material. */
export function revocationKeyId(publicKey: KeyObject): string {
  if (!(publicKey instanceof KeyObject) || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw Error('Expected an Ed25519 public key');
  }
  return `ed25519:${createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex')}`;
}
function signingBytes(unsigned: Omit<SignedRevocation, 'signature'>): Buffer {
  return Buffer.concat([domain, Buffer.from(canonical(unsigned), 'utf8')]);
}

/** No I/O or private-key persistence. Only an approved caller may invoke signing. */
export function signRevocations(payload: RevocationPayload, keyId: string, privateKey: KeyObject): Uint8Array {
  if (!(privateKey instanceof KeyObject) || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw Error('Expected an Ed25519 private key');
  }
  if (keyId !== revocationKeyId(createPublicKey(privateKey))) throw Error('Signing key ID mismatch');
  const unsigned: Omit<SignedRevocation, 'signature'> = {
    schemaVersion: 'stadtstack-signed-revocations-v1', algorithm: 'Ed25519', keyId,
    payload: RevocationPayloadSchema.parse(payload),
  };
  // Bound before invoking cryptography; an Ed25519 signature has fixed encoded length.
  const length = Buffer.byteLength(canonical({ ...unsigned, signature: 'A'.repeat(88) }));
  if (length > MAX_REVOCATION_BYTES) throw Error('Signed revocation artifact exceeds byte limit');
  const signature = sign(null, signingBytes(unsigned), privateKey).toString('base64');
  return Buffer.from(canonical({ ...unsigned, signature }), 'utf8');
}

declare const verifiedRevocationsBrand: unique symbol;
export type VerifiedRevocations = Readonly<{
  [verifiedRevocationsBrand]: true;
  releaseId: string;
  artifactSha256: string;
  issuedAt: string;
  sequence: number;
  keyId: string;
  targets: readonly Readonly<RevocationTarget>[];
}>;
type TargetIndex = { records: Set<string>; hosts: Set<string>; mcpSources: Set<string>; registrySources: Map<string, Set<string>> };
// Runtime authenticity and private indexes: freezing a Set alone would not prevent mutation.
const verifiedIndexes = new WeakMap<VerifiedRevocations, TargetIndex>();
function indexOf(state: VerifiedRevocations): TargetIndex {
  const index = verifiedIndexes.get(state);
  if (!index) throw Error('Expected verified revocation state');
  return index;
}

/** Trust must come from independent governed configuration, not the artifact. */
export function verifyRevocations(bytes: Uint8Array, trustInput: unknown, expectedReleaseId: string): VerifiedRevocations {
  const trust = RevocationTrustSchema.parse(trustInput);
  hashSchema.parse(expectedReleaseId);
  if (trust.releaseId !== expectedReleaseId) throw Error('Revocation trust release mismatch');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_REVOCATION_BYTES) {
    throw Error('Invalid signed revocation artifact byte length');
  }
  const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
  if (artifactSha256 !== trust.expectedArtifactSha256) throw Error('Revocation artifact hash mismatch');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const envelope = SignedRevocationSchema.parse(JSON.parse(text));
  if (canonical(envelope) !== text) throw Error('Signed revocation artifact is not canonical');
  if (envelope.payload.releaseId !== expectedReleaseId) throw Error('Revocation payload release mismatch');
  const trustedKey = trust.keys.find(key => key.keyId === envelope.keyId);
  if (!trustedKey) throw Error('Untrusted revocation signing key');
  const publicKey = createPublicKey({ key: Buffer.from(trustedKey.publicKeySpki, 'base64'), format: 'der', type: 'spki' });
  const { signature, ...unsigned } = envelope;
  if (!verify(null, signingBytes(unsigned), publicKey, Buffer.from(signature, 'base64'))) throw Error('Invalid revocation signature');
  const index: TargetIndex = { records: new Set(), hosts: new Set(), mcpSources: new Set(), registrySources: new Map() };
  for (const target of envelope.payload.targets) {
    switch (target.type) {
      case 'record': index.records.add(target.recordId); break;
      case 'host': index.hosts.add(target.host); break;
      case 'mcp_source': index.mcpSources.add(target.mcpSourceId); break;
      case 'registry_source': {
        let sources = index.registrySources.get(target.municipalityId);
        if (!sources) { sources = new Set(); index.registrySources.set(target.municipalityId, sources); }
        sources.add(target.registrySourceId);
        break;
      }
    }
    Object.freeze(target);
  }
  const state = Object.freeze({
    releaseId: envelope.payload.releaseId, artifactSha256, issuedAt: envelope.payload.issuedAt,
    sequence: envelope.payload.sequence, keyId: envelope.keyId, targets: Object.freeze(envelope.payload.targets),
  }) as VerifiedRevocations;
  verifiedIndexes.set(state, index);
  return state;
}

export type RevocationSourceDescriptor = Readonly<{
  mcpSourceId?: string;
  municipalityId?: string;
  registrySourceId?: string;
  url?: string;
}>;
function sourceRevoked(index: TargetIndex, source: RevocationSourceDescriptor, municipalityId?: string): boolean {
  if (source.mcpSourceId !== undefined && index.mcpSources.has(source.mcpSourceId)) return true;
  const scope = source.municipalityId ?? municipalityId;
  if (scope !== undefined && source.registrySourceId !== undefined && index.registrySources.get(scope)?.has(source.registrySourceId)) return true;
  return source.url !== undefined && index.hosts.size > 0 && index.hosts.has(revocationHostFromUrl(source.url));
}
export function isSourceRevoked(state: VerifiedRevocations, source: RevocationSourceDescriptor): boolean {
  return sourceRevoked(indexOf(state), source);
}
export function isRecordRevoked(state: VerifiedRevocations, record: Readonly<{
  recordId: string;
  municipalityId?: string;
  sources: readonly RevocationSourceDescriptor[];
}>): boolean {
  const index = indexOf(state);
  return index.records.has(record.recordId) || record.sources.some(source => sourceRevoked(index, source, record.municipalityId));
}
