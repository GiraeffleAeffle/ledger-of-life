import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/workflow.ts';
import type { Store } from './store.ts';

/**
 * EU Digital Identity Wallet via OpenID4VP, using the EU's hosted reference verifier
 * (test environment, public "TEST-01" registration). The app asks a PID credential for the birth
 * date (the current EU PID carries no age-over-18 flag) and, only if the person opts in, the city
 * of residence. It keeps only the derived statement ("adult", optional city), never the birth
 * date, the credential or any other attribute.
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
  /** City of residence (PID address.locality), only when the person chose to share it. */
  city?: string;
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

export async function startIdentityRequest(store: Store, identity: VerifiedIdentity, options: { shareCity: boolean }) {
  const birth = { id: 'birth', path: ['birthdate'] };
  const city = { id: 'city', path: ['address', 'locality'] };
  // With the city requested, claim_sets let the wallet fall back to birth date only when the PID has no address.
  const pidQuery = options.shareCity
    ? { claims: [birth, city], claim_sets: [['birth', 'city'], ['birth']] }
    : { claims: [birth] };
  const nonce = randomBytes(18).toString('base64url');
  const response = await fetch(`${VERIFIER}/ui/presentations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      dcql_query: {
        credentials: [{ id: QUERY_ID, format: 'dc+sd-jwt', meta: { vct_values: [PID_VCT] }, ...pidQuery }],
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
  // Store only if this exact request is still pending: "Forget" or a newer request wins over a late answer.
  const stored = await store
    .update<IdentityRecord>(key(identity.subject), (current) => {
      if (current.pending?.transactionId !== pending.transactionId || current.pending.nonce !== pending.nonce)
        throw new WorkflowError('This request was cancelled.');
      return { statement };
    })
    .catch(() => null);
  return stored ? { state: 'verified', statement } : identityStatus(store, identity);
}

export async function forgetIdentity(store: Store, identity: VerifiedIdentity) {
  await save(store, identity.subject, {});
}

const decodeJson = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/** Whole years between an ISO birth date (YYYY-MM-DD) and `now`, in UTC. */
export function ageOn(birthdate: string, now: Date): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!match) throw new WorkflowError('The wallet shared an unreadable birth date.');
  const [year, month, day] = match.slice(1).map(Number);
  const beforeBirthday = now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day);
  return now.getUTCFullYear() - year - (beforeBirthday ? 1 : 0);
}

/**
 * Reads an SD-JWT VC presentation (issuer JWT ~ disclosures ~ key-binding JWT) into the minimal
 * statement. The birth date is used for the age check and then dropped.
 */
export function statementFromSdJwt(presentation: string, nonce: string, now = new Date()): IdentityStatement {
  const parts = presentation.split('~');
  const issuerJwt = parts[0];
  const keyBinding = parts[parts.length - 1];
  const payload = decodeJson(issuerJwt.split('.')[1] ?? '');
  if (payload.vct !== PID_VCT) throw new WorkflowError('The shared credential is not an EU person identification (PID).');
  if (!keyBinding) throw new WorkflowError('The presentation is not bound to this request.');
  const binding = decodeJson(keyBinding.split('.')[1] ?? '');
  if (binding.nonce !== nonce) throw new WorkflowError('The presentation belongs to a different request.');
  const disclosures = parts.slice(1, -1).filter(Boolean).map((d) => JSON.parse(Buffer.from(d, 'base64url').toString('utf8')) as unknown[]);
  const claim = (name: string) => disclosures.find((d) => d.length === 3 && d[1] === name)?.[2];
  const birthdate = claim('birthdate');
  if (typeof birthdate !== 'string') throw new WorkflowError('The wallet did not share a birth date.');
  if (ageOn(birthdate, now) < 18) throw new WorkflowError('The identity shared is under 18.');
  // locality is disclosed either on its own (nested disclosure) or inside a disclosed address object.
  const address = claim('address') as Record<string, unknown> | undefined;
  const locality = claim('locality') ?? address?.locality;
  return {
    adult: true,
    ...(typeof locality === 'string' && locality.trim() ? { city: locality.trim().slice(0, 80) } : {}),
    issuer: String(payload.iss ?? 'unknown issuer'),
    credentialType: PID_VCT,
    verifiedAt: now.toISOString(),
    via: 'EU reference verifier (test environment)',
  };
}
