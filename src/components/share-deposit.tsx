'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRentalWallet } from '@/wallets';
import { belowGasDripThreshold } from '@/domain/gas-threshold';
import type { ShareDepositPlan, SolanaShareDepositPlan, ShareDepositView, ShareDepositAction } from '@/domain/share-deposit';
import { TestDollars } from './test-dollars';
import { nextShareDepositAction, pendingShareDepositReceipt, requireBoundShareReview, requireBoundSolanaShareReview, formatDepositShares, shareDepositReceiptUrl, type ShareReviewParties, shareDepositAmount, shareRefreshIsCurrent, showShareClaim, showTenantFunding, shareFeeBalance, shareReceiptPollDelay } from './share-deposit-logic';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Receipt = { planId: string; transactionHash: string };
export const depositShares = (raw: string, decimals: 6 | 18 = 18) => decimals === 6 ? formatDepositShares(raw, 6) : (Number(raw) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 8 });
export const depositUsd = (raw: string) => `$${(Number(raw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })}`;
const time = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const labels: Record<ShareDepositAction, string> = {
  create: 'Create the empty escrow', approve: 'Approve exact TSLA', pledge: 'Lock test TSLA',
  activate: 'Activate deposit', withdraw: 'Withdraw extra TSLA', proposeClaim: 'Propose USD deduction',
  acceptClaim: 'Accept bounded deduction', contestClaim: 'Contest deduction', lowerClaim: 'Lower or withdraw deduction',
  escalateClaim: 'Escalate to arbitrator', resolveClaim: 'Resolve in TSLA', requestReturn: 'Request full return',
  closeUnclaimed: 'Return unclaimed deposit', closeUnresolved: 'Return unresolved deposit', payout: 'Collect fixed-recipient payout',
};
export function ShareDepositRules({ network }: { network?: 'solana-devnet' } = {}) {
  return <div className="small-copy">
    <p>Test TSLA deposit on {network === 'solana-devnet' ? 'Solana devnet (6 decimal shares). The site sponsors transaction fees.' : 'Robinhood Chain testnet (46630).' } 150 % cover to activate or withdraw extra; below 125 % the tenant is asked to top up, not forced on chain. No yield, forced sale or DEX: settlement is in TSLA, not dollars.</p>
    <p>Default response and return windows: 7 days each; arbitration: 30 days. The accepted agreement fixes the actual windows. Silence is never consent or an automatic landlord award. After the arbitration window anyone may return the deposit to the tenant. {network === 'solana-devnet' ? 'Fictional test shares have no value or rights.' : 'Robinhood can pause, block, burn or upgrade TSLA. Test tokens have no value;'} not legal advice.</p>
  </div>;
}
type DepositProps = { rentalId: string; request: Request; reload: () => Promise<void>; network?: 'solana-devnet' };
export function ShareDeposit(props: DepositProps) {
  return props.network === 'solana-devnet' ? <SolanaShareDeposit {...props} /> : <EvmShareDeposit {...props} />;
}
function EvmShareDeposit({ rentalId, request, reload }: DepositProps) {
  const wallet = useRentalWallet();
  const walletIds = wallet.wallets.filter(w => w.chainType === 'ethereum' && w.connected).map(w => w.id).join(',');
  const [view, setView] = useState<ShareDepositView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [plan, setPlan] = useState<ShareDepositPlan | null>(null);
  const [receipts, setReceipts] = useState<string[]>([]);
  const [pending, setPending] = useState<Receipt | null>(null);
  const [ethBalance, setEthBalance] = useState<string | undefined>();
  const [evidence, setEvidence] = useState('');
  const [records, setRecords] = useState<{ name: string; body: string }[]>([]);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const result = await request<{ view: ShareDepositView }>(`/api/share-deposit?rentalId=${encodeURIComponent(rentalId)}`);
      if (!shareRefreshIsCurrent(current, revision.current)) return;
      setView(result.view);
      const unfinished = pendingShareDepositReceipt(result.view.receipts, walletIds.split(','));
      setPending(unfinished ? { planId: unfinished.planId, transactionHash: unfinished.transactionHash } : null);
      const assets = await request<{ robinhood: { ok: boolean; value?: { ethBalance?: string } } | null }>('/api/assets?area=holdings');
      if (shareRefreshIsCurrent(current, revision.current)) setEthBalance(shareFeeBalance(assets));
      const agreement = await request<{ agreement: { records: { name: string; body: string }[] } }>(`/api/agreements/${encodeURIComponent(rentalId)}`);
      if (current === revision.current) setRecords(agreement.agreement.records);
    } catch (cause) {
      if (!shareRefreshIsCurrent(current, revision.current)) return;
      setError(cause instanceof Error ? cause.message : 'Deposit unavailable'); setEthBalance(undefined);
    }
  }, [request, rentalId, walletIds]);
  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 0);
    const invalidate = () => { revision.current++; };
    return () => { clearTimeout(timer); invalidate(); };
  }, [refresh]);
  useEffect(() => {
    const read = () => { if (!busy && !plan && !pending && document.visibilityState === 'visible') void refresh(); };
    const timer = setInterval(read, 60_000);
    window.addEventListener('ledger-balances-changed', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      clearInterval(timer);
      window.removeEventListener('ledger-balances-changed', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, [refresh, busy, plan, pending]);
  const prepare = useCallback(async (operation: ShareDepositAction, side?: 'tenant' | 'landlord') => {
    revision.current++;
    setBusy(true); setError(''); setPlan(null);
    try {
      const body: Record<string, unknown> = { action: 'prepare', rentalId, operation };
      if (['approve', 'pledge', 'withdraw', 'resolveClaim'].includes(operation)) {
        if (!amount && !['approve', 'pledge'].includes(operation)) throw new Error('Enter the exact TSLA amount.');
        body.shares = amount ? shareDepositAmount(amount, 18) : view?.requiredShares;
      }
      if (['proposeClaim', 'contestClaim', 'resolveClaim'].includes(operation)) {
        if (evidence.trim().length < 12) throw new Error('Add a move-out reason of at least 12 characters.');
        body.evidence = evidence.trim();
      }
      if (['proposeClaim', 'lowerClaim'].includes(operation)) {
        if (!amount) throw new Error('Enter the USD deduction (zero returns the whole deposit).');
        body.usd6 = shareDepositAmount(amount, 6);
      }
      if (operation === 'acceptClaim') body.maxShares = view?.claim?.shares;
      if (side) body.side = side;
      const result = await request<{ plan: ShareDepositPlan }>('/api/share-deposit', body);
      if (!view) throw new Error('Refresh the accepted agreement first.');
      requireBoundShareReview(result.plan, view);
      setPlan(result.plan);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cannot prepare'); }
    finally { setBusy(false); }
  }, [request, rentalId, amount, evidence, view]);
  const confirmed = useCallback(async () => {
    await reload(); await refresh();
    window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } }));
  }, [reload, refresh]);
  const reconcile = useCallback(async (input: Receipt) => {
    const result = await request<{ status: 'pending' | 'confirmed' | 'failed'; view: ShareDepositView }>('/api/share-deposit', { action: 'submit', ...input });
    setView(result.view);
    if (result.status === 'confirmed') { setPending(null); await confirmed(); }
    else if (result.status === 'failed') { setPending(null); await reload(); setError('Transaction failed on chain. Review the refreshed deposit before trying another action.'); }
    return result.status;
  }, [request, confirmed, reload]);
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let running = false;
    let failures = 0;
    let timer: number;
    const poll = async () => {
      if (stopped || running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const status = await reconcile(pending);
        failures = 0;
        if (status !== 'pending') return;
      } catch (cause) {
        failures++;
        if (!stopped) setError(cause instanceof Error ? cause.message : 'Receipt unavailable; retrying.');
      } finally { running = false; }
      if (!stopped) timer = window.setTimeout(() => { void poll(); }, shareReceiptPollDelay(failures));
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') void poll();
    };
    timer = window.setTimeout(() => { void poll(); }, shareReceiptPollDelay(0));
    document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [pending, reconcile]);
  async function sign() {
    if (!plan || !view || busy) return;
    revision.current++;
    setBusy(true); setError('');
    try {
      if (ethBalance === undefined || belowGasDripThreshold(ethBalance)) throw new Error('Check your test ETH fee balance and use the gas drip before signing.');
      if (!wallet.wallets.some(w => w.id === plan.walletId && w.chainType === 'ethereum' && w.connected)) throw new Error('Use the verified EVM wallet for this agreement.');
      requireBoundShareReview(plan, view);
      const signed = await wallet.signEvmTransaction({
        walletId: plan.walletId, operationId: `share-deposit:${plan.id}:0`, description: plan.review.lines.join('\n'),
        expiresAt: plan.expiresAt, transaction: plan.transaction, shareDeposit: plan.review,
      });
      const result = await request<{ transactionHash: string; status: 'pending' | 'confirmed' | 'failed'; view: ShareDepositView }>('/api/share-deposit', { action: 'submit', planId: plan.id, signed });
      setReceipts(previous => [...previous, result.transactionHash]); setView(result.view); setPlan(null);
      if (result.status === 'pending') setPending({ planId: plan.id, transactionHash: result.transactionHash });
      else if (result.status === 'confirmed') await confirmed();
      else { setPending(null); await reload(); setError('Transaction failed on chain. No successful action is recorded; review again.'); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Approval failed'); }
    finally { setBusy(false); }
  }
  const next = view ? nextShareDepositAction(view) : null;
  return <section className="card share-workflows" aria-label="Share-backed rental deposit">
    <h3>Test TSLA rental deposit</h3>
    {error && <p role="alert">{error}</p>}
    {!view && !error && <p role="status">Reading escrow and agreement…</p>}
    {view && <>
      {view.deployment === 'not_deployed' && <p role="status">Share deposit not deployed yet. Funding and signatures are disabled.</p>}
      <p>Required security: {depositUsd(view.form.securityUsd6)} USD · state: {view.state ?? 'empty escrow not created'}.</p>
      {view.paidOut ? <p role="status">Paid out in TSLA: custody is empty and the payout receipt is confirmed.</p> : view.state === 'Closed' && <p role="status">Decision closed; payment is not complete until fixed-recipient payouts are confirmed. Outstanding landlord award: {depositShares(view.landlordOwed)} TSLA, with priority up to available custody; tenant receives the remainder.</p>}
      <p>Agreed windows: response {view.form.responseWindow / 86400} days · return {view.form.returnWindow / 86400} days · arbitration {view.form.arbitrationWindow / 86400} days.</p>
      <p>Locked in your deposit: {depositShares(view.lockedShares)} TSLA. Not spendable and not loan collateral.</p>
      {view.quote ? <p>Token quote: {depositUsd(view.quote.priceUsd6)} USD per TSLA · source {time(view.quote.sourceTime)} · copied {view.quote.copiedAt ? time(view.quote.copiedAt) : 'unavailable'} · {view.quote.fresh ? 'fresh' : 'stale — cover unavailable'}. Cover: {view.quote.fresh && view.coverBps !== null ? `${view.coverBps / 100} %` : 'unavailable'}.</p> : <p>Price and cover unavailable.</p>}
      {view.priceJob && <p role={view.priceJob.health === 'attention' ? 'alert' : 'status'}>Price copy job: {view.priceJob.message}</p>}
      {showTenantFunding(view) && view.needsTopUp && <p role="alert">Below 125 % cover: please top up. No forced sale or on-chain top-up enforcement.</p>}
      {showTenantFunding(view) && <p>You need {view.requiredShares === null ? 'a fresh price to calculate' : depositShares(view.requiredShares)} test TSLA at 150 %; you hold {depositShares(view.walletShares)}. <a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Robinhood faucet</a> gives 5 test TSLA per claim.</p>}
      {showShareClaim(view) && view.claim && <p>Deduction proposed: {depositUsd(view.claim.usd6)} USD = {depositShares(view.claim.shares)} TSLA, fixed at proposal price {depositUsd(view.claim.price6)}. Acceptance is capped at these shares; no later price is used. Move-out evidence: {view.claim.evidenceHash}.</p>}
      {view.responseDeadline > 0 && <p>Response deadline: {time(view.responseDeadline)}</p>}
      {view.returnDeadline > 0 && <p>Return deadline: {time(view.returnDeadline)}</p>}
      {view.arbitrationDeadline > 0 && <p>Arbitration deadline: {time(view.arbitrationDeadline)}</p>}
      {view.warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
      {records.length > 0 && <details><summary>Agreement records</summary>{records.map((record, index) => <section key={index}><h4>{record.name}</h4><p style={{ whiteSpace: 'pre-wrap' }}>{record.body}</p></section>)}</details>}
      {view.actions.length > 0 && view.deployment === 'deployed' && <>
        <p>Next: {next ? labels[next] : view.state === 'Active' && view.role === 'tenant' ? 'no action needed. Top up below 125 %, withdraw extra above 150 %, or request return' : 'wait for another party'}. Parties send their own transactions.</p>
        {showShareClaim(view) && records.filter(record => ['Move-out inspection', 'Dispute the deduction', 'Arbitration decision'].includes(record.name)).map((record, index) => <section key={index}><h4>{record.name}</h4><p style={{ whiteSpace: 'pre-wrap' }}>{record.body}</p></section>)}
        {view.actions.includes('withdraw') && <p>Withdraw extra: maximum {view.maximumWithdrawShares === null ? 'unavailable without a fresh quote' : `${depositShares(view.maximumWithdrawShares)} test TSLA (${view.maximumWithdrawShares} raw units)`}. Active withdrawals must leave 150 % cover.</p>}
        <label>Amount (TSLA for pledge / withdrawal / arbitration; USD for deduction)<input inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setPlan(null); }} /></label>
        <label>Move-out record / dispute / arbitration reason<textarea value={evidence} onChange={e => { setEvidence(e.target.value); setPlan(null); }} /></label>
        {ethBalance === undefined && <p role="status">Test ETH balance unavailable. Refresh before signing.</p>}
        {(ethBalance === undefined || belowGasDripThreshold(ethBalance)) && <TestDollars request={request} ethBalance={ethBalance} refresh={refresh} needDollars={false} />}
        <div className="deduction-choices">
          {view.actions.filter(action => action !== 'payout').map(action => <button key={action} className="button secondary" disabled={busy || !!pending} onClick={() => void prepare(action)}>{labels[action]}</button>)}
          {view.actions.includes('payout') && <>
            <button className="button secondary" disabled={busy || !!pending} onClick={() => void prepare('payout', 'landlord')}>Pay landlord in TSLA</button>
            <button className="button secondary" disabled={busy || !!pending} onClick={() => void prepare('payout', 'tenant')}>Pay tenant in TSLA</button>
          </>}
        </div>
      </>}
      {view.explorerUrl && <a href={view.explorerUrl} target="_blank" rel="noopener noreferrer">Read escrow on explorer</a>}
    </>}
    {plan && <section className="card" aria-label="Exact transaction review">
      <h4>{plan.review.title}</h4>{plan.review.lines.map((line, index) => <p key={index}>{line}</p>)}
      <ShareDepositRules />
      <p>Contract: {plan.to} · function: {plan.review.functionName} · chain 46630 · native value 0.</p>
      <button className="button primary" disabled={busy || ethBalance === undefined || belowGasDripThreshold(ethBalance)} onClick={() => void sign()}>Sign this exact transaction</button>
      <button className="button secondary" disabled={busy} onClick={() => setPlan(null)}>Cancel review</button>
    </section>}
    {pending && <p role="status">Submitted; awaiting confirmed receipt. <button className="button secondary" disabled={busy} onClick={() => { setBusy(true); void reconcile(pending).catch(cause => setError(String(cause))).finally(() => setBusy(false)); }}>Check receipt</button></p>}
    {view?.receipts.map(receipt => <p key={receipt.planId}>{labels[receipt.action]} · {receipt.status} · <a href={`https://explorer.testnet.chain.robinhood.com/tx/${receipt.transactionHash}`} target="_blank" rel="noopener noreferrer">Transaction receipt {receipt.transactionHash}</a></p>)}
    {receipts.filter(hash => !view?.receipts.some(receipt => receipt.transactionHash === hash)).map(hash => <p key={hash}><a href={`https://explorer.testnet.chain.robinhood.com/tx/${hash}`} target="_blank" rel="noopener noreferrer">Submitted transaction {hash}</a></p>)}
    <button className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh deposit and fee balance</button>
  </section>;
}

function SolanaShareDeposit({ rentalId, request, reload }: DepositProps) {
  const wallet = useRentalWallet();
  const walletIds = wallet.wallets.filter(w => w.chainType === 'solana' && w.connected).map(w => w.id).join(',');
  const [view, setView] = useState<ShareDepositView | null>(null);
  const [parties, setParties] = useState<ShareReviewParties | null>(null);
  const [records, setRecords] = useState<{ name: string; body: string }[]>([]);
  const [plan, setPlan] = useState<SolanaShareDepositPlan | null>(null);
  const [pending, setPending] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('');
  const [evidence, setEvidence] = useState('');
  const signed = useRef<{ planId: string; signedTransactionBase64: string } | null>(null);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const [result, agreement] = await Promise.all([
        request<{ view: ShareDepositView }>(`/api/share-deposit?rentalId=${encodeURIComponent(rentalId)}`),
        request<{ agreement: { parties: Record<'tenant' | 'landlord' | 'arbitrator', { wallet?: { address: string } } | null>; records: { name: string; body: string }[] } }>(`/api/agreements/${encodeURIComponent(rentalId)}`),
      ]);
      if (!shareRefreshIsCurrent(current, revision.current)) return;
      if (result.view.network !== 'solana-devnet') throw new Error('This is not a Solana share deposit.');
      setView(result.view);
      setParties({
        tenant: agreement.agreement.parties.tenant?.wallet?.address ?? '',
        landlord: agreement.agreement.parties.landlord?.wallet?.address ?? '',
        arbitrator: agreement.agreement.parties.arbitrator?.wallet?.address ?? '',
      });
      setRecords(agreement.agreement.records);
      const unfinished = pendingShareDepositReceipt(result.view.receipts, walletIds.split(','));
      setPending(unfinished ? { planId: unfinished.planId, transactionHash: unfinished.transactionHash } : null);
      setError('');
    } catch (cause) {
      if (shareRefreshIsCurrent(current, revision.current)) setError(cause instanceof Error ? cause.message : 'Deposit unavailable');
    }
  }, [request, rentalId, walletIds]);
  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 0);
    const invalidate = () => { revision.current++; };
    return () => { clearTimeout(timer); invalidate(); };
  }, [refresh]);
  useEffect(() => {
    const read = () => { if (!busy && !plan && !pending && document.visibilityState === 'visible') void refresh(); };
    const timer = setInterval(read, 60_000);
    window.addEventListener('ledger-balances-changed', read);
    document.addEventListener('visibilitychange', read);
    return () => { clearInterval(timer); window.removeEventListener('ledger-balances-changed', read); document.removeEventListener('visibilitychange', read); };
  }, [refresh, busy, plan, pending]);
  const reconcile = useCallback(async (receipt: Receipt) => {
    const result = await request<{ transactionHash: string; status: 'pending' | 'confirmed' | 'failed'; view: ShareDepositView }>('/api/share-deposit', {
      action: 'submit', network: 'solana-devnet', planId: receipt.planId,
      ...(signed.current?.planId === receipt.planId ? { signedTransactionBase64: signed.current.signedTransactionBase64 } : {}),
    });
    setView(result.view);
    if (result.status !== 'pending') {
      signed.current = null; setPending(null);
      await reload(); await refresh();
      if (result.status === 'confirmed') window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'solana' } }));
      else setError('Transaction failed on chain. Review the refreshed deposit before trying another action.');
    } else if (result.transactionHash && !receipt.transactionHash) setPending({ ...receipt, transactionHash: result.transactionHash });
    return result.status;
  }, [request, reload, refresh]);
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let running = false;
    let failures = 0;
    let timer: number;
    const poll = async () => {
      if (stopped || running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const status = await reconcile(pending);
        failures = 0;
        if (status !== 'pending') return;
      } catch (cause) {
        failures++;
        if (!stopped) setError(cause instanceof Error ? cause.message : 'Receipt unavailable; retrying.');
      } finally { running = false; }
      if (!stopped) timer = window.setTimeout(() => { void poll(); }, shareReceiptPollDelay(failures));
    };
    const visible = () => { clearTimeout(timer); if (document.visibilityState === 'visible') void poll(); };
    timer = window.setTimeout(() => { void poll(); }, shareReceiptPollDelay(0));
    document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [pending, reconcile]);
  async function prepare(operation: ShareDepositAction, side?: 'tenant' | 'landlord') {
    if (!view || !parties || busy || pending) return;
    revision.current++; setBusy(true); setError('');
    try {
      if (plan) await request('/api/share-deposit', { action: 'cancel', network: 'solana-devnet', planId: plan.id });
      setPlan(null);
      const body: Record<string, unknown> = { action: 'prepare', rentalId, operation, requestId: crypto.randomUUID(), network: 'solana-devnet' };
      if (['pledge', 'withdraw', 'resolveClaim'].includes(operation)) {
        if (!amount && operation !== 'pledge') throw new Error('Enter the exact TSLA amount.');
        if (!amount && view.requiredShares === null) throw new Error('A fresh price is required to calculate the remaining pledge.');
        const remaining = view.requiredShares === null ? 0n : BigInt(view.requiredShares) - BigInt(view.lockedShares);
        body.shares = amount ? shareDepositAmount(amount, 6) : (remaining > 0n ? remaining : 0n).toString();
      }
      if (['proposeClaim', 'contestClaim', 'resolveClaim'].includes(operation)) {
        if (evidence.trim().length < 12) throw new Error('Add a move-out reason of at least 12 characters.');
        body.evidence = evidence.trim();
      }
      if (['proposeClaim', 'lowerClaim'].includes(operation)) {
        if (!amount) throw new Error('Enter the USD deduction (zero returns the whole deposit).');
        body.usd6 = shareDepositAmount(amount, 6);
      }
      if (operation === 'acceptClaim') body.maxShares = view.claim?.shares;
      if (side) body.side = side;
      const result = await request<{ plan: SolanaShareDepositPlan }>('/api/share-deposit', body);
      const actor = wallet.wallets.find(w => w.id === result.plan.walletId && w.chainType === 'solana' && w.connected);
      if (!actor) throw new Error('Use the verified Solana wallet for this agreement.');
      requireBoundSolanaShareReview(result.plan, view, parties, actor);
      if (result.plan.action !== operation ||
          (body.shares !== undefined && result.plan.review.shares !== body.shares) ||
          (body.maxShares !== undefined && result.plan.review.shares !== body.maxShares) ||
          (body.usd6 !== undefined && result.plan.review.usd6 !== body.usd6))
        throw new Error('Prepared review differs from the requested action or exact amount.');
      setPlan(result.plan);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cannot prepare'); }
    finally { setBusy(false); }
  }
  async function sign() {
    if (!plan || !view || !parties || busy || pending) return;
    revision.current++; setBusy(true); setError('');
    try {
      const actor = wallet.wallets.find(w => w.id === plan.walletId && w.chainType === 'solana' && w.connected);
      if (!actor) throw new Error('Use the verified Solana wallet for this agreement.');
      requireBoundSolanaShareReview(plan, view, parties, actor);
      const bytes = await wallet.signSolanaTransaction({
        walletId: plan.walletId, operationId: `share-deposit:${plan.id}`, chain: 'solana:devnet', feePayer: plan.feePayer,
        expiresAt: plan.expiresAt, description: plan.review.lines.join('\n'),
        transaction: Uint8Array.from(atob(plan.transactionBase64), character => character.charCodeAt(0)),
      });
      signed.current = { planId: plan.id, signedTransactionBase64: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) };
      const receipt = { planId: plan.id, transactionHash: '' };
      setPlan(null); setPending(receipt);
      await reconcile(receipt);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Signature or submission failed'); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!plan || busy) return;
    setBusy(true); setError('');
    try { await request('/api/share-deposit', { action: 'cancel', network: 'solana-devnet', planId: plan.id }); setPlan(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Cannot cancel review'); }
    finally { setBusy(false); }
  }
  const shares = (raw: string) => depositShares(raw, 6);
  const next = view ? nextShareDepositAction(view) : null;
  return <section className="card share-workflows" aria-label="Solana share-backed rental deposit">
    <h3>Test TSLA rental deposit · Solana devnet</h3>
    {error && <p role="alert">{error}</p>}
    {!view && !error && <p role="status">Reading escrow and accepted agreement…</p>}
    {view && <>
      {view.deployment === 'not_deployed' && <p role="status">Share deposit not deployed yet. Funding and signatures are disabled.</p>}
      <p>Required security: {depositUsd(view.form.securityUsd6)} USD · state: {view.state ?? 'empty escrow not created'}.</p>
      <p>Locked in your deposit: {shares(view.lockedShares)} test TSLA (6 decimals). Not spendable and not loan collateral.</p>
      {view.paidOut ? <p role="status">Paid out in test TSLA: custody is empty and the payout receipt is confirmed.</p> : view.state === 'Closed' && <p role="status">Decision closed; payment is not complete until fixed-recipient payouts are confirmed. Outstanding landlord award: {shares(view.landlordOwed)} test TSLA, with priority up to available custody; tenant receives the remainder.</p>}
      <p>Agreed windows: response {view.form.responseWindow / 86400} days · return {view.form.returnWindow / 86400} days · arbitration {view.form.arbitrationWindow / 86400} days.</p>
      {view.quote ? <p>Token quote: {depositUsd(view.quote.priceUsd6)} USD per TSLA · source {time(view.quote.sourceTime)} · copied {view.quote.copiedAt ? time(view.quote.copiedAt) : 'unavailable'} · {view.quote.fresh ? 'fresh' : 'stale — cover unavailable'}. Cover: {view.quote.fresh && view.coverBps !== null ? `${view.coverBps / 100} %` : 'unavailable'}.</p> : <p>Price and cover unavailable.</p>}
      {view.priceJob && <p role={view.priceJob.health === 'attention' ? 'alert' : 'status'}>Price copy job: {view.priceJob.message}</p>}
      {showTenantFunding(view) && view.needsTopUp && <p role="alert">Needs you: below 125 % cover, please top up. No forced sale or on-chain top-up enforcement.</p>}
      {showTenantFunding(view) && <p>You need {view.requiredShares === null ? 'a fresh price to calculate' : shares(view.requiredShares)} test TSLA at 150 %; you hold {shares(view.walletShares)}. For fictional test shares, go to <Link href="/?area=money">Money</Link> → Get test money → Test TSLA on Solana (5 per verified account per 24 hours; shared daily limit). Applying does not fund the deposit.</p>}
      {showShareClaim(view) && view.claim && <p>Deduction proposed: {depositUsd(view.claim.usd6)} USD = {shares(view.claim.shares)} test TSLA, fixed at proposal price {depositUsd(view.claim.price6)}. Acceptance is capped at these shares; no later price is used. Move-out evidence: {view.claim.evidenceHash}.</p>}
      {view.responseDeadline > 0 && <p>Response deadline: {time(view.responseDeadline)}</p>}
      {view.returnDeadline > 0 && <p>Return deadline: {time(view.returnDeadline)}</p>}
      {view.arbitrationDeadline > 0 && <p>Arbitration deadline: {time(view.arbitrationDeadline)}</p>}
      {view.warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
      {records.length > 0 && <details><summary>Agreement records</summary>{records.map((record, index) => <section key={index}><h4>{record.name}</h4><p style={{ whiteSpace: 'pre-wrap' }}>{record.body}</p></section>)}</details>}
      {view.actions.length > 0 && view.deployment === 'deployed' && <>
        <p>Next: {next ? labels[next] : view.state === 'Active' && view.role === 'tenant' ? 'no action needed. Top up below 125 %, withdraw extra above 150 %, or request return' : 'wait for another party'}.</p>
        {view.actions.includes('withdraw') && <p>Withdraw extra: maximum {view.maximumWithdrawShares === null ? 'unavailable without a fresh quote' : `${shares(view.maximumWithdrawShares)} test TSLA`}. Active withdrawals must leave 150 % cover.</p>}
        <label style={{ display: 'grid', gap: 6 }}>Amount ({view.role === 'landlord' ? 'USD deduction' : 'test TSLA'})<input inputMode="decimal" value={amount} disabled={busy || !!plan || !!pending} onChange={event => setAmount(event.target.value)} /></label>
        {view.actions.some(action => ['proposeClaim', 'contestClaim', 'resolveClaim'].includes(action)) && <label style={{ display: 'grid', gap: 6 }}>Move-out record / dispute / arbitration reason<textarea value={evidence} disabled={busy || !!plan || !!pending} onChange={event => setEvidence(event.target.value)} /></label>}
        <p>The site sponsors Solana devnet fees. No SOL gas drip or separate token approval is needed. Test shares have no value.</p>
        <div className="deduction-choices" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          {view.actions.filter(action => action !== 'payout' && action !== 'approve').map(action => <button key={action} className="button secondary" disabled={busy || !!pending || !!plan || !parties} onClick={() => void prepare(action)}>{labels[action]}</button>)}
          {view.actions.includes('payout') && <><button className="button secondary" disabled={busy || !!pending || !!plan || !parties} onClick={() => void prepare('payout', 'landlord')}>Pay landlord in test TSLA</button><button className="button secondary" disabled={busy || !!pending || !!plan || !parties} onClick={() => void prepare('payout', 'tenant')}>Pay tenant in test TSLA</button></>}
        </div>
      </>}
      {view.explorerUrl && <a href={view.explorerUrl} target="_blank" rel="noopener noreferrer">Read escrow on Solana Explorer · devnet</a>}
    </>}
    {plan && <section className="card" aria-label="Exact Solana transaction review">
      <h4>{plan.review.title}</h4>{plan.review.lines.map((line, index) => <p key={index}>{line}</p>)}
      <p>Network: Solana devnet · sponsored fees. Program: {plan.review.programId} · mint: {plan.review.mint} · escrow: {plan.review.escrow}.</p>
      <p>Signer: {plan.review.actor} · tenant: {plan.review.tenant} · landlord: {plan.review.landlord} · arbitrator: {plan.review.arbitrator}.</p>
      {plan.review.shares !== null && <p>Exact shares: {shares(plan.review.shares)} test TSLA ({plan.review.shares} atomic units).</p>}
      {plan.review.usd6 !== null && <p>Exact USD deduction: {depositUsd(plan.review.usd6)}.</p>}
      <ShareDepositRules network="solana-devnet" />
      <button className="button primary" disabled={busy} onClick={() => void sign()}>Sign this exact transaction</button>
      <button className="button secondary" disabled={busy} onClick={() => void cancel()}>Cancel review</button>
    </section>}
    {pending && <p role="status">Submitted; awaiting confirmed Solana devnet receipt. Do not sign another transaction. <button className="button secondary" disabled={busy} onClick={() => { setBusy(true); void reconcile(pending).catch(cause => setError(String(cause))).finally(() => setBusy(false)); }}>Check receipt</button></p>}
    {view?.receipts.map(receipt => <p key={receipt.planId}>{labels[receipt.action]} · {receipt.status} · <a href={shareDepositReceiptUrl(receipt.transactionHash, 'solana-devnet')} target="_blank" rel="noopener noreferrer">Solana devnet receipt {receipt.transactionHash}</a></p>)}
    <button className="button secondary" disabled={busy || !!plan || !!pending} onClick={() => void refresh()}>Refresh deposit</button>
  </section>;
}
