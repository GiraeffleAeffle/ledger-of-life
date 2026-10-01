'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits, parseUnits } from 'viem';
import { useRentalWallet } from '@/wallets';
import type { EvmSigningRequest } from '../wallets/types';
import type { AuthorizedRequest } from './use-city-signals';
import { buildingActionState, estimateBuildingHeat } from './building-panel-logic';

type Operation = 'approve' | 'stake' | 'unstake' | 'claim' | 'sync';
type Receipt = { operation: string; quantityRaw: string | null; hash: string; status: 'pending' | 'confirmed' | 'failed' };
type Building = {
  configured: boolean; status: string; reason: string | null; distributor: string | null; explorerUrl: string;
  revenueRaw: string; paidAnswers: number; gpuTokensServed: number; totalStakedRaw: string;
  heat?: { nominalPowerWatts: number | null; runtimeSeconds: number | null; measuredWhPerToken: number | null };
  validator?: { name?: string; url?: string; status?: string } | null;
  revenueTransactions: { transactionHash: string; amountRaw: string; explorerUrl: string }[];
};
type Position = { configured: boolean; account: string; walletUnitsRaw: string | null; stakedRaw: string | null; earnedRaw: string | null; allowanceRaw: string | null; pendingRevenueRaw?: string | null; receipts?: Receipt[] };
type Plan = { id: string; request: EvmSigningRequest; review: { operation: string; amount: string; asset: string; distributor: string } };
const dollars = (raw: string) => formatUnits(BigInt(raw), 6);

export function BuildingPanel({ request }: { request: AuthorizedRequest }) {
  const wallet = useRentalWallet();
  const [building, setBuilding] = useState<Building | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [amount, setAmount] = useState('1');
  const [submitted, setSubmitted] = useState<Receipt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasSigned, setHasSigned] = useState(false);
  const active = useRef(true);
  const lock = useRef(false);
  const revision = useRef(0);
  const signed = useRef<{ planId: string; bytes: string } | null>(null);
  const account = wallet.wallets.find((item) => item.chainType === 'ethereum' && item.connected)?.address;
  const refresh = useCallback(async () => {
    const generation = ++revision.current;
    try {
      const response = await fetch('/api/building', { cache: 'no-store' });
      if (!response.ok) throw new Error('Building read unavailable');
      const value = await response.json() as { building: Building };
      if (active.current && generation === revision.current) setBuilding(value.building);
      const own = account ? await request<Position>('/api/building/claims') : null;
      if (active.current && generation === revision.current) { setPosition(own); setError(''); }
    } catch (cause) {
      if (active.current && generation === revision.current) { setPosition(null); setError(cause instanceof Error ? cause.message : 'Building read unavailable'); }
    }
  }, [account, request]);
  useEffect(() => {
    active.current = true;
    const live = active;
    const revisions = revision;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setPosition(null); setPlan(null); setSubmitted(null); setHasSigned(false); signed.current = null;
      void refresh();
    });
    const timer = setInterval(() => { if (!lock.current) void refresh(); }, 30_000);
    return () => { cancelled = true; live.current = false; ++revisions.current; clearInterval(timer); };
  }, [refresh]);
  async function act(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await operation(); } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Building action unavailable'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  let quantity: string | null = null;
  try { if (/^\d+(?:\.\d{1,18})?$/.test(amount)) quantity = parseUnits(amount, 18).toString(); } catch { /* Invalid amounts remain editable. */ }
  const receipts = position?.receipts ?? [];
  const pending = receipts.some((receipt) => receipt.status === 'pending') || Boolean(submitted?.status === 'pending' && !receipts.some((receipt) => receipt.hash === submitted.hash && receipt.status !== 'pending'));
  const common = { configured: Boolean(building?.configured && position?.configured), connected: Boolean(account), busy: busy || pending || Boolean(plan), quantityRaw: quantity, walletUnitsRaw: position?.walletUnitsRaw ?? null, stakedRaw: position?.stakedRaw ?? null, earnedRaw: position?.earnedRaw ?? null, pendingRevenueRaw: position?.pendingRevenueRaw ?? null };
  const stakeOperation = quantity && position?.allowanceRaw != null && BigInt(position.allowanceRaw) >= BigInt(quantity) ? 'stake' : 'approve';
  async function prepare(operation: Operation) {
    await act(async () => {
      const next = await request<{ plan: Plan }>('/api/building/claims', { action: 'prepare', operation, ...(['approve', 'stake', 'unstake'].includes(operation) ? { quantity } : {}) });
      if (active.current) { signed.current = null; setPlan(next.plan); }
    });
  }
  async function submit() {
    if (!plan) return;
    await act(async () => {
      if (!signed.current) signed.current = { planId: plan.id, bytes: await wallet.signEvmTransaction(plan.request) };
      if (active.current) setHasSigned(true);
      const next = await request<{ hash: string; status: 'pending' | 'confirmed' }>('/api/building/claims', { action: 'submit', planId: signed.current.planId, signedTransaction: signed.current.bytes });
      if (active.current) { setSubmitted({ ...next, operation: plan.review.operation, quantityRaw: quantity }); setPlan(null); setHasSigned(false); signed.current = null; }
      await refresh();
    });
  }
  const heat = building ? estimateBuildingHeat({ tokens: building.gpuTokensServed, measuredWhPerToken: building.heat?.measuredWhPerToken, runtimeMs: building.heat?.runtimeSeconds == null ? null : building.heat.runtimeSeconds * 1000, nominalWatts: building.heat?.nominalPowerWatts }) : null;
  return <div className="city-flywheel building-panel" style={{ overflowWrap: 'anywhere' }}>
    <span className="eyebrow">tHOME · FICTIONAL TEST UNITS · NO VALUE, NO RIGHTS</span><h3>Live building</h3>
    <p>Only staked tHOME units earn: income streams to stakers over 7 days, not as an instant payout. Seven days is a scheduling window, not a guaranteed finish: every positive new receipt extends the outstanding stream, even a tiny test-dollar transfer. Revenue during an idle period restarts streaming when staking resumes, never as a lump sum.</p>
    <p>Stake, claim accrued earnings or unstake any time with your own wallet. Unstake units before selling them back at the desk. This is fictional testnet accounting, not property rights or real investment returns.</p>
    <button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>Refresh building</button>
    {error && <p role="alert">{error} · No success or missing balance is inferred.</p>}
    {!building ? <p role="status">Reading the building…</p> : <>
      {!building.configured && <p role="status">Not configured: {building.reason || 'The building distributor has not been provisioned.'}</p>}
      <div className="local-ai-metrics">
        <div><strong>{building.paidAnswers}</strong><span>Recorded paid GPU answers</span></div>
        <div><strong>{dollars(building.revenueRaw)} tUSDG</strong><span>Verified received by building</span></div>
        <div><strong>{building.gpuTokensServed}</strong><span>Recorded served tokens</span></div>
        <div><strong>{heat ? `${heat.kwh.toFixed(6)} kWh` : 'Unavailable'}</strong><span>Estimated GPU heat</span></div>
      </div>
      <p>{heat ? `Heat estimate: ${heat.assumption}.` : 'Heat estimate unavailable: measured energy per token or runtime and nominal GPU power are not recorded.'} GPU electrical energy becomes heat; this is not metered useful heat or a heating-bill saving. Recoverable heat offsets heating mainly in winter, depending on location and demand. Recorded answer runtime is wall-clock time, not measured GPU-active time.</p>
      <p><strong>Validator:</strong> {building.validator ? <>{building.validator.name || 'Configured validator'} · {building.validator.status || 'Public read'} {building.validator.url && <a href={building.validator.url} target="_blank" rel="noopener noreferrer">View public reading</a>}</> : 'Planned · no building validator configured.'}</p>
      <p><strong>Solar:</strong> Needs the local Home Assistant link; not shown on the hosted site.</p>
      <p>Public answers are available only when a host enables them, within the shared allowance; free answers have no payout. <a href="/library">Open the public AI desk</a></p>
      <h4>GPU revenue receipts</h4>
      {building.revenueTransactions.length ? <ul>{building.revenueTransactions.map((tx) => <li key={tx.transactionHash}><a href={tx.explorerUrl} target="_blank" rel="noopener noreferrer">{dollars(tx.amountRaw)} tUSDG received · {tx.transactionHash}</a></li>)}</ul> : <p>No building transfer receipts recorded. Existing personal host payouts are not building income.</p>}
      <h4>Your units and earnings</h4>
      <div className="local-ai-metrics">
        <div><strong>{position?.configured && position.walletUnitsRaw != null ? formatUnits(BigInt(position.walletUnitsRaw), 18) : '—'} tHOME</strong><span>In your wallet</span></div>
        <div><strong>{position?.configured && position.stakedRaw != null ? formatUnits(BigInt(position.stakedRaw), 18) : '—'} tHOME</strong><span>Staked · earning share</span></div>
        <div><strong>{position?.configured && position.earnedRaw != null ? dollars(position.earnedRaw) : '—'} tUSDG</strong><span>Earned so far · currently claimable</span></div>
      </div>
      {position?.configured && <p>Wallet: <code>{position.account}</code> · Total building stake: {formatUnits(BigInt(building.totalStakedRaw), 18)} tHOME.</p>}
      <label>tHOME units to stake or unstake <input aria-label="tHOME stake or unstake amount" inputMode="decimal" value={amount} disabled={busy || Boolean(plan) || pending} onChange={(event) => setAmount(event.target.value)} /></label>
      <div className="local-test-actions">
        {(['stake', 'claim', 'unstake'] as const).map((operation) => {
          const reason = buildingActionState({ ...common, operation });
          return <div key={operation}><button type="button" className="button primary" disabled={Boolean(reason) || Boolean(error)} onClick={() => void prepare(operation === 'stake' ? stakeOperation : operation)}>{operation === 'stake' ? stakeOperation === 'approve' ? 'Stake · review exact approval first' : 'Review stake' : operation === 'claim' ? 'Review claim' : 'Review unstake'}</button>{reason && <p className="small-copy">{reason}</p>}</div>;
        })}
      </div>
      {position?.configured && position.pendingRevenueRaw != null && BigInt(position.pendingRevenueRaw) > 0n && <div><p>{dollars(position.pendingRevenueRaw)} tUSDG of new income awaits a stream update. This does not claim earnings or pay you a lump sum.</p><button type="button" className="button primary" disabled={Boolean(buildingActionState({ ...common, operation: 'sync' })) || Boolean(error)} onClick={() => void prepare('sync')}>Start streaming new income to stakers (anyone can do this)</button></div>}
      <p className="small-copy">Staking needs two separate exact reviews when allowance is insufficient: approve only the entered units, then stake after the approval receipt is confirmed. No unlimited approval. Fictional test units, no value, no rights.</p>
      <p className="small-copy">Use the Stake action, never transfer tHOME directly to the distributor: direct unit transfers do not earn rewards and cannot be recovered. Plain tUSDG transfers are revenue, not unit stakes.</p>
      {plan && <div className="local-order-review"><h4>Exact {plan.review.operation} review</h4><p>{plan.review.amount} {plan.review.asset} · Robinhood Chain testnet (46630).</p><p>Distributor: <code>{plan.review.distributor}</code><br />Own wallet: <code>{wallet.wallets.find((item) => item.id === plan.request.walletId)?.address || position?.account}</code></p><p>{plan.request.description} Network fees use test ETH. Fictional test units, no value, no rights.</p><button type="button" className="button primary" disabled={busy || !account} onClick={() => void submit()}>{hasSigned ? 'Retry submitting the same signed transaction' : `${plan.review.operation === 'approve' ? 'Approve exact units' : plan.review.operation === 'stake' ? 'Stake' : plan.review.operation === 'unstake' ? 'Unstake' : plan.review.operation === 'sync' ? 'Start streaming new income' : 'Claim'} with my wallet`}</button>{!hasSigned && <button type="button" className="text-button" disabled={busy} onClick={() => setPlan(null)}>Close unsigned review</button>}</div>}
      {pending && <p role="status">A signed building transaction is pending. Wait for its verified receipt before another action.</p>}
      <h4>Your building action receipts</h4>
      {!receipts.length && !submitted && <p>No building action receipts for this wallet.</p>}
      <ul>{[...receipts, ...(submitted && !receipts.some((item) => item.hash === submitted.hash) ? [submitted] : [])].map((item) => <li key={item.hash}><a href={`${building.explorerUrl}/tx/${item.hash}`} target="_blank" rel="noopener noreferrer">{item.operation} · {item.status === 'confirmed' ? 'confirmed' : item.status === 'failed' ? 'failed · no success inferred' : 'awaiting verified receipt'} · {item.hash}</a></li>)}</ul>
    </>}
  </div>;
}
