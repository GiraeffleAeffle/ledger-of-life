'use client';
import { useEffect, useState } from 'react';
import { BadgeCheck, Fingerprint, Loader2, ShieldCheck, X } from 'lucide-react';
import type { IdentityStatus } from '@/server/eudi';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;

/** Identity header of the portfolio: passkey sign-in plus an optional EU Digital Identity Wallet check. */
export function IdentityStrip({ request }: { request: Request }) {
  const [status, setStatus] = useState<IdentityStatus | null>(null);
  const [offer, setOffer] = useState<{ walletLink: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    request<{ identity: IdentityStatus }>('/api/identity').then((r) => active && setStatus(r.identity)).catch(() => {});
    return () => { active = false; };
  }, [request]);

  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(async () => {
      try {
        const r = await request<{ identity: IdentityStatus }>('/api/identity', { action: 'poll' });
        if (r.identity.state === 'verified') { setStatus(r.identity); setOffer(null); }
        if (r.identity.state === 'none') { setOffer(null); setError('The request expired. Please start again.'); }
      } catch (e) {
        setOffer(null);
        setError(e instanceof Error ? e.message : 'Please try again.');
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [offer, request]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      setOffer(await request<{ walletLink: string; qr: string }>('/api/identity', { action: 'start' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  async function forget() {
    const r = await request<{ identity: IdentityStatus }>('/api/identity', { action: 'forget' });
    setStatus(r.identity);
  }

  const verified = status?.state === 'verified' ? status.statement : null;
  return (
    <div className={`identity-strip${verified ? ' verified' : ''}`}>
      {verified ? <BadgeCheck size={20} /> : <Fingerprint size={18} />}
      <div className="identity-copy">
        <strong>{verified ? 'Verified adult · EU Digital Identity Wallet' : 'Signed in with passkey'}</strong>
        <span>
          {verified
            ? `Test credential, checked ${new Date(verified.verifiedAt).toLocaleDateString()}. The app learned only "18 or over": no name, no birth date, no address.`
            : 'Own wallets on Solana and Robinhood Chain. Add your EU identity wallet to prove you are a real adult without sharing personal data.'}
        </span>
      </div>
      {verified
        ? <button className="text-button" onClick={forget}>Forget</button>
        : <button className="secondary-button" onClick={start} disabled={busy || !!offer}>
            {busy ? <Loader2 className="spin" size={15} /> : <ShieldCheck size={15} />} Verify with EU wallet
          </button>}
      {offer && (
        <div className="identity-offer">
          <button className="icon-button" aria-label="Cancel" onClick={() => setOffer(null)}><X size={16} /></button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={offer.qr} alt="QR code for the EU identity wallet" width={200} height={200} />
          <div>
            <strong>Scan with the EU reference wallet</strong>
            <ol>
              <li>Open the EUDI reference wallet app with a test PID.</li>
              <li>Scan this code and review the request: only &ldquo;age 18 or over&rdquo;.</li>
              <li>Approve. This page updates by itself.</li>
            </ol>
            <a className="text-button" href={offer.walletLink}>On this phone? Open the wallet</a>
            <span className="small-copy"><Loader2 className="spin" size={12} /> Waiting for your wallet · EU test environment, not a real identity check</span>
          </div>
        </div>
      )}
      {error && <span className="identity-error">{error}</span>}
    </div>
  );
}
