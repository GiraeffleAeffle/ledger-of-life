'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { TenancyJourney } from '@/server/journey';
import type { PortfolioView, PortfolioPartial } from '@/server/portfolio';
import { AssetsOverview } from './assets';
import { goToSection, type Area } from './areas';
import { DeviceReadings } from './device-readings';
import { ShareWorkflows } from './share-workflows';
import { LocalInvestments } from './local-investments';
import { OwnershipJourney } from './ownership-journey';
import { LocalAiWorkspace } from './local-ai';
import { SectionTabs, useSectionTabActive } from './section-tabs';
import { StockCollateral } from './stock-collateral';
import { createPortfolioRefresh, type PortfolioSnapshot } from './portfolio-refresh';
import { operationLabels, visibleDepositActivity } from './deposit-activity';
import { TEST_EXIT_NOTICE } from './money-guidance';
import './money-area.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const b64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toB64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

/**
 * Money answers one question: what do I own, owe and earn? Four sections, one job each. Holdings shows
 * what exists; the other three are where it is changed or earned. A section is never repeated in
 * another area: Today, Home, Places and Me link here.
 */
export function MoneyArea({ request, tenancies, loaded, homeError, retryHome, go }: {
  request: Request; tenancies: TenancyJourney[]; loaded: boolean; homeError: string; retryHome: () => Promise<void>; go: (area: Area) => void;
}) {
  return (
    <div className="money-journey">
      <SectionTabs label="Money sections" tabs={[
        { id: 'money-holdings', label: 'Holdings', reality: ['testnet_real', 'read_only_live'],
          summary: 'What you hold and what is locked. The priced subtotal counts your rental deposit, test TSLA, test dollars lent to the shared pool and test cash, minus what you borrowed. Local stakes and devices are not in it.',
          content: <>
            {loaded ? <AssetsOverview request={request} tenancies={tenancies} show="money" go={go} solanaAction={<Portfolio request={request} />} />
              : homeError ? <p className="note" role="alert">{homeError} <button className="button secondary" type="button" onClick={() => void retryHome()}>Retry Home read</button></p> : <p className="money-activity-pending" role="status">Reading your tenancies before the holdings subtotal…</p>}
            <div id="ownership-journey" tabIndex={-1}><OwnershipJourney request={request} go={go} /></div>
            {loaded && <MoneyActivity request={request} tenancies={tenancies} go={go} />}
          </> },
        { id: 'money-shares', label: 'Shares & loans', reality: ['testnet_real', 'read_only_live'],
          summary: "Borrow test dollars against Robinhood's official test TSLA, or lend test dollars to one shared pool. The TSLA price is copied from Chainlink on Robinhood Chain mainnet; everything else is test money with no value.",
          content: <><ShareWorkflows request={request} go={go} /><StockCollateral /></> },
        { id: 'money-stakes', label: 'Local stakes', reality: ['testnet_simulated'],
          summary: 'Buy fictional test units in a housing project or a workshop. They grant no company, cooperative or property rights.',
          content: <LocalInvestments request={request} go={go} /> },
        { id: 'money-devices', label: 'Devices & income', reality: ['read_only_live', 'testnet_real'],
          summary: 'Things you run that produce value: home solar, a validator and a local AI node on a GPU. Readings are read-only and outside the priced subtotal; connections are set up in Me.',
          content: <><DeviceReadings request={request} go={go} /><LocalAiWorkspace /></> },
      ]} />
    </div>
  );
}

type RecordedOperation = { id: string; action: { kind: string; amountAtomic?: string }; role: string; state: string; createdAt: string; signature: string | null };
function MoneyActivity({ request, tenancies, go }: { request: Request; tenancies: TenancyJourney[]; go: (area: Area) => void }) {
  const [activity, setActivity] = useState<{ entries: { agreementId: string; property: string; operation: RecordedOperation }[]; error: boolean } | null>(null);
  const agreementKey = JSON.stringify(tenancies.filter((tenancy) => tenancy.chain).map(({ agreementId, property, role }) => ({ agreementId, property, role })));
  const agreements = useMemo(() => JSON.parse(agreementKey) as { agreementId: string; property: string; role: TenancyJourney['role'] }[], [agreementKey]);
  const activeTab = useSectionTabActive();
  useEffect(() => {
    if (!activeTab || document.visibilityState === 'hidden') return;
    let active = true;
    if (!agreements.length) return;
    Promise.allSettled(agreements.map(async ({ agreementId, property, role }) => {
      const result = await request<{ operations: RecordedOperation[] }>(`/api/finance/solana?agreement=${encodeURIComponent(agreementId)}`);
      return visibleDepositActivity(role, result.operations).map((operation) => ({ agreementId, property, operation }));
    })).then((results) => {
      if (!active) return;
      setActivity({
        entries: results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
          .sort((a, b) => b.operation.createdAt.localeCompare(a.operation.createdAt)).slice(0, 5),
        error: results.some((result) => result.status === 'rejected'),
      });
    });
    return () => { active = false; };
  }, [request, agreements, activeTab]);
  if (!agreements.length) return null;
  if (!activity) return <p className="money-activity-pending" role="status">Reading tenancy activity…</p>;
  if (!activity.entries.length) return <details className="money-activity-empty">
    <summary>{activity.error ? 'Deposit activity unavailable' : 'Deposit activity · no recorded operations yet'}</summary>
    <p>{activity.error ? 'Some tenancy operations could not be checked. Open the tenancy in Home for its other records.' : 'There are no recorded deposit operations for these tenancies yet.'}</p>
  </details>;
  return <section className="card money-activity" aria-label="Deposit activity for your role">
    <span className="eyebrow">DEPOSIT ACTIVITY · SOLANA DEVNET</span><h2>Deposit activity</h2>
    {activity.error && <p role="status">Some tenancy operations are unavailable; this activity may be incomplete.</p>}
    <ol>{activity.entries.map(({ agreementId, property, operation }) => <li key={operation.id}>
      <strong>{operationLabels[operation.action.kind] ?? 'Tenancy operation'} · {property}</strong>
      <span>{operation.state === 'finalized' ? 'Confirmed' : operation.state === 'failed' ? 'Failed' : 'Not yet confirmed'} · recorded {new Date(operation.createdAt).toLocaleString('en-GB')}</span>
      {operation.action.amountAtomic && <span>{(Number(operation.action.amountAtomic) / 1e6).toFixed(2)} test USDC · Solana devnet</span>}
      {operation.signature && <span>Transaction reference: <code>{operation.signature}</code></span>}
      <button className="text-button" onClick={() => goToSection(go, 'home', `tenancy-${agreementId}`)}>Tenancy & full records →</button>
    </li>)}</ol>
    <details><summary>About these records</summary>
      <p>Only operations performed in your role are shown. A recorded time marks creation, not completion; pending or expired preparation is not shown. Other tenancy records remain in Home.</p>
    </details>
  </section>;
}

function Portfolio({ request }: { request: Request }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot<PortfolioView | PortfolioPartial>>({
    view: null, checkedAt: null, unavailable: false,
  });
  const { view, checkedAt, unavailable } = snapshot;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [purchase, setPurchase] = useState<'none' | 'pending'>('none');
  const [signedAttempt, setSignedAttempt] = useState<{ id: string; signedTxBase64: string } | null>(null);
  const reader = useMemo(() => createPortfolioRefresh(
    async () => (await request<{ portfolio: PortfolioView | PortfolioPartial | { available: false } }>('/api/portfolio')).portfolio,
    setSnapshot,
  ), [request]);
  const refresh = useCallback(() => reader.refresh(), [reader]);
  useEffect(() => {
    if (!activeTab) return;
    let active = true;
    request<{ result: { state: string } }>('/api/portfolio', { action: 'purchase_status' })
      .then(({ result }) => { if (active && result.state === 'pending') setPurchase('pending'); })
      .catch(() => {});
    let retry: ReturnType<typeof setTimeout> | undefined;
    async function loadPortfolio() {
      let delay = 60_000;
      try {
        await refresh();
      } catch {
        // The existing transient-error retry leaves the last checked balances visible.
        delay = 8000;
      }
      if (active) retry = setTimeout(loadPortfolio, delay);
    }
    if (document.visibilityState === 'visible') void loadPortfolio();
    const onVisibility = () => { if (document.visibilityState === 'visible') void loadPortfolio(); else clearTimeout(retry); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; clearTimeout(retry); document.removeEventListener('visibilitychange', onVisibility); reader.dispose(); };
  }, [request, refresh, reader, activeTab]);
  useEffect(() => {
    const onBalancesChanged = (event: Event) => {
      if (activeTab && document.visibilityState === 'visible' && event instanceof CustomEvent && event.detail?.chain === 'solana') void refresh().catch(() => {});
    };
    window.addEventListener('ledger-balances-changed', onBalancesChanged);
    return () => window.removeEventListener('ledger-balances-changed', onBalancesChanged);
  }, [refresh, activeTab]);
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
  }, [purchase, request, refresh, signedAttempt, activeTab]);
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
      {BigInt(view.testUsdcAtomic) < 5_000_000n && <p role="status">You need 5 test USDC in your Solana wallet to buy; current cash is {(Number(view.testUsdcAtomic) / 1e6).toFixed(2)} test USDC.</p>}
      <p className="small-copy">{TEST_EXIT_NOTICE}</p>
      {message && <p className="note" role="status">{message}</p>}
    </div>
  );
}
