import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getAddressDecoder } from '@solana/kit';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { IdentityError, type VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { RecoveryChallenge } from '../wallets/recovery.ts';
import {
  createIdentityHandlers,
  requireWalletRecovery,
  type IdentitySnapshot,
} from './recovery.ts';
import { LocalStore } from './store.ts';

const origin = process.env.APP_ORIGIN || 'https://rental.example';
const isSecure = new URL(origin).protocol === 'https:';
const cookieName = isSecure ? '__Host-rental_recovery_browser' : 'rental_recovery_browser';

function fixture(filename = ':memory:') {
  let now = Date.parse('2026-09-22T19:00:00.000Z');
  let store = new LocalStore(filename);
  const evm = privateKeyToAccount(generatePrivateKey());
  const ed25519 = generateKeyPairSync('ed25519');
  const solanaAddress = getAddressDecoder().decode(
    new Uint8Array(ed25519.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)),
  );
  const enrollment: VerifiedIdentity = {
    subject: 'did:privy:tenant',
    sessionId: 'session-enrollment',
    expiresAt: Math.floor(now / 1000) + 3600,
    passkeyCount: 1,
    backupLoginLinked: true,
    wallets: [
      { id: 'wallet-ethereum', address: evm.address, chainType: 'ethereum' },
      { id: 'wallet-solana', address: solanaAddress, chainType: 'solana' },
    ],
  };
  const identities = new Map<string, VerifiedIdentity>([
    ['first', enrollment],
    ['second', { ...enrollment, sessionId: 'session-recovery' }],
    ['third', { ...enrollment, sessionId: 'session-third' }],
    ['other', { ...enrollment, subject: 'did:privy:other', sessionId: 'session-other' }],
  ]);
  let verificationCalls = 0;
  const handlers = createIdentityHandlers({
    getStore: async () => store,
    verifyToken: async (token) => {
      verificationCalls++;
      const identity = identities.get(token);
      if (!identity) throw new IdentityError('unauthenticated', 'Sign in to continue.');
      return structuredClone(identity);
    },
    now: () => now,
  });
  async function request(
    method: keyof typeof handlers,
    {
      token = 'first',
      cookie,
      body = {},
      requestOrigin = origin,
    }: { token?: string; cookie?: string; body?: unknown; requestOrigin?: string } = {},
  ) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (cookie) headers.Cookie = cookie;
    const write = method !== 'get';
    if (write) {
      headers.Origin = requestOrigin;
      headers['Content-Type'] = 'application/json';
    }
    const response = await handlers[method](
      new Request(`${origin}/api/identity/${write ? method : ''}`, {
        method: write ? 'POST' : 'GET',
        headers,
        ...(write ? { body: JSON.stringify(body) } : {}),
      }),
    );
    return response;
  }
  async function browser(token = 'first') {
    const result = await request('get', { token });
    assert.equal(result.status, 200);
    const setCookie = result.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    if (isSecure) assert.match(setCookie, /Secure/);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    return setCookie.split(';')[0];
  }
  async function enroll() {
    const cookie = await browser();
    const result = await request('baseline', { cookie });
    assert.equal(result.status, 200);
    return { cookie, data: (await result.json()) as IdentitySnapshot };
  }
  async function challenge(cookie: string, walletId = 'wallet-ethereum', token = 'second') {
    const result = await request('challenge', { token, cookie, body: { walletId } });
    assert.equal(result.status, 200);
    return (await result.json()) as { challenge: RecoveryChallenge; message: string };
  }
  async function signChallenge(issued: { challenge: RecoveryChallenge; message: string }) {
    return issued.challenge.chainType === 'ethereum'
      ? evm.signMessage({ message: issued.message })
      : sign(null, Buffer.from(issued.message), ed25519.privateKey).toString('base64');
  }
  return {
    enrollment,
    identities,
    request,
    browser,
    enroll,
    challenge,
    signChallenge,
    currentStore: () => store,
    calls: () => verificationCalls,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    restart: async () => {
      await store.close();
      store = new LocalStore(filename);
    },
    close: () => store.close(),
  };
}

test('HTTP recovery verifies actual EVM and Ed25519 signatures in another browser and persists the proof', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rental-recovery-test-'));
  const context = fixture(join(directory, 'recovery.sqlite'));
  try {
    const enrolled = await context.enroll();
    assert.equal(enrolled.data.recovery.status, 'use_another_browser');
    assert.equal(enrolled.data.recoveryProof, null);
    await assert.rejects(
      requireWalletRecovery(context.currentStore(), context.enrollment, 'wallet-ethereum'),
      { code: 'recovery_required' },
    );
    const cookie = await context.browser('second');
    assert.notEqual(cookie, enrolled.cookie);
    for (const walletId of ['wallet-ethereum', 'wallet-solana']) {
      const issued = await context.challenge(cookie, walletId);
      const signature = await context.signChallenge(issued);
      const result = await context.request('verify', {
        token: 'second',
        cookie,
        body: { challengeId: issued.challenge.id, signature },
      });
      assert.equal(result.status, 200);
      const data = (await result.json()) as IdentitySnapshot;
      assert.equal(Boolean(data.recoveryProof), walletId === 'wallet-solana');
      if (walletId === 'wallet-solana') {
        assert.equal(data.recovery.status, 'verified');
        assert.deepEqual(data.recoveryProof?.walletIds, ['wallet-ethereum', 'wallet-solana']);
      }
    }
    await context.restart();
    const result = await context.request('get', { cookie: enrolled.cookie });
    const persisted = (await result.json()) as IdentitySnapshot;
    assert.equal(persisted.recoveryProof?.subject, context.enrollment.subject);
    const gate = await requireWalletRecovery(
      context.currentStore(),
      context.enrollment,
      'wallet-ethereum',
    );
    assert.equal(gate.wallet.address, context.enrollment.wallets[0].address);
    assert.equal(gate.proof!.checkedAt, '2026-09-22T19:00:00.000Z');
    assert.equal(JSON.stringify(persisted).includes('browserHash'), false);
    assert.equal(JSON.stringify(persisted).includes('nonce'), false);
  } finally {
    await context.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('same browser and copied enrollment session cannot issue recovery challenges', async () => {
  const context = fixture();
  try {
    const { cookie } = await context.enroll();
    const same = await context.request('challenge', {
      token: 'second',
      cookie,
      body: { walletId: 'wallet-ethereum' },
    });
    assert.equal(same.status, 409);
    assert.equal((await same.json()).code, 'another_browser_required');
    const newCookie = await context.browser('first');
    const copiedSession = await context.request('challenge', {
      cookie: newCookie,
      body: { walletId: 'wallet-ethereum' },
    });
    assert.equal(copiedSession.status, 409);
    assert.equal((await copiedSession.json()).code, 'fresh_session_required');
    const forged = await context.request('challenge', {
      token: 'second',
      cookie: `${cookieName}=${'a'.repeat(64)}`,
      body: { walletId: 'wallet-ethereum' },
    });
    assert.equal(forged.status, 403);
    assert.equal((await forged.json()).code, 'browser_required');
  } finally {
    await context.close();
  }
});

test('duplicate verification races consume the nonce once and remain consumed after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rental-recovery-replay-'));
  const context = fixture(join(directory, 'recovery.sqlite'));
  try {
    await context.enroll();
    const cookie = await context.browser('second');
    const issued = await context.challenge(cookie);
    const body = {
      challengeId: issued.challenge.id,
      signature: await context.signChallenge(issued),
    };
    const results = await Promise.all([
      context.request('verify', { token: 'second', cookie, body }),
      context.request('verify', { token: 'second', cookie, body }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    await context.restart();
    const replay = await context.request('verify', { token: 'second', cookie, body });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, 'challenge_used');
  } finally {
    await context.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed signatures do not consume challenges and a five-minute expiry prevents verification', async () => {
  const context = fixture();
  try {
    await context.enroll();
    const cookie = await context.browser('second');
    const issued = await context.challenge(cookie, 'wallet-solana');
    const invalid = await context.request('verify', {
      token: 'second',
      cookie,
      body: { challengeId: issued.challenge.id, signature: Buffer.alloc(64).toString('base64') },
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'invalid_signature');
    const valid = await context.request('verify', {
      token: 'second',
      cookie,
      body: { challengeId: issued.challenge.id, signature: await context.signChallenge(issued) },
    });
    assert.equal(valid.status, 200);
    const expires = await context.challenge(cookie);
    context.advance(5 * 60 * 1000);
    const expired = await context.request('verify', {
      token: 'second',
      cookie,
      body: { challengeId: expires.challenge.id, signature: await context.signChallenge(expires) },
    });
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).code, 'challenge_expired');
  } finally {
    await context.close();
  }
});

test('a request is bound to one subject, wallet, browser and session', async () => {
  const context = fixture();
  try {
    await context.enroll();
    const cookie = await context.browser('second');
    const issued = await context.challenge(cookie);
    const body = {
      challengeId: issued.challenge.id,
      signature: await context.signChallenge(issued),
    };
    const other = await context.request('verify', { token: 'other', cookie, body });
    assert.notEqual(other.status, 200);
    const thirdCookie = await context.browser('third');
    const wrongBrowser = await context.request('verify', {
      token: 'second',
      cookie: thirdCookie,
      body,
    });
    assert.equal(wrongBrowser.status, 403);
    const wrongSession = await context.request('verify', { token: 'third', cookie, body });
    assert.equal(wrongSession.status, 403);
    const unknownWallet = await context.request('challenge', {
      token: 'second',
      cookie,
      body: { walletId: 'wallet-attacker' },
    });
    assert.equal(unknownWallet.status, 403);
    const injected = await context.request('verify', {
      token: 'second',
      cookie,
      body: { ...body, address: 'attacker', role: 'arbitrator' },
    });
    assert.equal(injected.status, 400);
    const swappedSignature = await privateKeyToAccount(generatePrivateKey()).signMessage({
      message: issued.message,
    });
    const swapped = await context.request('verify', {
      token: 'second',
      cookie,
      body: { ...body, signature: swappedSignature },
    });
    assert.equal(swapped.status, 400);
  } finally {
    await context.close();
  }
});

test('baseline cannot be replaced by a new wallet or client-provided wallet values', async () => {
  const context = fixture();
  try {
    const { cookie, data } = await context.enroll();
    const injected = await context.request('baseline', {
      cookie,
      body: { wallets: [{ id: 'attacker' }] },
    });
    assert.equal(injected.status, 400);
    const second = context.identities.get('second')!;
    context.identities.set('second', {
      ...second,
      wallets: [{ ...second.wallets[0], id: 'wallet-replacement' }, second.wallets[1]],
    });
    const browser = await context.browser('second');
    const replacement = await context.request('baseline', { token: 'second', cookie: browser });
    assert.equal(replacement.status, 409);
    assert.equal((await replacement.json()).code, 'wallet_changed');
    const profile = await context.request('get', { token: 'second', cookie: browser });
    const after = (await profile.json()) as IdentitySnapshot;
    assert.deepEqual(after.baseline, data.baseline);
    assert.equal(after.recoveryProof, null);
    await assert.rejects(
      requireWalletRecovery(
        context.currentStore(),
        context.identities.get('second')!,
        'wallet-replacement',
      ),
      { code: 'wallet_changed' },
    );
  } finally {
    await context.close();
  }
});

test('writes require same origin and an authenticated bearer session', async () => {
  const context = fixture();
  try {
    const { cookie } = await context.enroll();
    const calls = context.calls();
    const crossOrigin = await context.request('baseline', {
      cookie,
      requestOrigin: 'https://attacker.invalid',
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(context.calls(), calls);
    const unauthorized = await context.request('get', { token: 'made-up-session' });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('set-cookie'), null);
    context.identities.set('not-ready', { ...context.enrollment, passkeyCount: 0 });
    const incomplete = await context.request('baseline', { token: 'not-ready', cookie });
    assert.equal(incomplete.status, 409);
    assert.equal((await incomplete.json()).code, 'account_setup_required');
  } finally {
    await context.close();
  }
});
