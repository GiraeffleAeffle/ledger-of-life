'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRentalWallet } from '@/wallets';
import type { IdentitySnapshot } from '@/server/recovery';

export type AuthorizedRequest = <T>(path: string, body?: unknown) => Promise<T>;

/** The same-wallet recovery check shared by the account panel and the places that ask for it. */
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

let requirement: Promise<boolean> | null = null;
/**
 * Whether this server asks for a backup email and a second-browser recovery proof (false only in local demo builds).
 * Asked once per page load; null until answered; a failed answer counts as required, the safe side.
 */
export function useRecoveryRequired(): boolean | null {
  const [required, setRequired] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    requirement ??= fetch('/api/status', { signal: AbortSignal.timeout(4000) })
      .then((response) => response.json())
      .then((status: { recoveryCheck?: boolean }) => status.recoveryCheck !== false)
      .catch(() => { requirement = null; return true; });
    void requirement.then((value) => { if (active) setRequired(value); });
    return () => { active = false; };
  }, []);
  return required;
}
