'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { TenancyJourney } from '@/server/journey';
import type { PortfolioView } from '@/server/portfolio';
import { AssetsOverview } from './assets';
import type { Area } from './areas';
import { PlannedHere } from './ideas';
import { LocalInvestments } from './local-investments';
import { Badge, money } from './workspace-panels';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const b64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toB64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

export function MoneyArea({ request, tenancies, loaded, go }: {
  request: Request; tenancies: TenancyJourney[]; loaded: boolean; go: (area: Area) => void;
}) {
  return (
    <>
      {loaded && <AssetsOverview request={request} tenancies={tenancies} show="money" go={go} />}
      <LocalInvestments request={request} />
      <Portfolio request={request} />
      <PlannedHere area="money" go={go} />
    </>
  );
}

function Portfolio({ request }: { request: Request }) {
  const wallet = useRentalWallet();
  const [view, setView] = useState<PortfolioView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [purchase, setPurchase] = useState<'none' | 'pending'>('none');
  const [signedAttempt, setSignedAttempt] = useState<{ id: string; signedTxBase64: string } | null>(null);
  const refresh = useCallback(async () => {
    const { portfolio } = await request<{ portfolio: PortfolioView | { available: false } }>('/api/portfolio');
    setView(portfolio.available ? portfolio : null);
  }, [request]);
  useEffect(() => {
    let active = true;
    request<{ result: { state: string } }>('/api/portfolio', { action: 'purchase_status' })
      .then(({ result }) => { if (active && result.state === 'pending') setPurchase('pending'); })
      .catch(() => {});
    let retry: ReturnType<typeof setTimeout> | undefined;
    async function loadPortfolio() {
      try {
        const { portfolio } = await request<{ portfolio: PortfolioView | { available: false } }>('/api/portfolio');
        if (!active) return;
        setView(portfolio.available ? portfolio : null);
        setUnavailable(false);
        if (portfolio.available && portfolio.referencePriceStale) retry = setTimeout(loadPortfolio, 60_000);
      } catch {
        if (!active) return;
        setUnavailable(true);
        retry = setTimeout(loadPortfolio, 8000);
      }
    }
    void loadPortfolio();
    return () => { active = false; clearTimeout(retry); };
  }, [request, refresh]);
  useEffect(() => {
    if (purchase !== 'pending') return;
    let active = true;
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      request<{ result: { state: 'none' | 'pending' | 'finalized' | 'failed' } }>('/api/portfolio', { action: 'purchase_status' })
        .then(async ({ result }) => {
          if (!active) return;
          let state = result.state;
          if (state === 'pending') return;
          if (state === 'none' && signedAttempt) {
            try {
              const response = await request<{ result: { state: 'none' | 'pending' | 'finalized' | 'failed' } }>('/api/portfolio', {
                action: 'submit_buy', ...signedAttempt,
              });
              if (!active) return;
              state = response.result.state;
              if (state === 'pending') return;
            } catch (error) {
              if (!active) return;
              if (!(error && typeof error === 'object' && 'code' in error && error.code === 'operation_expired')) return;
              setMessage('The signed test purchase expired without broadcast. You can try again.');
            }
          }
          if (state === 'finalized') {
            setMessage('Bought. Your test holding is updated.');
            void refresh().catch(() => {});
          } else if (state === 'failed') {
            setMessage('The test purchase failed on the network. You can try again.');
          } else if (state === 'none') {
            setMessage('The purchase was not broadcast. You can try again.');
          }
          setSignedAttempt(null);
          setPurchase('none');
        })
        .catch(() => { /* A status timeout is not evidence that the purchase failed. */ })
        .finally(() => { checking = false; });
    }, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [purchase, request, refresh, signedAttempt]);
  if (!view) return unavailable ? (
    <section className="card portfolio-card" role="status">
      <h2>Invest · stocks on Solana</h2>
      <p>Test-network portfolio temporarily unavailable; retrying…</p>
    </section>
  ) : null;
  async function invest() {
    if (busy || purchase === 'pending') return;
    setBusy(true);
    setMessage('');
    let submitted = false;
    try {
      const { buy } = await request<{ buy: { id: string; walletId: string; feePayer: string; expiresAt: string; transactionBase64: string } }>(
        '/api/portfolio', { action: 'prepare_buy', usdcInAtomic: '5000000' });
      const signed = await wallet.signSolanaTransaction({
        operationId: buy.id, walletId: buy.walletId, chain: 'solana:devnet', feePayer: buy.feePayer,
        expiresAt: buy.expiresAt, transaction: b64(buy.transactionBase64), description: 'Invest 5 test USDC in tSPYx',
      });
      const attempt = { id: buy.id, signedTxBase64: toB64(signed) };
      setSignedAttempt(attempt);
      submitted = true;
      const { result } = await request<{ result: { state: 'pending' | 'finalized' | 'failed' } }>(
        '/api/portfolio', { action: 'submit_buy', ...attempt });
      if (result.state === 'pending') {
        setPurchase('pending');
        setMessage('Test purchase pending, checking the network.');
      } else {
        setSignedAttempt(null);
        setMessage(result.state === 'finalized' ? 'Bought. Your test holding is updated.' : 'The test purchase failed on the network.');
        await refresh();
      }
    } catch (e) {
      if (submitted && !(e && typeof e === 'object' && 'code' in e && e.code === 'operation_expired')) {
        setPurchase('pending');
        setMessage('Test purchase pending, checking the network. Please do not start another.');
      } else {
        setSignedAttempt(null);
        const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined;
        if (code === 'buy_pending') {
          setPurchase('pending');
          setMessage('Test purchase pending, checking the network.');
        } else {
          setMessage(code === 'operation_expired' ? 'The price quote expired. Please approve again.' : e instanceof Error ? e.message : 'The test purchase failed.');
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card portfolio-card">
      <div className="section-heading">
        <h2>Invest · stocks on Solana</h2>
        <Badge tone="neutral">Devnet test market · no value</Badge>
      </div>
      {unavailable && <p className="note" role="status">Test-network portfolio temporarily unavailable; retrying…</p>}
      {view.referencePriceStale && <p className="note" role="status">Reference price as of {new Date(view.referencePriceObservedAt).toLocaleString()}; live price temporarily unavailable. Investing resumes when refreshed.</p>}
      <dl className="journey-facts">
        <div><dt>tSPYx (S&amp;P 500 copy)</dt><dd>{view.shares.toFixed(6)} shares</dd></div>
        <div><dt>{view.referencePriceStale ? 'Value at last known SPYx price' : 'Value at recent SPYx price'}</dt><dd>${view.valueUsd.toFixed(2)}</dd></div>
        <div><dt>Simulated distributions so far</dt><dd>{((view.multiplier - 1) * 100).toFixed(2)} %</dd></div>
        <div><dt>Test USDC available</dt><dd>{money(view.testUsdcAtomic)}</dd></div>
      </dl>
      <p className="small-copy">
        Deposit earnings above the required deposit are yours to invest. Devnet lending pays no interest, so you can
        invest your own test USDC here. Distributions raise your displayed shares, as they do for xStocks.
      </p>
      <button className="button primary" disabled={busy || purchase === 'pending' || view.referencePriceStale || BigInt(view.testUsdcAtomic) < 5_000_000n} onClick={invest}>
        {busy ? <Loader2 className="spin" size={16} /> : null} {purchase === 'pending' ? 'Purchase pending, checking' : 'Invest 5 test USDC'} <ArrowRight size={16} />
      </button>
      {message && <p className="note" role="status">{message}</p>}
    </section>
  );
}
