'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Loader2, ShieldCheck, Wallet } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { IdentitySnapshot } from '@/server/recovery';
import { useRecovery, useRecoveryRequired, type AuthorizedRequest } from './use-recovery';
import './recovery-step.css';

type Status = IdentitySnapshot['recovery']['status'];

export interface RecoveryView {
  status: Status | undefined;
  email: string | null;
  origin: string;
  busy: boolean;
  error: string;
  copied: boolean;
  onEnroll: () => void;
  onVerify: () => void;
  onCopy: () => void;
  onSignInAgain: () => void;
}

/** What to do next to prove the backup email leads to the same two wallets, for each state the server reports. */
export function RecoveryStepView({ status, email, origin, busy, error, copied, onEnroll, onVerify, onCopy, onSignInAgain }: RecoveryView) {
  return (
    <div className="recovery-step">
      {status === undefined ? (
        <p role="status"><Loader2 className="spin" size={14} /> Checking…</p>
      ) : status === 'needs_setup' ? (
        <p>Your account setup is not complete yet. Open Me → Passkeys, wallets &amp; recovery to finish it.</p>
      ) : status === 'needs_baseline' ? (
        <>
          <p>First we record which two wallets are yours. The record cannot be replaced later.</p>
          <button type="button" className="button primary large" disabled={busy} onClick={onEnroll}><ShieldCheck size={18} /> Remember my wallets</button>
        </>
      ) : status === 'use_another_browser' ? (
        <>
          <p>
            Now open this app in a <strong>different browser</strong> (for example Safari if you use Chrome), choose
            <strong> Continue with email</strong> with <strong>{email ?? 'your backup email'}</strong>, and approve two signatures there.
            This page continues by itself when that is done.
          </p>
          <div className="invite-link">
            <input readOnly value={origin} aria-label="Address of this app" />
            <button type="button" className="button secondary" onClick={onCopy}><Copy size={15} /> {copied ? 'Copied' : 'Copy link'}</button>
          </div>
          <p className="small-copy"><Loader2 className="spin" size={12} /> Waiting for the other browser…</p>
        </>
      ) : status === 'sign_in_again' ? (
        <>
          <p>This browser is still signed in from setup. Sign in again with your backup email here to continue the check.</p>
          <button type="button" className="button primary" onClick={onSignInAgain}>Sign in with email</button>
        </>
      ) : status === 'ready' ? (
        <>
          <p>You signed in with your backup email. Approve two signatures to prove these are the same wallets.</p>
          <button type="button" className="button primary large" disabled={busy} onClick={onVerify}>
            {busy ? <Loader2 className="spin" size={18} /> : <Wallet size={18} />} Verify my wallets
          </button>
        </>
      ) : status === 'wallet_changed' ? (
        <p className="note">This account’s wallets changed since they were recorded. Sign in to the original account first.</p>
      ) : (
        <p className="recovery-verified"><Check size={16} /> Verified: your backup email leads to the same two wallets.</p>
      )}
      {error && <p className="note" role="alert">{error}</p>}
    </div>
  );
}

/**
 * The recovery state for one place that shows it. `active` false means nothing is fetched:
 * a demo build that skips the proof never calls the server about it.
 */
export function useRecoveryFlow(request: AuthorizedRequest, active: boolean) {
  const wallet = useRentalWallet();
  const recovery = useRecovery(request);
  const [copied, setCopied] = useState(false);
  const { inspect } = recovery;
  const status = recovery.identity?.recovery.status;
  useEffect(() => {
    if (!active) return;
    const first = setTimeout(() => void inspect(), 0);
    return () => clearTimeout(first);
  }, [active, inspect]);
  // The second browser finishes on its own; this one notices.
  useEffect(() => {
    if (!active || status !== 'use_another_browser') return;
    const timer = setInterval(() => void inspect(), 6000);
    return () => clearInterval(timer);
  }, [active, status, inspect]);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const view: RecoveryView = {
    status, email: wallet.backupEmail, origin, busy: recovery.busy || wallet.busy, error: recovery.error, copied,
    onEnroll: () => void recovery.enroll(),
    onVerify: () => void recovery.verify(),
    onCopy: () => { void navigator.clipboard.writeText(origin); setCopied(true); },
    onSignInAgain: () => void wallet.logout().then(() => wallet.loginWithBackup()),
  };
  return { recovery, status, view };
}

/** The proof on its own, for a place that is already about it (a tenancy waiting on it). */
export function RecoveryStep({ request, onVerified }: { request: AuthorizedRequest; onVerified?: () => void }) {
  const { status, view } = useRecoveryFlow(request, true);
  const notified = useRef(false);
  useEffect(() => {
    if (status !== 'verified' || notified.current) return;
    notified.current = true;
    onVerified?.();
  }, [status, onVerified]);
  return <RecoveryStepView {...view} />;
}

export function RecoveryCard({ children }: { children: ReactNode }) {
  return (
    <section className="recovery-card" aria-label="Recovery check">
      <span className="eyebrow">BEFORE YOUR FIRST DEPOSIT</span>
      <h2>Prove you can recover your wallets</h2>
      <p>
        If this device is lost, your backup email must lead back to the same two wallets. It takes about two minutes and needs a
        second browser. You can look around first: the app asks again the first time a wallet acts on a tenancy.
      </p>
      {children}
    </section>
  );
}

/** Today's reminder: shown only where the server asks for the proof, and only until it is done. */
export function RecoveryPrompt({ request }: { request: AuthorizedRequest }) {
  const required = useRecoveryRequired();
  const { status, view } = useRecoveryFlow(request, required === true);
  if (required !== true || status === undefined || status === 'verified') return null;
  return <RecoveryCard><RecoveryStepView {...view} /></RecoveryCard>;
}

/** Wraps an action that uses a wallet: the action once the proof is done, the proof until then. */
export function RecoveryGate({ request, children }: { request: AuthorizedRequest; children: ReactNode }) {
  const required = useRecoveryRequired();
  const { status, view } = useRecoveryFlow(request, required === true);
  if (required === null || (required && status === undefined))
    return <p className="small-copy" role="status"><Loader2 className="spin" size={13} /> Checking your account…</p>;
  if (!required || status === 'verified') return <>{children}</>;
  return (
    <div className="recovery-gate">
      <strong>One safety step first</strong>
      <p>Before a wallet takes part in a tenancy, prove you can recover it.</p>
      <RecoveryStepView {...view} />
    </div>
  );
}
