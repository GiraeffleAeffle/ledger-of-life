import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { verifyAccessToken } from '@privy-io/node';
import { isAddress as isSolanaAddress } from '@solana/kit';
import { isAddress as isEthereumAddress } from 'viem';
import {
  createIdentityVerifier,
  IdentityError,
  type IdentityVerificationDependencies,
} from './identity-policy.ts';

const subject = 'did:privy:tenant_test';
const appId = 'rental-test-app';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const verificationKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const solanaAddress = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ethereumAddress = '0x1111111111111111111111111111111111111111';

function accessToken(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: subject,
      iss: 'privy.io',
      aud: appId,
      iat: now,
      exp: now + 300,
      sid: 'session-test',
      ...overrides,
    }),
  ).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function fixture(overrides: Partial<IdentityVerificationDependencies> = {}) {
  const linked = [
    { type: 'passkey' },
    { type: 'email' },
    {
      type: 'wallet',
      id: 'wallet-solana',
      address: solanaAddress,
      chain_type: 'solana',
      connector_type: 'embedded',
      wallet_client_type: 'privy',
      delegated: false,
    },
    {
      type: 'wallet',
      id: 'wallet-ethereum',
      address: ethereumAddress,
      chain_type: 'ethereum',
      connector_type: 'embedded',
      wallet_client_type: 'privy',
      delegated: false,
    },
    {
      type: 'wallet',
      address: 'attacker-controlled-external',
      chain_type: 'ethereum',
      wallet_client_type: 'metamask',
    },
  ];
  const dependencies: IdentityVerificationDependencies = {
    appId,
    verifyToken: async (access_token) => {
      const claims = await verifyAccessToken({
        access_token,
        app_id: appId,
        verification_key: verificationKey,
      });
      return {
        appId: claims.app_id,
        issuer: claims.issuer,
        subject: claims.user_id,
        sessionId: claims.session_id,
        expiresAt: claims.expiration,
      };
    },
    getUser: async () => ({ id: subject, is_guest: false, linked_accounts: linked }),
    getWallet: async (id) => ({
      id,
      address: id === 'wallet-solana' ? solanaAddress : ethereumAddress,
      chain_type: id === 'wallet-solana' ? 'solana' : 'ethereum',
      owner_id: 'owner-quorum',
      additional_signers: [],
    }),
    getOwner: async (id) => ({
      id,
      user_ids: [subject],
      authorization_keys: [],
      authorization_threshold: 1,
    }),
    isValidAddress: (address, chain) =>
      chain === 'solana' ? isSolanaAddress(address) : isEthereumAddress(address),
    ...overrides,
  };
  return { linked, dependencies, verify: createIdentityVerifier(dependencies) };
}

test('verified JWT plus provider user and sole-owner quorum yields network-aware wallets without client roles', async () => {
  const { verify } = fixture();
  const identity = await verify(
    accessToken({ roles: ['arbitrator'], wallets: [{ address: 'attacker' }] }),
  );
  assert.equal(identity.subject, subject);
  assert.deepEqual(identity.wallets, [
    { id: 'wallet-solana', address: solanaAddress, chainType: 'solana' },
    { id: 'wallet-ethereum', address: ethereumAddress, chainType: 'ethereum' },
  ]);
  assert.equal(identity.passkeyCount, 1);
  assert.equal(identity.backupLoginLinked, true);
  assert.equal('roles' in identity, false);
});

for (const [name, claims] of [
  ['another application', { aud: 'wrong-app' }],
  ['another issuer', { iss: 'attacker.example' }],
  ['expired session', { exp: 1 }],
] as const) {
  test(`rejects ${name} cryptographically before loading an account`, async () => {
    let requested = false;
    const { verify } = fixture({
      getUser: async () => {
        requested = true;
        throw new Error('must not run');
      },
    });
    await assert.rejects(verify(accessToken(claims)), { code: 'unauthenticated' });
    assert.equal(requested, false);
  });
}

test('rejects a tampered signature and never treats provider outage as anonymous success', async () => {
  const { verify } = fixture();
  const token = accessToken();
  const split = token.split('.');
  split[1] = Buffer.from(JSON.stringify({ sub: 'did:privy:attacker' })).toString('base64url');
  await assert.rejects(verify(split.join('.')), { code: 'unauthenticated' });
  const outage = fixture({
    getUser: async () => {
      throw new Error('provider offline');
    },
  });
  await assert.rejects(outage.verify(token), { code: 'identity_unavailable' });
});

test('rejects fetched user mismatch and guests', async () => {
  for (const user of [{ id: 'did:privy:other' }, { id: subject, is_guest: true }]) {
    const { verify } = fixture({ getUser: async () => ({ ...user, linked_accounts: [] }) });
    await assert.rejects(verify(accessToken()), { code: 'unauthenticated' });
  }
});

test('a Solana case change is a different address, not normalization', async () => {
  const { dependencies } = fixture();
  const verify = createIdentityVerifier({
    ...dependencies,
    getWallet: async (id) => ({
      ...(await dependencies.getWallet(id)),
      address: solanaAddress.toLowerCase(),
    }),
  });
  await assert.rejects(verify(accessToken()), { code: 'wallet_not_user_owned' });
});

test('rejects additional signers, automations, foreign owners and imported keys', async () => {
  const { dependencies } = fixture();
  for (const extra of [
    { additional_signers: [{ signer_id: 'server-key' }] },
    { automations: [{ id: 'server-automation' }] },
    { imported_at: Date.now() },
    { owner_id: null },
  ]) {
    const verify = createIdentityVerifier({
      ...dependencies,
      getWallet: async (id) => ({ ...(await dependencies.getWallet(id)), ...extra }),
    });
    await assert.rejects(verify(accessToken()), { code: 'wallet_not_user_owned' });
  }
  for (const extra of [
    { user_ids: ['did:privy:landlord'] },
    { authorization_keys: [{ public_key: 'server-key' }] },
    { key_quorum_ids: ['nested-operator-quorum'] },
  ]) {
    const verify = createIdentityVerifier({
      ...dependencies,
      getOwner: async (id) => ({ ...(await dependencies.getOwner(id)), ...extra }),
    });
    await assert.rejects(verify(accessToken()), { code: 'wallet_not_user_owned' });
  }
});

test('a missing wallet observation is unavailable, never an empty success', async () => {
  const { verify } = fixture({
    getWallet: async () => {
      throw new Error('unavailable');
    },
  });
  await assert.rejects(
    verify(accessToken()),
    (error) => error instanceof IdentityError && error.code === 'identity_unavailable',
  );
});

test('simultaneous area requests share verified identity until the short ownership window ends', async () => {
  let clock = Date.now();
  let reads = 0;
  const { dependencies } = fixture();
  const verify = createIdentityVerifier({
    ...dependencies,
    now: () => clock,
    getUser: async (id) => {
      reads++;
      return dependencies.getUser(id);
    },
  });
  const token = accessToken();
  const identities = await Promise.all(Array.from({ length: 12 }, () => verify(token)));
  assert.equal(reads, 1);
  assert.ok(identities.every((identity) => identity === identities[0]));
  clock += 30_001;
  await verify(token);
  assert.equal(reads, 2);
});

test('provider failure is not cached, and refreshed ownership cannot outlive the cache window', async () => {
  let clock = Date.now();
  let unavailable = true;
  let otherSigner = false;
  const { dependencies } = fixture();
  const verify = createIdentityVerifier({
    ...dependencies,
    now: () => clock,
    getUser: async (id) => {
      if (unavailable) throw new Error('provider offline');
      return dependencies.getUser(id);
    },
    getWallet: async (id) => ({
      ...(await dependencies.getWallet(id)),
      additional_signers: otherSigner ? [{ signer_id: 'foreign' }] : [],
    }),
  });
  const token = accessToken();
  await assert.rejects(verify(token), { code: 'identity_unavailable' });
  unavailable = false;
  await verify(token);
  otherSigner = true;
  clock += 30_001;
  await assert.rejects(verify(token), { code: 'wallet_not_user_owned' });
});

test('a cached identity stops at the access token expiration', async () => {
  let clock = Date.now();
  const { dependencies } = fixture();
  const verify = createIdentityVerifier({ ...dependencies, now: () => clock });
  const token = accessToken({ exp: Math.floor(clock / 1000) + 30 });
  await verify(token);
  clock += 31_000;
  await assert.rejects(verify(token), { code: 'unauthenticated' });
});
