'use client';
import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, X } from 'lucide-react';
import type { IdentityStatus } from '@/server/eudi';
import { CITY_CHANGED_EVENT } from './use-city-signals';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;

/** Passkey sign-in and optional EU Digital Identity Wallet check in Me. */
export function IdentityStrip({ request, status, loading, readError, onStatusChange, onRefresh, homeCity = false }: {
  request: Request; status: IdentityStatus | null; loading: boolean; readError: string; homeCity?: boolean;
  onStatusChange: (status: IdentityStatus) => void; onRefresh: () => Promise<void>;
}) {
  const [offer, setOffer] = useState<{ walletLink: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shareCity, setShareCity] = useState(false);


  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(async () => {
      try {
        const r = await request<{ identity: IdentityStatus }>('/api/eudi', { action: 'poll' });
        if (r.identity.state === 'verified') { onStatusChange(r.identity); window.dispatchEvent(new Event(CITY_CHANGED_EVENT)); setOffer(null); }
        if (r.identity.state === 'none') { onStatusChange(r.identity); setOffer(null); setError('The request expired. Please start again.'); }
      } catch (e) {
        setOffer(null);
        setError(e instanceof Error ? e.message : 'Please try again.');
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [offer, request, onStatusChange]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      setOffer(await request<{ walletLink: string; qr: string }>('/api/eudi', { action: 'start', shareCity: shareCity && !homeCity }));
      void onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  async function forget() {
    const r = await request<{ identity: IdentityStatus }>('/api/eudi', { action: 'forget' });
    onStatusChange(r.identity);
    window.dispatchEvent(new Event(CITY_CHANGED_EVENT));
  }

  const verified = status?.state === 'verified' ? status.statement : null;
  return (
    <div className="ledger-identity">
      <div className="identity-copy">
        {verified && <span>Checked {new Date(verified.verifiedAt).toLocaleDateString()}. Kept: &ldquo;18 or over&rdquo;{verified.city ? ' and your city' : ''}. No name, birth date or street address kept.</span>}
        {!homeCity && !verified && !offer && !loading && !readError && (
          <label className="identity-option">
            <input type="checkbox" checked={shareCity} onChange={(e) => setShareCity(e.target.checked)} />
            Also share my city (not the street) for local news and decisions
          </label>
        )}
      </div>
      {verified
        ? <button className="text-button" onClick={forget} disabled={busy || loading}>Forget</button>
        : <button className="secondary-button" onClick={start} disabled={busy || !!offer || loading || Boolean(readError)}>
            {busy || loading ? <Loader2 className="spin" size={15} /> : <ShieldCheck size={15} />} Check EU test-wallet proof
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
              <li>Scan this code and review the request: your birth date{shareCity && !homeCity ? ' and city' : ''}, nothing else.</li>
              <li>Approve. This page updates by itself.</li>
            </ol>
            <a className="text-button" href={offer.walletLink}>On this phone? Open the wallet</a>
            <span className="small-copy">The app checks &ldquo;18 or over&rdquo; and discards the birth date. The current EU person ID has no separate age flag.</span>
            <span className="small-copy"><Loader2 className="spin" size={12} /> Waiting for your wallet · EU test environment, not a real identity check</span>
          </div>
        </div>
      )}
      {error && <span className="identity-error">{error}</span>}
      {readError && <span className="identity-error" role="status">{readError} <button type="button" className="text-button" onClick={() => void onRefresh()}>Retry identity check</button></span>}
    </div>
  );
}
