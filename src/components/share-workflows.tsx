'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseUnits } from 'viem';
import { marketShortfall } from '@/domain/market-preflight';
import { belowGasDripThreshold } from '@/domain/gas-threshold';
import { useRentalWallet } from '@/wallets';
import { SHARE_NAVIGATION_INTENT, type Area } from './areas';
import { useSectionTabActive } from './section-tabs';
import { settleShareAction } from './share-action';
import { TestDollars } from './test-dollars';
import './share-workflows.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Step = { description: string; transaction: { chainId: 46630; to: string; data: string; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } };
type View = {
  enabled: boolean; deployment: null | { pool: string; oracle: string; stock: string; usd: string }; disclaimer: string; stockSymbol: string;
  sharesRaw: string | null; testUsdAtomic: string | null; priceAtomic: string | null; walletValueAtomic: string | null;
  price: null | { sourceRoundId: string; sourceUpdatedAt: number; pushedAt: number; ageSeconds: number; stale: boolean; weekendFreshnessWindow: boolean; sourceFeed: string; sourceChainId: number };
  /** Last hourly price-job run, shaped by the server; null when the job record could not be read. */
  priceJob?: null | { health: 'ok' | 'waiting' | 'attention'; message: string; lastRun: null | { at: number; status: string; reason: string | null; sourceUpdatedAt: number | null }; lastPush: null | { at: number; sourceRoundId: string; sourceUpdatedAt: number | null; transactionHash: string | null } };
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
const EXPLORER_TX = 'https://explorer.testnet.chain.robinhood.com/tx/';
/** Age of a Unix-seconds time against the browser clock. */
const since = (unixSeconds: number) => age(Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds));

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
  const [operation, setOperation] = useState('deposit_collateral');
  const [ethBalance, setEthBalance] = useState<string | undefined>();
  const [quantity, setQuantity] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmedHashes, setConfirmedHashes] = useState<string[]>([]);
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
      // The assets route wraps each reading as { ok, value } so a failed chain read stays distinguishable from zero.
      void request<{ robinhood: { ok: boolean; value?: { ethBalance?: string } } | null }>('/api/assets?area=holdings')
        .then(({ robinhood }) => { if (current === revision.current) setEthBalance(robinhood?.ok ? robinhood.value?.ethBalance : undefined); })
        .catch(() => { if (current === revision.current) setEthBalance(undefined); });
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
    const consume = () => { const intent = sessionStorage.getItem(SHARE_NAVIGATION_INTENT); if (intent) { const choice = intent === 'lend' ? 'lend' : 'borrow'; setTab(choice); setOperation(choice === 'lend' ? 'lend' : 'deposit_collateral'); setReview(null); sessionStorage.removeItem(SHARE_NAVIGATION_INTENT); } };
    consume(); window.addEventListener(SHARE_NAVIGATION_INTENT, consume);
    return () => window.removeEventListener(SHARE_NAVIGATION_INTENT, consume);
  }, []);
  async function execute() {
    if (!review || acting.current || actionBlocked(review.operation)) return;
    const action = review;
    acting.current = true; setBusy(true); setError(''); setMessage(''); setConfirmedHashes([]); setReview(null); setStepDescription('');
    const hashes: string[] = [];
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
            hashes.push(hash);
          }
        } while (needsApproval);
        return hash;
      }, () => window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } })), refresh);
      if (result.confirmation) setMessage('Confirmed');
      // Every submitted step (approvals and the market call) gets its explorer link, even when a later step failed.
      setConfirmedHashes(hashes);
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
  function blockedReason(selected: string) {
    if (!actionBlocked(selected)) return '';
    if (busy) return 'Waiting for the current wallet action and network confirmation.';
    if (readError) return 'Market balances could not be checked. Refresh before reviewing an action.';
    if (!ready) return 'A deployed market and confirmed wallet read are required.';
    if (['deposit_collateral', 'withdraw_collateral', 'borrow', 'liquidate'].includes(selected) && view?.suspended) return 'Collateral operations are suspended by the issuer restrictions shown above.';
    if (selected === 'liquidate' && (loansLoading || loansError || loanPage?.suspended)) return 'Wait for a successful, unsuspended liquidation assessment.';
    return 'A fresh mirrored TSLA price is required for this action.';
  }
  const collateralAction = operation === 'deposit_collateral' || operation === 'withdraw_collateral';
  const amountUnit = collateralAction ? 'TSLA' : 'tUSDG';
  let amountAtomic: bigint | null = null;
  const humanAmount = quantity.trim();
  if (/^\d+(?:\.\d+)?$/.test(humanAmount) && (humanAmount.split('.')[1]?.length ?? 0) <= (collateralAction ? 18 : 6)) {
    amountAtomic = parseUnits(humanAmount, collateralAction ? 18 : 6);
  }
  const cashNeeded = operation === 'repay' && view?.loan && amountAtomic !== null
    ? amountAtomic < BigInt(view.loan.debtAtomic) ? amountAtomic : BigInt(view.loan.debtAtomic)
    : amountAtomic;
  const needsDollars = Boolean(ready && view?.testUsdAtomic !== null && cashNeeded !== null && ['lend', 'repay'].includes(operation) && cashNeeded > BigInt(view?.testUsdAtomic ?? '0'));
  const needsShares = Boolean(ready && view?.sharesRaw !== null && amountAtomic !== null && operation === 'deposit_collateral' && amountAtomic > BigInt(view?.sharesRaw ?? '0'));
  const operations = tab === 'lend' ? [['lend', 'Lend'], ['unlend', 'Withdraw lent dollars']] : [['deposit_collateral', '1. Add collateral'], ['borrow', '2. Borrow'], ['repay', 'Repay'], ['withdraw_collateral', 'Withdraw collateral']];
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
      // The server checks again with fresh chain reads; this answers at once, before any review or signature.
      const shortfall = view && view.sharesRaw !== null && view.testUsdAtomic !== null && view.loan && view.lender && marketShortfall(operation, atomic, {
        walletTsla: BigInt(view.sharesRaw), walletUsd: BigInt(view.testUsdAtomic), collateral: BigInt(view.loan.sharesRaw), debt: BigInt(view.loan.debtAtomic),
        available: BigInt(view.loan.availableAtomic), withdrawable: BigInt(view.lender.maxWithdrawAtomic) });
      if (shortfall) { setError(shortfall); return; }
      setReview({ operation, quantity: atomic.toString(), humanAmount, unit, ...(borrower ? { borrower } : {}) });
    }}>{label}</button>;
  }
  return <section className="card share-workflows" id="share-workflows">
    <header className="share-market-head"><h2>Borrow against test TSLA, or lend test dollars.</h2><p>Robinhood Chain testnet; no real money.</p></header>
    {readError && <p role="alert">{readError}</p>}
    {!view && !readError && <p role="status">Reading shared market…</p>}
    {view && <>
      <p>{view.disclaimer}</p>
      {!view.deployment && <p role="status">Shared market is not deployed. No mirrored TSLA valuation or loan actions are available.</p>}
      {view.suspended && <p role="alert">Market operations suspended: {view.suspensionReasons.join('; ') || 'External issuer restrictions'}. Collateral is not currently usable for market operations.</p>}
      {view.deployment && !view.price && <p role="status">No mainnet round copied yet.</p>}
      <div className="share-market-overview" aria-label="Wallet, loan and lender status">
        <p>Wallet: {view.sharesRaw === null ? 'unavailable' : shares(view.sharesRaw)} official test TSLA · {dollars(view.testUsdAtomic)} · {ethBalance === undefined ? 'fee balance unavailable' : `${ethBalance} test ETH for fees`}. {fresh ? `Mirrored token price: ${dollars(view.priceAtomic)}; wallet TSLA value: ${dollars(view.walletValueAtomic)}.` : 'Fresh mirrored token price unavailable.'}</p>
        <p>Your loan · collateral: {view.loan ? shares(view.loan.sharesRaw) : 'unavailable'} TSLA · debt: {dollars(view.loan?.debtAtomic ?? null)} · collateral value: {fresh ? dollars(view.loan?.valueAtomic ?? null) : 'unavailable'} · LTV: {fresh && view.loan ? `${view.loan.ltvBps / 100}%` : 'unavailable'} · available borrowing: {fresh ? dollars(view.loan?.availableAtomic ?? null) : 'unavailable'}</p>
        <p>Your lending · net supplied: {dollars(view.lender?.netContributedAtomic ?? null)} · current value: {dollars(view.lender?.valueAtomic ?? null)} · earned (value minus net contributed, may be negative): {dollars(view.lender?.earnedAtomic ?? null)} · cash withdrawable now: {dollars(view.lender?.maxWithdrawAtomic ?? null)}</p>
        {view.price && <p>Price source round: {since(view.price.sourceUpdatedAt)} old (published {time(view.price.sourceUpdatedAt)}) · copied to this chain {since(view.price.pushedAt)} ago ({time(view.price.pushedAt)}){view.price.weekendFreshnessWindow ? ' · weekend freshness window (74 h)' : ''}{view.price.stale ? ' · stale — valuation unavailable' : ''}.</p>}
        {view.deployment && view.priceJob && <p role={view.priceJob.health === 'attention' ? 'alert' : 'status'}>Price job: {view.priceJob.health === 'ok' ? 'healthy' : view.priceJob.health === 'waiting' ? 'waiting for a newer round' : 'needs attention'} — {view.priceJob.message}{view.priceJob.lastRun ? ` Last run ${since(view.priceJob.lastRun.at)} ago.` : ''}</p>}
      </div>
      <nav className="share-market-choices" aria-label="Choose a test-money task">{([['borrow', 'Loan against shares'], ['lend', 'Lend test dollars']] as const).map(([id, label]) => <button key={id} type="button" className={tab === id ? 'button' : 'button secondary'} aria-pressed={tab === id} onClick={() => { setTab(id); setOperation(id === 'lend' ? 'lend' : 'deposit_collateral'); setReview(null); setError(''); }}>{label}</button>)}</nav>
      <section className="share-market-task" aria-label={tab === 'lend' ? 'Lending task' : 'Borrowing task'}>
        <h3>{tab === 'lend' ? 'Lend test dollars — no TSLA needed' : 'Add collateral, then review a loan'}</h3>
        {tab === 'lend' ? <p>Borrower interest increases lender share value. Cash becomes available when borrowers repay; losses and bad debt reduce lender value.</p> : <p>Borrowing is limited to 50% LTV and 90% pool utilization. Liquidation starts at 80% LTV. Repayment and adding collateral remain possible with a stale price. Interest accrues every second: to close the loan, enter a little more than the debt; Repay takes only what you owe.</p>}
        {tab === 'borrow' && <p className="share-market-risk">Liquidation can take your test TSLA collateral. Robinhood can pause, block, burn or upgrade its token; these issuer powers can affect collateral.</p>}
        <nav className="share-market-operations" aria-label="Select an operation">{operations.map(([id, label]) => <button key={id} type="button" className={operation === id ? 'button' : 'button secondary'} aria-pressed={operation === id} onClick={() => { setOperation(id); setReview(null); setError(''); }}>{label}</button>)}</nav>
        <label className="share-market-amount">Amount in {amountUnit}<input value={quantity} onChange={(event) => { setQuantity(event.target.value); setReview(null); }} inputMode="decimal" /></label>
        {needsShares && <p role="status">This collateral amount needs more official test TSLA. Get test TSLA from the <a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Robinhood faucet</a> (no value).</p>}
        {ready && (needsDollars || belowGasDripThreshold(ethBalance)) && <div className="share-market-funding"><p>For this {tab === 'lend' ? 'lending' : 'loan'} action: {needsDollars ? 'test dollars (tUSDG), plus test ETH for fees.' : 'test ETH for fees.'} These tokens cannot fund a Solana deposit.</p><TestDollars request={request} ethBalance={ethBalance} refresh={refresh} needDollars={needsDollars} /></div>}
        {tab === 'borrow' && operation === 'borrow' && view.pool && <p className="share-market-borrow-facts" role="status">Pool cash available to borrow: {dollars(view.pool.cashAtomic)} (borrowing also stops at 90% utilization; your limit now: {fresh ? dollars(view.loan?.availableAtomic ?? null) : 'unavailable without a fresh price'}). Price age: {view.price ? `${since(view.price.sourceUpdatedAt)} old${view.price.stale ? ', stale' : ''}, copied ${since(view.price.pushedAt)} ago` : 'no price copied yet'}.</p>}
        {action(`Review ${operations.find(([id]) => id === operation)?.[1].replace(/^\d\. /, '').toLowerCase() ?? operation}`, operation, operation === 'borrow' || operation === 'withdraw_collateral' && BigInt(view.loan?.debtAtomic ?? '0') > 0n)}
        {blockedReason(operation) && <p role="status">{blockedReason(operation)}</p>}
      </section>
      <details className="share-market-detail"><summary>Price source &amp; pool facts</summary>
        {view.price && <p>Robinhood TSLA token price from <a href={`https://robinhoodchain.blockscout.com/address/${view.price.sourceFeed}`} target="_blank" rel="noopener noreferrer">Chainlink RHTSLA/USD (mainnet)</a>, converted to the test token’s multiplier · source chain {view.price.sourceChainId} · round {view.price.sourceRoundId} at {time(view.price.sourceUpdatedAt)} · copied at {time(view.price.pushedAt)}. Mirror, not a Chainlink contract.</p>}
        {view.deployment && view.priceJob && <p>Hourly price job · {view.priceJob.message} {view.priceJob.lastRun ? `Last run: ${time(view.priceJob.lastRun.at)}, ${view.priceJob.lastRun.status}${view.priceJob.lastRun.reason ? ` (${view.priceJob.lastRun.reason.replaceAll('_', ' ')})` : ''}. ` : ''}{view.priceJob.lastPush ? <>Last round copied: {view.priceJob.lastPush.sourceRoundId}, source time {view.priceJob.lastPush.sourceUpdatedAt ? time(view.priceJob.lastPush.sourceUpdatedAt) : 'unknown'}, copied {time(view.priceJob.lastPush.at)}{view.priceJob.lastPush.transactionHash && <> (<a href={`${EXPLORER_TX}${view.priceJob.lastPush.transactionHash}`} target="_blank" rel="noopener noreferrer">transaction</a>)</>}.</> : 'No copy recorded by the job yet.'}</p>}
        {view.pool && <div><h3>Pool facts</h3><p>Cash: {dollars(view.pool.cashAtomic)} · total assets: {dollars(view.pool.totalAssetsAtomic)} · borrowed: {dollars(view.pool.borrowedAtomic)} · utilization: {view.pool.utilizationBps / 100}% · current borrower rate: {view.pool.borrowAprBps / 100}% a year, compounded continuously (≈{view.pool.effectiveBorrowApyBps / 100}% a year) · current lender rate: {view.pool.supplyAprBps / 100}% APR (not a projection).</p><p>10,000 tUSDG seeded at deploy to a burn address. Nobody can withdraw those seed shares; their interest stays locked in the pool.</p></div>}
      </details>
      <details className="share-market-detail"><summary>Advanced · loans that can be liquidated</summary>
      <label className="share-market-amount">Liquidation repayment amount in tUSDG<input value={quantity} onChange={(event) => { setQuantity(event.target.value); setReview(null); }} inputMode="decimal" /></label>
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
      </details>
    </>}
    {review && <div className="share-market-review" role="region" aria-label="Review market action"><p>Review {operations.find(([id]) => id === review.operation)?.[1].replace(/^\d\. /, '').toLowerCase() ?? (review.operation === 'liquidate' ? 'repay part and receive TSLA' : review.operation)}: {review.humanAmount} {review.unit}{review.borrower ? ` for ${review.borrower}` : ''}. You sign exact-amount approvals and the market transaction with your own wallet.</p><button type="button" className="button primary" disabled={actionBlocked(review.operation)} onClick={() => void execute()}>Confirm and sign</button><button type="button" className="button secondary" onClick={() => setReview(null)}>Cancel</button>{blockedReason(review.operation) && <p role="status">{blockedReason(review.operation)}</p>}</div>}
    {busy && <p role="status">{stepDescription || 'Waiting for wallet and transaction confirmation…'}</p>}{message && <p role="status">{message}{confirmedHashes.length > 0 && <> · {confirmedHashes.map((hash, index) => <span key={hash}>{index > 0 && ', '}<a href={`${EXPLORER_TX}${hash}`} target="_blank" rel="noopener noreferrer">{confirmedHashes.length > 1 ? `step ${index + 1}` : 'view transaction'}</a></span>)}</>}</p>}{!message && confirmedHashes.length > 0 && <p role="status">Submitted: {confirmedHashes.map((hash, index) => <span key={hash}>{index > 0 && ', '}<a href={`${EXPLORER_TX}${hash}`} target="_blank" rel="noopener noreferrer">step {index + 1}</a></span>)}</p>}{error && <p role="alert">{error}</p>}
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
  return <details className="share-market-detail" aria-label="Local earnings rehearsal"><summary>Rental earnings rehearsal · needs a local setup</summary><h3>Rental earnings rehearsal in a local setup</h3><p>Not connected to a Home tenancy. The operator acts as the test landlord only. You self-mint test dollars, sign funding and supply to the shared pool. Earnings are actual borrower interest, not operator credits, and belong to the tenant; there may be none yet. Test dollars have no monetary value.</p>
    {starting && <p role="status">Rehearsal setup is incomplete. Resume setup to continue the saved steps.</p>}
    {earnings && <p>Escrow <code>{earnings.escrow}</code> · pool <code>{earnings.vault}</code> · state {earnings.state} · protected principal {dollars(earnings.securityAtomic)} · claimable {dollars(earnings.releasableAtomic)} · released {dollars(earnings.releasedAtomic)}. Claims require pool cash.</p>}
    {operations.map((operation) => <button type="button" key={operation} disabled={busy || (operation === 'claim' && BigInt(earnings?.releasableAtomic ?? '0') === 0n)} onClick={() => setReview(operation)}>{operation === 'setup' && starting ? 'Resume setup' : operation}</button>)}
    {review && <div><p>Review local rehearsal step: {review}. This uses test dollars with no monetary value.</p><button type="button" disabled={busy} onClick={() => void execute(review)}>Confirm {review}</button><button type="button" onClick={() => setReview(null)}>Cancel</button></div>}
    {busy && <p role="status">Waiting for rehearsal transaction…</p>}{error && <p role="alert">{error}</p>}
  </details>;
}
