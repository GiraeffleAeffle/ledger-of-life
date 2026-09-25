'use client';
import { useCallback, useState } from 'react';
import { useRentalWallet } from '@/wallets';
import type { IdentitySnapshot } from '@/server/recovery';

export type AuthorizedRequest = <T>(path: string, body?: unknown) => Promise<T>;

/** The same-wallet recovery check shared by onboarding and Connections. */
export function useRecovery(authorized: AuthorizedRequest) {
  const wallet = useRentalWallet();
  const [identity, setIdentity] = useState<IdentitySnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remember = useCallback((next: IdentitySnapshot) => {
    if (!wallet.authenticated || next.profile.subject !== wallet.subject)
      throw new Error('The verified account changed. Check the current account again.');
    setIdentity(next);
  }, [wallet.authenticated, wallet.subject]);
  const step = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, []);
  const inspect = useCallback(() => step(async () => remember(await authorized<IdentitySnapshot>('/api/identity'))), [authorized, remember, step]);
  const enroll = useCallback(() => step(async () => remember(await authorized<IdentitySnapshot>('/api/identity/baseline', {}))), [authorized, remember, step]);
  const verify = useCallback(() => step(async () => {
    if (!identity?.baseline) throw new Error('Record the original wallets in your first browser.');
    for (const original of identity.baseline.wallets) {
      if (identity.recovery.verifiedWalletIds.includes(original.id)) continue;
      const issued = await authorized<{ message: string; challenge: { id: string } }>('/api/identity/challenge', { walletId: original.id });
      const signed = await wallet.signRecoveryChallenge(original.chainType, issued.message);
      remember(await authorized<IdentitySnapshot>('/api/identity/verify', { challengeId: issued.challenge.id, signature: signed.signature }));
    }
  }), [authorized, identity, remember, step, wallet]);
  return { identity, busy, error, inspect, enroll, verify };
}

export const recoveryInstructions: Record<IdentitySnapshot['recovery']['status'], string> = {
  needs_setup:
    'Add a passkey, verify your backup email and create both personal wallets above. Then check the verified account again.',
  needs_baseline: 'Record these original wallets before opening a recovery check in another browser.',
  wallet_changed:
    'The current wallets differ from the recorded originals. Sign in to the original account and restore access to those wallets before funding.',
  use_another_browser: 'Continue in a different browser using backup access, then check the verified account there.',
  sign_in_again:
    'This browser still uses the enrollment sign-in session. Sign out here, sign in again with backup access and check the verified account.',
  ready: 'Sign a recovery challenge for each original wallet. Both signatures are required before funding.',
  verified: 'Same-wallet access verified in another browser.',
};
