'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Gavel, Home as HomeIcon, KeyRound, Loader2, Mail, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import { useRecovery, type AuthorizedRequest } from './use-recovery';

export type ChosenRole = 'tenant' | 'landlord' | 'arbitrator';
const ROLE_KEY = 'deposit-workspace.role';

/** The role only shapes what you see first; permissions always come from each agreement. */
export function useChosenRole() {
  const [role, setRole] = useState<ChosenRole | null>(null);
  useEffect(() => {
    const saved = window.localStorage.getItem(ROLE_KEY);
    if (saved === 'tenant' || saved === 'landlord' || saved === 'arbitrator') queueMicrotask(() => setRole(saved));
  }, []);
  const choose = useCallback((next: ChosenRole | null) => {
    if (next) window.localStorage.setItem(ROLE_KEY, next);
    else window.localStorage.removeItem(ROLE_KEY);
    setRole(next);
  }, []);
  return [role, choose] as const;
}

const ROLES: { id: ChosenRole; title: string; text: string; icon: typeof HomeIcon }[] = [
  { id: 'tenant', title: 'I’m looking for a home', text: 'Apply for a flat. Your deposit stays yours, earns while you live there and comes back at move-out.', icon: KeyRound },
  { id: 'landlord', title: 'I rent out a home', text: 'Post your flat, choose a tenant and get a secured deposit without holding anyone’s money.', icon: HomeIcon },
  { id: 'arbitrator', title: 'I resolve disputes', text: 'Be the neutral person who decides only if tenant and landlord disagree at move-out.', icon: Gavel },
];

export function RolePicker({ onPick, onDemo }: { onPick: (role: ChosenRole) => void; onDemo: () => void }) {
  return (
    <section className="onboarding">
      <span className="eyebrow">WELCOME</span>
      <h1>A rental deposit that works for you.</h1>
      <p className="lede">
        Your deposit stays locked for the home, earns while you live there, and every payout goes straight to
        the right person. Test network only; no real money.
      </p>
      <h2>Who are you?</h2>
      <div className="role-grid">
        {ROLES.map((role) => (
          <button key={role.id} className="role-card" onClick={() => onPick(role.id)}>
            <role.icon size={26} />
            <strong>{role.title}</strong>
            <span>{role.text}</span>
            <span className="role-go">Continue <ArrowRight size={16} /></span>
          </button>
        ))}
      </div>
      <button className="text-button" onClick={onDemo}>
        <Sparkles size={16} /> Just look around: open the demo with made-up people, no account needed
      </button>
    </section>
  );
}

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
export function AccountSetup({ role, authorized, onChangeRole, onReady }: {
  role: ChosenRole;
  authorized: AuthorizedRequest;
  onChangeRole: () => void;
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
  const backupDone = accountDone && wallet.backupLoginLinked;
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
  const roleName = ROLES.find((r) => r.id === role)!.title;
  return (
    <section className="onboarding">
      <span className="eyebrow">SET UP YOUR ACCOUNT · {roleName.toUpperCase()}</span>
      <h1>{recoveryCheck ? 'Four quick steps, once.' : 'Three quick steps, once.'}</h1>
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
        <Step n={2} state={state(backupDone, accountDone)} title="Add a backup email">
          <p>So you never lose access if this device is gone. You’ll get a one-time code.</p>
          <button className="button primary large" disabled={wallet.busy} onClick={wallet.addBackupEmail}><Mail size={18} /> Add email</button>
        </Step>
        <Step n={3} state={state(hasWallets, backupDone)} title="Create your wallet">
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
      {wallet.error && <p className="note" role="alert">{wallet.error}</p>}
      <button className="text-button" onClick={onChangeRole}>Not a {role}? Choose another role</button>
    </section>
  );
}

export function RoleIntro({ role, solanaAddress, testUsdcAtomic }: { role: ChosenRole; solanaAddress: string | null; testUsdcAtomic: string | null }) {
  const [copied, setCopied] = useState(false);
  if (role === 'tenant' && solanaAddress && (testUsdcAtomic === null || BigInt(testUsdcAtomic) < 5_000_000n))
    return (
      <section className="card next-step-card">
        <span className="eyebrow">BEFORE YOU APPLY</span>
        <h3>Get test USDC for your deposit</h3>
        <p>
          Open <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Circle’s faucet</a>, choose
          <strong> Solana Devnet</strong> and paste your wallet address. It takes a few seconds; this card disappears when it arrives.
        </p>
        <div className="invite-link">
          <input readOnly value={solanaAddress} />
          <button className="button secondary" onClick={() => { void navigator.clipboard.writeText(solanaAddress); setCopied(true); }}>
            <Copy size={15} /> {copied ? 'Copied' : 'Copy address'}
          </button>
        </div>
      </section>
    );
  if (role === 'arbitrator')
    return (
      <section className="card next-step-card passive">
        <span className="eyebrow">YOU’RE READY</span>
        <h3>Wait for an invitation</h3>
        <p>A landlord sends you a private link. Open it here and join; you’ll only be asked to act if tenant and landlord disagree.</p>
      </section>
    );
  return null;
}
