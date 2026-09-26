'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Mail, ShieldCheck, Wallet } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import { useRecovery, type AuthorizedRequest } from './use-recovery';


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

/** Guided account setup; renders nothing once the account can hold and sign for a deposit. */
export function AccountSetup({ authorized, onReady }: {
  authorized: AuthorizedRequest;
  onReady: () => void;
}) {
  const wallet = useRentalWallet();
  const recovery = useRecovery(authorized);
  const [copied, setCopied] = useState(false);
  const creating = useRef(false);
  const [recoveryCheck, setRecoveryCheck] = useState(true);
  useEffect(() => {
    fetch('/api/status').then((r) => r.json()).then((d) => setRecoveryCheck(d.recoveryCheck !== false)).catch(() => {});
  }, []);
  const hasWallets = wallet.wallets.some((w) => w.chainType === 'solana') && wallet.wallets.some((w) => w.chainType === 'ethereum');
  const accountDone = wallet.authenticated && wallet.passkeyCount > 0;
  const backupDone = accountDone && (wallet.backupLoginLinked || !recoveryCheck);
  const status = recovery.identity?.recovery.status;
  const recoveryDone = recoveryCheck ? status === 'verified' : hasWallets;

  // Wallets are created automatically once passkey and backup exist.
  useEffect(() => {
    if (!backupDone || hasWallets || creating.current || wallet.busy) return;
    creating.current = true;
    wallet.createMissingWallets().catch(() => {}).finally(() => { creating.current = false; });
  }, [backupDone, hasWallets, wallet]);
  // Keep the recovery status live (it changes when the second browser finishes).
  const { inspect } = recovery;
  useEffect(() => {
    if (!recoveryCheck || !backupDone || !hasWallets || recoveryDone) return;
    const first = setTimeout(() => void inspect(), 0);
    const timer = setInterval(() => void inspect(), 6000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [recoveryCheck, backupDone, hasWallets, recoveryDone, inspect]);
  useEffect(() => {
    if (recoveryDone) onReady();
  }, [recoveryDone, onReady]);

  const state = (done: boolean, previous: boolean): StepState => (done ? 'done' : previous ? 'current' : 'todo');
  const link = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <section className="onboarding">
      <span className="eyebrow">SET UP YOUR ACCOUNT</span>
      <h1>{recoveryCheck ? 'Four quick steps, once.' : 'Two quick steps, once.'}</h1>
      <p className="lede">Your passkey signs you in. Your own wallet holds your money; nobody else can move it.</p>
      <ol className="setup-steps">
        <Step n={1} state={state(accountDone, true)} title="Create your account with a passkey">
          <p>Uses Face ID, Touch ID or your device PIN. No password.</p>
          <div className="button-row">
            <button className="button primary large" disabled={!wallet.ready || wallet.busy} onClick={() => void wallet.signupWithPasskey().catch(() => {})}>
              <KeyRound size={18} /> Create account
            </button>
            <button className="button secondary" disabled={!wallet.ready || wallet.busy} onClick={() => void wallet.loginWithPasskey().catch(() => {})}>
              I already have one
            </button>
            <button className="text-button" disabled={!wallet.ready} onClick={wallet.loginWithBackup}>Continue with email</button>
          </div>
          {wallet.authenticated && wallet.passkeyCount === 0 && (
            <button className="button primary" onClick={() => void wallet.addPasskey().catch(() => {})}>Add a passkey to this account</button>
          )}
        </Step>
        {recoveryCheck && (
          <Step n={2} state={state(backupDone, accountDone)} title="Add a backup email">
            <p>So you never lose access if this device is gone. You’ll get a one-time code.</p>
            <button className="button primary large" disabled={wallet.busy} onClick={wallet.addBackupEmail}><Mail size={18} /> Add email</button>
          </Step>
        )}
        <Step n={recoveryCheck ? 3 : 2} state={state(hasWallets, backupDone)} title="Create your wallet">
          <p><Loader2 className="spin" size={14} /> Creating your personal wallet…</p>
        </Step>
        {recoveryCheck && <Step n={4} state={state(recoveryDone, backupDone && hasWallets)} title="Prove you can recover it">
          {status === undefined || recovery.busy && !status ? (
            <p><Loader2 className="spin" size={14} /> Checking…</p>
          ) : status === 'needs_baseline' ? (
            <>
              <p>First we remember which wallet is yours.</p>
              <button className="button primary large" disabled={recovery.busy} onClick={() => void recovery.enroll()}><ShieldCheck size={18} /> Remember my wallet</button>
            </>
          ) : status === 'use_another_browser' ? (
            <>
              <p>
                Now open this app in a <strong>different browser</strong> (for example Safari if you use Chrome), choose
                <strong> Continue with email</strong> with <strong>{wallet.backupEmail}</strong>, and approve two signatures there.
                This page continues by itself when that’s done.
              </p>
              <div className="invite-link">
                <input readOnly value={link} />
                <button className="button secondary" onClick={() => { void navigator.clipboard.writeText(link); setCopied(true); }}>
                  <Copy size={15} /> {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
              <p className="small-copy"><Loader2 className="spin" size={12} /> Waiting for the other browser…</p>
            </>
          ) : status === 'sign_in_again' ? (
            <>
              <p>This browser is still signed in from setup. Sign in again with your email here to continue the check.</p>
              <button className="button primary" onClick={() => void wallet.logout().then(() => wallet.loginWithBackup())}>Sign in with email</button>
            </>
          ) : status === 'ready' ? (
            <>
              <p>You signed in with your backup email. Approve two signatures to prove it’s the same wallet.</p>
              <button className="button primary large" disabled={recovery.busy} onClick={() => void recovery.verify()}>
                {recovery.busy ? <Loader2 className="spin" size={18} /> : <Wallet size={18} />} Verify my wallet
              </button>
            </>
          ) : status === 'wallet_changed' ? (
            <p className="note">This account’s wallet changed since setup. Sign in to the original account first.</p>
          ) : (
            <p>Finish the steps above first.</p>
          )}
          {recovery.error && <p className="note" role="alert">{recovery.error}</p>}
        </Step>}
      </ol>
      {!recoveryCheck && (
        <p className="small-copy">
          <Mail size={13} /> In a real launch you’d also add a backup email and prove recovery from a second device, so
          losing this phone never means losing your deposit. Skipped in this demo.
        </p>
      )}
      {wallet.error && <p className="note" role="alert">{wallet.error}</p>}
    </section>
  );
}
