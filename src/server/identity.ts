import 'server-only';

import { PrivyClient } from '@privy-io/node';
import { isAddress as isSolanaAddress } from '@solana/kit';
import { isAddress as isEthereumAddress } from 'viem';
import { createIdentityVerifier, IdentityError, type VerifiedIdentity } from '../wallets/identity-policy.ts';
import { createPrivyAccessTokenVerifier } from '../wallets/privy-access-token.ts';
import { createSolanaWalletLookup, type SolanaWalletLookup } from './identity-solana-wallet.ts';

export { IdentityError };
export type { VerifiedIdentity, VerifiedWallet } from '../wallets/identity-policy.ts';

let configuredVerifier: ((token: string) => Promise<VerifiedIdentity>) | undefined;

/** Verifies an access token and current wallet ownership; never signs or assigns roles. */
export async function verifyPrivyToken(token: string) {
  if (!configuredVerifier) {
    const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
    const appSecret = process.env.PRIVY_APP_SECRET?.trim();
    if (!appId || !appSecret) {
      throw new IdentityError('identity_unavailable', 'Account access is not configured yet.');
    }
    const client = new PrivyClient({
      appId,
      appSecret,
      timeout: 10_000,
      maxRetries: 1,
    });
    configuredVerifier = createIdentityVerifier({
      appId,
      verifyToken: createPrivyAccessTokenVerifier(
        appId, process.env.PRIVY_VERIFICATION_KEY?.replace(/\\n/g, '\n'), process.env.PRIVY_API_BASE_URL,
      ),
      getUser: (subject) => client.users()._get(subject),
      getWallet: (id) => client.wallets().get(id),
      getOwner: (id) => client.keyQuorums().get(id),
      isValidAddress: (address, chainType) =>
        chainType === 'solana' ? isSolanaAddress(address) : isEthereumAddress(address),
    });
  }
  return configuredVerifier(token);
}

let payoutLookup: SolanaWalletLookup | undefined;
export async function verifiedSolanaWalletForSubject(subject: string): Promise<{ id: string; address: string } | null> {
  if (!payoutLookup) {
    const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
    const appSecret = process.env.PRIVY_APP_SECRET?.trim();
    if (!appId || !appSecret) throw new IdentityError('identity_unavailable', 'Account access is not configured yet.');
    const client = new PrivyClient({ appId, appSecret, timeout: 10_000, maxRetries: 1 });
    payoutLookup = createSolanaWalletLookup({
      appId, verifyToken: async () => { throw new Error('Not a token verifier'); },
      getUser: (id) => client.users()._get(id),
      getWallet: (id) => client.wallets().get(id),
      getOwner: (id) => client.keyQuorums().get(id),
      isValidAddress: (value, chain) => chain === 'solana' ? isSolanaAddress(value) : isEthereumAddress(value),
    });
  }
  return payoutLookup(subject);
}
