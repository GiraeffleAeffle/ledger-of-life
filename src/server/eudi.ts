import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/workflow.ts';
import type { Store } from './store.ts';

/**
 * EU Digital Identity Wallet via OpenID4VP, using the EU's hosted reference verifier
 * (test environment, public "TEST-01" registration). The app asks only for "age 18 or over"
 * from a PID credential and stores the resulting statement, never the credential itself.
 *
 * Signature and issuer-chain validation happen in the reference verifier before it accepts the
 * wallet's response; this module additionally checks the nonce binding and the credential type.
 */
const VERIFIER = process.env.EUDI_VERIFIER_URL ?? 'https://verifier-backend.eudiw.dev';
const INTENDED_USE = process.env.EUDI_INTENDED_USE_ID ?? 'TEST-01';
const PID_VCT = 'urn:eudi:pid:1';
const PENDING_TTL_MS = 5 * 60_000;
const QUERY_ID = 'pid';

export interface IdentityStatement {
  adult: true;
  issuer: string;
  credentialType: string;
  verifiedAt: string;
  via: 'EU reference verifier (test environment)';
}
interface IdentityRecord {
  pending?: { transactionId: string; nonce: string; startedAt: string };
  statement?: IdentityStatement;
}
export type IdentityStatus =
  | { state: 'none' }
  | { state: 'pending'; startedAt: string }
  | { state: 'verified'; statement: IdentityStatement };

const key = (subject: string) => `eudi:${subject}`;
const save = (store: Store, subject: string, record: IdentityRecord) =>
  store.update<IdentityRecord>(key(subject), () => record).catch(() => store.create(key(subject), record));

export async function identityStatus(store: Store, identity: VerifiedIdentity): Promise<IdentityStatus> {
  const record = (await store.get<IdentityRecord>(key(identity.subject))) ?? {};
  if (record.statement) return { state: 'verified', statement: record.statement };
  if (record.pending && Date.now() - Date.parse(record.pending.startedAt) < PENDING_TTL_MS) return { state: 'pending', startedAt: record.pending.startedAt };
  return { state: 'none' };
}

export async function startIdentityRequest(store: Store, identity: VerifiedIdentity) {
  const nonce = randomBytes(18).toString('base64url');
  const response = await fetch(`${VERIFIER}/ui/presentations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      dcql_query: {
        credentials: [{ id: QUERY_ID, format: 'dc+sd-jwt', meta: { vct_values: [PID_VCT] }, claims: [{ path: ['age_equal_or_over', '18'] }] }],
      },
      nonce,
      jar_mode: 'by_reference',
      request_uri_method: 'get',
      profile: 'openid4vp',
      intended_use_id: INTENDED_USE,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { transaction_id?: string; client_id?: string; request_uri?: string; error?: string };
  if (!response.ok || !body.transaction_id || !body.client_id || !body.request_uri)
    throw new WorkflowError(`The EU test verifier is unavailable${body.error ? ` (${body.error})` : ''}. Please try again.`);
  const params = new URLSearchParams({ client_id: body.client_id, request_uri: body.request_uri, request_uri_method: 'get' });
  const walletLink = `eudi-openid4vp://?${params}`;
  const current = (await store.get<IdentityRecord>(key(identity.subject))) ?? {};
  await save(store, identity.subject, { ...current, pending: { transactionId: body.transaction_id, nonce, startedAt: new Date().toISOString() } });
  return { walletLink, qr: await QRCode.toDataURL(walletLink, { margin: 1, width: 260 }) };
}

export async function pollIdentityRequest(store: Store, identity: VerifiedIdentity): Promise<IdentityStatus> {
  const record = (await store.get<IdentityRecord>(key(identity.subject))) ?? {};
  const pending = record.pending;
  if (!pending || Date.now() - Date.parse(pending.startedAt) >= PENDING_TTL_MS) return identityStatus(store, identity);
  const response = await fetch(`${VERIFIER}/ui/presentations/${encodeURIComponent(pending.transactionId)}`, { signal: AbortSignal.timeout(15_000) });
  // Older hosted verifier versions answer an empty 400 until the wallet has posted; newer ones add
  // "PresentationNotSubmitted". Only InvalidResponseCode is terminal; the pending TTL bounds the wait.
  if (response.status === 400) {
    const error = ((await response.json().catch(() => ({}))) as { error?: string }).error;
    if (error === 'InvalidResponseCode') throw new WorkflowError('The wallet response was not accepted. Please start again.');
    return { state: 'pending', startedAt: pending.startedAt };
  }
  if (response.status === 404) throw new WorkflowError('The request expired at the EU test verifier. Please start again.');
  if (!response.ok) throw new WorkflowError('The EU test verifier is unavailable. Please try again.');
  const body = (await response.json()) as { vp_token?: Record<string, string | string[]> };
  const token = body.vp_token?.[QUERY_ID];
  const presentation = Array.isArray(token) ? token[0] : token;
  if (!presentation) throw new WorkflowError('The wallet did not share an identity credential.');
  const statement = statementFromSdJwt(presentation, pending.nonce);
  await save(store, identity.subject, { statement });
  return { state: 'verified', statement };
}

export async function forgetIdentity(store: Store, identity: VerifiedIdentity) {
  await save(store, identity.subject, {});
}

const decodeJson = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/** Reads an SD-JWT VC presentation (issuer JWT ~ disclosures ~ key-binding JWT) into the minimal statement. */
export function statementFromSdJwt(presentation: string, nonce: string): IdentityStatement {
  const parts = presentation.split('~');
  const issuerJwt = parts[0];
  const keyBinding = parts[parts.length - 1];
  const payload = decodeJson(issuerJwt.split('.')[1] ?? '');
  if (payload.vct !== PID_VCT) throw new WorkflowError('The shared credential is not an EU person identification (PID).');
  if (!keyBinding) throw new WorkflowError('The presentation is not bound to this request.');
  const binding = decodeJson(keyBinding.split('.')[1] ?? '');
  if (binding.nonce !== nonce) throw new WorkflowError('The presentation belongs to a different request.');
  const disclosures = parts.slice(1, -1).filter(Boolean).map((d) => JSON.parse(Buffer.from(d, 'base64url').toString('utf8')) as unknown[]);
  const adult = disclosures.some((d) => d.length === 3 && d[1] === '18' && d[2] === true)
    || disclosures.some((d) => d[1] === 'age_equal_or_over' && (d[2] as Record<string, unknown> | undefined)?.['18'] === true);
  if (!adult) throw new WorkflowError('The wallet did not confirm age 18 or over.');
  return { adult: true, issuer: String(payload.iss ?? 'unknown issuer'), credentialType: PID_VCT, verifiedAt: new Date().toISOString(), via: 'EU reference verifier (test environment)' };
}
