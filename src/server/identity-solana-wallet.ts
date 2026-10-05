import { createIdentityVerifier, IdentityError, type VerifiedIdentity, type IdentityVerificationDependencies } from '../wallets/identity-policy.ts';

export type SolanaWalletLookup = (subject: string) => Promise<{ id: string; address: string } | null>;
/** Provider ownership checks are identical to sign-in; no token is needed for a payout lookup. */
export function createSolanaWalletLookup(dependencies: IdentityVerificationDependencies): SolanaWalletLookup {
  const cache = new Map<string, { until: number; wallet: { id: string; address: string } }>();
  const verify = createIdentityVerifier({
    ...dependencies,
    verifyToken: async (subject) => ({
      subject, appId: dependencies.appId, issuer: 'privy.io',
      sessionId: 'server-payout-lookup', expiresAt: Math.floor((dependencies.now?.() ?? Date.now()) / 1000) + 60,
    }),
  });
  return async (subject: string): Promise<{ id: string; address: string } | null> => {
    const now = dependencies.now?.() ?? Date.now();
    const hit = cache.get(subject);
    if (hit && hit.until > now) return { ...hit.wallet };
    let identity: VerifiedIdentity;
    try { identity = await verify(subject); }
    catch (error) {
      if (error instanceof IdentityError && (error.code === 'wallet_not_user_owned' || error.code === 'unauthenticated')) return null;
      throw error;
    }
    const wallets = identity.wallets.filter((wallet) => wallet.chainType === 'solana');
    if (wallets.length !== 1) return null;
    const wallet = { id: wallets[0].id, address: wallets[0].address };
    cache.set(subject, { until: now + 120_000, wallet });
    return { ...wallet };
  };
}
