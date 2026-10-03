'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ExternalLink, Loader2, Wallet } from 'lucide-react';
import { formatUnits } from 'viem';
import { useRentalWallet } from '@/wallets';
import { parseAmount } from '@/domain/assets';
import { AGRI_PV_EXAMPLE, STRAUSBERG_INVESTMENT_LEADS, TEST_CITY_INVESTMENTS, type TestCityInvestmentId } from '@/data/local-investments';
import type { LocalInvestmentOrder, LocalInvestmentView } from '@/server/local-investments';
import { LOCAL_INVESTMENT_NAVIGATION_INTENT, openInvestmentOnMap, type Area } from './areas';
import { CITY_CHANGED_EVENT, readPersonCity, type AuthorizedRequest } from './use-city-signals';
import type { CityResult } from '@/server/city';
import { stakeDisabledReason, TEST_EXIT_NOTICE } from './money-guidance';
import { useSectionTabActive } from './section-tabs';
import { ProjectBlueprint } from './city-flywheel';
import { AgriPvExample } from './agri-pv-example';
import { ProjectMap } from './project-map';
import { DEFAULT_PROJECT_SYSTEMS, type ProjectSystems } from './project-map-model';
import { TestDollars } from './test-dollars';
import { BuildingPanel, type BuildingPosition } from './building-panel';
import { Hero, StatusLine, Figures, Figure, MoreList, MoreRow, ScreenNote } from './blocks';
import './local-investments.css';

const cash = (raw: string) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number(BigInt(raw)) / 1e6);
const units = (raw: string) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 4 }).format(Number(BigInt(raw) / 10n ** 14n) / 1e4);
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'The test-unit order could not be checked.';

/** Real signed test-unit purchases; project rights, physical plans and local effects remain fictional. */
export function LocalInvestments({ request, go }: { request: AuthorizedRequest; go: (area: Area) => void }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const [selectedId, setSelectedId] = useState<TestCityInvestmentId>(TEST_CITY_INVESTMENTS[0].id);
  const [showAgriPv, setShowAgriPv] = useState(false);
  const [systemsByProject, setSystemsByProject] = useState<Record<TestCityInvestmentId, ProjectSystems>>({
    'demo-neighbourhood-homes': { ...DEFAULT_PROJECT_SYSTEMS },
    'demo-retrofit-workshop': { ...DEFAULT_PROJECT_SYSTEMS },
  });
  const [city, setCity] = useState<CityResult | null>(null);
  const [market, setMarket] = useState<LocalInvestmentView | null>(null);
  const [buildingPosition, setBuildingPosition] = useState<BuildingPosition | null>(null);
  const [order, setOrder] = useState<LocalInvestmentOrder | null>(null);
  const [amount, setAmount] = useState('5');
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  const mounted = useRef(false);
  const readRevision = useRef(0);
  const actionRevision = useRef(0);
  const mutating = useRef(false);
  const preparation = useRef<{ id: string; projectId: TestCityInvestmentId; direction: 'buy' | 'sell'; amountRaw: string } | null>(null);
  const refresh = useCallback((afterMutation = false) => {
    if (mutating.current && !afterMutation) return Promise.resolve();
    const revision = ++readRevision.current;
    return request<{ market: LocalInvestmentView }>('/api/local-investments').then(({ market: next }) => {
      if (!mounted.current || (mutating.current && !afterMutation) || revision !== readRevision.current) return;
      if (next.order && (next.order.state === 'review' || next.order.state === 'pending') &&
        preparation.current?.projectId === next.order.projectId && preparation.current.direction === next.order.direction && preparation.current.amountRaw === (next.order.direction === 'sell' ? next.order.minimumUnitsRaw : next.order.cashAtomic)) {
        preparation.current = null;
        if (afterMutation) setActionError('');
      }
      setMarket(next); setOrder(next.order); setReadError(''); setCheckedAt(new Date().toLocaleTimeString());
    }, (cause: unknown) => {
      if (mounted.current && (!mutating.current || afterMutation) && revision === readRevision.current) setReadError(message(cause));
    });
  }, [request]);
  useEffect(() => {
    mounted.current = true;
    const active = mounted; const reads = readRevision; const actions = actionRevision;
    return () => { active.current = false; ++reads.current; ++actions.current; };
  }, []);
  useEffect(() => {
    if (activeTab && document.visibilityState === 'visible') void refresh();
    const balancesChanged = (event: Event) => {
      if (activeTab && document.visibilityState === 'visible' && (event as CustomEvent<{ chain?: string }>).detail?.chain === 'evm') void refresh();
    };
    const onVisible = () => { if (activeTab && document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('ledger-balances-changed', balancesChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener('ledger-balances-changed', balancesChanged); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, activeTab]);
  useEffect(() => {
    if (!activeTab) return;
    let current = true;
    const read = () => { void readPersonCity(request).then((next) => { if (current) setCity(next); }, () => { if (current) setCity(null); }); };
    read();
    window.addEventListener(CITY_CHANGED_EVENT, read);
    return () => { current = false; window.removeEventListener(CITY_CHANGED_EVENT, read); };
  }, [request, activeTab]);
  useEffect(() => {
    function consume() {
      const id = sessionStorage.getItem(LOCAL_INVESTMENT_NAVIGATION_INTENT);
      if (!id) return;
      sessionStorage.removeItem(LOCAL_INVESTMENT_NAVIGATION_INTENT);
      const project = TEST_CITY_INVESTMENTS.find((item) => item.id === id);
      if (project) queueMicrotask(() => { setSelectedId(project.id); setShowAgriPv(false); });
    }
    window.addEventListener(LOCAL_INVESTMENT_NAVIGATION_INTENT, consume); consume();
    return () => window.removeEventListener(LOCAL_INVESTMENT_NAVIGATION_INTENT, consume);
  }, []);

  const pendingOrderId = order?.state === 'pending' ? order.id : null;
  useEffect(() => {
    if (!pendingOrderId) return;
    let active = true; let checking = false;
    const check = () => {
      if (checking || !activeTab || document.visibilityState === 'hidden') return;
      checking = true;
      void request<{ order: LocalInvestmentOrder }>('/api/local-investments', { action: 'reconcile', orderId: pendingOrderId }).then(({ order: next }) => {
        if (!active) return;
        ++readRevision.current; setOrder(next); setActionError('');
        if (next.state === 'completed' || next.state === 'failed') window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } }));
      }, () => {
        if (active) setActionError('Confirmation is unavailable. The submitted transaction remains unresolved; no replacement order has been started.');
      }).finally(() => { checking = false; });
    };
    check(); const timer = window.setInterval(check, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pendingOrderId, request, activeTab]);

  const project = TEST_CITY_INVESTMENTS.find((item) => item.id === selectedId)!;
  const systems = systemsByProject[selectedId];
  const setSystems = (update: React.SetStateAction<ProjectSystems>) => setSystemsByProject((current) => ({
    ...current, [selectedId]: typeof update === 'function' ? update(current[selectedId]) : update,
  }));
  const asset = market?.assets.find((item) => item.projectId === selectedId);
  const currentOrder = order?.projectId === selectedId ? order : null;
  const openOrder = Boolean(order && (order.state === 'review' || order.state === 'pending'));
  const nextStep = currentOrder?.steps.find((step) => step.state === 'ready' && step.request);
  const account = wallet.wallets.find((item) => item.chainType === 'ethereum' && item.connected)?.address;
  const ownBuildingPosition = buildingPosition?.configured && buildingPosition.account.toLowerCase() === account?.toLowerCase() ? buildingPosition : null;
  const tradeHash = currentOrder?.state === 'completed' ? currentOrder.steps.find((step) => step.kind !== 'approve')?.hash : null;
  const healthy = market?.state === 'ready' && !readError && asset && !asset.error;
  const hasWallet = wallet.wallets.some((item) => item.chainType === 'ethereum' && item.connected);
  let requestedAmount: string | null = null;
  try { requestedAmount = parseAmount(amount, direction === 'sell' ? 18 : 6); } catch { /* Invalid input is kept editable, never treated as zero. */ }
  const hasGas = market?.nativeAtomic !== null && market?.nativeAtomic !== undefined && BigInt(market.nativeAtomic) > 0n;
  const disabledReason = direction === 'buy'
    ? requestedAmount && BigInt(requestedAmount) > 0n && BigInt(requestedAmount) < 1000n ? 'Buy at least 0.001 fictional tUSDG; fractional units are supported.' : stakeDisabledReason({ amountAtomic: requestedAmount, cashAtomic: market?.cashAtomic ?? null, nativeAtomic: market?.nativeAtomic ?? null, hasWallet })
    : !hasWallet ? 'Connect your Shares wallet in Me first.'
      : !requestedAmount || BigInt(requestedAmount) <= 0n ? 'Choose a positive fictional-unit amount.'
        : BigInt(requestedAmount) > 100n * 10n ** 18n ? 'Sell-back orders are capped at 100 fictional test units.'
          : asset?.holdingRaw === null || !asset ? 'Wait for a verified unit balance.'
            : BigInt(requestedAmount) > BigInt(asset.holdingRaw) ? 'Not enough fictional test units to sell back.'
              : !hasGas ? 'Get network-fee test ETH first.' : '';
  const affordable = !disabledReason;

  async function finishAction(generation: number) {
    if (!mounted.current || generation !== actionRevision.current) return;
    ++readRevision.current;
    // Recover the durable order even when prepare/submit's HTTP response was lost.
    await refresh(true);
    if (mounted.current && generation === actionRevision.current) {
      mutating.current = false;
      setBusy('');
    }
  }
  async function prepare() {
    if (!healthy || !hasWallet || !affordable || !hasGas || !requestedAmount || openOrder || busy) return;
    const generation = ++actionRevision.current; ++readRevision.current; mutating.current = true;
    if (!preparation.current || preparation.current.projectId !== selectedId || preparation.current.direction !== direction || preparation.current.amountRaw !== requestedAmount)
      preparation.current = { id: crypto.randomUUID(), projectId: selectedId, direction, amountRaw: requestedAmount };
    const intent = preparation.current;
    setBusy('Preparing review'); setActionError('');
    try {
      const { order: prepared } = await request<{ order: LocalInvestmentOrder }>('/api/local-investments', {
        action: 'prepare', requestId: intent.id, projectId: intent.projectId, direction: intent.direction,
        ...(intent.direction === 'sell' ? { unitsRaw: intent.amountRaw } : { cashAtomic: intent.amountRaw }),
      });
      if (mounted.current && generation === actionRevision.current) {
        ++readRevision.current; preparation.current = null; setOrder(prepared);
      }
    } catch (cause) {
      if (mounted.current && generation === actionRevision.current) setActionError(message(cause));
    } finally {
      await finishAction(generation);
    }
  }
  async function signStep() {
    if (!currentOrder || !nextStep?.request || busy || !healthy || !hasWallet) return;
    const generation = ++actionRevision.current; ++readRevision.current; mutating.current = true;
    setBusy('Waiting for your wallet'); setActionError('');
    try {
      const signedTransaction = await wallet.signEvmTransaction(nextStep.request);
      if (!mounted.current || generation !== actionRevision.current) return;
      setBusy('Submitting your signed step');
      const { order: next } = await request<{ order: LocalInvestmentOrder }>('/api/local-investments', {
        action: 'submit', orderId: currentOrder.id, stepId: nextStep.id, signedTransaction,
      });
      if (!mounted.current || generation !== actionRevision.current) return;
      ++readRevision.current; preparation.current = null; setOrder(next);
      if (next.state === 'completed' || next.state === 'failed') window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } }));
    } catch (cause) {
      if (mounted.current && generation === actionRevision.current) setActionError(message(cause));
    } finally {
      await finishAction(generation);
    }
  }
  async function cancelReview() {
    if (!currentOrder || currentOrder.state !== 'review' || busy) return;
    const generation = ++actionRevision.current; ++readRevision.current; mutating.current = true;
    setBusy('Closing review'); setActionError('');
    try {
      const { order: next } = await request<{ order: LocalInvestmentOrder }>('/api/local-investments', { action: 'cancel', orderId: currentOrder.id });
      if (mounted.current && generation === actionRevision.current) {
        ++readRevision.current; preparation.current = null; setOrder(next);
      }
    } catch (cause) {
      if (mounted.current && generation === actionRevision.current) setActionError(message(cause));
    } finally {
      await finishAction(generation);
    }
  }

  const desk = <MoreRow id="local-unit-desk" title="Buy or sell units" defaultOpen={currentOrder?.state === 'review' || currentOrder?.state === 'pending'} meta={currentOrder?.state === 'review' || currentOrder?.state === 'pending' ? 'Review in progress' : 'Exact review before signing'}>
      <div className="local-investment-review">
        <div className="local-cash"><Wallet size={18} /><span>Available in your Shares wallet</span><strong>{market?.cashAtomic === null || !market ? '—' : cash(market.cashAtomic)} <small>test USD (tUSDG)</small></strong></div>
        {!market && !readError && <p role="status" style={{ minHeight: 180 }}><Loader2 className="spin" size={16} /> Checking the market…</p>}
        {market?.state !== 'ready' && market && <p className="local-market-alert">{market.state === 'not_configured' ? 'The test-issuer contracts have not been provisioned in this environment.' : market.error || 'The test market is unavailable; no balance or purchase is inferred.'} <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void refresh()}>Check again</button></p>}
        {asset?.error && <p role="alert">{asset.error}</p>}
        {currentOrder && (currentOrder.state === 'review' || currentOrder.state === 'pending') ? <div className="local-order-review">
          <span className="eyebrow">REVIEW {currentOrder.direction === 'sell' ? 'SELL-BACK' : 'PURCHASE'} · FICTIONAL TEST UNITS</span><h4>{currentOrder.direction === 'sell' ? <>{formatUnits(BigInt(currentOrder.minimumUnitsRaw), 18)} {project.symbol} in <ArrowRight size={18} /> {cash(currentOrder.cashAtomic)} tUSDG out</> : <>{cash(currentOrder.cashAtomic)} tUSDG in <ArrowRight size={18} /> {formatUnits(BigInt(currentOrder.minimumUnitsRaw), 18)} {project.symbol} out</>}</h4>
          <p>Robinhood Chain testnet · network fees use test ETH. Units convey no property or company rights. {TEST_EXIT_NOTICE}</p>
          <ol className="local-order-steps">{currentOrder.steps.map((step) => <li key={step.id} className={`is-${step.state}`}><span>{step.state === 'confirmed' ? <Check size={14} /> : step.kind === 'approve' ? '1' : '2'}</span><div><strong>{step.kind === 'approve' ? `Approve only this ${currentOrder.direction === 'sell' ? project.symbol : 'tUSDG'} amount` : step.kind === 'sell' ? 'Sell back fictional test units' : 'Buy fictional test units'}</strong><small>{step.state === 'confirmed' ? 'Confirmed on the network' : step.state === 'pending' ? 'Submitted · awaiting verified receipt' : step.state === 'failed' ? 'Failed; no success inferred' : 'Your wallet signature is required'}</small>{step.hash && market && <a href={`${market.network.explorerUrl}/tx/${step.hash}`} target="_blank" rel="noopener noreferrer">View {step.kind} transaction <ExternalLink size={12} /></a>}</div></li>)}</ol>
          {currentOrder.state === 'pending' ? <p role="status"><Loader2 className="spin" size={16} /> Checking the signed transaction. Do not start a replacement order.</p> : nextStep && <button type="button" className="button primary" disabled={Boolean(busy) || !healthy || !hasWallet} onClick={() => void signStep()}>{busy ? <><Loader2 className="spin" size={16} />{busy}</> : nextStep.kind === 'approve' ? `Approve ${currentOrder.direction === 'sell' ? project.symbol : 'tUSDG'} in my wallet` : nextStep.kind === 'sell' ? 'Sell back fictional test units with my wallet' : 'Buy fictional test units with my wallet'}</button>}
          {currentOrder.state === 'review' && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void cancelReview()}>Cancel this review</button>}
        </div> : <>
          {currentOrder?.state === 'completed' && <div className="local-order-success" role="status"><Check size={18} /><div><strong>{currentOrder.direction === 'sell' ? 'Sell-back' : 'Purchase'} confirmed.</strong><span>{formatUnits(BigInt(currentOrder.minimumUnitsRaw), 18)} {project.symbol} {currentOrder.direction === 'sell' ? 'in' : 'out'} · {cash(currentOrder.cashAtomic)} tUSDG {currentOrder.direction === 'sell' ? 'out' : 'in'} at the fixed test price. Receipt and both transfers verified.</span>{tradeHash && market && <a href={`${market.network.explorerUrl.replace(/\/$/, '')}/tx/${tradeHash}`} target="_blank" rel="noopener noreferrer">View {currentOrder.direction === 'sell' ? 'sell-back' : 'purchase'} transaction <ExternalLink size={13} /></a>}</div></div>}
          {currentOrder?.error && <p className="local-market-alert">{currentOrder.error}</p>}
          <div className="local-test-actions" role="group" aria-label="Choose test-unit action"><button type="button" className="text-button" disabled={Boolean(busy) || openOrder} aria-pressed={direction === 'buy'} onClick={() => setDirection('buy')}>Buy test units</button><button type="button" className="text-button" disabled={Boolean(busy) || openOrder} aria-pressed={direction === 'sell'} onClick={() => setDirection('sell')}>Sell back</button></div>
          <form onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
            <label>{direction === 'sell' ? 'Units to sell back' : 'Test dollars to spend'} <span>{direction === 'sell' ? project.symbol : 'tUSDG'}</span><input aria-label={direction === 'sell' ? `Sell-back amount in ${project.symbol}` : 'Stake amount in test USD (tUSDG)'} inputMode="decimal" value={amount} disabled={Boolean(busy) || openOrder} onChange={(event) => setAmount(event.target.value)} /></label>
            <div className="local-amount-presets">{['5', '10', '25'].map((value) => <button type="button" key={value} disabled={Boolean(busy) || openOrder} aria-pressed={amount === value} onClick={() => setAmount(value)}>{value}</button>)}</div>
            <p className="local-price">{asset ? `${cash(asset.priceAtomic)} tUSDG per whole ${project.symbol}` : 'Fixed test price is unavailable until the deployed desk is checked.'}<small>Fixed test issue and sell-back price, not a market valuation. Sell-back requires enough tUSDG in the desk.</small></p>
            <p className="small-copy">Fractional buys from 0.001 tUSDG; maximum 100 fictional test units per order, buys also capped at 100 tUSDG.</p>
            <button className="button primary" disabled={!healthy || !affordable || openOrder || Boolean(busy)}>{busy ? <><Loader2 className="spin" size={16} />{busy}</> : <>Review {direction === 'sell' ? 'sell-back' : 'purchase'} <ArrowRight size={16} /></>}</button>
          </form>
          {disabledReason && <p className="local-funding-note" role="status">{disabledReason}</p>}
          {hasWallet && direction === 'buy' && !openOrder && <TestDollars request={request} ethBalance={market?.nativeAtomic ?? undefined} refresh={refresh} />}
        </>}
        {actionError && <p className="local-market-alert" role="alert">{actionError}</p>}
        {checkedAt && <span className="local-checked">Wallet/market last checked {checkedAt}{readError ? ' · refresh unavailable' : ''}</span>}
      </div>
  </MoreRow>;
  return <section className="local-capital" id="local-investments" tabIndex={-1} aria-label="Local stakes">
    <div className="lean-project-picker" role="group" aria-label="Choose a fictional local project">
      {TEST_CITY_INVESTMENTS.map(item => <button type="button" key={item.id} data-project-id={item.id} disabled={Boolean(busy)} aria-pressed={!showAgriPv && selectedId === item.id} onClick={() => { setSelectedId(item.id); setShowAgriPv(false); setActionError(''); }}>{item.kind === 'housing' ? 'House' : 'Workshop'}</button>)}
      <button type="button" data-project-id={AGRI_PV_EXAMPLE.id} disabled={Boolean(busy)} aria-pressed={showAgriPv} onClick={() => { setShowAgriPv(true); setActionError(''); }}>Agri-PV</button>
    </div>
    {showAgriPv ? <AgriPvExample /> : <>
    {city?.name && city.cityId !== 'strausberg' && <p>No local stakes in {city.name} yet; these fictional examples are set in Strausberg.</p>}
    {readError && <p className="local-market-alert" role="alert">Stake reads unavailable: {readError} <button type="button" className="text-button" onClick={() => void refresh()}>Retry reading</button></p>}
    {openOrder && order?.projectId !== selectedId && <p className="local-market-alert">Another fictional test-unit order is still open. <button type="button" className="text-button" onClick={() => { setSelectedId(order!.projectId as TestCityInvestmentId); }}>Open that review →</button></p>}
    {project.kind === 'housing' ? <BuildingPanel request={request} position={ownBuildingPosition} setPosition={setBuildingPosition} visual={<ProjectMap key={project.id} project={project} systems={systems} variant="hero" />} /> : <>
      <Hero visual={<ProjectMap key={project.id} project={project} systems={systems} variant="hero" />} title="Fictional workshop example" subtitle="Shared tools and repair space in Strausberg · illustrative" status={<StatusLine tone="neutral">{!hasWallet ? 'Connect your Shares wallet in Me to see your units' : readError || asset?.error ? 'Your units could not be checked' : market && market.state !== 'ready' ? market.error || 'Test-unit market not configured' : asset?.holdingRaw == null ? market ? 'Your unit balance is unavailable' : 'Checking your units…' : BigInt(asset.holdingRaw) === 0n ? `You hold no ${project.symbol} yet` : `You hold ${units(asset.holdingRaw)} ${project.symbol}`}</StatusLine>}>
        <Figures><Figure label="Your units" value={asset?.holdingRaw == null ? '—' : units(asset.holdingRaw)} unit={project.symbol} /><Figure label="Claimable now" value="—" note="No income distributor for this example" /></Figures>
        <button type="button" className="button primary" onClick={() => { const row = document.getElementById('local-unit-desk') as HTMLDetailsElement | null; if (row) { row.open = true; row.dispatchEvent(new Event('toggle')); row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }}>Buy units</button>
      </Hero>
    </>}
    <MoreList>{desk}</MoreList>
    <MoreList>
      <MoreRow title="Explore the building idea" meta="Solar, heat & shared spaces">
        <ProjectBlueprint kind={project.kind} go={go} enabled={systems} setEnabled={setSystems} />
        <div className="local-test-actions">
        <button type="button" className="text-button" onClick={() => openInvestmentOnMap(go, project.id)}>See on the city map</button>
        <button type="button" className="text-button" onClick={() => setShowAgriPv(true)}>Explore the Agri-PV income example →</button>
        </div>
      </MoreRow>
      <MoreRow title="Sources & token rights" meta="Fictional units · research leads">
        <p>{project.description}</p><p>{project.rights}</p>
        <p>These issuers and projects are fictional. They establish no construction, funding, dividend, employment or tax outcome. An issue price is not a resale quote or a guaranteed exit. Borrowing and buying units require separate approvals; buying units does not repay a loan, and collateral can still be liquidated. Shared test dollars are counted once.</p>
        {asset && market && <div className="local-contract-links"><a href={`${market.network.explorerUrl.replace(/\/$/, '')}/address/${asset.unitAddress}`} target="_blank" rel="noopener noreferrer">{project.symbol} contract</a><a href={`${market.network.explorerUrl.replace(/\/$/, '')}/address/${asset.marketAddress}`} target="_blank" rel="noopener noreferrer">Market contract</a></div>}
        <h4>Real Strausberg research leads</h4><ul>{STRAUSBERG_INVESTMENT_LEADS.map(lead => <li key={lead.url}><a href={lead.url} target="_blank" rel="noopener noreferrer">{lead.name}</a> · {lead.kind}. Check eligibility and terms directly.</li>)}</ul>
      </MoreRow>
    </MoreList>
    </>}
    <ScreenNote>{showAgriPv ? 'No token, no purchase, no offer.' : <>Fictional test units: no value, no rights. No company, cooperative or property rights.{project.kind === 'housing' && ' Solar income is simulated feed-in.'}</>}</ScreenNote>
  </section>;
}
