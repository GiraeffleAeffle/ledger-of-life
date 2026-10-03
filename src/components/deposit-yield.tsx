'use client';

import { useEffect, useRef, useState } from 'react';
import type { DepositYieldView } from '../server/deposit-yield';
import { Figure, Figures } from './blocks';
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;

export function DepositYield({ view, requiredAtomic, tenant, request, agreementId, reload, compact = false, presentation = 'details' }: {
  view: DepositYieldView; requiredAtomic: string; tenant: boolean; request?: Request; agreementId?: string; reload?: () => Promise<void>; compact?: boolean; presentation?: 'details' | 'figure';
}) {
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const intent = useRef<string | null>(null);
  useEffect(() => {
    const started = Date.now();
    const reset = setTimeout(() => setElapsed(0), 0);
    if (!view.since || view.until) return () => clearTimeout(reset);
    const ticker = setInterval(() => setElapsed(Math.max(0, Date.now() - started)), 1000);
    return () => { clearTimeout(reset); clearInterval(ticker); };
  }, [view]);
  const extra = view.since && !view.until
    ? BigInt(requiredAtomic) * BigInt(view.rateBps) * BigInt(elapsed) / (10_000n * 31_536_000_000n) : 0n;
  const accrued = BigInt(view.accruedAtomic) + extra;
  const due = accrued - BigInt(view.claimedAtomic);
  const amount = (Number(accrued) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  const rate = view.rateBps / 100;
  async function claim() {
    if (!request || !agreementId || !reload) return;
    setBusy(true); setMessage('');
    const requestId = view.pendingRequestId ?? intent.current ?? crypto.randomUUID();
    intent.current = requestId;
    try {
      const result = await request<{ status: string; amountAtomic?: string }>('/api/deposit-yield', { agreementId, requestId });
      if (result.status === 'confirmed') { intent.current = null; setMessage('Simulated yield paid to your test-USDC wallet.'); }
      else if (result.status === 'pending') setMessage('Yield payment is confirming. Check the same payment again; no new amount is sent.');
      else { intent.current = null; setMessage('This payment did not complete. You may make a new claim.'); }
      await reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Yield claim could not complete. Retry the same claim.'); }
    finally { setBusy(false); }
  }
  if (compact) return <span className="asset-gain">Earned so far: {amount} tUSDC · simulated at {rate} % a year · {Number(view.claimedAtomic) / 1e6} tUSDC claimed</span>;
  const action = <>
    {tenant && request && <>
      {(presentation !== 'figure' || view.claimAllowed || view.pendingRequestId) && <button className={presentation === 'figure' ? 'text-button' : 'button secondary'} type="button" disabled={busy || (!view.pendingRequestId && (!view.claimAllowed || due <= 0n))} onClick={() => void claim()}>{busy ? 'Checking…' : view.pendingRequestId ? 'Check pending payment' : presentation === 'figure' ? 'Claim' : 'Claim simulated yield'}</button>}
      {!view.claimAllowed && <p className="small-copy">{view.since ? 'Claimable at settlement.' : 'Yield starts after confirmed funding.'}</p>}
    </>}
    {message && <p role="status">{message}</p>}
  </>;
  const figure = <Figure label={presentation === 'figure' ? 'Earned for you' : 'Deposit earnings'} value={`$${(Number(accrued) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} note={<>Simulated · {rate}% a year · {tenant ? 'yours to keep' : 'belongs to the tenant'}</>} action={action} />;
  if (presentation === 'figure') return figure;
  return <div className="deposit-yield-details">
    <Figures>{figure}</Figures>
    <p className="small-copy">Simple interest{view.since ? ` from confirmed funding on ${new Date(view.since).toLocaleDateString()}` : ' after confirmed funding'}{view.until ? '; stopped at settlement' : ''}. Paid in test USDC.</p>
    {BigInt(view.claimedAtomic) > 0n && <p className="small-copy">Already claimed: {(Number(view.claimedAtomic) / 1e6).toFixed(6)} tUSDC; later claims pay only the remainder.</p>}
  </div>;
}
