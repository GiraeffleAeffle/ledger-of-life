import { IdentityError, type VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { Store } from './store.ts';

/** Provider-verified passkey and sole-owned wallet; no recovery record or browser tracking. */
export type WalletAccessGate = (store: Store, identity: VerifiedIdentity, walletId: string) => Promise<unknown>;
export async function requireWalletAccess(_store: Store, identity: VerifiedIdentity, walletId: string) {
  if (identity.passkeyCount < 1) throw new IdentityError('unauthenticated', 'Add a passkey before using a tenancy wallet.');
  const wallet = identity.wallets.find((candidate) => candidate.id === walletId);
  if (!wallet) throw new IdentityError('wallet_not_user_owned', 'This wallet is not linked to your account.');
  return { wallet };
}
