'use client';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { formatUnits, parseUnits } from 'viem';
import { useRentalWallet } from '@/wallets';
import type { EvmSigningRequest } from '../wallets/types';
import type { AuthorizedRequest } from './use-city-signals';
import { buildingActionState, estimateBuildingHeat, projectedBuildingEarnings } from './building-panel-logic';
import { useSectionTabActive } from './section-tabs';
import type { ReinvestView } from '../server/building-revenue-reinvest';
import { Hero, StatusLine, Figures, Figure, MoreList, MoreRow } from './blocks';
import { usd } from './money-valuation';

type Operation = 'approve' | 'stake' | 'unstake' | 'claim' | 'sync';
type Receipt = { operation: string; quantityRaw: string | null; hash: string; status: 'pending' | 'confirmed' | 'failed' };
type Building = {
  configured: boolean; status: string; reason: string | null; distributor: string | null; explorerUrl: string;
  revenueRaw: string; paidAnswers: number; gpuTokensServed: number; totalStakedRaw: string;
  rewardRateRaw: string; rewardScaleRaw: string; periodFinish: number;
  incomeSources: { id: string; name: string; meaning: string; amountRaw: string }[];
  payingDevices: { name: string; kind: 'operator' | 'community'; availability: 'online' | 'asleep' | 'offline' }[];
  heat?: { nominalPowerWatts: number | null; runtimeSeconds: number | null; measuredWhPerToken: number | null };
  validator?: { name?: string; url?: string; status?: string } | null;
  revenueTransactions: { transactionHash: string; logIndex: number; amountRaw: string; explorerUrl: string; sourceName: string }[];
};
export type BuildingPosition = { configured: boolean; account: string; walletUnitsRaw: string | null; stakedRaw: string | null; earnedRaw: string | null; allowanceRaw: string | null; pendingRevenueRaw?: string | null; receipts?: Receipt[]; observedAt?: number; reinvest?: ReinvestView | null };
type Plan = { id: string; request: EvmSigningRequest; review: { operation: string; amount: string; asset: string; distributor: string } };
const dollars = (raw: string) => formatUnits(BigInt(raw), 6);

export function BuildingPanel({ request, position, setPosition, visual }: { request: AuthorizedRequest; position: BuildingPosition | null; setPosition: Dispatch<SetStateAction<BuildingPosition | null>>; visual: ReactNode }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const [building, setBuilding] = useState<Building | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [amount, setAmount] = useState('1');
  const [submitted, setSubmitted] = useState<Receipt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [readingPosition, setReadingPosition] = useState(true);
  const [hasSigned, setHasSigned] = useState(false);
  const [reinvestHasSigned, setReinvestHasSigned] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const active = useRef(true);
  const lock = useRef(false);
  const reading = useRef(false);
  const revision = useRef(0);
  const signed = useRef<{ planId: string; bytes: string } | null>(null);
  const reinvestSigned = useRef<{ stepId: string; bytes: string } | null>(null);
  const account = wallet.wallets.find((item) => item.chainType === 'ethereum' && item.connected)?.address;
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    setReadingPosition(true);
    const generation = ++revision.current;
    try {
      const response = await fetch('/api/building', { cache: 'no-store' });
      if (!response.ok) throw new Error('Building read unavailable');
      const value = await response.json() as { building: Building };
      if (active.current && generation === revision.current) setBuilding(value.building);
      const own = account ? await request<BuildingPosition>('/api/building/claims') : null;
      if (active.current && generation === revision.current) { setPosition(own); setError(''); }
    } catch (cause) {
      if (active.current && generation === revision.current) { setPosition(null); setError(cause instanceof Error ? cause.message : 'Building read unavailable'); }
    } finally { reading.current = false; if (active.current && generation === revision.current) setReadingPosition(false); }
  }, [account, request, setPosition]);
  useEffect(() => {
    if (!activeTab) return;
    active.current = true;
    const live = active;
    const revisions = revision;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setPosition(null); setPlan(null); setSubmitted(null); setHasSigned(false); setReinvestHasSigned(false); signed.current = null; reinvestSigned.current = null;
      void refresh();
    });
    const timer = setInterval(() => { if (!lock.current) void refresh(); }, 10_000);
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => { cancelled = true; live.current = false; ++revisions.current; clearInterval(timer); clearInterval(tick); };
  }, [refresh, activeTab, setPosition]);
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
  const reinvest = position?.reinvest;
  const reinvesting = Boolean(reinvest && !['completed', 'stopped'].includes(reinvest.phase));
  const common = { configured: Boolean(building?.configured && position?.configured), connected: Boolean(account), busy: busy || pending || Boolean(plan) || reinvesting, quantityRaw: quantity, walletUnitsRaw: position?.walletUnitsRaw ?? null, stakedRaw: position?.stakedRaw ?? null, earnedRaw: position?.earnedRaw ?? null, pendingRevenueRaw: position?.pendingRevenueRaw ?? null };
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
  async function reinvestAction(action: 'reinvest_start' | 'reinvest_prepare' | 'reinvest_submit') {
    await act(async () => {
      const step = reinvest?.request;
      if (action === 'reinvest_submit') {
        if (!step || !reinvest.stepId) return;
        if (!reinvestSigned.current) reinvestSigned.current = { stepId: reinvest.stepId, bytes: await wallet.signEvmTransaction(step) };
        if (active.current) setReinvestHasSigned(true);
      }
      const next = await request<{ reinvest: ReinvestView }>('/api/building/claims', {
        action, ...(action === 'reinvest_submit' && reinvestSigned.current ? { stepId: reinvestSigned.current.stepId, signedTransaction: reinvestSigned.current.bytes } : {}),
      });
      if (active.current) { setPosition(current => current ? { ...current, reinvest: next.reinvest } : current); reinvestSigned.current = null; setReinvestHasSigned(false); }
      await refresh();
      window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } }));
    });
  }
  const earnedDisplay = position?.earnedRaw != null && position.stakedRaw != null && position.observedAt && building
    ? projectedBuildingEarnings({ earnedRaw: position.earnedRaw, stakedRaw: position.stakedRaw, totalStakedRaw: building.totalStakedRaw,
      rewardRateRaw: building.rewardRateRaw, rewardScaleRaw: building.rewardScaleRaw, periodFinish: building.periodFinish, observedAt: position.observedAt, now })
    : position?.earnedRaw ?? null;
  const heat = building ? estimateBuildingHeat({ tokens: building.gpuTokensServed, measuredWhPerToken: building.heat?.measuredWhPerToken, runtimeMs: building.heat?.runtimeSeconds == null ? null : building.heat.runtimeSeconds * 1000, nominalWatts: building.heat?.nominalPowerWatts }) : null;
  const claimReason = buildingActionState({ ...common, operation: 'claim' });
  const reinvestReason = claimReason || (position?.earnedRaw == null ? 'Wait for verified earnings' : BigInt(position.earnedRaw) < 1000n || BigInt(position.earnedRaw) > 100_000_000n ? 'Reinvest requires 0.001–100 tUSDG of verified earnings' : null);
  const units = (raw: string | null | undefined) => raw == null ? '—' : Number(formatUnits(BigInt(raw) / 10n ** 14n, 4)).toLocaleString('en-GB', { maximumFractionDigits: 4 });
  const openRow = (id: string) => { const row = document.getElementById(id) as HTMLDetailsElement | null; if (row) { row.open = true; row.dispatchEvent(new Event('toggle')); row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
  return <div className="lean-building" style={{ overflowWrap: 'anywhere' }}>
    <Hero visual={visual} title="Fictional housing example" subtitle="Shared housing with rooftop solar in Strausberg · illustrative" status={<StatusLine tone={position?.configured ? 'ok' : 'neutral'}>{!account ? 'Connect your Shares wallet in Me to see your units' : building && !building.configured ? building.reason || 'Building distributor not configured' : error ? 'Your units could not be checked' : position?.walletUnitsRaw != null && position.stakedRaw != null ? BigInt(position.walletUnitsRaw) + BigInt(position.stakedRaw) === 0n ? 'You hold no tHOME yet' : `You hold ${units((BigInt(position.walletUnitsRaw) + BigInt(position.stakedRaw)).toString())} tHOME · ${BigInt(position.walletUnitsRaw) === 0n ? 'all staked' : `${units(position.stakedRaw)} staked`}` : !readingPosition ? 'Your unit balance is unavailable' : 'Checking your units…'}</StatusLine>}>
      <Figures>
        <Figure label="Claimable now" value={position?.earnedRaw == null ? '—' : BigInt(position.earnedRaw) > 0n && BigInt(position.earnedRaw) < 10_000n ? '< $0.01' : usd(Number(dollars(position.earnedRaw)))} note={claimReason && reinvestReason && claimReason !== reinvestReason ? `${claimReason} · ${reinvestReason}` : claimReason || reinvestReason || undefined} action={<div className="lean-claim-actions"><button type="button" className="text-button" title={claimReason || undefined} disabled={Boolean(claimReason) || Boolean(error)} onClick={() => void prepare('claim')}>Claim</button><button type="button" className="text-button" title={reinvestReason || undefined} disabled={Boolean(error) || Boolean(reinvestReason)} onClick={() => void reinvestAction('reinvest_start')}>Reinvest</button></div>} />
        <Figure label="Your units" value={units(position?.stakedRaw)} unit="tHOME" note={`staked · ${units(position?.walletUnitsRaw)} in wallet`} />
        <Figure label="House income so far" value={building?.revenueRaw == null ? '—' : BigInt(building.revenueRaw) > 0n && BigInt(building.revenueRaw) < 10_000n ? '< $0.01' : usd(Number(dollars(building.revenueRaw)))} />
      </Figures>
      <div className="local-test-actions"><button type="button" className="button primary" onClick={() => openRow('local-unit-desk')}>Buy units</button><button type="button" className="button" onClick={() => openRow('local-unit-staking')}>Stake</button></div>
    </Hero>
    {error && <p role="alert">{error} · No success or missing balance is inferred.</p>}
    {!building ? <p role="status">Reading the building…</p> : <>
      {!building.configured && <p role="status">Not configured: {building.reason || 'The building distributor has not been provisioned.'}</p>}
      <section className="building-rewards" aria-label="Your building rewards">
      {plan && <div className="local-order-review"><h4>Exact {plan.review.operation} review</h4><p>{plan.review.amount} {plan.review.asset} · Robinhood Chain testnet (46630).</p><p>Distributor: <code>{plan.review.distributor}</code><br />Own wallet: <code>{wallet.wallets.find((item) => item.id === plan.request.walletId)?.address || position?.account}</code></p><p>{plan.request.description} Network fees use test ETH. Fictional test units, no value, no rights.</p><button type="button" className="button primary" disabled={busy || !account} onClick={() => void submit()}>{hasSigned ? 'Retry submitting the same signed transaction' : `${plan.review.operation === 'approve' ? 'Approve exact units' : plan.review.operation === 'stake' ? 'Stake' : plan.review.operation === 'unstake' ? 'Unstake' : plan.review.operation === 'sync' ? 'Start streaming new income' : 'Claim'} with my wallet`}</button>{!hasSigned && <button type="button" className="text-button" disabled={busy} onClick={() => setPlan(null)}>Close unsigned review</button>}</div>}
      {pending && <p role="status">A signed building transaction is pending. Wait for its verified receipt before another action. {(submitted?.status === 'pending' ? submitted.hash : receipts.find(receipt => receipt.status === 'pending')?.hash) && <a href={`${building.explorerUrl}/tx/${submitted?.status === 'pending' ? submitted.hash : receipts.find(receipt => receipt.status === 'pending')?.hash}`} target="_blank" rel="noopener noreferrer">View pending transaction</a>}</p>}
      </section>
      <MoreList>
      {reinvest && <MoreRow key={reinvesting ? 'active-reinvest' : 'reinvest-history'} title="Reinvest earnings" meta={reinvesting ? 'Review the next step' : reinvest.phase === 'completed' ? 'Completed · receipts' : 'Stopped · receipts'} defaultOpen={reinvesting}><div className="local-order-review" aria-label="Reinvest earnings workflow">
        <h4>Reinvest · {reinvest.phase === 'completed' ? 'completed' : reinvest.phase === 'stopped' ? 'stopped' : `next: ${reinvest.phase}`}</h4>
        <p>Own wallet: <code>{reinvest.account}</code>{reinvest.claimedRaw != null && <> · Confirmed claim: {dollars(reinvest.claimedRaw)} tUSDG</>}{reinvest.unitsRaw != null && <> · Bought: {formatUnits(BigInt(reinvest.unitsRaw), 18)} tHOME</>}</p>
        <ol><li>Claim accrued tUSDG to your wallet</li><li>Approve only the claimed tUSDG if needed; buy tHOME at the pinned desk</li><li>Approve only the bought tHOME; stake it to earn a share of future streams</li></ol>
        {reinvest.error && <p role="alert">{reinvest.error}</p>}
        {reinvest.pending ? <p role="status">Waiting for the exact signed transaction’s verified receipt. Reload is safe; no replacement is started.</p> : reinvest.request ? <>
          <h4>Exact own-wallet review</h4><p>{reinvest.request.description}</p>
          <p>Chain 46630 · To: <code>{reinvest.request.transaction.to}</code><br />Native value: {reinvest.request.transaction.value} · Nonce: {reinvest.request.transaction.nonce}<br />Gas limit: {reinvest.request.transaction.gasLimit} · Max fee/gas: {reinvest.request.transaction.maxFeePerGas}</p>
          <button type="button" className="button primary" disabled={busy || !account} onClick={() => void reinvestAction('reinvest_submit')}>{reinvestHasSigned ? 'Retry the same signed step' : 'Sign only this reviewed step in my wallet'}</button>
        </> : reinvesting && <button type="button" className="button primary" disabled={busy || !account} onClick={() => void reinvestAction('reinvest_prepare')}>Review next reinvest step</button>}
        <ul>{reinvest.receipts.map(receipt => <li key={receipt.hash}><a href={`${building.explorerUrl}/tx/${receipt.hash}`} target="_blank" rel="noopener noreferrer">{receipt.operation} · {receipt.status} · {receipt.hash}</a></li>)}</ul>
      </div></MoreRow>}
      <MoreRow id="local-unit-staking" title="Stake or unstake" meta={`${units(position?.stakedRaw)} staked`}>
      {position?.configured && position.walletUnitsRaw != null && position.stakedRaw != null && BigInt(position.stakedRaw) === 0n && BigInt(position.walletUnitsRaw) > 0n && <p className="small-copy">Stake your wallet units to share future house income.</p>}
      <p>In your wallet: {position?.walletUnitsRaw == null ? '—' : formatUnits(BigInt(position.walletUnitsRaw), 18)} tHOME. Staked: {position?.stakedRaw == null ? '—' : formatUnits(BigInt(position.stakedRaw), 18)} tHOME.</p>
      <div className="local-test-actions"><button type="button" className="text-button" disabled={busy || Boolean(plan) || pending || position?.walletUnitsRaw == null} onClick={() => position?.walletUnitsRaw != null && setAmount(formatUnits(BigInt(position.walletUnitsRaw), 18))}>Max wallet units</button><button type="button" className="text-button" disabled={busy || Boolean(plan) || pending || position?.stakedRaw == null} onClick={() => position?.stakedRaw != null && setAmount(formatUnits(BigInt(position.stakedRaw), 18))}>Max staked units</button></div>
      <label>tHOME units to stake or unstake <input aria-label="tHOME stake or unstake amount" inputMode="decimal" value={amount} disabled={busy || Boolean(plan) || pending} onChange={(event) => setAmount(event.target.value)} /></label>
      <div className="local-test-actions">{(['stake', 'unstake'] as const).map((operation) => {
        const reason = buildingActionState({ ...common, operation });
        return <div key={operation}><button type="button" className="button primary" disabled={Boolean(reason) || Boolean(error)} onClick={() => void prepare(operation === 'stake' ? stakeOperation : operation)}>{operation === 'stake' ? stakeOperation === 'approve' ? 'Stake · review exact approval first' : 'Review stake' : 'Review unstake'}</button>{reason && <p className="small-copy">{reason}</p>}</div>;
      })}</div>
      <p className="small-copy">Approve only the entered units, then stake after the receipt is confirmed. Never transfer tHOME directly to the distributor: direct transfers do not earn and cannot be recovered.</p>
      {position?.configured && <p>Wallet: <code>{position.account}</code> · Total building stake: {formatUnits(BigInt(building.totalStakedRaw), 18)} tHOME.</p>}
      </MoreRow>
      <MoreRow title="Building action receipts" meta={pending ? 'Pending · receipts' : `${receipts.length} recorded`}>
      <h4>Your building action receipts</h4>
      {!receipts.length && !submitted && <p>No building action receipts for this wallet.</p>}
      <ul>{[...receipts, ...(submitted && !receipts.some((item) => item.hash === submitted.hash) ? [submitted] : [])].map((item) => <li key={item.hash}><a href={`${building.explorerUrl}/tx/${item.hash}`} target="_blank" rel="noopener noreferrer">{item.operation} · {item.status === 'confirmed' ? 'confirmed' : item.status === 'failed' ? 'failed · no success inferred' : 'awaiting verified receipt'} · {item.hash}</a></li>)}</ul>
      </MoreRow>
      <MoreRow title="Where the income comes from" meta={position?.pendingRevenueRaw != null && BigInt(position.pendingRevenueRaw) > 0n ? 'New income ready to stream · sources & receipts' : `${building.paidAnswers} paid answers · sources & receipts`}>
      {position?.configured && position.pendingRevenueRaw != null && BigInt(position.pendingRevenueRaw) > 0n && <div><p>{dollars(position.pendingRevenueRaw)} tUSDG of new income awaits a stream update. This does not claim earnings or pay you a lump sum.</p><button type="button" className="button primary" disabled={Boolean(buildingActionState({ ...common, operation: 'sync' })) || Boolean(error)} onClick={() => void prepare('sync')}>Start streaming new income to stakers (anyone can do this)</button></div>}
      {building.payingDevices.length ? <ul>{building.payingDevices.map((device, index) => <li key={`${device.kind}:${device.name}:${index}`}><strong>{device.name}</strong> · {device.kind === 'operator' ? 'operator device' : 'community device'} · {device.availability}</li>)}</ul> : <p>No device currently pays the building.</p>}
      <Figures>
        <Figure label="Paid answers" value={building.paidAnswers} />
        <Figure label="Served tokens" value={building.gpuTokensServed} />
        <Figure label="Estimated GPU heat" value={heat ? heat.kwh.toFixed(6) : '—'} unit="kWh" />
      </Figures>
      {building.incomeSources.length ? <ul>{building.incomeSources.map(source => <li key={source.id}><strong>{source.name} · {dollars(source.amountRaw)} tUSDG</strong><p className="small-copy">{source.meaning}</p></li>)}</ul> : <p>No confirmed building income yet. Personal host payouts are not building income.</p>}
      <details><summary>All confirmed income receipts</summary>
        {building.revenueTransactions.length ? <ul>{building.revenueTransactions.map(tx => <li key={`${tx.transactionHash}:${tx.logIndex}`}><a href={tx.explorerUrl} target="_blank" rel="noopener noreferrer">{tx.sourceName} · {dollars(tx.amountRaw)} tUSDG · {tx.transactionHash}</a></li>)}</ul> : <p>No distributor transfer receipts recorded.</p>}
      </details>
      <p>Projected earned so far: {earnedDisplay == null ? '—' : dollars(earnedDisplay)} tUSDG. Claim reviews always use a fresh verified read.</p>
    <p>Only staked tHOME units earn: income streams to stakers over 7 days, not as an instant payout. Seven days is a scheduling window, not a guaranteed finish: every positive new receipt extends the outstanding stream, even a tiny test-dollar transfer. Revenue during an idle period restarts streaming when staking resumes, never as a lump sum.</p>
    <p>Stake, claim accrued earnings, reinvest them or unstake any time with your own wallet. Reinvest means claim → buy fractional tHOME at 1 tUSDG per tHOME → exact approval → stake. Review each step separately; reload resumes the durable workflow. Unstake units before selling them back at the desk. Fictional testnet accounting, not property rights or real investment returns.</p>
      <p>The earnings projection follows the current stream and stake share and stops at the stream’s end. New income or stake changes require a fresh read. Reinvest requires 0.001–100 tUSDG of verified earnings; test ETH pays each network fee.</p>
      <p>{heat ? `Heat estimate: ${heat.assumption}.` : 'Heat estimate unavailable: measured energy per token or runtime and nominal GPU power are not recorded.'} GPU electrical energy becomes heat; this is not metered useful heat or a heating-bill saving. Recoverable heat offsets heating mainly in winter, depending on location and demand. Recorded answer runtime is wall-clock time, not measured GPU-active time.</p>
      <p><strong>Validator:</strong> {building.validator ? <>{building.validator.name || 'Configured validator'} · {building.validator.status || 'Public read'} {building.validator.url && <a href={building.validator.url} target="_blank" rel="noopener noreferrer">View public reading</a>}</> : 'Planned · no building validator configured.'}</p>
      <p><strong>Solar:</strong> Home Node readings can support explicitly assigned, simulated feed-in income. The hosted site never pulls your LAN or Home Assistant token; this is not a real electricity sale.</p>
      <p>Public answers are available only when a host enables them, within the shared allowance; free answers have no payout. <a href="/library">Open the public AI desk</a></p>
      <button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>Refresh building</button>
      </MoreRow>
      </MoreList>
    </>}
  </div>;
}
