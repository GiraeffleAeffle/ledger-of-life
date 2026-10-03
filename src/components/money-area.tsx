'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { TenancyJourney } from '@/server/journey';
import { AssetsOverview, useHoldingsRead } from './assets';
import type { Area } from './areas';
import { DeviceReadings } from './device-readings';
import { HomeNode } from './home-node';
import { ShareWorkflows } from './share-workflows';
import { LocalInvestments } from './local-investments';
import { LocalAiWorkspace } from './local-ai';
import { SectionTabs, useSectionTabActive } from './section-tabs';
import { TestDollars } from './test-dollars';
import { ScreenNote } from './blocks';
import './money-area.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const b64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toB64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

/**
 * Money answers one question: what do I own, owe and earn? Four sections, one job each. Holdings shows
 * what exists; the other three are where it is changed or earned. A section is never repeated in
 * another area: Home, Places and Me link here.
 */
export function MoneyArea({ request, tenancies, loaded, homeError, go }: {
  request: Request; tenancies: TenancyJourney[]; loaded: boolean; homeError: string; retryHome: () => Promise<void>; go: (area: Area) => void;
}) {
  return (
    <div className="money-journey">
      <SectionTabs label="Money sections" tabs={[
        { id: 'money-holdings', label: 'Holdings',
          content: <AssetsOverview request={request} tenancies={tenancies} tenanciesLoaded={loaded && !homeError} go={go} solanaAction={<Portfolio request={request} />}>
            <TestMoney request={request} />
          </AssetsOverview> },
        { id: 'money-shares', label: 'Borrow & lend',
          content: <ShareWorkflows request={request} go={go} /> },
        { id: 'money-stakes', label: 'Local stakes',
          content: <LocalInvestments request={request} go={go} /> },
        { id: 'money-devices', label: 'Devices & income',
          content: <><HomeNode request={request} /><DeviceReadings request={request} go={go} /><LocalAiWorkspace /><ScreenNote>Device receipts use test networks and have no value. Solar income is simulated feed-in, not an electricity sale; readings are outside your Holdings total. AI answers can be wrong.</ScreenNote></> },
      ]} />
    </div>
  );
}

/** Funding help lives beside the tokens' different uses; balances come from Holdings. */
function TestMoney({ request }: { request: Request }) {
  const read = useHoldingsRead();
  const wallet = useRentalWallet();
  const [copied, setCopied] = useState('');
  const solanaAddress = wallet.wallets.find(item => item.chainType === 'solana')?.address;
  const robinhoodAddress = wallet.wallets.find(item => item.chainType === 'ethereum')?.address;
  async function copyAddress(address: string, chain: string) {
    try { await navigator.clipboard.writeText(address); setCopied(`${chain} address copied.`); }
    catch { setCopied(`Copy failed. Select and copy your ${chain} wallet address manually: ${address}`); }
  }
  return <section className="card test-money" aria-labelledby="test-money-title">
    <h2 id="test-money-title">Test money</h2>
    <div className="test-money-need">
      <p>Test dollars for rent, loans, local stakes and paid answers</p>
      <TestDollars request={request} ethBalance={read.ethBalance} refresh={read.refresh} />
    </div>
    <div className="test-money-need">
      <p>Test USDC for a cash rental deposit</p>
      <TestUsdc request={request} />
    </div>
    <div className="test-money-need">
      <p>Test TSLA shares: <a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Robinhood faucet ↗</a></p>
      {robinhoodAddress && <button className="button secondary" type="button" onClick={() => void copyAddress(robinhoodAddress, 'Shares')}>Copy shares address</button>}
    </div>
    <div className="test-money-need">
      <p>Only for tSPYx trades: <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer">Circle&apos;s devnet faucet ↗</a></p>
      {solanaAddress && <button className="button secondary" type="button" onClick={() => void copyAddress(solanaAddress, 'Deposit')}>Copy deposit address</button>}
      <small>Circle USDC is a different token; it cannot fund a site-tUSDC cash deposit.</small>
    </div>
    {copied && <p className="test-money-copy-status" role="status">{copied}</p>}
  </section>;
}

type TestUsdcResult = { status: 'unconfigured' } | { status: 'pending'; signature: string } | { status: 'confirmed'; signature: string; amountAtomic: string };

/** The authenticated request helper binds this infrastructure faucet to the current account. */
export function TestUsdc({ request }: { request: Request }) {
  const wallet = useRentalWallet();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestUsdcResult | null>(null);
  const [error, setError] = useState('');
  const hasWallet = wallet.wallets.some((item) => item.chainType === 'solana');
  async function getTestUsdc() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const received = await request<TestUsdcResult>('/api/test-usdc', {});
      setResult(received);
      if (received.status === 'confirmed') window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'solana' } }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Test USDC was not confirmed. Retry to check the same request.'); }
    finally { setBusy(false); }
  }
  return <div className="test-usdc">
    <small>Site-minted tUSDC · Solana devnet · not Circle USDC.</small>
    <button type="button" className="button primary" disabled={busy || !hasWallet} onClick={() => { void getTestUsdc(); }}>
      {busy ? 'Checking test USDC…' : result?.status === 'pending' ? 'Check pending test USDC request' : 'Get test USDC'}
    </button>
    <small>Up to 10,000 tUSDC per account and wallet every 24 hours, subject to the site&apos;s daily cap.</small>
    {!hasWallet && <p>Connect your Deposit wallet in Me first.</p>}
    {result?.status === 'unconfigured' && <p className="note" role="status">The site test-USDC faucet is not configured. Circle&apos;s faucet supplies a different token and cannot fund a tUSDC deposit.</p>}
    {result?.status === 'pending' && <p className="note" role="status">Test USDC mint pending. Check this request again to recover its result; do not start a separate mint. <a href={`https://explorer.solana.com/tx/${encodeURIComponent(result.signature)}?cluster=devnet`} target="_blank" rel="noopener noreferrer">View devnet transaction</a>.</p>}
    {result?.status === 'confirmed' && <p className="note" role="status">{(Number(result.amountAtomic) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} tUSDC received. <a href={`https://explorer.solana.com/tx/${encodeURIComponent(result.signature)}?cluster=devnet`} target="_blank" rel="noopener noreferrer">View devnet transaction</a>.</p>}
    {error && <p className="note" role="alert">{error}</p>}
  </div>;
}


function Portfolio({ request }: { request: Request }) {
  const read = useHoldingsRead();
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const { view, checkedAt, unavailable } = read.portfolio;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [purchase, setPurchase] = useState<'none' | 'pending'>('none');
  const [signedAttempt, setSignedAttempt] = useState<{ id: string; signedTxBase64: string } | null>(null);
  useEffect(() => {
    if (!activeTab) return;
    let active = true;
    request<{ result: { state: string } }>('/api/portfolio', { action: 'purchase_status' })
      .then(({ result }) => { if (active && result.state === 'pending') setPurchase('pending'); })
      .catch(() => {});
    return () => { active = false; };
  }, [request, activeTab]);
  useEffect(() => {
    if (purchase !== 'pending') return;
    let active = true;
    let checking = false;
    const timer = setInterval(() => {
      if (checking || !activeTab || document.visibilityState === 'hidden') return;
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
            setMessage('Bought. Checking your updated test holding.');
            window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'solana' } }));
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
  }, [purchase, request, signedAttempt, activeTab]);
  if (!view) return unavailable ? (
    <div className="solana-buy-row" role="status">
      <span>Solana test portfolio temporarily unavailable; checking again…</span>
    </div>
  ) : <div className="solana-buy-row" role="status">Loading Solana test portfolio…</div>;
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
        expiresAt: buy.expiresAt, transaction: b64(buy.transactionBase64), description: 'Buy tSPYx with 5 test USDC',
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
        setMessage(result.state === 'finalized' ? 'Bought. Checking your updated test holding.' : 'The test purchase failed on the network.');
        if (result.state === 'finalized') window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'solana' } }));
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
    <div className="solana-buy-row" role="group" aria-label="Buy tSPYx with test USDC">
      {checkedAt !== null && <p className="small-copy">Buy eligibility checked {new Date(checkedAt).toLocaleString()}.</p>}
      {unavailable && <p className="note" role="status">Test portfolio temporarily unavailable; showing the last checked buy eligibility.</p>}
      {view.referencePriceUsd === null ? (
        <p className="note" role="status">Reference price unavailable; {view.shares > 0 ? 'share valuation incomplete' : 'cash balance remains known'}. Buying resumes when refreshed.</p>
      ) : view.referencePriceStale && (
        <p className="note" role="status">Reference price as of {new Date(view.referencePriceObservedAt).toLocaleString()}; live price temporarily unavailable. Buying resumes when refreshed.</p>
      )}
      <button className="button primary" disabled={busy || purchase === 'pending' || unavailable || view.referencePriceStale || BigInt(view.testUsdcAtomic) < 5_000_000n} onClick={invest}>
        {busy ? <Loader2 className="spin" size={16} /> : null} {purchase === 'pending' ? 'Purchase pending, checking' : 'Buy tSPYx with 5 test USDC'} <ArrowRight size={16} />
      </button>
      {BigInt(view.testUsdcAtomic) < 5_000_000n && <p role="status">You need 5 Circle devnet USDC in your Deposit wallet to buy; current cash is {(Number(view.testUsdcAtomic) / 1e6).toFixed(2)} test USDC. Funding help is in Test money below.</p>}
      {message && <p className="note" role="status">{message}</p>}
    </div>
  );
}
