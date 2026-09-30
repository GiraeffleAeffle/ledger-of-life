'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseUnits } from 'viem';
import { useRentalWallet } from '@/wallets';
import { SHARE_NAVIGATION_INTENT, type Area } from './areas';
import { useSectionTabActive } from './section-tabs';
import { settleShareAction } from './share-action';
import './share-workflows.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Step = { description: string; transaction: { chainId: 46630; to: string; data: string; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } };
type View = {
  enabled: boolean; deployment: null | { pool: string; oracle: string; stock: string; usd: string }; disclaimer: string; stockSymbol: string;
  sharesRaw: string | null; testUsdAtomic: string | null; priceAtomic: string | null; walletValueAtomic: string | null;
  price: null | { sourceRoundId: string; sourceUpdatedAt: number; pushedAt: number; ageSeconds: number; stale: boolean; weekendFreshnessWindow: boolean; sourceFeed: string; sourceChainId: number };
  loan: null | { sharesRaw: string; debtAtomic: string; valueAtomic: string | null; ltvBps: number; availableAtomic: string; priceFresh: boolean };
  lender: null | { sharesRaw: string; netContributedAtomic: string; valueAtomic: string; earnedAtomic: string; maxWithdrawAtomic: string };
  pool: null | { cashAtomic: string; totalAssetsAtomic: string; borrowedAtomic: string; utilizationBps: number; borrowAprBps: number; effectiveBorrowApyBps: number; supplyAprBps: number };
  suspended: boolean; suspensionReasons: string[];
};
type LiquidationPage = { loans: { borrower: string; debtAtomic: string; sharesRaw: string; ltvBps: number }[]; nextCursor: string | null; scanned: number; observedAt: number; suspended: boolean; suspensionReasons: string[] };
const dollars = (value: string | null) => value === null ? 'unavailable' : `${(Number(value) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} tUSDG`;
const shares = (value: string) => (Number(value) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 });
const time = (value: number) => new Date(value * 1000).toLocaleString();
/** How old the copied price is, in the unit a person reads at a glance. */
const age = (seconds: number) => seconds < 60 ? 'under a minute' : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;

export function ShareWorkflows({ request, go }: { request: Request; go: (area: Area) => void }) {
  const wallet = useRentalWallet();
  const account = `${wallet.subject}:${wallet.wallets.find((item) => item.chainType === 'ethereum')?.id ?? ''}`;
  // Another account gets a fresh view: remounting resets every piece of state at once.
  return <SharedMarketView key={account} request={request} go={go} account={account} />;
}

function SharedMarketView({ request, account }: { request: Request; go: (area: Area) => void; account: string }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const revision = useRef(0);
  const acting = useRef(false);
  const [view, setView] = useState<View | null>(null);
  const [tab, setTab] = useState('borrow');
  const [quantity, setQuantity] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [message, setMessage] = useState('');
  const [review, setReview] = useState<{ operation: string; borrower?: string; quantity: string; humanAmount: string; unit: string } | null>(null);
  const [stepDescription, setStepDescription] = useState('');
  const [loanPage, setLoanPage] = useState<LiquidationPage | null>(null);
  const [loansLoading, setLoansLoading] = useState(false);
  const [loansError, setLoansError] = useState('');
  const loadingLoans = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function loadLoans() {
    if (loadingLoans.current) return;
    loadingLoans.current = true; setLoansLoading(true); setLoansError('');
    try {
      const { page } = await request<{ page: LiquidationPage }>(`/api/share-workflows?view=unhealthy&cursor=${encodeURIComponent(loanPage?.nextCursor ?? '0')}&pageSize=20`);
      if (!mounted.current) return;
      setLoanPage((previous) => ({ ...page, scanned: (previous?.scanned ?? 0) + page.scanned, loans: [...(previous?.loans ?? []), ...page.loans.filter((loan) => !previous?.loans.some((existing) => existing.borrower === loan.borrower))] }));
      setReview(null);
    } catch (cause) {
      if (mounted.current) { setLoansError(cause instanceof Error ? cause.message : 'Loans unavailable'); setReview(null); }
    } finally {
      loadingLoans.current = false;
      if (mounted.current) setLoansLoading(false);
    }
  }
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const { workflow } = await request<{ workflow: View }>('/api/share-workflows');
      if (current !== revision.current) return;
      setView(workflow); setReadError(''); setReview(null);
    } catch (cause) {
      if (current === revision.current) { setReadError(cause instanceof Error ? cause.message : 'Market unavailable'); setReview(null); }
    }
  }, [request]);
  useEffect(() => {
    const read = () => { if (activeTab && !acting.current && document.visibilityState === 'visible') void refresh(); };
    read();
    const timer = setInterval(read, 60_000);
    window.addEventListener('ledger-balances-changed', read);
    document.addEventListener('visibilitychange', read);
    return () => { clearInterval(timer); window.removeEventListener('ledger-balances-changed', read); document.removeEventListener('visibilitychange', read); };
  }, [refresh, activeTab, account]);
  useEffect(() => {
    const consume = () => { const intent = sessionStorage.getItem(SHARE_NAVIGATION_INTENT); if (intent) { setTab(intent); sessionStorage.removeItem(SHARE_NAVIGATION_INTENT); } };
    consume(); window.addEventListener(SHARE_NAVIGATION_INTENT, consume);
    return () => window.removeEventListener(SHARE_NAVIGATION_INTENT, consume);
  }, []);
  async function execute() {
    if (!review || acting.current || actionBlocked(review.operation)) return;
    const action = review;
    acting.current = true; setBusy(true); setError(''); setMessage(''); setReview(null); setStepDescription('');
    let submitted = false;
    try {
      const result = await settleShareAction(async () => {
        let hash = '';
        let needsApproval: boolean;
        do {
          const prepared = await request<{ walletId: string; steps: Step[]; needsApproval: boolean }>('/api/share-workflows', { action: 'prepare', operation: action.operation, quantity: action.quantity, ...(action.borrower ? { borrower: action.borrower } : {}) });
          needsApproval = prepared.needsApproval;
          for (const step of prepared.steps) {
            setStepDescription(step.description);
            const signed = await wallet.signEvmTransaction({ walletId: prepared.walletId, operationId: `market-${step.transaction.nonce}`, description: step.description, expiresAt: new Date(Date.now() + 120_000).toISOString(), transaction: step.transaction });
            submitted = true;
            hash = (await request<{ hash: string }>('/api/share-workflows', { action: 'submit', signed })).hash;
          }
        } while (needsApproval);
        return hash;
      }, () => window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } })), refresh);
      if (result.confirmation) setMessage(`Confirmed · ${result.confirmation}`);
      const reason = result.actionError instanceof Error ? result.actionError.message : String(result.actionError);
      // Before the first submission nothing reached the chain, so there is no partial action to warn about.
      if (result.actionError) setError(submitted ? `Action could not be confirmed; earlier steps may have changed balances. ${reason}` : reason);
      if (result.refreshError) setReadError('Transaction completed, but balances could not be refreshed.');
    } finally { acting.current = false; setBusy(false); setStepDescription(''); }
  }
  const fresh = Boolean(view?.deployment && !view.suspended && view.price && !view.price.stale && view.priceAtomic !== null && BigInt(view.priceAtomic) > 0n);
  const ready = Boolean(view?.enabled && view.deployment && !readError);
  function actionBlocked(operation: string, needsPrice = operation === 'borrow' || operation === 'liquidate' || (operation === 'withdraw_collateral' && BigInt(view?.loan?.debtAtomic ?? '0') > 0n)) {
    const usesCollateral = ['deposit_collateral', 'withdraw_collateral', 'borrow', 'liquidate'].includes(operation);
    return busy || !ready || (usesCollateral && Boolean(view?.suspended)) || (needsPrice && !fresh) || (operation === 'liquidate' && (loansLoading || Boolean(loansError) || Boolean(loanPage?.suspended)));
  }
  function action(label: string, operation: string, needsPrice = false, borrower?: string) {
    return <button type="button" className="button secondary" disabled={actionBlocked(operation, needsPrice)} onClick={() => {
      setError(''); setReview(null);
      const collateral = operation === 'deposit_collateral' || operation === 'withdraw_collateral';
      const decimals = collateral ? 18 : 6;
      const unit = collateral ? 'TSLA' : 'tUSDG';
      const humanAmount = quantity.trim();
      if (!/^\d+(?:\.\d+)?$/.test(humanAmount)) { setError(`Enter a positive decimal amount in ${unit}.`); return; }
      if ((humanAmount.split('.')[1]?.length ?? 0) > decimals) { setError(`${unit} amounts support at most ${decimals} decimal places; no rounding is applied.`); return; }
      const atomic = parseUnits(humanAmount, decimals);
      if (atomic <= 0n || atomic.toString().length > 78) { setError(`Enter a positive ${unit} amount within the supported range.`); return; }
      setReview({ operation, quantity: atomic.toString(), humanAmount, unit, ...(borrower ? { borrower } : {}) });
    }}>{label}</button>;
  }
  return <section className="card share-workflows" id="share-workflows">
    <h2>Shared test TSLA loan market</h2>
    {!view && <p>Official test TSLA · test dollars anyone can mint. tUSDG has no monetary value; these are not income or euro balances.</p>}
    <p><a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Get 5 test TSLA and test ETH from Robinhood’s faucet</a></p>
    {readError && <p role="alert">{readError}</p>}
    {!view && !readError && <p role="status">Reading shared market…</p>}
    {view && <>
      <p>{view.disclaimer}</p>
      {!view.deployment && <p role="status">Shared market is not deployed. No mirrored TSLA valuation or loan actions are available.</p>}
      {view.suspended && <p role="alert">Market operations suspended: {view.suspensionReasons.join('; ') || 'External issuer restrictions'}. Collateral is not currently usable for market operations.</p>}
      {view.deployment && !view.price && <p role="status">No mainnet round copied yet.</p>}
      {view.price && <p>Robinhood TSLA token price from <a href={`https://robinhoodchain.blockscout.com/address/${view.price.sourceFeed}`} target="_blank" rel="noopener noreferrer">Chainlink RHTSLA/USD (mainnet)</a>, converted to the test token’s multiplier · source chain {view.price.sourceChainId} · round {view.price.sourceRoundId} at {time(view.price.sourceUpdatedAt)} · copied at {time(view.price.pushedAt)} · {age(view.price.ageSeconds)} old{view.price.weekendFreshnessWindow ? ' · weekend freshness window (74 h)' : ''}{view.price.stale ? ' · stale — valuation unavailable' : ''}. Mirror, not a Chainlink contract.</p>}
      <p>Wallet: {view.sharesRaw === null ? 'unavailable' : shares(view.sharesRaw)} official test TSLA · {dollars(view.testUsdAtomic)}. {fresh ? `Mirrored token price: ${dollars(view.priceAtomic)}; wallet TSLA value: ${dollars(view.walletValueAtomic)}.` : 'Fresh mirrored token price unavailable.'}</p>
      <nav aria-label="Share market panels">{([['borrow', 'Loan'], ['lend', 'Lend test dollars'], ['deposit', 'Rental deposit']] as const).map(([id, label]) => <button key={id} type="button" className={tab === id ? 'button' : 'button secondary'} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>
      <label>Amount ({tab === 'borrow' ? 'TSLA for collateral actions; tUSDG for borrow/repay' : 'tUSDG'}) <input value={quantity} onChange={(event) => { setQuantity(event.target.value); setReview(null); }} inputMode="decimal" /></label>
      {tab === 'deposit' ? <p>A rental deposit needs a real landlord and is not available on the hosted demo. Share-backed rental deposits are not offered here.</p> : tab === 'lend' ? <div><h3>Lend test dollars</h3><p>Net supplied: {dollars(view.lender?.netContributedAtomic ?? '0')} · current value: {dollars(view.lender?.valueAtomic ?? '0')} · earned (value minus net contributed, may be negative): {dollars(view.lender?.earnedAtomic ?? '0')} · cash withdrawable now: {dollars(view.lender?.maxWithdrawAtomic ?? '0')}</p>{action('Lend', 'lend')}{action('Withdraw lent dollars', 'unlend')}<p>Borrower interest increases lender share value. Cash becomes available when borrowers repay; losses and bad debt reduce lender value.</p></div> : <div><h3>Your loan</h3><p>Collateral: {shares(view.loan?.sharesRaw ?? '0')} TSLA · debt: {dollars(view.loan?.debtAtomic ?? '0')} · collateral value: {fresh ? dollars(view.loan?.valueAtomic ?? '0') : 'unavailable'} · LTV: {fresh ? `${(view.loan?.ltvBps ?? 0) / 100}%` : 'unavailable'} · available borrowing: {fresh ? dollars(view.loan?.availableAtomic ?? '0') : 'unavailable'}</p>{action('Add collateral', 'deposit_collateral')}{action('Withdraw collateral', 'withdraw_collateral', BigInt(view.loan?.debtAtomic ?? '0') > 0n)}{action('Borrow', 'borrow', true)}{action('Repay', 'repay')}<p>Borrowing is limited to 50% LTV and 90% pool utilization. Liquidation starts at 80% LTV. Repayment and adding collateral remain possible with a stale price. Interest accrues every second: to close the loan, enter a little more than the debt; Repay takes only what you owe.</p></div>}
      {view.pool && <div><h3>Pool facts</h3><p>Cash: {dollars(view.pool.cashAtomic)} · total assets: {dollars(view.pool.totalAssetsAtomic)} · borrowed: {dollars(view.pool.borrowedAtomic)} · utilization: {view.pool.utilizationBps / 100}% · current borrower rate: {view.pool.borrowAprBps / 100}% a year, compounded continuously (≈{view.pool.effectiveBorrowApyBps / 100}% a year) · current lender rate: {view.pool.supplyAprBps / 100}% APR (not a projection).</p><p>10,000 tUSDG seeded at deploy to a burn address. Nobody can withdraw those seed shares; their interest stays locked in the pool.</p></div>}
      <h3>Loans that can be liquidated</h3>
      {!fresh && <p>Fresh price required to assess or liquidate loans.</p>}
      {!loanPage && <button type="button" className="button secondary" disabled={loansLoading || !ready || !fresh} onClick={() => void loadLoans()}>Show loans that can be liquidated</button>}
      {loansLoading && <p role="status">Reading up to 20 borrowers…</p>}
      {loansError && <p role="alert">{loansError}</p>}
      {loanPage && <>
        <p>Scanned {loanPage.scanned} borrowers · observed at {time(loanPage.observedAt)}. This is a point-in-time assessment, not a guarantee of liquidation.</p>
        {loanPage.suspended && <p role="alert">Liquidation suspended: {loanPage.suspensionReasons.join('; ') || 'External issuer restrictions'}.</p>}
        {loanPage.loans.length === 0 && !loanPage.suspended && <p>No loans that can be liquidated in the scanned borrowers.</p>}
        {loanPage.loans.map((loan) => <div key={loan.borrower}><code>{loan.borrower}</code><p>Debt {dollars(loan.debtAtomic)} · collateral {shares(loan.sharesRaw)} TSLA · LTV {loan.ltvBps / 100}%</p>{action('Repay part and receive TSLA', 'liquidate', true, loan.borrower)}</div>)}
        {loanPage.nextCursor !== null && <button type="button" className="button secondary" disabled={loansLoading || !ready || !fresh} onClick={() => void loadLoans()}>Load next 20 borrowers</button>}
      </>}
      <p>Anyone liquidates with their own test dollars and wallet signature. No operator can stage a price fall. Robinhood can pause, block, burn or upgrade its token; these issuer powers can affect collateral.</p>
    </>}
    {review && <div role="region" aria-label="Review market action"><p>Review {review.operation}: {review.humanAmount} {review.unit}{review.borrower ? ` for ${review.borrower}` : ''}. You sign exact-amount approvals and the market transaction with your own wallet.</p><button type="button" disabled={actionBlocked(review.operation)} onClick={() => void execute()}>Confirm and sign</button><button type="button" onClick={() => setReview(null)}>Cancel</button></div>}
    {busy && <p role="status">{stepDescription || 'Waiting for wallet and transaction confirmation…'}</p>}{message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    <LocalEarningsRehearsal key={account} request={request} account={account} />
  </section>;
}

type Earnings = { status: 'ready'; escrow: string; vault: string; state: number; nonce: string; supplied: boolean; releasableAtomic: string; releasedAtomic: string; securityAtomic: string } | { status: 'starting'; vault: string; usd: string; escrow?: string };
function LocalEarningsRehearsal({ request, account }: { request: Request; account: string }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const [status, setStatus] = useState<{ enabled: boolean; earnings: Earnings | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const result = await request<{ enabled: boolean; earnings: Earnings | null }>('/api/share-earnings');
      if (current === revision.current) setStatus(result);
    } catch (cause) { if (current === revision.current) setError(String(cause)); }
  }, [request]);
  useEffect(() => {
    // Same shape as the market view's read(): refresh only sets state after its request resolves.
    const read = () => { if (activeTab) void refresh(); };
    read();
  }, [account, activeTab, refresh]);
  async function execute(operation: string) {
    setBusy(true); setReview(null); setError('');
    try {
      if (operation === 'setup') await request('/api/share-earnings', { action: 'setup' });
      else {
        const prepared = await request<{ walletId: string; steps: Step[] }>('/api/share-earnings', { action: 'prepare', operation });
        for (const step of prepared.steps) {
          const signed = await wallet.signEvmTransaction({ walletId: prepared.walletId, operationId: `earnings-${step.transaction.nonce}`, description: step.description, expiresAt: new Date(Date.now() + 120_000).toISOString(), transaction: step.transaction });
          await request('/api/share-earnings', { action: 'submit', signed });
        }
      }
      window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } }));
    } catch (cause) { setError(`Rehearsal step could not be confirmed; earlier steps may have changed balances. ${String(cause)}`); }
    finally { await refresh(); setBusy(false); }
  }
  if (!status?.enabled) return error ? <p role="alert">{error}</p> : null;
  const starting = status.earnings?.status === 'starting';
  const earnings = status.earnings?.status === 'ready' ? status.earnings : null;
  const operations = !earnings ? ['setup'] : earnings.state === 0 ? ['accept'] : earnings.state === 1 ? ['mint', 'fund'] : !earnings.supplied ? ['supply'] : ['claim'];
  return <div aria-label="Local earnings rehearsal"><h3>Localhost rental earnings rehearsal</h3><p>The operator acts as the test landlord only. You self-mint test dollars, sign funding and supply to the shared pool. Earnings are actual borrower interest, not operator credits; there may be none yet.</p>
    {starting && <p role="status">Rehearsal setup is incomplete. Resume setup to continue the saved steps.</p>}
    {earnings && <p>Escrow <code>{earnings.escrow}</code> · pool <code>{earnings.vault}</code> · state {earnings.state} · protected principal {dollars(earnings.securityAtomic)} · claimable {dollars(earnings.releasableAtomic)} · released {dollars(earnings.releasedAtomic)}. Claims require pool cash.</p>}
    {operations.map((operation) => <button type="button" key={operation} disabled={busy || (operation === 'claim' && BigInt(earnings?.releasableAtomic ?? '0') === 0n)} onClick={() => setReview(operation)}>{operation === 'setup' && starting ? 'Resume setup' : operation}</button>)}
    {review && <div><p>Review local rehearsal step: {review}. This uses test dollars with no monetary value.</p><button type="button" disabled={busy} onClick={() => void execute(review)}>Confirm {review}</button><button type="button" onClick={() => setReview(null)}>Cancel</button></div>}
    {busy && <p role="status">Waiting for rehearsal transaction…</p>}{error && <p role="alert">{error}</p>}
  </div>;
}
