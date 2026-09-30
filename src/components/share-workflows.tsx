'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Home, KeyRound, Landmark, Loader2, LockKeyhole, ShieldAlert } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import { parseAmount } from '@/domain/assets';
import { settleShareAction } from './share-action';
import { goToSection, SHARE_NAVIGATION_INTENT, type Area } from './areas';
import { clearShareControl, readPendingShareControl, reserveShareControl, type PendingShareControl } from './share-control-intent';
import { missingRepaymentCash, priceFallBeforeLiquidation, TEST_EXIT_NOTICE } from './money-guidance';
import { useSectionTabActive } from './section-tabs';
import './share-workflows.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Step = { description: string; transaction: { chainId: 46630; to: string; data: string; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } };
type Position = { sharesRaw: string; debtAtomic: string; valueAtomic: string; ltvBps: number; healthBps: number; availableAtomic: string };
type View = {
  enabled: boolean; disclaimer: string; stockSymbol: string; fakeStock: null | { symbol: 'tTSLA'; walletRaw: string; walletValueAtomic: string; priceAtomic: string };
  sharesRaw: string; testUsdAtomic: string; priceAtomic: string; walletValueAtomic: string;
  suggestedPledgeRaw: string; suggestedDepositAtomic: string;
  deployment: null | { oracle: string; desk: string; pool: string; escrow?: string; provisioner?: string | null };
  deposit: null | { state: number; sharesRaw: string; cashAtomic: string; valueAtomic: string; depositAtomic: string; bufferAtomic: string; deadline: number; claimAtomic: string };
  loan: Position | null;
  earnings: null | { escrow: string; state: number; nonce: string; supplied: boolean; yieldsToday: number; yieldAvailable: boolean; purchaseFaucetDone: boolean; previousEscrow: string | null; releasableAtomic: string; releasedAtomic: string; securityAtomic: string };
  earningsError?: string | null;
};
const usd = (atomic: string) => `$${(Number(atomic) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const shares = (raw: string) => (Number(raw) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 });

export function ShareWorkflows({ request, go }: { request: Request; go: (area: Area) => void }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const visibleTab = useRef(activeTab);
  visibleTab.current = activeTab;
  const [view, setView] = useState<View | null>(null);
  const [choice, setChoice] = useState<'deposit' | 'borrow'>('deposit');
  useEffect(() => {
    function consume() {
      const selected = sessionStorage.getItem(SHARE_NAVIGATION_INTENT);
      if (!selected) return;
      sessionStorage.removeItem(SHARE_NAVIGATION_INTENT);
      if (selected === 'deposit' || selected === 'borrow') queueMicrotask(() => setChoice(selected));
    }
    window.addEventListener(SHARE_NAVIGATION_INTENT, consume);
    consume();
    return () => window.removeEventListener(SHARE_NAVIGATION_INTENT, consume);
  }, []);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [borrowAmount, setBorrowAmount] = useState('12');
  const [repayAmount, setRepayAmount] = useState('1');
  const [review, setReview] = useState<{ label: string; detail: string; work: () => Promise<string> } | null>(null);
  const [readError, setReadError] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [earningsCheckedAt, setEarningsCheckedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const revision = useRef(0);
  const acting = useRef(false);
  const [pendingControl, setPendingControl] = useState<PendingShareControl | null>(null);
  const [pendingAccount, setPendingAccount] = useState('');
  const evmWallet = wallet.wallets.find((item) => item.chainType === 'ethereum');
  const accountKey = `${wallet.subject}:${evmWallet?.id ?? ''}:${evmWallet?.address ?? ''}`;
  const activeAccount = useRef(accountKey);
  activeAccount.current = accountKey;
  const refresh = useCallback(async () => {
    if (activeAccount.current !== accountKey) return;
    const current = ++revision.current;
    try {
      const { workflow } = await request<{ workflow: View }>('/api/share-workflows');
      if (current !== revision.current || activeAccount.current !== accountKey) return;
      setView((previous) => ({
        ...workflow,
        earnings: workflow.earningsError ? previous?.earnings ?? null : workflow.earnings,
      }));
      setReview(null); // A review of the previous debt, shares or simulated price is no longer current.
      setCheckedAt(Date.now());
      if (!workflow.earningsError) setEarningsCheckedAt(Date.now());
      setReadError('');
    } catch (cause) {
      if (current === revision.current && activeAccount.current === accountKey)
        setReadError(cause instanceof Error ? cause.message : 'Test market unavailable.');
    }
  }, [request, accountKey]);
  useEffect(() => {
    acting.current = false;
    queueMicrotask(() => {
      if (activeAccount.current !== accountKey) return;
      try { setPendingControl(readPendingShareControl(localStorage, accountKey)); setPendingAccount(accountKey); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'A reserved test control cannot be read.'); }
    });
    setView(null);
    setReview(null);
    setCheckedAt(null);
    setEarningsCheckedAt(null);
    setReadError('');
    const timer = setInterval(() => { if (!acting.current && visibleTab.current && document.visibilityState === 'visible') void refresh(); }, 60_000);
    const onBalancesChanged = (event: Event) => {
      if ((event as CustomEvent<{ chain?: string }>).detail?.chain === 'evm' && !acting.current && visibleTab.current && document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('ledger-balances-changed', onBalancesChanged);
    const invalidate = () => { revision.current++; };
    return () => {
      invalidate();
      clearInterval(timer);
      window.removeEventListener('ledger-balances-changed', onBalancesChanged);
    };
  }, [request, refresh, accountKey]);
  useEffect(() => { if (activeTab && document.visibilityState === 'visible') void refresh(); }, [activeTab, refresh]);
  useEffect(() => {
    if (!view?.deposit?.deadline || !activeTab || document.visibilityState === 'hidden') return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view?.deposit?.deadline, activeTab]);

  async function execute(label: string, work: () => Promise<string>) {
    acting.current = true;
    setBusy(label);
    setMessage(''); setError('');
    try {
      const result = await settleShareAction(
        work,
        () => window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } })),
        refresh,
      );
      if (activeAccount.current !== accountKey) return;
      if (result.confirmation) setMessage(result.confirmation);
      if (result.actionError) setError(`A test step could not be confirmed; earlier steps may have changed your balances. Wait for the refreshed position before signing again. ${result.actionError instanceof Error ? result.actionError.message : 'Please check the test position.'}`);
      if (result.refreshError) setReadError('Balances could not be checked after the test action. The transaction result remains confirmed.');
    } finally {
      if (activeAccount.current === accountKey) {
        acting.current = false;
        setBusy('');
      }
    }
  }
  async function sign(operation: string, quantity?: string, rail: 'shares' | 'earnings' = 'shares') {
    const { walletId, steps } = await request<{ walletId: string; steps: Step[] }>('/api/share-workflows', { action: rail === 'earnings' ? 'earn_prepare' : 'prepare', operation, quantity });
    let lastHash = '';
    for (const step of steps) {
      const signed = await wallet.signEvmTransaction({
        operationId: `shares-${step.transaction.nonce}`, walletId, description: step.description,
        expiresAt: new Date(Date.now() + 120_000).toISOString(), transaction: step.transaction,
      });
      const result = await request<{ hash: string }>('/api/share-workflows', { action: rail === 'earnings' ? 'earn_submit' : 'submit', signed });
      lastHash = result.hash;
    }
    return operation === 'withdraw_collateral' ? `Loan repaid; remaining test shares returned to your wallet · ${lastHash}` : lastHash;
  }
  async function control(operation: string) {
    const existing = readPendingShareControl(localStorage, accountKey);
    const managed = Boolean(view?.deployment?.provisioner || existing);
    const intent = managed ? reserveShareControl(localStorage, accountKey, operation, () => crypto.randomUUID()) : null;
    if (intent) { setPendingControl(intent); setPendingAccount(accountKey); }
    const result = await request<{ hash?: string; state?: 'failed_unsigned'; error?: string; deployment?: { pool: string } }>('/api/share-workflows', {
      action: operation === 'start' ? 'start' : 'control', operation, requestId: intent?.requestId ?? crypto.randomUUID(),
    });
    if (intent) {
      if (result.hash || result.state === 'failed_unsigned') {
        clearShareControl(localStorage, accountKey, intent);
        if (activeAccount.current === accountKey) setPendingControl(null);
      }
      if (result.state === 'failed_unsigned') throw new Error(result.error ?? 'The unsigned operator control failed; no transaction was submitted.');
    }
    return result.hash ?? result.deployment?.pool ?? '';
  }
  function button(label: string, work: () => Promise<string>, primary = false, disabled = false) {
    return <button type="button" className={`button ${primary ? 'primary' : 'secondary'}`} disabled={Boolean(busy) || Boolean(readError) || disabled} onClick={() => void execute(label, work)}>
      {busy === label && <Loader2 size={15} className="spin" />} {label}
    </button>;
  }
  function reviewButton(label: string, detail: string, work: () => Promise<string>, disabled = false) {
    return <button type="button" className="button primary" disabled={Boolean(busy) || Boolean(readError) || disabled} onClick={() => setReview({ label, detail, work })}>{label}</button>;
  }

  const d = view?.deposit;
  const earnings = view?.earnings;
  const loan = view?.loan;
  const walletShares = BigInt(view?.sharesRaw ?? '0');
  const testUsd = BigInt(view?.testUsdAtomic ?? '0');
  const available = BigInt(loan?.availableAtomic ?? '0');
  const activeLoan = BigInt(loan?.debtAtomic ?? '0');
  const secured = d?.state === 1;
  const shortfall = Boolean(d?.deadline);
  const wait = Math.max(0, (d?.deadline ?? 0) - Math.floor((tick || Date.now()) / 1000));
  const pledgeSize = BigInt(view?.suggestedPledgeRaw ?? '0');
  const heldInPool = BigInt(loan?.sharesRaw ?? '0');
  const remainingPledge = walletShares / 3n;
  const purchaseAmount = testUsd < 3_600_000_000n ? testUsd : 3_600_000_000n;
  const earningsUnknown = Boolean(view?.earningsError);
  const legacyMarket = Boolean(view?.deployment && !view.fakeStock);
  const setupFinished = Boolean(earnings?.purchaseFaucetDone && BigInt(earnings.releasedAtomic) > 0n);
  let borrowAtomic: bigint | null = null;
  try { borrowAtomic = BigInt(parseAmount(borrowAmount)); } catch { /* Keep invalid input editable. */ }
  const validBorrow = borrowAtomic !== null && borrowAtomic > 0n && borrowAtomic <= available;
  let repayAtomic: bigint | null = null;
  try { repayAtomic = BigInt(parseAmount(repayAmount)); } catch { /* Keep invalid input editable. */ }
  const repayAllowed = repayAtomic !== null && repayAtomic > 0n && repayAtomic <= testUsd && activeLoan > 0n && repayAtomic <= activeLoan + 1000n;
  const repaymentGap = missingRepaymentCash(view?.testUsdAtomic ?? '0', loan?.debtAtomic ?? '0');
  const fall = loan ? priceFallBeforeLiquidation(loan.valueAtomic, loan.debtAtomic) : null;

  return <section className="card share-flow" aria-label="Share deposit and loan" id="share-workflows" tabIndex={-1}>
    <header className="share-flow-head">
      <div><span className="share-flow-tag">ROBINHOOD CHAIN TESTNET · ROBINHOOD CHAIN WALLET</span><h2>Shares &amp; loans</h2><p>Choose a separate share-backed test deposit or a test loan. {TEST_EXIT_NOTICE}</p></div>
    </header>
    {error && <p className="note" role="alert">{error}</p>}
    {readError && <p className="note" role="status">Could not check share positions. {view && checkedAt ? `Showing the last successful read from ${new Date(checkedAt).toLocaleString()}.` : 'No balance is available yet.'} Actions are paused until positions refresh. {readError}</p>}
    {earningsUnknown && <p className="note" role="status">Earnings steps are temporarily unavailable. {earnings && earningsCheckedAt ? `Showing the last confirmed step from ${new Date(earningsCheckedAt).toLocaleString()}; signing and demo preparation are paused.` : 'No earnings step is verified; demo preparation is paused.'}</p>}
    {message && <p className="share-flow-result" role="status">Latest test action returned a result this session. {readError ? 'Balance refresh failed; do not sign again until positions are checked.' : 'Check the position below for current balances.'}</p>}
    {message && <details className="share-flow-technical"><summary>Latest response and transaction reference</summary><p>{message}</p></details>}
    {pendingAccount === accountKey && pendingControl && <div className="share-flow-result" role="status">Reserved test control: {pendingControl.operation.replaceAll('_', ' ')}. Resume this request before another operator action. <button className="text-button" type="button" disabled={Boolean(busy)} onClick={() => void execute(`Resume ${pendingControl.operation}`, () => control(pendingControl.operation))}>Resume reserved control</button></div>}
    {review && <div className="share-flow-result" role="group" aria-label="Review share action"><h3>Review {review.label}</h3><p>{review.detail}</p><p>Robinhood Chain testnet · the wallet must approve before anything is signed. Interest continues to accrue and test prices can change.</p><button className="button primary" type="button" disabled={Boolean(busy) || Boolean(readError)} onClick={() => { const selected = review; setReview(null); void execute(selected.label, selected.work); }}>Confirm and open wallet</button> <button className="button secondary" type="button" onClick={() => setReview(null)}>Cancel</button></div>}
    {!view ? <p className="small-copy" role="status">{readError ? 'Share positions unavailable.' : 'Checking your share positions…'}</p> : <>
      <div className="share-flow-choices" role="group" aria-label="Choose a share workflow">
        <button type="button" className={choice === 'deposit' ? 'selected' : ''} aria-pressed={choice === 'deposit'} onClick={() => setChoice('deposit')}><span className="share-choice-icon"><KeyRound size={24} /></span><span className="share-choice-copy"><strong>Share-backed test deposit</strong><span>Separate from your Home tenancy; shares remain pledged during this test deposit.</span></span><ArrowRight size={18} /></button>
        <button type="button" className={choice === 'borrow' ? 'selected' : ''} aria-pressed={choice === 'borrow'} onClick={() => setChoice('borrow')}><span className="share-choice-icon"><Landmark size={24} /></span><span className="share-choice-copy"><strong>Loan against shares</strong><span>Borrow against shares, then choose a housing or company stake in Local stakes.</span></span><ArrowRight size={18} /></button>
      </div>
      <div className="share-route-map" aria-label={choice === 'deposit' ? 'Shares to locked collateral to separate test deposit' : 'Available shares to loan collateral to borrowed test cash for local stakes'}>
        <span><Landmark size={18} /> Wallet shares</span><i aria-hidden="true" /><span><LockKeyhole size={18} /> Locked collateral</span><i aria-hidden="true" /><span>{choice === 'deposit' ? <KeyRound size={18} /> : <Home size={18} />}{choice === 'deposit' ? 'Separate test deposit' : 'Borrowed test cash → local stakes'}</span>
      </div>
      <p className="share-flow-risk"><ShieldAlert size={19} /> Collateral is locked. A price fall or growing interest can let someone repay up to half your loan and take shares worth 110% of what they paid. This is not a sale you control.</p>
      <div className="share-flow-overview">
        <div className="share-flow-overview-title"><span>Current position</span><strong>{choice === 'deposit' ? d?.state === 5 ? 'Deposit closed' : d?.state === 1 ? 'Deposit secured with shares' : d ? 'Deposit in progress' : 'No share-backed deposit yet' : activeLoan > 0n ? 'Loan to repay' : heldInPool > 0n ? 'Shares still held in pool' : 'No open loan'}</strong></div>
        <dl className="share-flow-position">
          <div><dt>In your Robinhood Chain wallet</dt><dd>{shares(view.sharesRaw)} {view.stockSymbol}<small>{usd(view.testUsdAtomic)} test USD (tUSDG) cash</small></dd></div>
          <div><dt>Locked for deposit</dt><dd>{d && d.state > 0 && d.state < 5 ? `${shares(d.sharesRaw)} ${view.stockSymbol}` : 'None'}</dd></div>
          <div><dt>Loan collateral</dt><dd>{heldInPool > 0n ? `${shares(loan!.sharesRaw)} ${view.stockSymbol}` : 'None'}</dd></div>
          <div><dt>Loan debt</dt><dd>{activeLoan > 0n ? `${usd(loan!.debtAtomic)} test USD (tUSDG)` : 'None'}</dd></div>
        </dl>
        <small>{checkedAt ? `Checked ${new Date(checkedAt).toLocaleString()}` : 'Checking positions…'} · simulated collateral price {usd(view.priceAtomic)} per share. Locked shares are not wallet-available shares; debt is not an asset.</small>
      </div>
      {!view.enabled && <p className="small-copy" role="status">Operator test scenario controls are disabled here; existing wallet-held and contract positions remain readable.</p>}
      {!view.deployment && <p className="small-copy">For an empty share position, choose “Prepare example shares” in the ownership path above. Preparation only starts when you request it.</p>}
      {choice === 'deposit' && <div className="share-flow-detail">
          <div className="share-flow-detail-intro"><div><span className="share-route-number">01 / DEPOSIT</span><h3>Share-backed test deposit (separate from your Home tenancy)</h3><p>An operator-run test tenancy holds pledged shares. It does not secure your Home tenancy. Shares remain yours but locked until this separate test settlement; a claim or shortfall may reduce what comes back.</p></div></div>
          {!d && <p className="share-route-terms">Illustrative test terms: deposit ≈ {usd(view.suggestedDepositAtomic)} against half your available {view.stockSymbol} ({shares(view.suggestedPledgeRaw)} shares), initially worth 150% of the deposit. Separate from the earnings tenancy.</p>}
          {view.enabled && view.deployment && !view.deployment.escrow && <div className="share-main-action">{button('Test landlord accepts new tenancy', () => control('landlord_accepts'), true, pledgeSize === 0n)}{pledgeSize === 0n && <p role="status">No test shares are available to secure this test deposit.</p>}</div>}
          {view.deployment?.escrow && !d && <p role="status">New test tenancy accepted. Reading its on-chain position…</p>}
          {d && <dl className="share-flow-facts">
            <div><dt>Shares pledged</dt><dd>{shares(d.sharesRaw)} {view.stockSymbol}</dd></div>
            <div><dt>Security at test price</dt><dd>{d.state === 0 || d.state === 5 ? '—' : `${usd(d.valueAtomic)} / ${usd(d.depositAtomic)} deposit`}</dd></div>
            <div><dt>Buffer above 125% maintenance</dt><dd>{d.state === 0 || d.state === 5 ? '—' : usd(d.bufferAtomic)}</dd></div>
            <div><dt>Test tenancy</dt><dd>{['Ready to pledge', 'Secured', 'Claim proposed', 'Claim contested', 'Claim approved', 'Closed'][d.state] ?? 'Unknown'}</dd></div>
          </dl>}
          {d?.state === 0 && <div className="share-main-action">{reviewButton('Review share pledge', `Pledge ${shares(view.suggestedPledgeRaw)} ${view.stockSymbol} worth approximately ${usd((pledgeSize * BigInt(view.priceAtomic) / 10n ** 18n).toString())} at the simulated test price. This is a separate test deposit; loan-to-value afterwards is ${activeLoan > 0n ? `${loan!.ltvBps / 100}%` : '0% (no open loan)'}.`, () => sign('pledge', view.suggestedPledgeRaw), pledgeSize > walletShares || pledgeSize === 0n)}{(pledgeSize > walletShares || pledgeSize === 0n) && <p role="status">No available test shares to pledge; prepare example shares in Holdings if operator tools are on.</p>}</div>}
          {secured && <>
            {shortfall ? <p className="share-route-warning">Top-up requested. {wait ? `Protective sale can start in ${wait}s.` : 'Protective sale may now occur.'} Review the pledge before acting.</p> : <p className="share-route-terms">Deposit secured. Your pledged shares are locked until settlement; a price drop below maintenance can require more shares or a partial protective sale.</p>}
            {shortfall && remainingPledge > 0n && <div className="share-main-action">{button('Sign share top-up', () => sign('top_up', remainingPledge.toString()), true)}</div>}
          </>}
          {d?.state === 2 && <div className="share-main-action"><p>Test landlord proposes a {usd(d.claimAtomic)} claim. Your wallet decides whether to accept it.</p>{button('Sign claim acceptance', () => sign('accept_claim'), true)}</div>}
          {d?.state === 4 && view.enabled && <div className="share-main-action">{button('Pay claim and return remaining shares', () => control('settle'), true)}</div>}
          {d?.state === 5 && <p className="share-flow-result">Closed · approved test claim paid; remaining {view.stockSymbol} returned to your wallet. No further deposit action is required.</p>}
        </div>}
        {choice === 'borrow' && <div className="share-flow-detail">
          <div className="share-flow-detail-intro"><div><span className="share-route-number">02 / BORROW</span><h3>Loan against shares</h3><p>Lock wallet-available shares as collateral, then borrow test USD (tUSDG). Your loan remains owed after you spend test cash; repay it before returning collateral.</p></div><button type="button" className="text-button" onClick={() => goToSection(go, 'money', 'local-investments')}>Explore local stakes →</button></div>
          <div className="share-flow-overview" aria-label="Loan rules"><h4>How this test loan works</h4><p>Interest is 5% a year on the outstanding test USD (tUSDG). You may borrow up to 50% of your shares&apos; current simulated test value. At 80% loan-to-value, anyone can repay up to half your debt and take shares worth 110% of the repayment.</p><p>{fall === null ? activeLoan > 0n ? 'The current collateral value is zero; the loan may already be liquidatable.' : 'No current debt: the price-fall distance does not apply.' : `At the current test price and debt, the share price can fall approximately ${fall}% before liquidation becomes possible. Interest accrual can shorten that distance.`}</p></div>
          {loan && <dl className="share-flow-facts">
            <div><dt>Shares in pool</dt><dd>{shares(loan.sharesRaw)} {view.stockSymbol} ≈ {usd(loan.valueAtomic)}</dd></div>
            <div><dt>Test USD (tUSDG) owed, including interest</dt><dd>{usd(loan.debtAtomic)} test value</dd></div>
            <div><dt>Loan-to-value</dt><dd>{activeLoan > 0n ? `${loan.ltvBps / 100}% · ${loan.ltvBps >= 8_000 ? 'Liquidatable' : 'Below 80% threshold'}` : 'No debt · not at risk'}</dd></div>
            <div><dt>{activeLoan > 0n ? 'Room before 80% liquidation LTV' : 'Borrowing room at 50% test LTV'}</dt><dd>{activeLoan > 0n ? usd((BigInt(loan.valueAtomic) * 80n / 100n > activeLoan ? BigInt(loan.valueAtomic) * 80n / 100n - activeLoan : 0n).toString()) : usd(loan.availableAtomic)}</dd></div>
          </dl>}
          {view.deployment && walletShares > 0n && heldInPool === 0n && (d?.state === 5
            ? <details className="share-flow-restart"><summary>Start another test borrowing cycle</summary>{reviewButton('Review share collateral', `Lock ${shares(view.sharesRaw)} ${view.stockSymbol} worth approximately ${usd(view.walletValueAtomic)} at the simulated test price. Loan-to-value afterwards: ${activeLoan > 0n ? `${Math.floor(Number(activeLoan * 10000n / (BigInt(loan!.valueAtomic) + BigInt(view.walletValueAtomic)))) / 100}%` : '0% (no debt)'}.`, () => sign('deposit_collateral', walletShares.toString()))}</details>
            : <div className="share-main-action">{reviewButton('Review share collateral', `Lock ${shares(view.sharesRaw)} ${view.stockSymbol} worth approximately ${usd(view.walletValueAtomic)} at the simulated test price. Loan-to-value afterwards: ${activeLoan > 0n ? `${loan!.ltvBps / 100}% or less` : '0% (no debt)'}.`, () => sign('deposit_collateral', walletShares.toString()))}</div>)}
          {view.deployment && walletShares === 0n && heldInPool === 0n && <div className="share-main-action"><button className="button primary" disabled>Review share collateral</button><p role="status">No test shares are in your Robinhood Chain wallet to deposit as loan collateral.</p></div>}
          {view.enabled && view.deployment && heldInPool > 0n && available > 0n &&
            <div className="share-main-action">
              <label className="share-borrow-label" htmlFor="share-borrow-amount">Borrow test USD (tUSDG) <input id="share-borrow-amount" type="number" inputMode="decimal" min="0.000001" step="0.01" value={borrowAmount} onChange={(event) => setBorrowAmount(event.target.value)} aria-describedby="share-borrow-limit" /></label>
              <p id="share-borrow-limit">Available additional borrowing: {usd(available.toString())} test USD (tUSDG). Review this amount before signing; 12 test USD (tUSDG) covers two stakes costing 5 test USD (tUSDG) each and a small AI request when your limit permits.</p>
              {reviewButton(`Review borrowing ${validBorrow ? usd(borrowAtomic!.toString()) : 'chosen amount'} test USD (tUSDG)`, `Borrow ${validBorrow ? usd(borrowAtomic!.toString()) : '—'} test USD (tUSDG); debt afterwards approximately ${validBorrow ? usd((activeLoan + borrowAtomic!).toString()) : '—'}; loan-to-value afterwards approximately ${validBorrow && BigInt(loan!.valueAtomic) > 0n ? (Number((activeLoan + borrowAtomic!) * 10000n / BigInt(loan!.valueAtomic)) / 100).toFixed(2) : '—'}%. Borrowed cash spent on stakes cannot be used to repay.`, () => sign('borrow', borrowAtomic!.toString()), !validBorrow)}
              {!validBorrow && <p role="status">Enter more than zero and no more than your available borrowing limit.</p>}
            </div>}
          {activeLoan > 0n && <div className="share-flow-actions">
            <label>Amount to repay in test USD (tUSDG) <input type="number" inputMode="decimal" min="0.000001" step="0.01" value={repayAmount} onChange={(event) => setRepayAmount(event.target.value)} /></label>
            {reviewButton('Review repayment', `Repay up to ${repayAllowed ? usd(repayAtomic!.toString()) : '—'} test USD (tUSDG). Debt afterwards approximately ${repayAllowed ? usd((activeLoan > repayAtomic! ? activeLoan - repayAtomic! : 0n).toString()) : '—'}; loan-to-value afterwards approximately ${repayAllowed && BigInt(loan!.valueAtomic) > 0n ? (Number((activeLoan > repayAtomic! ? activeLoan - repayAtomic! : 0n) * 10000n / BigInt(loan!.valueAtomic)) / 100).toFixed(2) : '—'}%. You can repay part of the debt; interest continues on the remainder.`, () => sign('repay', repayAtomic!.toString()), !repayAllowed)}
            {walletShares > 0n && button('Add your remaining shares', () => sign('deposit_collateral', walletShares.toString()))}
            {!repayAllowed && <span className="small-copy" role="status">{repaymentGap > 0n ? `Full repayment needs ${usd(repaymentGap.toString())} more test USD (tUSDG), including a small interest buffer. Enter an amount no greater than your wallet cash for partial repayment.` : 'Enter a positive amount no greater than the test USD (tUSDG) in your wallet.'}</span>}
          </div>}
          {heldInPool > 0n && activeLoan === 0n && <>
            <p className="share-flow-result">No loan debt. {shares(loan!.sharesRaw)} {view.stockSymbol} remain in the pool until you return them to your wallet.</p>
            <div className="share-flow-actions">{button('Return your remaining test shares', () => sign('withdraw_collateral', loan!.sharesRaw))}</div>
          </>}
          {view.deployment && heldInPool === 0n && activeLoan === 0n && <p className="share-flow-result">No open loan · no shares held in the pool. Any returned shares appear in your wallet above.</p>}
        </div>}
      {choice === 'deposit' && (legacyMarket ? <details className="share-flow-technical"><summary>Older official TSLA test position</summary><p>Existing official TSLA test market remains separate from fake stock; its contract holdings use the simulated collateral price. No new fake-stock setup or redeployment is needed.</p></details> : <details className="share-flow-history" open={!view.deployment || (walletShares === 0n && !setupFinished)}>
        <summary>{setupFinished ? 'Demo setup and earnings · completed' : 'Set up test shares and earnings'}</summary>
        <ol className="share-flow-steps">
        <li>
          <strong>Simulated test deposit earnings</strong>
          <p>A test landlord accepts a $1,500 test USD (tUSDG) deposit. Your wallet signs funding and vault supply; the operator contributes simulated yield because testnet lending pays nothing. The test faucet provides test USD (tUSDG) purchase funds.</p>
          {!earningsUnknown && view.enabled && (!view.fakeStock || !earnings?.purchaseFaucetDone) && button('Prepare a demo position', async () => {
            const { result } = await request<{ result: { escrow: string; stock: string; faucet: string | null } }>('/api/share-workflows', { action: 'prepare_demo' });
            return `Fake test stock and $3,540 test USD (tUSDG) purchase faucet prepared; landlord accepted ${result.escrow}`;
          }, true)}
          {earnings?.previousEscrow && <details className="share-flow-technical"><summary>Earlier test deposit</summary><p>Earlier escrow: {earnings.previousEscrow}</p></details>}
          {!earningsUnknown && earnings?.state === 0 && button('Sign test earnings agreement', () => sign('accept', undefined, 'earnings'), true)}
          {!earningsUnknown && earnings?.state === 1 && button('Sign funding of your test deposit', () => sign('fund', undefined, 'earnings'), true)}
          {!earningsUnknown && earnings?.state === 2 && !earnings.supplied && button('Sign test vault supply', () => sign('supply', undefined, 'earnings'), true)}
          {!earningsUnknown && earnings?.state === 2 && earnings.supplied && earnings.yieldAvailable && view.enabled && button(`Simulate test deposit earnings (${earnings.yieldsToday}/3 today)`, async () => {
            const { result } = await request<{ result: { hashes: string[] } }>('/api/share-workflows', { action: 'earn_yield' });
            return `Operator contributed simulated yield · ${result.hashes.at(-1)}`;
          })}
          {!earningsUnknown && earnings && BigInt(earnings.releasableAtomic) > 0n && (BigInt(earnings.releasedAtomic) === 0n || BigInt(earnings.releasableAtomic) >= 10_000n) && button(`Sign claim of up to ${usd(earnings.releasableAtomic)} test earnings`, () => sign('claim', undefined, 'earnings'), true)}
          {earnings && BigInt(earnings.releasedAtomic) > 0n && <span className="small-copy">Claimed {usd(earnings.releasedAtomic)} test USD (tUSDG) of simulated yield to your wallet with your signature.</span>}
        </li>
        <li>
          <strong>Buy fake test shares with your wallet</strong>
          <p>After claiming test earnings, your wallet may buy tTSLA through the isolated test desk. This does not change official Robinhood TSLA.</p>
          {!earningsUnknown && view.fakeStock && earnings && BigInt(earnings.releasedAtomic) > 0n && purchaseAmount >= 60_000_000n && button(`Buy fake tTSLA test stock with ${usd(purchaseAmount.toString())} test USD (tUSDG)`, () => sign('buy_fake', purchaseAmount.toString()), !setupFinished && walletShares === 0n)}
          <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void refresh()}>Check share balances</button>
        </li>
      </ol>
      </details>)}
      {view.enabled && <details className="share-flow-scenarios">
        <summary>Test scenario controls</summary>
        <p className="small-copy">Operator-funded examples change test prices or advance an on-chain demo; they are not live-market actions.</p>
        <div className="share-flow-actions">
          {choice === 'deposit' && secured && <>
            {button('Set test price −30%', () => control('price_down_30'))}
            {button('Restore test price', () => control('price_reset'))}
            {!shortfall && BigInt(d.bufferAtomic) < 0n && button('Request top-up', () => control('flag_shortfall'))}
            {shortfall && button(wait ? `Protective sale in ${wait}s` : 'Protect deposit with partial sale', () => control('protect_deposit'), false, wait > 0)}
            {button('Test landlord proposes move-out claim', () => control('move_out_claim'))}
          </>}
          {choice === 'borrow' && activeLoan > 0n && <>
            {button('Set test price −30%', () => control('price_down_30'))}
            {button('Set test price −60%', () => control('price_down_60'))}
            {button('Set test price −70%', () => control('price_down_70'))}
            {button('Restore test price', () => control('price_reset'))}
            {testUsd < activeLoan + 1_000n && button('Test USD (tUSDG) repayment faucet', () => control('faucet'))}
            {loan!.ltvBps >= 8_000 && button('Test liquidator repays part of unhealthy loan', () => control('liquidate_loan'))}
          </>}
        </div>
      </details>}
      <details className="share-flow-activity">
        <summary>{message ? 'Activity · latest test result available' : 'Activity · no dated activity available for this position'}</summary>
        <p>This position has no dated personal transaction trail. Current balances alone do not tell us when a step happened.</p>
        {message && <p>Latest result in this session: <strong>{message}</strong> (no completion time provided).</p>}
        {view.deployment && <p>Contract setup evidence, not your activity: oracle {view.deployment.oracle} · desk {view.deployment.desk} · pool {view.deployment.pool}{view.deployment.escrow ? ` · escrow ${view.deployment.escrow}` : ''}.</p>}
      </details>
      <p className="small-copy">Deposit and loan are separate uses of the same {view.stockSymbol} shares. Locked shares remain in test contracts until settlement or withdrawal. {view.fakeStock ? 'Fake tTSLA uses a simulated price; official Robinhood TSLA and Solana tSPYx are separate holdings, with no bridge here.' : 'Official Robinhood TSLA and Solana tSPYx are separate holdings, with no bridge here.'}</p>
    </>}
  </section>;
}
