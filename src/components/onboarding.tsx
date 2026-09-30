'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, Loader2, Mail } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { SetupStep } from './account-setup-state';
import { invitationPayload } from './home-journey-logic';

type StepState = 'done' | 'current' | 'todo';
function Step({ n, state, title, children }: { n: number; state: StepState; title: string; children?: React.ReactNode }) {
  return (
    <li className={`setup-step ${state}`}>
      <span className="journey-dot">{state === 'done' ? <Check size={12} /> : n}</span>
      <div>
        <strong>{title}</strong>
        {state === 'current' && children}
      </div>
    </li>
  );
}

/** Shown until the wallet SDK and the server say who is signed in, so a returning person never sees the welcome steps. */
export function SigningIn() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <section className="onboarding" aria-busy="true">
      <p role="status"><Loader2 className="spin" size={16} /> Checking your sign-in…</p>
      {slow && <p className="note">This is taking longer than usual. Sign-in needs a connection to privy.io: check that a content blocker or firewall is not stopping it, then reload.</p>}
    </section>
  );
}

/**
 * Account setup: passkey, backup email, then both wallets. It ends there. The second-browser recovery
 * proof is asked later, the first time a wallet acts on a tenancy (recovery-step.tsx).
 */
export function AccountSetup({ step, recoveryRequired }: { step: Exclude<SetupStep, 'loading' | 'done'>; recoveryRequired: boolean }) {
  const wallet = useRentalWallet();
  const creating = useRef(false);
  const accountDone = step !== 'account';
  const backupDone = step === 'wallets';

  const invitation = typeof window === 'undefined' ? null : new URLSearchParams(window.location.hash.slice(1)).get('invitation');
  const invitedRole = invitation ? invitationPayload(invitation)?.role : null;
  // Wallets are created automatically once passkey and backup exist.
  useEffect(() => {
    if (step !== 'wallets' || creating.current || wallet.busy) return;
    creating.current = true;
    wallet.createMissingWallets().catch(() => {}).finally(() => { creating.current = false; });
  }, [step, wallet]);

  const state = (done: boolean, previous: boolean): StepState => (done ? 'done' : previous ? 'current' : 'todo');
  return (
    <section className="onboarding">
      <span className="eyebrow">WELCOME TO LEDGER OF LIFE</span>
      <h1>{recoveryRequired ? 'Three quick steps, once.' : 'Two quick steps, once.'}</h1>
      <p className="lede">Ledger of Life keeps your home, your money and your city in one place. Your passkey signs you in, and your own wallets hold your assets: nobody else can move them.</p>
      <p className="small-copy">The money features run on test networks with test tokens, so no real money moves.</p>
      {recoveryRequired && <p className="small-copy">After these steps you can look around. Before your first deposit you will also prove you can recover your wallets from a second browser (about two minutes).</p>}
      {!wallet.configured && <p className="note" role="alert">Sign-in is not set up on this server yet. The operator needs to add a Privy app id (see docs/WALLET_SETUP.md).</p>}
      {invitation && <p className="note" role="status">{invitedRole ? `You were invited to a tenancy as ${invitedRole === 'arbitrator' ? 'a neutral arbitrator' : 'a tenant'}. Finish these steps, then you can join.` : 'This invitation link is malformed. You can still finish setup and ask for a new link.'}</p>}
      <ol className="setup-steps">
        <Step n={1} state={state(accountDone, true)} title="Create your account with a passkey">
          <p>Uses Face ID, Touch ID or your device PIN. No password.</p>
          <div className="button-row">
            <button className="button primary large" disabled={!wallet.configured || !wallet.ready || wallet.busy} onClick={() => void wallet.signupWithPasskey().catch(() => {})}>
              <KeyRound size={18} /> Create account
            </button>
            <button className="button secondary" disabled={!wallet.configured || !wallet.ready || wallet.busy} onClick={() => void wallet.loginWithPasskey().catch(() => {})}>
              I already have one
            </button>
            <button className="text-button" disabled={!wallet.configured || !wallet.ready} onClick={wallet.loginWithBackup}>Continue with email</button>
          </div>
          {wallet.authenticated && wallet.passkeyCount === 0 && (
            <button className="button primary" onClick={() => void wallet.addPasskey().catch(() => {})}>Add a passkey to this account</button>
          )}
          {wallet.error && <p className="note" role="alert">{wallet.error}</p>}
        </Step>
        {recoveryRequired && (
          <Step n={2} state={state(backupDone, accountDone)} title="Add a backup email">
            <p>So you never lose access if this device is gone. You’ll get a one-time code.</p>
            <button className="button primary large" disabled={wallet.busy} onClick={wallet.addBackupEmail}><Mail size={18} /> Add email</button>
            {wallet.error && <p className="note" role="alert">{wallet.error}</p>}
          </Step>
        )}
        <Step n={recoveryRequired ? 3 : 2} state={state(false, backupDone)} title="Create your two wallets">
          <p><Loader2 className="spin" size={14} /> Creating your Solana and Robinhood Chain wallets. Only you can sign with them.</p>
          {wallet.error && <p className="note" role="alert">{wallet.error}</p>}
        </Step>
      </ol>
      {!recoveryRequired && (
        <p className="small-copy">
          <Mail size={13} /> In a real launch you’d also add a backup email and prove recovery from a second device, so
          losing this phone never means losing your deposit. Skipped in this demo.
        </p>
      )}
      {wallet.authenticated && <button type="button" className="text-button" disabled={wallet.busy} onClick={() => void wallet.logout().catch(() => {})}>Use a different account</button>}
    </section>
  );
}
