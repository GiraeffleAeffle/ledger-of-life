import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifyEd25519,
} from 'node:crypto';
import { getAddressEncoder, isAddress as isSolanaAddress } from '@solana/kit';
import { isAddress as isEthereumAddress, verifyMessage } from 'viem';
import {
  IdentityError,
  type VerifiedIdentity,
  type VerifiedWallet,
} from '../wallets/identity-policy.ts';
import { formatRecoveryMessage, type RecoveryChallenge } from '../wallets/recovery.ts';
import type { Store } from './store.ts';
import { errorResponse, readBody, sameOrigin } from './http.ts';

const challengeLifetime = 5 * 60 * 1000;
const browserLifetime = 30 * 24 * 60 * 60 * 1000;
const maxPendingChallenges = 12;

export interface RecoveryProof {
  subject: string;
  walletIds: string[];
  checkedAt: string;
}

interface BrowserRecord {
  hash: string;
  createdAt: number;
  expiresAt: number;
}

interface Baseline {
  id: string;
  enrolledAt: string;
  wallets: VerifiedWallet[];
  browserHash: string;
  sessionId: string;
}

interface StoredChallenge {
  challenge: RecoveryChallenge;
  browserHash: string;
  sessionId: string;
  consumedAt: string | null;
}

interface VerificationReceipt {
  challengeId: string;
  walletId: string;
  browserHash: string;
  sessionId: string;
  signatureDigest: string;
  checkedAt: string;
}

interface RecoveryRecord {
  subject: string;
  baseline: Baseline;
  challenges: StoredChallenge[];
  receipts: VerificationReceipt[];
  proof: RecoveryProof | null;
}

export interface IdentitySnapshot {
  profile: VerifiedIdentity;
  baseline: Pick<Baseline, 'id' | 'enrolledAt' | 'wallets'> | null;
  recoveryProof: RecoveryProof | null;
  recovery: {
    status:
      | 'needs_setup'
      | 'needs_baseline'
      | 'wallet_changed'
      | 'use_another_browser'
      | 'sign_in_again'
      | 'ready'
      | 'verified';
    eligibleForChallenge: boolean;
    enrolledBrowser: boolean;
    verifiedWalletIds: string[];
  };
}

export class RecoveryError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RecoveryError';
    this.status = status;
    this.code = code;
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const accountKey = (subject: string) => `identity-recovery:${digest(subject)}`;
const browserKey = (hash: string) => `identity-browser:${hash}`;

function sameWallet(first: VerifiedWallet, second: VerifiedWallet) {
  return (
    first.id === second.id &&
    first.chainType === second.chainType &&
    (first.chainType === 'ethereum'
      ? first.address.toLowerCase() === second.address.toLowerCase()
      : first.address === second.address)
  );
}

function walletsMatch(record: RecoveryRecord, identity: VerifiedIdentity) {
  return (
    record.subject === identity.subject &&
    record.baseline.wallets.length === identity.wallets.length &&
    record.baseline.wallets.every((wallet) =>
      identity.wallets.some((current) => sameWallet(wallet, current)),
    )
  );
}

function setupComplete(identity: VerifiedIdentity) {
  return (
    identity.passkeyCount > 0 &&
    identity.backupLoginLinked &&
    identity.wallets.length === 2 &&
    identity.wallets.filter((wallet) => wallet.chainType === 'ethereum').length === 1 &&
    identity.wallets.filter((wallet) => wallet.chainType === 'solana').length === 1
  );
}

function assertCurrentBaseline(
  record: RecoveryRecord | null,
  identity: VerifiedIdentity,
): asserts record is RecoveryRecord {
  if (!record)
    throw new RecoveryError(
      409,
      'baseline_required',
      'Record your existing wallets before testing recovery.',
    );
  if (!walletsMatch(record, identity))
    throw new RecoveryError(
      409,
      'wallet_changed',
      'Your wallets differ from the recorded originals. Restore access to those wallets before continuing.',
    );
  if (!setupComplete(identity))
    throw new RecoveryError(
      409,
      'account_setup_required',
      'Register a passkey, verify backup email access and create both personal wallets first.',
    );
}

function assertRecoveryBrowser(
  record: RecoveryRecord,
  identity: VerifiedIdentity,
  browser: BrowserRecord,
) {
  if (record.baseline.browserHash === browser.hash)
    throw new RecoveryError(
      409,
      'another_browser_required',
      'Open another browser and sign in to this same account with backup access.',
    );
  if (record.baseline.sessionId === identity.sessionId)
    throw new RecoveryError(
      409,
      'fresh_session_required',
      'Sign in again in the other browser. Copying the enrollment session does not verify recovery.',
    );
}

/** Read-only gate for connected finance; no caller-provided recovery flag is accepted. */
/** Custody services only need the gate to throw when recovery is missing; the result is unused. */
export type RecoveryGate = (store: Store, identity: VerifiedIdentity, walletId: string) => Promise<unknown>;
export async function requireWalletRecovery(
  store: Store,
  identity: VerifiedIdentity,
  walletId: string,
) {
  const record = await store.get<RecoveryRecord>(accountKey(identity.subject));
  assertCurrentBaseline(record, identity);
  const wallet = record.baseline.wallets.find((candidate) => candidate.id === walletId);
  const proof = record.proof;
  if (
    !wallet ||
    !proof ||
    proof.subject !== identity.subject ||
    proof.walletIds.length !== record.baseline.wallets.length ||
    !record.baseline.wallets.every((candidate) => proof.walletIds.includes(candidate.id)) ||
    !Number.isFinite(Date.parse(proof.checkedAt))
  ) {
    throw new RecoveryError(
      409,
      'recovery_required',
      'Verify access to these same wallets in another browser before using connected funds.',
    );
  }
  return { wallet, proof };
}

function snapshot(
  identity: VerifiedIdentity,
  browser: BrowserRecord,
  record: RecoveryRecord | null,
): IdentitySnapshot {
  const complete = setupComplete(identity);
  const matched = record ? walletsMatch(record, identity) : false;
  const enrolledBrowser = record?.baseline.browserHash === browser.hash;
  const freshSession = record?.baseline.sessionId !== identity.sessionId;
  const eligible = Boolean(complete && matched && !enrolledBrowser && freshSession);
  const proof = matched && complete ? (record?.proof ?? null) : null;
  let status: IdentitySnapshot['recovery']['status'];
  if (record && !matched) status = 'wallet_changed';
  else if (!complete) status = 'needs_setup';
  else if (!record) status = 'needs_baseline';
  else if (proof) status = 'verified';
  else if (enrolledBrowser) status = 'use_another_browser';
  else if (!freshSession) status = 'sign_in_again';
  else status = 'ready';
  return {
    profile: identity,
    baseline: record
      ? {
          id: record.baseline.id,
          enrolledAt: record.baseline.enrolledAt,
          wallets: record.baseline.wallets,
        }
      : null,
    recoveryProof: proof,
    recovery: {
      status,
      eligibleForChallenge: eligible,
      enrolledBrowser: Boolean(enrolledBrowser),
      verifiedWalletIds: matched
        ? record!.receipts
            .filter(
              (receipt) =>
                receipt.browserHash === browser.hash && receipt.sessionId === identity.sessionId,
            )
            .map((receipt) => receipt.walletId)
        : [],
    },
  };
}

function secureRequest(request: Request) {
  return new URL(process.env.APP_ORIGIN || request.url).protocol === 'https:';
}

function cookieName(request: Request) {
  return secureRequest(request) ? '__Host-rental_recovery_browser' : 'rental_recovery_browser';
}

function readBrowserToken(request: Request) {
  const name = `${cookieName(request)}=`;
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(name));
  if (values.length !== 1) return null;
  const token = values[0].slice(name.length);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

async function findBrowser(store: Store, request: Request, now: number) {
  const token = readBrowserToken(request);
  if (!token) return null;
  const hash = digest(token);
  const record = await store.get<BrowserRecord>(browserKey(hash));
  return record && record.hash === hash && record.expiresAt > now ? record : null;
}

async function issueBrowser(store: Store, request: Request, now: number) {
  const token = randomBytes(32).toString('hex');
  const browser: BrowserRecord = {
    hash: digest(token),
    createdAt: now,
    expiresAt: now + browserLifetime,
  };
  await store.create(browserKey(browser.hash), browser);
  const secure = secureRequest(request) ? '; Secure' : '';
  return {
    browser,
    cookie: `${cookieName(request)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${browserLifetime / 1000}${secure}`,
  };
}

async function verifiedSignature(wallet: VerifiedWallet, message: string, signature: string) {
  try {
    if (wallet.chainType === 'ethereum') {
      if (!isEthereumAddress(wallet.address) || !/^0x[0-9a-fA-F]{130}$/.test(signature))
        return false;
      return await verifyMessage({
        address: wallet.address,
        message,
        signature: signature as `0x${string}`,
      });
    }
    if (!isSolanaAddress(wallet.address)) return false;
    const bytes = Buffer.from(signature, 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== signature) return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(getAddressEncoder().encode(wallet.address)),
      ]),
      format: 'der',
      type: 'spki',
    });
    return verifyEd25519(null, Buffer.from(message, 'utf8'), publicKey, bytes);
  } catch {
    return false;
  }
}

function stringField(body: Record<string, unknown>, name: string, maximum: number) {
  const value = body[name];
  if (typeof value !== 'string' || !value || value.length > maximum)
    throw new RecoveryError(400, 'invalid_request', `Invalid ${name}.`);
  return value;
}

function onlyFields(body: Record<string, unknown>, names: string[]) {
  if (Object.keys(body).some((key) => !names.includes(key)))
    throw new RecoveryError(400, 'invalid_request', 'Unexpected recovery fields.');
}

function response(value: unknown, cookie?: string) {
  const headers: Record<string, string> = {
    'Cache-Control': 'private, no-store',
    Vary: 'Authorization, Cookie',
  };
  if (cookie) headers['Set-Cookie'] = cookie;
  return Response.json(value, { headers });
}

function failure(error: unknown) {
  if (error instanceof RecoveryError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } },
    );
  if (error instanceof IdentityError) {
    const status =
      error.code === 'unauthenticated' ? 401 : error.code === 'wallet_not_user_owned' ? 403 : 503;
    return Response.json(
      { error: error.message, code: error.code },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return errorResponse(error);
}

export interface IdentityHandlerDependencies {
  getStore: () => Promise<Store>;
  verifyToken: (token: string) => Promise<VerifiedIdentity>;
  now?: () => number;
}

/** All mutation and proof completion for an identity share one durable record. */
export function createIdentityHandlers(dependencies: IdentityHandlerDependencies) {
  const now = dependencies.now ?? Date.now;
  async function authorize(request: Request, write = false) {
    if (write) sameOrigin(request);
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
    if (!match) throw new IdentityError('unauthenticated', 'Sign in to continue.');
    const identity = await dependencies.verifyToken(match[1]);
    const store = await dependencies.getStore();
    return { identity, store };
  }
  async function writeContext(request: Request) {
    const context = await authorize(request, true);
    const browser = await findBrowser(context.store, request, now());
    if (!browser)
      throw new RecoveryError(
        403,
        'browser_required',
        'Refresh account access in this browser before continuing.',
      );
    return { ...context, browser, body: await readBody(request) };
  }

  return {
    async get(request: Request) {
      try {
        const { identity, store } = await authorize(request);
        const existing = await findBrowser(store, request, now());
        const issued = existing
          ? { browser: existing, cookie: undefined }
          : await issueBrowser(store, request, now());
        const record = await store.get<RecoveryRecord>(accountKey(identity.subject));
        return response(snapshot(identity, issued.browser, record), issued.cookie);
      } catch (error) {
        return failure(error);
      }
    },
    async baseline(request: Request) {
      try {
        const { identity, store, browser, body } = await writeContext(request);
        onlyFields(body, []);
        if (!setupComplete(identity))
          throw new RecoveryError(
            409,
            'account_setup_required',
            'Register a passkey, verify backup email access and create both personal wallets first.',
          );
        let record = await store.get<RecoveryRecord>(accountKey(identity.subject));
        if (!record) {
          record = {
            subject: identity.subject,
            baseline: {
              id: randomUUID(),
              enrolledAt: new Date(now()).toISOString(),
              wallets: identity.wallets.map((wallet) => ({ ...wallet })),
              browserHash: browser.hash,
              sessionId: identity.sessionId,
            },
            challenges: [],
            receipts: [],
            proof: null,
          };
          try {
            await store.create(accountKey(identity.subject), record);
          } catch (error) {
            const winner = await store.get<RecoveryRecord>(accountKey(identity.subject));
            if (!winner) throw error;
            record = winner;
          }
        }
        assertCurrentBaseline(record, identity);
        return response(snapshot(identity, browser, record));
      } catch (error) {
        return failure(error);
      }
    },
    async challenge(request: Request) {
      try {
        const { identity, store, browser, body } = await writeContext(request);
        onlyFields(body, ['walletId']);
        const walletId = stringField(body, 'walletId', 128);
        const current = await store.get<RecoveryRecord>(accountKey(identity.subject));
        assertCurrentBaseline(current, identity);
        assertRecoveryBrowser(current, identity, browser);
        const wallet = current.baseline.wallets.find((candidate) => candidate.id === walletId);
        if (!wallet)
          throw new RecoveryError(
            403,
            'wallet_not_enrolled',
            'Choose one of your recorded wallets.',
          );
        const challenge: RecoveryChallenge = {
          id: randomUUID(),
          subject: identity.subject,
          walletId: wallet.id,
          chainType: wallet.chainType,
          address: wallet.address,
          nonce: randomBytes(32).toString('hex'),
          expiresAt: new Date(now() + challengeLifetime).toISOString(),
        };
        const record = await store.update<RecoveryRecord>(accountKey(identity.subject), (state) => {
          assertCurrentBaseline(state, identity);
          assertRecoveryBrowser(state, identity, browser);
          const active = state.challenges.filter(
            (item) => Date.parse(item.challenge.expiresAt) > now(),
          );
          if (active.length >= maxPendingChallenges)
            throw new RecoveryError(
              429,
              'too_many_challenges',
              'Wait five minutes before starting another recovery check.',
            );
          return {
            ...state,
            challenges: [
              ...active,
              {
                challenge,
                browserHash: browser.hash,
                sessionId: identity.sessionId,
                consumedAt: null,
              },
            ],
          };
        });
        return response({
          challenge,
          message: formatRecoveryMessage(challenge),
          recovery: snapshot(identity, browser, record).recovery,
        });
      } catch (error) {
        return failure(error);
      }
    },
    async verify(request: Request) {
      try {
        const { identity, store, browser, body } = await writeContext(request);
        onlyFields(body, ['challengeId', 'signature']);
        const challengeId = stringField(body, 'challengeId', 128);
        const signature = stringField(body, 'signature', 256);
        const current = await store.get<RecoveryRecord>(accountKey(identity.subject));
        assertCurrentBaseline(current, identity);
        assertRecoveryBrowser(current, identity, browser);
        const assertChallenge = (state: RecoveryRecord) => {
          const stored = state.challenges.find((item) => item.challenge.id === challengeId);
          if (
            !stored ||
            stored.challenge.subject !== identity.subject ||
            stored.browserHash !== browser.hash ||
            stored.sessionId !== identity.sessionId
          )
            throw new RecoveryError(
              403,
              'challenge_not_available',
              'This recovery request is not available to this account and browser.',
            );
          if (stored.consumedAt)
            throw new RecoveryError(
              409,
              'challenge_used',
              'This recovery request has already been verified. Refresh account access for its result.',
            );
          if (Date.parse(stored.challenge.expiresAt) <= now())
            throw new RecoveryError(
              410,
              'challenge_expired',
              'This recovery request expired. Request another check.',
            );
          return stored;
        };
        const stored = assertChallenge(current);
        const wallet = current.baseline.wallets.find(
          (item) => item.id === stored.challenge.walletId,
        );
        if (
          !wallet ||
          !sameWallet(wallet, {
            id: stored.challenge.walletId,
            address: stored.challenge.address,
            chainType: stored.challenge.chainType,
          })
        )
          throw new RecoveryError(
            403,
            'wallet_not_enrolled',
            'This recovery request does not match your original wallet.',
          );
        const message = formatRecoveryMessage(stored.challenge);
        if (!(await verifiedSignature(wallet, message, signature)))
          throw new RecoveryError(
            400,
            'invalid_signature',
            'The signature does not verify access to this wallet.',
          );
        const record = await store.update<RecoveryRecord>(accountKey(identity.subject), (state) => {
          assertCurrentBaseline(state, identity);
          assertRecoveryBrowser(state, identity, browser);
          assertChallenge(state);
          const checkedAt = new Date(now()).toISOString();
          const receipt: VerificationReceipt = {
            challengeId,
            walletId: wallet.id,
            browserHash: browser.hash,
            sessionId: identity.sessionId,
            signatureDigest: digest(signature),
            checkedAt,
          };
          const receipts = [
            ...state.receipts.filter((item) => item.walletId !== wallet.id),
            receipt,
          ];
          const allChecked = state.baseline.wallets.every((item) =>
            receipts.some(
              (check) =>
                check.walletId === item.id &&
                check.browserHash === browser.hash &&
                check.sessionId === identity.sessionId,
            ),
          );
          return {
            ...state,
            challenges: state.challenges.map((item) =>
              item.challenge.id === challengeId ? { ...item, consumedAt: checkedAt } : item,
            ),
            receipts,
            proof: allChecked
              ? {
                  subject: identity.subject,
                  walletIds: state.baseline.wallets.map((item) => item.id),
                  checkedAt,
                }
              : state.proof,
          };
        });
        return response(snapshot(identity, browser, record));
      } catch (error) {
        return failure(error);
      }
    },
  };
}
