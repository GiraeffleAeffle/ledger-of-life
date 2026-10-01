'use client';

import { useSyncExternalStore } from 'react';
import { useRentalWallet } from './provider.tsx';
import { pendingInvitationRole } from './pending-invitation.ts';
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
        <div className={styles.eyebrow}>Account access</div>
        <h3 id="wallet-access-title">Your assets, your account</h3>
        <p>Passkey sign-in and personal wallets are not configured yet. Once available, you can access your own account and the test-network services it is eligible to use.</p>
        <span className={styles.pending}>Provider setup pending</span>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="wallet-access-title" aria-busy={access.busy}>
      <div className={styles.eyebrow}>Account access</div>
      <h3 id="wallet-access-title">Keep your assets with you</h3>
      <p>
        Sign in with a passkey. We recommend a second passkey on another device as an optional backup. If you lose every passkey, you lose this test account. Nothing here has monetary value.
      </p>
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
            <li>
              <div>
                <strong>Personal wallets</strong>
                <span>
                  {hasBothWallets
                    ? 'Robinhood and Solana wallets linked'
                    : 'Create wallets after securing your account'}
                </span>
              </div>
              {!hasBothWallets && (
                <button
                  type="button"
                  disabled={disabled || access.passkeyCount === 0}
                  onClick={() => run(access.createMissingWallets)}
                >
                  Create wallets
                </button>
              )}
            </li>
          </ol>
          {access.hasLinkedEmail && access.passkeyCount > 0 && (
            <div className={styles.note}>
              <p>An email is still linked to this older Privy account. Remove it to keep passkey-only access; keep your passkeys safe.</p>
              <button type="button" disabled={disabled} onClick={() => run(access.removeEmail)}>Remove my email</button>
            </div>
          )}
          {access.wallets.length > 0 && (
            <details className={styles.details}>
              <summary>Wallet and control details</summary>
              {access.wallets.map((wallet) => (
                <div className={styles.wallet} key={wallet.id}>
                  <strong>{wallet.chainType === 'solana' ? 'Solana' : 'Robinhood Chain'}</strong>
                  <code>{wallet.address}</code>
                  <span>
                    {wallet.connected
                      ? 'Ready to request your signature'
                      : 'Waiting for wallet connection'}
                  </span>
                </div>
              ))}
              <p>
                Your passkey signs you in; your embedded wallet signs transactions you approve. This
                app does not add a server signer or give landlords or arbitrators access to your
                personal wallet.
              </p>
            </details>
          )}
          <button
            type="button"
            className={styles.textButton}
            disabled={disabled}
            onClick={() => run(access.logout)}
          >
            Sign out
          </button>
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
