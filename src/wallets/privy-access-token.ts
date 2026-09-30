import { createRemoteJWKSet, errors, importSPKI, jwtVerify, type JWTPayload } from 'jose';
import { IdentityError } from './identity-policy.ts';

/** Match Privy's ES256 access-token checks while preserving network errors as unavailable, not signed-out. */
export function createPrivyAccessTokenVerifier(appId: string, verificationKey?: string, apiUrl = 'https://api.privy.io') {
  // Keep the JWKS request convention aligned with the pinned @privy-io/node version.
  const remoteKey = verificationKey ? null : createRemoteJWKSet(
    new URL(`${apiUrl.replace(/\/$/, '')}/v1/apps/${encodeURIComponent(appId)}/jwks.json`),
    { cacheMaxAge: 60 * 60 * 1000, cooldownDuration: 10 * 60 * 1000,
      headers: { 'privy-client': 'node:0.35.0' } },
  );
  let localKey: Promise<CryptoKey> | undefined;
  return async (token: string) => {
    let payload: JWTPayload;
    try {
      const key = verificationKey ? await (localKey ??= importSPKI(verificationKey, 'ES256')) : remoteKey!;
      ({ payload } = await jwtVerify(token, key, {
        typ: 'JWT', algorithms: ['ES256'], issuer: 'privy.io', audience: appId,
      }));
    } catch (error) {
      if (error instanceof errors.JWTExpired || error instanceof errors.JWTClaimValidationFailed ||
        error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid ||
        error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JOSEAlgNotAllowed ||
        error instanceof errors.JWKSNoMatchingKey)
        throw new IdentityError('unauthenticated', 'Your session could not be verified. Sign in again.');
      throw new IdentityError('identity_unavailable', 'Account verification is temporarily unavailable.');
    }
    if (typeof payload.aud !== 'string' || typeof payload.iss !== 'string' ||
      typeof payload.sub !== 'string' || typeof payload.sid !== 'string' ||
      typeof payload.iat !== 'number' || payload.iat <= 0 ||
      typeof payload.exp !== 'number' || payload.exp <= 0)
      throw new IdentityError('unauthenticated', 'Your session could not be verified. Sign in again.');
    return {
      appId: payload.aud, issuer: payload.iss, subject: payload.sub,
      sessionId: payload.sid, expiresAt: payload.exp,
    };
  };
}
