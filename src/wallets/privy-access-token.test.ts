import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createPrivyAccessTokenVerifier } from './privy-access-token.ts';

const appId = 'ledger-auth-test';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
function token(changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ aud: appId, iss: 'privy.io', sub: 'did:privy:disposable',
    sid: 'disposable-session', iat: now, exp: now + 300, ...changes })).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

test('a real signed session verifies; foreign, expired and tampered sessions remain denied', async () => {
  const verify = createPrivyAccessTokenVerifier(appId, publicPem);
  const identity = await verify(token());
  assert.equal(identity.subject, 'did:privy:disposable');
  for (const changes of [{ aud: 'foreign-app' }, { iss: 'foreign-issuer' }, { exp: 1 }])
    await assert.rejects(verify(token(changes)), { code: 'unauthenticated' });
  const valid = token();
  const [header, payload] = valid.split('.');
  await assert.rejects(verify(`${header}.${payload}.${'A'.repeat(86)}`), { code: 'unauthenticated' });
});

test('an unavailable verification-key service is not mislabeled as a signed-out person', async () => {
  const server = createServer((_request, response) => { response.writeHead(503); response.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const verify = createPrivyAccessTokenVerifier(appId, undefined, `http://127.0.0.1:${address.port}`);
    await assert.rejects(verify(token()), { code: 'identity_unavailable' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
