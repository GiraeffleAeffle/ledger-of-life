'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits, parseUnits } from 'viem';
import { marketShortfall } from '@/domain/market-preflight';
import { belowGasDripThreshold } from '@/domain/gas-threshold';
import { useRentalWallet } from '@/wallets';
import { SHARE_NAVIGATION_INTENT, type Area } from './areas';
import { useSectionTabActive } from './section-tabs';
import { settleShareAction } from './share-action';
import { TestDollars } from './test-dollars';
import { Figure, Figures, MoreList, MoreRow, ScreenNote, StatusLine } from './blocks';
import './share-workflows.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Step = { description: string; transaction: { chainId: 46630; to: string; data: string; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } };
type View = {
  network?: 'solana-devnet'; shareDecimals?: number; cashSymbol?: string; walletAddress?: string; walletId?: string; mirrorAvailable?: boolean; canRefreshPrice?: boolean;
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
const dollars = (value: string | null, symbol = 'tUSDG') => value === null ? 'unavailable' : `${(Number(value) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${symbol}`;
const shares = (value: string, decimals = 18) => Number(formatUnits(BigInt(value), decimals)).toLocaleString('en-US', { maximumFractionDigits: 6 });
const time = (value: number) => new Date(value * 1000).toLocaleString();
/** How old the copied price is, in the unit a person reads at a glance. */
const age = (seconds: number) => seconds < 60 ? 'under a minute' : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;
const EXPLORER_TX = 'https://explorer.testnet.chain.robinhood.com/tx/';
/** Age of a Unix-seconds time against the browser clock. */
const since = (unixSeconds: number) => age(Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds));

type PreparedOperation = { id: string; kind: string; walletId: string; feePayer: string; transactionBase64: string; expiresAt: string; review: Record<string, unknown>; network: 'solana-devnet' };
type OperationResult = { id: string; state: 'prepared' | 'broadcast' | 'confirmed' | 'failed' | 'expired'; signature?: string | null };
type OperationAttempt = { requestId: string; body: Record<string, unknown>; id?: string; prepared?: PreparedOperation; signedTransactionBase64?: string; submitted?: boolean; result?: OperationResult };
type DurableReceipt = OperationResult & { operation: string };
type RecoveryView = { network?: string; activeOperation?: (OperationResult & Partial<PreparedOperation>) | null; receipts?: DurableReceipt[] };
export type ReviewedSolanaOperation = {
  attempt: OperationAttempt | null; busy: boolean; error: string; loaded: boolean; terminal: boolean; receipts: DurableReceipt[];
  prepare: (body?: Record<string, unknown>) => Promise<void>; signSubmit: () => Promise<void>; reconcile: () => Promise<void>; resend: () => Promise<void>; dismiss: () => Promise<void>; recover: () => void;
};
const devnetReceipt = (signature: string) => `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;

/** One durable intent, exact reviewed bytes, and same-id recovery after an ambiguous send. */
export function useReviewedSolanaOperation(request: Request, endpoint: string, account: string, refresh: () => Promise<void>) {
  const wallet = useRentalWallet();
  const storageKey = `ledger-solana-review:${endpoint}:${account}`;
  const [attempt, setAttempt] = useState<OperationAttempt | null>(null);
  const current = useRef<OperationAttempt | null>(null);
  const acting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [receipts, setReceipts] = useState<DurableReceipt[]>([]);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const save = useCallback((next: OperationAttempt | null) => {
    current.current = next; setAttempt(next);
    if (next) sessionStorage.setItem(storageKey, JSON.stringify(next));
    else sessionStorage.removeItem(storageKey);
  }, [storageKey]);
  useEffect(() => {
    let live = true;
    const restore = async () => {
      setLoaded(false); setError('');
      try {
        const stored = sessionStorage.getItem(storageKey);
        const local = stored ? JSON.parse(stored) as OperationAttempt : null;
        current.current = local; setAttempt(local);
        const response = await request<RecoveryView & { workflow?: RecoveryView }>(endpoint);
        if (!live) return;
        const server = response.workflow ?? response;
        setReceipts(server.receipts ?? []);
        const active = server.activeOperation;
        if (current.current === local && active && (server.network === 'solana-devnet' || active.network === 'solana-devnet')) {
          const same = local?.prepared?.id === active.id || local?.id === active.id;
          const prepared = active.transactionBase64 && active.review && active.walletId && active.feePayer && active.expiresAt && active.kind
            ? { ...active, network: 'solana-devnet' } as PreparedOperation : undefined;
          save({ ...(same && local ? local : { requestId: active.id, body: {} }), id: active.id, prepared: prepared ?? (same ? local?.prepared : undefined),
            submitted: active.state !== 'prepared' || Boolean(same && local?.submitted), result: { id: active.id, state: active.state, signature: active.signature ?? (same ? local?.result?.signature : undefined) } });
        }
        setLoaded(true);
      } catch (cause) { if (live) setError(cause instanceof Error ? `Operation recovery unavailable: ${cause.message}` : 'The saved operation could not be recovered. Do not repeat a possibly submitted action.'); }
    };
    void restore();
    return () => { live = false; };
  }, [storageKey, request, endpoint, save, recoveryRevision]);
  async function run(action: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Operation could not be confirmed. Recover the same request below.'); }
    finally { acting.current = false; setBusy(false); }
  }
  async function prepare(body?: Record<string, unknown>) {
    if (!loaded) return;
    await run(async () => {
      let pending = current.current;
      if (!pending) {
        if (!body) return;
        pending = { requestId: crypto.randomUUID(), body }; save(pending);
      }
      if (pending.prepared || pending.submitted) return;
      const prepared = await request<PreparedOperation>(endpoint, { ...pending.body, action: 'prepare', requestId: pending.requestId });
      if (prepared.network !== 'solana-devnet') throw new Error('The prepared transaction is not on Solana devnet.');
      save({ ...pending, prepared });
    });
  }
  async function acceptResult(pending: OperationAttempt, result: OperationResult) {
    if (result.id !== (pending.prepared?.id ?? pending.id)) throw new Error('Operation receipt does not match the reviewed transaction.');
    save({ ...pending, result: { ...result, signature: result.signature ?? pending.result?.signature } });
    if (result.signature) setReceipts(previous => [{ ...result, operation: pending.prepared?.kind ?? 'Recovered operation' }, ...previous.filter(receipt => receipt.id !== result.id)]);
    if (result.state === 'confirmed') {
      window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'solana' } }));
      try { await refresh(); } catch { setError('Transaction confirmed, but balances could not be refreshed.'); }
    }
    if (result.state === 'failed' || result.state === 'expired') setError(`Transaction ${result.state}. Its receipt is retained below.`);
  }
  async function reconcile() {
    await run(async () => {
      const pending = current.current;
      const id = pending?.prepared?.id ?? pending?.id;
      if (!pending || !id) return;
      await acceptResult(pending, await request<OperationResult>(endpoint, { action: 'reconcile', id }));
    });
  }
  async function signSubmit() {
    await run(async () => {
      let pending = current.current;
      if (!loaded || !pending?.prepared || pending.result?.state === 'confirmed' || pending.result?.state === 'failed' || pending.result?.state === 'expired') return;
      if (pending.submitted) {
        await acceptResult(pending, await request<OperationResult>(endpoint, { action: 'reconcile', id: pending.prepared.id })); return;
      }
      const prepared = pending.prepared;
      if (!pending.signedTransactionBase64) {
        const signed = await wallet.signSolanaTransaction({
          walletId: prepared.walletId, operationId: prepared.id, chain: 'solana:devnet', feePayer: prepared.feePayer,
          description: typeof prepared.review.description === 'string' ? prepared.review.description : `Review ${prepared.kind} on Solana devnet`,
          expiresAt: prepared.expiresAt, transaction: Uint8Array.from(atob(prepared.transactionBase64), character => character.charCodeAt(0)),
        });
        pending = { ...pending, signedTransactionBase64: btoa(Array.from(signed, byte => String.fromCharCode(byte)).join('')) }; save(pending);
      }
      pending = { ...pending, submitted: true }; save(pending);
      const result = await request<OperationResult>(endpoint, { action: 'submit', id: prepared.id, signedTransactionBase64: pending.signedTransactionBase64 });
      await acceptResult(pending, result);
    });
  }
  async function resend() {
    await run(async () => {
      const pending = current.current;
      if (!pending?.prepared || !pending.signedTransactionBase64 || pending.result?.state !== 'prepared') return;
      await acceptResult(pending, await request<OperationResult>(endpoint, { action: 'submit', id: pending.prepared.id, signedTransactionBase64: pending.signedTransactionBase64 }));
    });
  }
  const terminal = Boolean(attempt?.result && ['confirmed', 'failed', 'expired'].includes(attempt.result.state));
  async function dismiss() {
    if (busy || !terminal && current.current?.submitted) return;
    await run(async () => {
      const id = current.current?.prepared?.id ?? current.current?.id;
      if (id && !terminal) await request(endpoint, { action: 'cancel', id });
      save(null); setError('');
    });
  }
  return { attempt, busy, error, loaded, terminal, receipts, prepare, signSubmit, reconcile, resend, dismiss, recover: () => setRecoveryRevision(previous => previous + 1) };
}

export function SolanaOperationReview({ operation }: { operation: ReviewedSolanaOperation }) {
  const { attempt, busy, terminal } = operation;
  if (!attempt) return <>{operation.receipts.length > 0 && <details><summary>Earlier devnet receipts</summary>{operation.receipts.map(receipt => <p key={receipt.id}>{receipt.operation} · {receipt.state}{receipt.signature && <> · <a href={devnetReceipt(receipt.signature)} target="_blank" rel="noopener noreferrer">View devnet transaction</a></>}</p>)}</details>}{operation.error && <><p role="alert">{operation.error}</p><button type="button" className="button secondary" disabled={busy} onClick={operation.recover}>Recover existing operation</button></>}</>;
  return <div className="share-market-review" role="region" aria-label="Exact Solana transaction review">
    {attempt.prepared ? <>
      <h3>Exact server review · Solana devnet</h3>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(attempt.prepared.review, null, 2)}</pre>
      <p>Operation <code>{attempt.prepared.id}</code> · fee sponsor <code>{attempt.prepared.feePayer}</code> · signing wallet <code>{attempt.prepared.walletId}</code> · expires {new Date(attempt.prepared.expiresAt).toLocaleString()}.</p>
      {!terminal && !attempt.submitted && <button type="button" className="button primary" disabled={busy || !operation.loaded} onClick={() => void operation.signSubmit()}>Confirm exact review and sign</button>}
      {!terminal && attempt.submitted && <><p role="status">Submitted or confirmation unknown. Recover this same operation; do not create another request.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void operation.reconcile()}>Check same operation</button>{attempt.result?.state === 'prepared' && <button type="button" className="button secondary" disabled={busy} onClick={() => void operation.resend()}>Resubmit identical signed transaction</button>}</>}
    </> : attempt.submitted ? <><p role="status">Recovering operation <code>{attempt.id}</code>. Do not create another request.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void operation.reconcile()}>Check same operation</button></> : <><p>Preparation not yet confirmed. Retry the same request to recover its review.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void operation.prepare()}>Recover same preparation</button></>}
    {attempt.result && <p role="status">Transaction {attempt.result.state}.</p>}
    {attempt.result?.signature && <p><a href={devnetReceipt(attempt.result.signature)} target="_blank" rel="noopener noreferrer">View devnet transaction</a></p>}
    {(terminal || !attempt.submitted) && <button type="button" className="button secondary" disabled={busy} onClick={() => void operation.dismiss()}>{terminal ? 'Done' : 'Cancel unsigned request'}</button>}
    {busy && <p role="status">Waiting for wallet or devnet confirmation…</p>}
    {operation.error && <><p role="alert">{operation.error}</p><button type="button" className="button secondary" disabled={busy} onClick={operation.recover}>Recover existing operation</button></>}
  </div>;
}

export function ShareWorkflows({ request, go }: { request: Request; go: (area: Area) => void }) {
  const wallet = useRentalWallet();
  const account = `${wallet.subject}:${wallet.wallets.map(item => item.id).join(':')}`;
  // Another account gets a fresh view: remounting resets every piece of state at once.
  return <SharedMarketView key={account} request={request} go={go} account={account} />;
}

function SharedMarketView({ request, account, earlier = false }: { request: Request; go?: (area: Area) => void; account: string; earlier?: boolean }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const revision = useRef(0);
  const acting = useRef(false);
  const [view, setView] = useState<View | null>(null);
  const solana = view?.network === 'solana-devnet';
  const shareDecimals = view?.shareDecimals ?? 18;
  const stockSymbol = view?.stockSymbol ?? 'TSLA';
  const cashSymbol = view?.cashSymbol ?? 'tUSDG';
  const marketDollars = (value: string | null) => dollars(value, cashSymbol);
  const selector = earlier ? '?network=robinhood' : '';
  const [tab, setTab] = useState('borrow');
  const [operation, setOperation] = useState('deposit_collateral');
  const [taskChosen, setTaskChosen] = useState(false);
  const taskRef = useRef<HTMLElement>(null);
  const [ethBalance, setEthBalance] = useState<string | undefined>();
  const [quantity, setQuantity] = useState('1');
  const [liquidationQuantity, setLiquidationQuantity] = useState('1');
  const [liquidationBorrower, setLiquidationBorrower] = useState('');
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
      const { page } = await request<{ page: LiquidationPage }>(`/api/share-workflows?view=unhealthy${earlier ? '&network=robinhood' : ''}&cursor=${encodeURIComponent(loanPage?.nextCursor ?? '0')}&pageSize=20`);
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
      const [{ workflow }, robinhood] = await Promise.all([
        request<{ workflow: View }>(`/api/share-workflows${selector}`),
        // A failed fee reading must not discard a successful market reading.
        request<{ robinhood: { ok: boolean; value?: { ethBalance?: string } } | null }>('/api/assets?area=holdings')
          .then(({ robinhood }) => robinhood).catch(() => null),
      ]);
      if (current !== revision.current) return;
      setView(workflow); setReadError(''); setReview(null);
      setEthBalance(robinhood?.ok ? robinhood.value?.ethBalance : undefined);
    } catch (cause) {
      if (current === revision.current) { setReadError(cause instanceof Error ? cause.message : 'Market unavailable'); setReview(null); }
    }
  }, [request, selector]);
  const solanaOperation = useReviewedSolanaOperation(request, '/api/share-workflows', `${account}:${earlier ? 'earlier' : 'primary'}`, refresh);
  useEffect(() => {
    const read = () => { if (activeTab && !acting.current && document.visibilityState === 'visible') void refresh(); };
    read();
    const timer = setInterval(read, 60_000);
    window.addEventListener('ledger-balances-changed', read);
    document.addEventListener('visibilitychange', read);
    return () => { clearInterval(timer); window.removeEventListener('ledger-balances-changed', read); document.removeEventListener('visibilitychange', read); };
  }, [refresh, activeTab, account]);
  useEffect(() => {
    if (earlier) return;
    const consume = () => { const intent = sessionStorage.getItem(SHARE_NAVIGATION_INTENT); if (intent) { const choice = intent === 'lend' ? 'lend' : 'borrow'; setTab(choice); setOperation(choice === 'lend' ? 'lend' : 'deposit_collateral'); setTaskChosen(true); setReview(null); sessionStorage.removeItem(SHARE_NAVIGATION_INTENT); } };
    consume(); window.addEventListener(SHARE_NAVIGATION_INTENT, consume);
    return () => window.removeEventListener(SHARE_NAVIGATION_INTENT, consume);
  }, [earlier]);
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
          const prepared = await request<{ walletId: string; steps: Step[]; needsApproval: boolean }>('/api/share-workflows', { network: 'robinhood', action: 'prepare', operation: action.operation, quantity: action.quantity, ...(action.borrower ? { borrower: action.borrower } : {}) });
          needsApproval = prepared.needsApproval;
          for (const step of prepared.steps) {
            setStepDescription(step.description);
            const signed = await wallet.signEvmTransaction({ walletId: prepared.walletId, operationId: `market-${step.transaction.nonce}`, description: step.description, expiresAt: new Date(Date.now() + 120_000).toISOString(), transaction: step.transaction });
            submitted = true;
            hash = (await request<{ hash: string }>('/api/share-workflows', { network: 'robinhood', action: 'submit', signed })).hash;
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
    return busy || (solana && (!solanaOperation.loaded || solanaOperation.busy || Boolean(solanaOperation.attempt))) || !ready || (usesCollateral && Boolean(view?.suspended)) || (needsPrice && !fresh && !(solana && (view?.mirrorAvailable || view?.canRefreshPrice))) || (operation === 'liquidate' && (loansLoading || Boolean(loansError) || Boolean(loanPage?.suspended)));
  }
  function blockedReason(selected: string) {
    if (!actionBlocked(selected)) return '';
    if (busy) return 'Waiting for the current wallet action and network confirmation.';
    if (solana && solanaOperation.attempt) return 'Finish or recover the existing Solana operation before preparing another.';
    if (readError) return 'Market balances could not be checked. Refresh before reviewing an action.';
    if (!ready) return 'A deployed market and confirmed wallet read are required.';
    if (['deposit_collateral', 'withdraw_collateral', 'borrow', 'liquidate'].includes(selected) && view?.suspended) return 'Collateral operations are suspended by the issuer restrictions shown above.';
    if (selected === 'liquidate' && (loansLoading || loansError || loanPage?.suspended)) return 'Wait for a successful, unsuspended liquidation assessment.';
    return 'A fresh mirrored TSLA price is required for this action.';
  }
  const collateralAction = operation === 'deposit_collateral' || operation === 'withdraw_collateral';
  const amountUnit = collateralAction ? stockSymbol : cashSymbol;
  let amountAtomic: bigint | null = null;
  const humanAmount = quantity.trim();
  if (/^\d+(?:\.\d+)?$/.test(humanAmount) && (humanAmount.split('.')[1]?.length ?? 0) <= (collateralAction ? shareDecimals : 6)) {
    amountAtomic = parseUnits(humanAmount, collateralAction ? shareDecimals : 6);
  }
  const cashNeeded = operation === 'repay' && view?.loan && amountAtomic !== null
    ? amountAtomic < BigInt(view.loan.debtAtomic) ? amountAtomic : BigInt(view.loan.debtAtomic)
    : amountAtomic;
  const needsDollars = Boolean(ready && view?.testUsdAtomic !== null && cashNeeded !== null && ['lend', 'repay'].includes(operation) && cashNeeded > BigInt(view?.testUsdAtomic ?? '0'));
  const needsShares = Boolean(ready && view?.sharesRaw !== null && amountAtomic !== null && operation === 'deposit_collateral' && amountAtomic > BigInt(view?.sharesRaw ?? '0'));
  const operations = tab === 'lend' ? [['lend', 'Lend'], ['unlend', 'Withdraw']] : [['deposit_collateral', 'Add collateral'], ['borrow', 'Borrow'], ['repay', 'Repay'], ['withdraw_collateral', 'Withdraw collateral']];
  const hasLoan = BigInt(view?.loan?.sharesRaw ?? '0') > 0n || BigInt(view?.loan?.debtAtomic ?? '0') > 0n;
  const hasCollateral = BigInt(view?.loan?.sharesRaw ?? '0') > 0n;
  const hasDebt = BigInt(view?.loan?.debtAtomic ?? '0') > 0n;
  const noShares = view?.sharesRaw === '0' && !hasLoan && tab === 'borrow';
  const figureDollars = (value: string | null | undefined) => value == null ? '—' : solana ? marketDollars(value) : (Number(value) / 1e6).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  function choose(next: string) {
    setTab(['lend', 'unlend'].includes(next) ? 'lend' : 'borrow');
    setOperation(next); setTaskChosen(true); setReview(null); setError('');
  }
  const marketLoaded = view !== null;
  useEffect(() => {
    if (!taskChosen || !marketLoaded) return;
    const task = taskRef.current;
    task?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    (task?.querySelector('input') ?? task)?.focus({ preventScroll: true });
  }, [taskChosen, operation, marketLoaded]);
  function action(label: string, operation: string, needsPrice = false, borrower?: string, inputQuantity = quantity) {
    return <button type="button" className="button secondary" disabled={actionBlocked(operation, needsPrice)} onClick={() => {
      setError(''); setReview(null);
      const collateral = operation === 'deposit_collateral' || operation === 'withdraw_collateral';
      const decimals = collateral ? shareDecimals : 6;
      const unit = collateral ? stockSymbol : cashSymbol;
      const humanAmount = inputQuantity.trim();
      if (!/^\d+(?:\.\d+)?$/.test(humanAmount)) { setError(`Enter a positive decimal amount in ${unit}.`); return; }
      if ((humanAmount.split('.')[1]?.length ?? 0) > decimals) { setError(`${unit} amounts support at most ${decimals} decimal places; no rounding is applied.`); return; }
      const atomic = parseUnits(humanAmount, decimals);
      if (atomic <= 0n || atomic.toString().length > 78) { setError(`Enter a positive ${unit} amount within the supported range.`); return; }
      if (operation === 'liquidate' && !borrower?.trim()) { setError('Enter the borrower wallet whose unsafe loan you want to assess.'); return; }
      // The server checks again with fresh chain reads; this answers at once, before any review or signature.
      const shortfall = !solana && view && view.sharesRaw !== null && view.testUsdAtomic !== null && view.loan && view.lender && marketShortfall(operation, atomic, {
        walletTsla: BigInt(view.sharesRaw), walletUsd: BigInt(view.testUsdAtomic), collateral: BigInt(view.loan.sharesRaw), debt: BigInt(view.loan.debtAtomic),
        available: BigInt(view.loan.availableAtomic), withdrawable: BigInt(view.lender.maxWithdrawAtomic) });
      if (shortfall) { setError(shortfall); return; }
      if (solana) void solanaOperation.prepare({ operation, quantity: atomic.toString(), ...(borrower ? { borrower } : {}) });
      else setReview({ operation, quantity: atomic.toString(), humanAmount, unit, ...(borrower ? { borrower } : {}) });
    }}>{label}</button>;
  }
  return <section className="card share-workflows" id={earlier ? 'earlier-share-workflows' : 'share-workflows'}>
    <header className="share-market-head"><h2>{earlier ? 'Robinhood Chain test pool · earlier balances' : 'Borrow test dollars against test TSLA, or lend test dollars to earn interest.'}</h2>{view && <p>{solana ? 'Solana devnet · tTSLA and tUSDC · 6 decimals · sponsored fees' : 'Robinhood Chain testnet · TSLA and tUSDG'}</p>}</header>
    {readError && <p role="alert">{readError}</p>}
    {!view && !readError && <p role="status" style={{ minHeight: 240 }}>Reading shared market…</p>}
    {view && <>
      {!view.deployment && <p role="status">Shared market is not deployed. No mirrored TSLA valuation or loan actions are available.</p>}
      {view.suspended && <p role="alert">Market operations suspended: {view.suspensionReasons.join('; ') || 'External issuer restrictions'}. Collateral is not currently usable for market operations.</p>}
      {view.deployment && !view.price && <p role="status">{solana ? 'No operator-mirrored price available.' : 'No mainnet round copied yet.'}</p>}
      <div className="share-position-cards">
        <section className="share-position-card" aria-labelledby={earlier ? 'earlier-your-loan' : 'your-loan'}>
          <h3 id={earlier ? 'earlier-your-loan' : 'your-loan'}>Your loan</h3>
          <Figures><Figure label="Borrowed" value={figureDollars(view.loan?.debtAtomic)} /><Figure label="Collateral" value={view.loan ? shares(view.loan.sharesRaw, shareDecimals) : '—'} unit={stockSymbol} /></Figures>
          {hasLoan && <StatusLine tone={!fresh ? 'waiting' : (view.loan?.ltvBps ?? 0) >= 8000 ? 'alert' : 'ok'}>{!fresh ? 'Health needs a fresh price' : (view.loan?.ltvBps ?? 0) >= 8000 ? 'Unsafe: liquidation possible' : `Healthy · ${Number(view.loan?.ltvBps ?? 0) / 100}% borrowed`}</StatusLine>}
          <div className="share-card-actions">{hasLoan ? <>{hasCollateral && !hasDebt ? <button className="button secondary" onClick={() => choose('borrow')}>Borrow</button> : <button className="button secondary" onClick={() => choose('repay')}>Repay</button>}<button className="button secondary" onClick={() => choose('deposit_collateral')}>Add collateral</button><button className="button secondary" onClick={() => choose('withdraw_collateral')}>Withdraw collateral</button></> : <button className="button primary" onClick={() => choose('deposit_collateral')}>Borrow</button>}</div>
        </section>
        <section className="share-position-card" aria-labelledby={earlier ? 'earlier-your-lending' : 'your-lending'}>
          <h3 id={earlier ? 'earlier-your-lending' : 'your-lending'}>Your lending</h3>
          <Figures label="Test dollars"><Figure label="Lent" value={figureDollars(view.lender?.netContributedAtomic)} /><Figure label="Earned" value={figureDollars(view.lender?.earnedAtomic)} /><Figure label="Withdrawable" value={figureDollars(view.lender?.maxWithdrawAtomic)} /></Figures>
          <div className="share-card-actions"><button className="button secondary" onClick={() => choose('lend')}>Lend</button>{BigInt(view.lender?.maxWithdrawAtomic ?? '0') > 0n && <button className="button secondary" onClick={() => choose('unlend')}>Withdraw</button>}</div>
        </section>
      </div>
      <p className="share-wallet-line">Wallet: {figureDollars(view.testUsdAtomic)} · {view.sharesRaw === null ? '—' : shares(view.sharesRaw, shareDecimals)} {stockSymbol} · {solana ? 'fees sponsored' : ethBalance === undefined ? 'fee balance unavailable' : belowGasDripThreshold(ethBalance) ? 'fee balance low' : 'fee balance OK'}{solana && view.walletAddress && <> · <code>{view.walletAddress}</code></>}</p>
      <StatusLine tone={fresh ? 'neutral' : 'alert'}>{view.priceAtomic ? `1 ${stockSymbol} ≈ ${figureDollars(view.priceAtomic)}` : 'Price unavailable'}{view.price && ` · price from ${since(view.price.sourceUpdatedAt)} ago`}{view.price?.stale && ' · stale'}</StatusLine>
      {solana && !fresh && (view.canRefreshPrice || view.mirrorAvailable) && <p role="status">Prepare checks a fresh Robinhood mirror copy before producing a transaction review. Synchronization can fail or remain pending; no wallet signature is requested until a valid review is available.</p>}
      {taskChosen && <section ref={taskRef} tabIndex={-1} className="share-market-task" aria-label={tab === 'lend' ? 'Lending task' : 'Borrowing task'}>
        <h3>{operations.find(([id]) => id === operation)?.[1] ?? operation}</h3>
        {noShares ? <p>{solana ? <>Get test tTSLA in <a href="#test-money">Get test money</a> to start a loan.</> : <>Get test TSLA from the <a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Robinhood faucet</a> to start a loan.</>}</p> : <>
          <label className="share-market-amount">Amount in {amountUnit}<input value={quantity} onChange={(event) => { setQuantity(event.target.value); setReview(null); }} inputMode="decimal" /></label>
          <p className="share-preview" role="status">{amountAtomic !== null && amountAtomic > 0n ? `${collateralAction ? `${quantity} ${stockSymbol}` : figureDollars(amountAtomic.toString())} ${operation === 'deposit_collateral' ? `locks about ${figureDollars(view.priceAtomic && fresh ? (amountAtomic * BigInt(view.priceAtomic) / 10n ** BigInt(shareDecimals)).toString() : null)} of collateral` : `to ${operations.find(([id]) => id === operation)?.[1].toLowerCase() ?? operation}`}` : 'Enter an amount to preview this action.'}</p>
          {operation === 'deposit_collateral' && <button className="text-button" onClick={() => choose('borrow')}>Collateral already added? Borrow →</button>}
          {needsShares && <p role="status">{solana ? <>This amount needs more test tTSLA from <a href="#test-money">Get test money</a>.</> : <>This amount needs more test TSLA from the <a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Robinhood faucet</a>.</>}</p>}
          {ready && (needsDollars || !solana && belowGasDripThreshold(ethBalance)) && <div className="share-market-funding">{solana ? <p>You need more site tUSDC. Use <a href="#test-money">Get test money</a>; transaction fees are sponsored.</p> : <><p>{needsDollars ? 'You need more test dollars and a fee balance.' : 'You need a fee balance.'}</p><TestDollars request={request} ethBalance={ethBalance} refresh={refresh} needDollars={needsDollars} /></>}</div>}
          {action(`Review ${operations.find(([id]) => id === operation)?.[1].toLowerCase() ?? operation}`, operation, operation === 'borrow' || operation === 'withdraw_collateral' && BigInt(view.loan?.debtAtomic ?? '0') > 0n)}
        </>}
        {tab === 'borrow' ? <>
          <p>Borrow up to 50% of collateral value; liquidation from 80%.</p>
          <p>{solana ? 'Centrally issued test shares have no value or rights. Price synchronization and liquidation can fail; collateral remains at risk.' : 'Robinhood can pause, block, burn or upgrade test TSLA.'}</p>
          {operation === 'repay' && <p>To close the loan, enter a little more than the debt; Repay takes only what you owe.</p>}
        </> : <p>Borrower interest increases lender value; losses and bad debt reduce it. Withdrawals depend on available pool cash.</p>}
        {blockedReason(operation) && <p role="status">{blockedReason(operation)}</p>}
      </section>}
      <MoreList>
      <MoreRow title="How prices and the pool work" meta={view.price?.stale ? 'Price stale' : 'Price source, job status and pool limits'}>
        <p>{view.disclaimer}</p>
        <p>Borrowing stops at 90% pool utilization. Interest accrues every second; Repay takes only what you owe. Adding collateral and repayment remain possible with a stale price. Lender value includes interest and losses; withdrawals depend on pool cash.</p>
        <p>Wallet {stockSymbol} value: {marketDollars(view.walletValueAtomic)} · collateral value: {marketDollars(view.loan?.valueAtomic ?? null)} · borrowing available: {marketDollars(view.loan?.availableAtomic ?? null)} · current lending value: {marketDollars(view.lender?.valueAtomic ?? null)}{!solana && <> · exact fee balance: {ethBalance ?? 'unavailable'} test ETH</>}.</p>
        <p>Exact debt: {view.loan ? `${formatUnits(BigInt(view.loan.debtAtomic), 6)} ${cashSymbol}` : 'unavailable'}.</p>
        {view.price && <p>Price source round is {since(view.price.sourceUpdatedAt)} old; copied {since(view.price.pushedAt)} ago.{view.price.weekendFreshnessWindow && ' Weekend freshness window: 74 h.'}</p>}
        {view.price && (solana ? <p>Operator mirror on Solana devnet, copied from the existing Robinhood test-TSLA mirror; not a Chainlink feed or a resale quote. Price account <code>{view.price.sourceFeed}</code> · source time {time(view.price.sourceUpdatedAt)} · copied at {time(view.price.pushedAt)}.</p> : <p>Robinhood TSLA token price from <a href={`https://robinhoodchain.blockscout.com/address/${view.price.sourceFeed}`} target="_blank" rel="noopener noreferrer">Chainlink RHTSLA/USD (mainnet)</a>, converted to the test token’s multiplier · source chain {view.price.sourceChainId} · round {view.price.sourceRoundId} at {time(view.price.sourceUpdatedAt)} · copied at {time(view.price.pushedAt)}. Mirror, not a Chainlink contract.</p>)}
        {view.deployment && view.priceJob && <p>Hourly price job · {view.priceJob.message} {view.priceJob.lastRun ? `Last run: ${time(view.priceJob.lastRun.at)}, ${view.priceJob.lastRun.status}${view.priceJob.lastRun.reason ? ` (${view.priceJob.lastRun.reason.replaceAll('_', ' ')})` : ''}. ` : ''}{view.priceJob.lastPush ? <>Last round copied: {view.priceJob.lastPush.sourceRoundId}, source time {view.priceJob.lastPush.sourceUpdatedAt ? time(view.priceJob.lastPush.sourceUpdatedAt) : 'unknown'}, copied {time(view.priceJob.lastPush.at)}{view.priceJob.lastPush.transactionHash && <> (<a href={`${EXPLORER_TX}${view.priceJob.lastPush.transactionHash}`} target="_blank" rel="noopener noreferrer">transaction</a>)</>}.</> : 'No copy recorded by the job yet.'}</p>}
        {view.pool && <div><h3>Pool facts</h3><p>Cash: {marketDollars(view.pool.cashAtomic)} · total assets: {marketDollars(view.pool.totalAssetsAtomic)} · borrowed: {marketDollars(view.pool.borrowedAtomic)} · utilization: {view.pool.utilizationBps / 100}% · current borrower rate: {view.pool.borrowAprBps / 100}% nominal a year (≈{view.pool.effectiveBorrowApyBps / 100}% effective a year) · current lender rate: {view.pool.supplyAprBps / 100}% APR (not a projection).</p>{solana ? <p>Debt exposure capped at 2,000 tUSDC. Test-only pool; lender shares are separate accounting units, not tTSLA.</p> : <p>10,000 tUSDG seeded at deploy to a burn address. Nobody can withdraw those seed shares; their interest stays locked in the pool.</p>}</div>}
      </MoreRow>
      <MoreRow title="Liquidate an unsafe loan · advanced" meta="Assess unsafe loans before choosing a repayment">
      <section className="share-market-task" aria-label="Liquidation task">
      <label className="share-market-amount">Liquidation repayment amount in {cashSymbol}<input value={liquidationQuantity} onChange={(event) => { setLiquidationQuantity(event.target.value); setReview(null); }} inputMode="decimal" /></label>
      {solana && <><label className="share-market-amount">Borrower Solana wallet<input value={liquidationBorrower} onChange={event => setLiquidationBorrower(event.target.value)} spellCheck={false} /></label><p>Prepare checks the borrower and synchronizes the price if needed. Only an eligible loan produces an exact review.</p>{action('Prepare liquidation review', 'liquidate', true, liquidationBorrower.trim(), liquidationQuantity)}</>}
      <h3>Loans that can be liquidated</h3>
      {!fresh && <p>A fresh price is required for assessment and signing.{solana && ' Preparation can check mirror synchronization before producing a review.'}</p>}
      {!loanPage && <button type="button" className="button secondary" disabled={loansLoading || !ready || !fresh} onClick={() => void loadLoans()}>Show loans that can be liquidated</button>}
      {loansLoading && <p role="status">Reading up to 20 borrowers…</p>}
      {loansError && <p role="alert">{loansError}</p>}
      {loanPage && <>
        <p>Scanned {loanPage.scanned} borrowers · observed at {time(loanPage.observedAt)}. This is a point-in-time assessment, not a guarantee of liquidation.</p>
        {loanPage.suspended && <p role="alert">Liquidation suspended: {loanPage.suspensionReasons.join('; ') || 'External issuer restrictions'}.</p>}
        {loanPage.loans.length === 0 && !loanPage.suspended && <p>No loans that can be liquidated in the scanned borrowers.</p>}
        {loanPage.loans.map((loan) => <div key={loan.borrower}><code>{loan.borrower}</code><p>Debt {marketDollars(loan.debtAtomic)} · collateral {shares(loan.sharesRaw, shareDecimals)} {stockSymbol} · LTV {loan.ltvBps / 100}%</p>{action(`Review repayment and receive ${stockSymbol}`, 'liquidate', true, loan.borrower, liquidationQuantity)}</div>)}
        {loanPage.nextCursor !== null && <button type="button" className="button secondary" disabled={loansLoading || !ready || !fresh} onClick={() => void loadLoans()}>Load next 20 borrowers</button>}
      </>}
      <p>Anyone liquidates with their own test dollars and wallet signature. No operator can stage a price fall. {solana ? 'The server prepares the exact repayment and collateral receipt on Solana devnet.' : 'Robinhood can pause, block, burn or upgrade its token; these issuer powers can affect collateral.'}</p>
      </section></MoreRow>
      </MoreList>
    </>}
    {review && <div className="share-market-review" role="region" aria-label="Review market action"><p>Review {operations.find(([id]) => id === review.operation)?.[1].replace(/^\d\. /, '').toLowerCase() ?? (review.operation === 'liquidate' ? 'repay part and receive TSLA' : review.operation)}: {review.humanAmount} {review.unit}{review.borrower ? ` for ${review.borrower}` : ''}. Robinhood Chain testnet · pool recipient <code>{view?.deployment?.pool}</code> · source wallet <code>{wallet.wallets.find(item => item.chainType === 'ethereum')?.address}</code>. You sign exact-amount approvals and the market transaction with your own wallet.</p><button type="button" className="button primary" disabled={actionBlocked(review.operation)} onClick={() => void execute()}>Confirm and sign</button><button type="button" className="button secondary" onClick={() => setReview(null)}>Cancel</button>{blockedReason(review.operation) && <p role="status">{blockedReason(review.operation)}</p>}</div>}
    {busy && <p role="status">{stepDescription || 'Waiting for wallet and transaction confirmation…'}</p>}{message && <p role="status">{message}{confirmedHashes.length > 0 && <> · {confirmedHashes.map((hash, index) => <span key={hash}>{index > 0 && ', '}<a href={`${EXPLORER_TX}${hash}`} target="_blank" rel="noopener noreferrer">{confirmedHashes.length > 1 ? `step ${index + 1}` : 'view transaction'}</a></span>)}</>}</p>}{!message && confirmedHashes.length > 0 && <p role="status">Submitted: {confirmedHashes.map((hash, index) => <span key={hash}>{index > 0 && ', '}<a href={`${EXPLORER_TX}${hash}`} target="_blank" rel="noopener noreferrer">step {index + 1}</a></span>)}</p>}{error && <p role="alert">{error}</p>}
    {!earlier && <SolanaOperationReview operation={solanaOperation} />}
    {!solana && <LocalEarningsRehearsal key={account} request={request} account={account} />}
    {solana && !earlier && <MoreList><MoreRow title="Robinhood Chain test pool · earlier balances" meta="Separate earlier TSLA, tUSDG, loans and lending"><SharedMarketView request={request} account={account} earlier /></MoreRow></MoreList>}
    <ScreenNote>Test dollars and test TSLA have no monetary value. Borrowing carries liquidation and issuer risk. Deposit earnings belong to the tenant.</ScreenNote>
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
  return <MoreRow title="Rental earnings rehearsal · local only" meta={starting ? 'Setup incomplete' : 'Needs a local setup'}><h3>Rental earnings rehearsal in a local setup</h3><p>Not connected to a Home tenancy. The operator acts as the test landlord only. You self-mint test dollars, sign funding and supply to the shared pool. Earnings are actual borrower interest, not operator credits, and belong to the tenant; there may be none yet.</p>
    {starting && <p role="status">Rehearsal setup is incomplete. Resume setup to continue the saved steps.</p>}
    {earnings && <p>Escrow <code>{earnings.escrow}</code> · pool <code>{earnings.vault}</code> · state {earnings.state} · protected principal {dollars(earnings.securityAtomic)} · claimable {dollars(earnings.releasableAtomic)} · released {dollars(earnings.releasedAtomic)}. Claims require pool cash.</p>}
    {operations.map((operation) => <button type="button" key={operation} disabled={busy || (operation === 'claim' && BigInt(earnings?.releasableAtomic ?? '0') === 0n)} onClick={() => setReview(operation)}>{operation === 'setup' && starting ? 'Resume setup' : operation}</button>)}
    {review && <div><p>Review local rehearsal step: {review}. This uses test dollars with no monetary value.</p><button type="button" disabled={busy} onClick={() => void execute(review)}>Confirm {review}</button><button type="button" onClick={() => setReview(null)}>Cancel</button></div>}
    {busy && <p role="status">Waiting for rehearsal transaction…</p>}{error && <p role="alert">{error}</p>}
  </MoreRow>;
}
