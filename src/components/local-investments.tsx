'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Building2, Check, ExternalLink, Loader2, MapPin, Wallet, Wrench } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import { parseAmount } from '@/domain/assets';
import { STRAUSBERG_INVESTMENT_LEADS, TEST_CITY_INVESTMENTS, type TestCityInvestmentId } from '@/data/local-investments';
import type { LocalInvestmentOrder, LocalInvestmentView } from '@/server/local-investments';
import { LOCAL_INVESTMENT_NAVIGATION_INTENT, openInvestmentOnMap, type Area } from './areas';
import type { AuthorizedRequest } from './use-city-signals';
import { projectDisplayName } from './project-display-name';
import { stakeDisabledReason, TEST_EXIT_NOTICE } from './money-guidance';
import { useSectionTabActive } from './section-tabs';
import { CityFlywheel, ProjectBlueprint } from './city-flywheel';
import './local-investments.css';

const cash = (raw: string) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number(BigInt(raw)) / 1e6);
const units = (raw: string) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 4 }).format(Number(BigInt(raw)) / 1e18);
const percent = (raw: string, total: string) => BigInt(total) > 0n ? `${Number(BigInt(raw) * 100_000n / BigInt(total)) / 1000}%` : '—';
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'The stake purchase could not be checked.';

/** Real signed test-unit purchases; project rights, physical plans and local effects remain fictional. */
export function LocalInvestments({ request, go }: { request: AuthorizedRequest; go: (area: Area) => void }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const [selectedId, setSelectedId] = useState<TestCityInvestmentId>(TEST_CITY_INVESTMENTS[0].id);
  const [panel, setPanel] = useState<'invest' | 'idea' | 'city'>('invest');
  const [market, setMarket] = useState<LocalInvestmentView | null>(null);
  const [order, setOrder] = useState<LocalInvestmentOrder | null>(null);
  const [amount, setAmount] = useState('5');
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  const mounted = useRef(false);
  const readRevision = useRef(0);
  const actionRevision = useRef(0);
  const mutating = useRef(false);
  const preparation = useRef<{ id: string; projectId: TestCityInvestmentId; cashAtomic: string } | null>(null);
  const refresh = useCallback((afterMutation = false) => {
    if (mutating.current && !afterMutation) return Promise.resolve();
    const revision = ++readRevision.current;
    return request<{ market: LocalInvestmentView }>('/api/local-investments').then(({ market: next }) => {
      if (!mounted.current || (mutating.current && !afterMutation) || revision !== readRevision.current) return;
      if (next.order && (next.order.state === 'review' || next.order.state === 'pending') &&
        preparation.current?.projectId === next.order.projectId && preparation.current.cashAtomic === next.order.cashAtomic) {
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
    function consume() {
      const id = sessionStorage.getItem(LOCAL_INVESTMENT_NAVIGATION_INTENT);
      if (!id) return;
      sessionStorage.removeItem(LOCAL_INVESTMENT_NAVIGATION_INTENT);
      const project = TEST_CITY_INVESTMENTS.find((item) => item.id === id);
      if (project) queueMicrotask(() => { setSelectedId(project.id); setPanel('invest'); });
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
        if (active) setActionError('Confirmation is unavailable. The submitted transaction remains unresolved; no replacement purchase has been started.');
      }).finally(() => { checking = false; });
    };
    check(); const timer = window.setInterval(check, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pendingOrderId, request, activeTab]);

  const project = TEST_CITY_INVESTMENTS.find((item) => item.id === selectedId)!;
  const asset = market?.assets.find((item) => item.projectId === selectedId);
  const currentOrder = order?.projectId === selectedId ? order : null;
  const openOrder = Boolean(order && (order.state === 'review' || order.state === 'pending'));
  const nextStep = currentOrder?.steps.find((step) => step.state === 'ready' && step.request);
  const purchaseHash = currentOrder?.state === 'completed' ? currentOrder.steps.find((step) => step.kind === 'buy')?.hash : null;
  const healthy = market?.state === 'ready' && !readError && asset && !asset.error;
  const hasWallet = wallet.wallets.some((item) => item.chainType === 'ethereum' && item.connected);
  let requestedCash: string | null = null;
  try { requestedCash = parseAmount(amount); } catch { /* Invalid input is kept editable, never treated as zero. */ }
  const disabledReason = stakeDisabledReason({ amountAtomic: requestedCash, cashAtomic: market?.cashAtomic ?? null, nativeAtomic: market?.nativeAtomic ?? null, hasWallet });
  const affordable = !disabledReason;
  const hasGas = market?.nativeAtomic !== null && market?.nativeAtomic !== undefined && BigInt(market.nativeAtomic) > 0n;

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
    if (!healthy || !hasWallet || !affordable || !hasGas || !requestedCash || openOrder || busy) return;
    const generation = ++actionRevision.current; ++readRevision.current; mutating.current = true;
    if (!preparation.current || preparation.current.projectId !== selectedId || preparation.current.cashAtomic !== requestedCash)
      preparation.current = { id: crypto.randomUUID(), projectId: selectedId, cashAtomic: requestedCash };
    const intent = preparation.current;
    setBusy('Preparing review'); setActionError('');
    try {
      const { order: prepared } = await request<{ order: LocalInvestmentOrder }>('/api/local-investments', {
        action: 'prepare', requestId: intent.id, projectId: intent.projectId, cashAtomic: intent.cashAtomic,
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

  return <section className="local-capital" id="local-investments" tabIndex={-1} aria-label="Local stakes">
    <header className="local-capital-heading"><div><span className="eyebrow">LOCAL STAKES · FICTIONAL TEST ISSUERS</span><h2>Buy a stake in a fictional local project.</h2><p>Explore a fictional housing project or workshop. {TEST_EXIT_NOTICE}</p></div></header>
    <div className="local-project-picker" role="group" aria-label="Choose a fictional test issuer">{TEST_CITY_INVESTMENTS.map((item) => {
      const holding = market?.assets.find((entry) => entry.projectId === item.id);
      const Icon = item.kind === 'housing' ? Building2 : Wrench;
      return <button type="button" key={item.id} data-project-id={item.id} disabled={Boolean(busy)} aria-pressed={selectedId === item.id} onClick={() => { setSelectedId(item.id); setActionError(''); }}>
        <span className={`local-project-icon ${item.kind}`}><Icon size={25} /></span><span><strong>{item.kind === 'housing' ? 'Homes we build together' : 'Tools, skills, local work'}</strong><small>{projectDisplayName(item.name)}</small></span>
        <span className="local-project-owned">{holding?.holdingRaw === null || !holding ? '— units' : `${units(holding.holdingRaw)} ${item.symbol}`}{readError && <small>Last checked</small>}</span>
      </button>;
    })}</div>
    <div className="local-project-toolbar"><div><MapPin size={15} />{project.cityName} · fictional test issuer</div><button type="button" className="text-button" onClick={() => openInvestmentOnMap(go, project.id)}>See on the map <ArrowUpRight size={15} /></button></div>
    <div className="local-project-tabs" role="group" aria-label="Stake and project views">
      <button type="button" aria-pressed={panel === 'invest'} onClick={() => setPanel('invest')}>Your stake</button>
      <button type="button" aria-pressed={panel === 'idea'} onClick={() => setPanel('idea')}>{project.kind === 'housing' ? 'The building idea' : 'The workshop idea'}</button>
      <button type="button" aria-pressed={panel === 'city'} onClick={() => setPanel('city')}>The city flywheel</button>
    </div>
    {readError && <p className="local-market-alert" role="alert">Stake reads unavailable: {readError} <button type="button" className="text-button" onClick={() => void refresh()}>Retry reading</button></p>}
    {openOrder && order?.projectId !== selectedId && <p className="local-market-alert">Another project purchase is still open. <button type="button" className="text-button" onClick={() => { setSelectedId(order!.projectId as TestCityInvestmentId); setPanel('invest'); }}>Open that review →</button></p>}
    {panel === 'idea' && <ProjectBlueprint key={project.id} kind={project.kind} go={go} />}
    {panel === 'city' && <CityFlywheel />}
    {panel === 'invest' && <div className="local-investment-body">
      <div className="local-project-story"><span className="eyebrow">{project.symbol} · FICTIONAL TEST ISSUER · PROJECT UNITS</span><h3>{project.kind === 'housing' ? 'A small stake in a fictional place.' : 'A fictional stake in local work.'}</h3><p>{project.description}</p>
        <div className="local-use-tags">{project.uses.map((use) => <span key={use}>{use}</span>)}</div>
        <div className="local-stake-display"><Building2 size={26} /><div><strong>{asset?.holdingRaw === null || !asset ? '—' : units(asset.holdingRaw)} <span>{project.symbol}</span></strong><small>Fictional test issuer · {asset?.holdingRaw !== null && asset ? `${percent(asset.holdingRaw, asset.totalSupplyRaw)} of the unit supply` : 'Wallet units appear after a successful network read'}</small></div></div>
        {asset && market && <div className="local-contract-links"><a href={`${market.network.explorerUrl.replace(/\/$/, '')}/address/${asset.unitAddress}`} target="_blank" rel="noopener noreferrer">{project.symbol} contract <ExternalLink size={12} /></a><a href={`${market.network.explorerUrl.replace(/\/$/, '')}/address/${asset.marketAddress}`} target="_blank" rel="noopener noreferrer">Market contract <ExternalLink size={12} /></a></div>}
      </div>
      <div className="local-investment-review">
        <div className="local-cash"><Wallet size={18} /><span>Available in your Robinhood Chain wallet</span><strong>{market?.cashAtomic === null || !market ? '—' : cash(market.cashAtomic)} <small>test USD (tUSDG)</small></strong></div>
        {!market && !readError && <p role="status"><Loader2 className="spin" size={16} /> Checking the market…</p>}
        {market?.state !== 'ready' && market && <p className="local-market-alert">{market.state === 'not_configured' ? 'The test-issuer contracts have not been provisioned in this environment.' : market.error || 'The test market is unavailable; no balance or purchase is inferred.'} <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void refresh()}>Check again</button></p>}
        {asset?.error && <p role="alert">{asset.error}</p>}
        {currentOrder && (currentOrder.state === 'review' || currentOrder.state === 'pending') ? <div className="local-order-review">
          <span className="eyebrow">REVIEW STAKE · FICTIONAL TEST ISSUER</span><h4>{cash(currentOrder.cashAtomic)} test USD (tUSDG) <ArrowRight size={18} /> at least {units(currentOrder.minimumUnitsRaw)} {project.symbol}</h4>
          <p>Robinhood Chain testnet · network fees use test ETH. Units convey no property or company rights. {TEST_EXIT_NOTICE}</p>
          <ol className="local-order-steps">{currentOrder.steps.map((step) => <li key={step.id} className={`is-${step.state}`}><span>{step.state === 'confirmed' ? <Check size={14} /> : step.kind === 'approve' ? '1' : '2'}</span><div><strong>{step.kind === 'approve' ? 'Approve only this test USD (tUSDG) amount' : 'Buy fictional test units'}</strong><small>{step.state === 'confirmed' ? 'Confirmed on the network' : step.state === 'pending' ? 'Submitted · awaiting verified receipt' : step.state === 'failed' ? 'Failed; no success inferred' : 'Your wallet approval is required'}</small></div></li>)}</ol>
          {currentOrder.state === 'pending' ? <p role="status"><Loader2 className="spin" size={16} /> Checking the signed transaction. Do not start a replacement purchase.</p> : nextStep && <button type="button" className="button primary" disabled={Boolean(busy) || !healthy || !hasWallet} onClick={() => void signStep()}>{busy ? <><Loader2 className="spin" size={16} />{busy}</> : nextStep.kind === 'approve' ? 'Approve test USD (tUSDG) in my wallet' : 'Buy fictional test units with my wallet'}</button>}
          {currentOrder.state === 'review' && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void cancelReview()}>Cancel this review</button>}
        </div> : <>
          {currentOrder?.state === 'completed' && <div className="local-order-success" role="status"><Check size={18} /><div><strong>Stake purchase confirmed.</strong><span>The purchase receipt was checked; fictional test units are shown separately from priced assets.</span>{purchaseHash && market && <a href={`${market.network.explorerUrl.replace(/\/$/, '')}/tx/${purchaseHash}`} target="_blank" rel="noopener noreferrer">View purchase transaction <ExternalLink size={13} /></a>}</div></div>}
          {currentOrder?.error && <p className="local-market-alert">{currentOrder.error}</p>}
          <form onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
            <label>Amount for your stake <span>test USD (tUSDG)</span><input aria-label="Stake amount in test USD (tUSDG)" inputMode="decimal" value={amount} disabled={Boolean(busy) || openOrder} onChange={(event) => setAmount(event.target.value)} /></label>
            <div className="local-amount-presets">{['5', '10', '25'].map((value) => <button type="button" key={value} disabled={Boolean(busy) || openOrder} aria-pressed={amount === value} onClick={() => setAmount(value)}>{value}</button>)}</div>
            <p className="local-price">{asset ? `${cash(asset.priceAtomic)} test USD (tUSDG) per whole ${project.symbol}` : 'Issue price is unavailable until the deployed market is checked.'}<small>Issue price, not a resale quote or market valuation.</small></p>
            <p className="small-copy">Maximum 100 test USD (tUSDG) per stake purchase · No sell · no rights.</p>
            <button className="button primary" disabled={!healthy || !affordable || openOrder || Boolean(busy)}>{busy ? <><Loader2 className="spin" size={16} />{busy}</> : <>Review stake <ArrowRight size={16} /></>}</button>
          </form>
          {disabledReason && <p className="local-funding-note" role="status">{disabledReason}</p>}
        </>}
        {actionError && <p className="local-market-alert" role="alert">{actionError}</p>}
        {checkedAt && <span className="local-checked">Wallet/market last checked {checkedAt}{readError ? ' · refresh unavailable' : ''}</span>}
      </div>
    </div>}
    <details className="local-investment-details"><summary>Sources, project context &amp; token rights</summary><p>Purchases move test tokens on Robinhood Chain testnet after your wallet signs. These issuers and projects are fictional; they are not the real buildings, owners or companies shown in public city records. They establish no construction, funding, dividend, employment or tax outcome. Test USD (tUSDG) can come from your existing Robinhood Chain wallet or a separate share-backed test loan; Solana assets do not bridge here. Borrowing and buying a stake require separate approvals; buying units does not repay a loan, and collateral can still be liquidated.</p><p>{project.rights} Fictional test units are displayed separately from priced assets: an issue price is not a resale quote, guaranteed exit or legal interest in a building. Shared test USD (tUSDG) is counted once.</p><h4>Real Strausberg research leads</h4><ul>{STRAUSBERG_INVESTMENT_LEADS.map((lead) => <li key={lead.url}><a href={lead.url} target="_blank" rel="noopener noreferrer">{lead.name}</a> · {lead.kind}. Research lead only; check eligibility and terms directly.</li>)}</ul></details>
  </section>;
}
