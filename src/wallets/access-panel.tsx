'use client';

import { useState, useSyncExternalStore } from 'react';
import { useRentalWallet } from './provider.tsx';
import { pendingInvitationRole } from './pending-invitation.ts';
import { WALLET_LABELS } from './labels.ts';
import styles from './access-panel.module.css';

const subscribe = () => () => undefined;
const subscribeHash = (callback: () => void) => {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
};
const localhostPasskeyUrl = () => {
  if (
    typeof window === 'undefined' ||
    window.location.protocol !== 'http:' ||
    window.location.hostname !== '127.0.0.1'
  )
    return '';
  const url = new URL(window.location.href);
  url.hostname = 'localhost';
  return url.href;
};
const supportsPasskeys = () =>
  typeof window !== 'undefined' &&
  !localhostPasskeyUrl() &&
  window.isSecureContext &&
  typeof PublicKeyCredential !== 'undefined';


export function WalletAccessPanel() {
  const access = useRentalWallet();
  const [copyStatus, setCopyStatus] = useState('');
  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopyStatus('Address copied.');
    } catch {
      setCopyStatus(`Could not copy the address. Select and copy this full address manually: ${address}`);
    }
  }
  const passkeysAvailable = useSyncExternalStore(subscribe, supportsPasskeys, () => false);
  const localPasskeyUrl = useSyncExternalStore(subscribe, localhostPasskeyUrl, () => '');
  const invitationRole = useSyncExternalStore(subscribeHash, pendingInvitationRole, () => null);
  const disabled = !access.ready || access.busy;
  const hasBothWallets =
    access.wallets.some((wallet) => wallet.chainType === 'ethereum') &&
    access.wallets.some((wallet) => wallet.chainType === 'solana');
  const run = (action: () => Promise<void>) => void action().catch(() => undefined);

  if (!access.configured) {
    return (
      <section className={styles.panel} aria-labelledby="wallet-access-title">
        <h2 id="wallet-access-title">Sign-in &amp; wallets</h2>
        <p>Account access is not configured yet.</p>
        <span className={styles.pending}>Provider setup pending</span>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-label="Passkeys and wallets" aria-busy={access.busy}>
      <h2>Sign-in &amp; wallets</h2>
      {!access.ready && <p role="status">Connecting account access…</p>}
      {!access.authenticated ? (
        <>
          {invitationRole && (
            <p className={styles.note}>
              This invitation is for the {invitationRole}. Create a separate passkey account if this
              account already belongs to another tenancy role.
            </p>
          )}
          <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
              disabled={disabled || !passkeysAvailable}
              onClick={() => run(access.signupWithPasskey)}
            >
              Create account with a passkey
            </button>
            <button
              type="button"
              disabled={disabled || !passkeysAvailable}
              onClick={() => run(access.loginWithPasskey)}
            >
              Sign in with passkey
            </button>
          </div>
        </>
      ) : (
        <>
          {invitationRole && (
            <p className={styles.note}>
              This invitation is for the {invitationRole}. An account already assigned to another
              role cannot join again.
            </p>
          )}
          <ol className={styles.steps}>
            <li>
              <div>
                <strong>Passkey</strong>
                <span>
                  {access.passkeyCount > 0
                    ? `${access.passkeyCount} registered`
                    : 'Add your first passkey'}
                </span>
              </div>
              <button
                type="button"
                disabled={disabled || !passkeysAvailable}
                onClick={() => run(access.addPasskey)}
              >
                {access.passkeyCount ? 'Add another' : 'Add passkey'}
              </button>
            </li>
          </ol>
          {!hasBothWallets && <div className={styles.actions}>
            <span>Create wallets after securing your account.</span>
            <button type="button" disabled={disabled || access.passkeyCount === 0} onClick={() => run(access.createMissingWallets)}>Create wallets</button>
          </div>}
          {access.hasLinkedEmail && access.passkeyCount > 0 && (
            <div className={styles.note}>
              <p>An email is still linked to this older Privy account. Remove it to keep passkey-only access; keep your passkeys safe.</p>
              <button type="button" disabled={disabled} onClick={() => run(access.removeEmail)}>Remove my email</button>
            </div>
          )}
          {access.wallets.length > 0 && (
            <div>
              {access.wallets.map((wallet) => (
                <div className={styles.wallet} key={wallet.id}>
                  <strong title={wallet.chainType === 'solana' ? 'Solana' : 'Robinhood Chain'}>{WALLET_LABELS[wallet.chainType]}</strong>
                  <code title={wallet.address}>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</code>
                  <button type="button" aria-label={`Copy ${WALLET_LABELS[wallet.chainType]} address`} onClick={() => void copyAddress(wallet.address)}>Copy</button>
                  {!wallet.connected && <span>Waiting for wallet connection</span>}
                </div>
              ))}
              <p>Your passkey signs you in; only you approve your wallet’s transactions, not your landlord or this app.</p>
              <details className={styles.backup}><summary>Passkey backup</summary><p>Add a passkey on another device. Losing every passkey means losing this account.</p></details>
              {copyStatus && <p className={styles.copyStatus} role="status">{copyStatus}</p>}
            </div>
          )}
        </>
      )}
      {!passkeysAvailable && access.ready && (
        <p className={styles.note}>
          {localPasskeyUrl ? (
            <>
              Passkeys cannot start from this IP address. Open the same app at{' '}
              <a href={localPasskeyUrl}>localhost</a> and create your passkey there.
            </>
          ) : (
            <>
              Passkeys need a supported browser on HTTPS or localhost. Open this app on a supported device.
            </>
          )}
        </p>
      )}
      {access.error && (
        <p className={styles.error} role="alert">
          {access.error}
        </p>
      )}
    </section>
  );
}
