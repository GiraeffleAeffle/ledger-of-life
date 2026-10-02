'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, LineChart, TrendingUp } from 'lucide-react';
import type { TenancyJourney } from '@/server/journey';
import type { PortfolioPartial, PortfolioView } from '@/server/portfolio';
import { goToSection, openShareWorkflow, type Area } from './areas';
import { NetPosition } from './net-position';
import { confirmedRobinhood, netPositionParts, netPositionTotal, shareValuationAvailable, usd, type RobinhoodRead, type SharePositionAmounts } from './money-valuation';
import { cashDepositStatus } from './money-guidance';
import type { LocalInvestmentView } from '@/server/local-investments';
import { TEST_CITY_INVESTMENTS } from '@/data/local-investments';
import { useSectionTabActive } from './section-tabs';
import { depositShares, depositUsd } from './share-deposit';
import { depositHoldings } from './deposit-holdings';
import type { PortfolioSnapshot } from './portfolio-refresh';

type AssetsResponse = { robinhood: RobinhoodRead };
type SharePositions = SharePositionAmounts & { enabled: boolean; testUsdAtomic: string | null };
type PricedPortfolio = PortfolioView | PortfolioPartial;
type MoneySnapshot = { assets: AssetsResponse; portfolio: PricedPortfolio; workflow: SharePositions; officialCashUsd: number; officialStockUsd: number; solanaStockUsd: number; checkedAt: number };
type LatestRead = { assets: AssetsResponse | null; portfolio: PricedPortfolio | null; workflow: SharePositions | null; checkedAt: number };
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
export type HoldingsRead = {
  portfolio: PortfolioSnapshot<PricedPortfolio>;
  ethBalance?: string;
  refresh: () => Promise<void>;
};
const HoldingsContext = createContext<HoldingsRead | null>(null);
export function useHoldingsRead(): HoldingsRead {
  const read = useContext(HoldingsContext);
  if (!read) throw new Error('Holdings actions require AssetsOverview.');
  return read;
}


const atomicUsd = (atomic: string | null | undefined) => Number(atomic ?? '0') / 1e6;

/**
 * Holdings and the Today summary; device readings live in DeviceReadings.
 */
export function AssetsOverview({ request, tenancies, tenanciesLoaded = true, show, go, solanaAction, children }: {
  request: Request; tenancies: TenancyJourney[]; tenanciesLoaded?: boolean; show: 'money' | 'summary'; go: (area: Area) => void;
  solanaAction?: ReactNode; children?: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<MoneySnapshot | null>(null);
  const [portfolioSnapshot, setPortfolioSnapshot] = useState<PortfolioSnapshot<PricedPortfolio>>({ view: null, checkedAt: null, unavailable: false });
  const activeTab = useSectionTabActive();
  const [latestRead, setLatestRead] = useState<LatestRead | null>(null);
  const [readError, setReadError] = useState('');
  const [stakes, setStakes] = useState<LocalInvestmentView | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++revision.current;
    setRefreshing(true);
    // Publish action eligibility and individual balances as each source settles.
    // The subtotal still commits only a single complete wallet/market reading.
    const [assetResult, portfolioResult, workflowResult] = await Promise.allSettled([
      request<AssetsResponse>('/api/assets?area=holdings').then(assets => {
        if (current === revision.current) setLatestRead(previous => ({ assets, portfolio: previous?.portfolio ?? null, workflow: previous?.workflow ?? null, checkedAt: Date.now() }));
        return assets;
      }),
      request<{ portfolio: PricedPortfolio | { available: false } }>('/api/portfolio').then(result => {
        if (current === revision.current) {
          const portfolio = result.portfolio.available ? result.portfolio : null;
          setPortfolioSnapshot(previous => portfolio
            ? { view: portfolio, checkedAt: Date.now(), unavailable: false }
            : { ...previous, unavailable: true });
          setLatestRead(previous => ({ assets: previous?.assets ?? null, portfolio, workflow: previous?.workflow ?? null, checkedAt: Date.now() }));
        }
        return result;
      }).catch(error => {
        if (current === revision.current) setPortfolioSnapshot(previous => ({ ...previous, unavailable: true }));
        throw error;
      }),
      request<{ workflow: SharePositions }>('/api/share-workflows').then(result => {
        if (current === revision.current) setLatestRead(previous => ({ assets: previous?.assets ?? null, portfolio: previous?.portfolio ?? null, workflow: result.workflow, checkedAt: Date.now() }));
        return result;
      }),
    ]);
    if (current !== revision.current) return;
    const assets = assetResult.status === 'fulfilled' ? assetResult.value : null;
    const official = confirmedRobinhood(assets?.robinhood ?? null);
    const portfolioResponse = portfolioResult.status === 'fulfilled' ? portfolioResult.value.portfolio : null;
    const solana = portfolioResponse?.available ? portfolioResponse : null;
    const workflow = workflowResult.status === 'fulfilled' ? workflowResult.value.workflow : null;
    setLatestRead({ assets, portfolio: solana, workflow, checkedAt: Date.now() });
    const issues = [
      !official ? 'Robinhood wallet balances' : null,
      !solana ? 'Solana wallet balances' : 'status' in solana && BigInt(solana.rawAtomic) > 0n ? 'tSPYx price' : null,
      !workflow || !shareValuationAvailable(workflow) ? 'fresh shared-market TSLA valuation' : null,
    ].filter((issue): issue is string => issue !== null);
    if (issues.length) {
      setReadError(`Live valuation incomplete: ${issues.join(', ')} unavailable.`);
    } else if (assets && official && solana && workflow) {
      setSnapshot({ assets, portfolio: solana, workflow,
        officialCashUsd: atomicUsd(official.testUsdAtomic),
        officialStockUsd: 0,
        solanaStockUsd: 'status' in solana ? 0 : solana.valueUsd,
        checkedAt: Date.now() });
      setReadError('');
    }
    setRefreshing(false);
    if (portfolioResult.status === 'rejected') throw portfolioResult.reason;
  }, [request]);
  useEffect(() => {
    let retry: number | undefined;
    let active = true;
    const visibleRefresh = async () => {
      if (!activeTab || document.visibilityState !== 'visible') return;
      clearTimeout(retry);
      let delay = 60_000;
      try { await refresh(); } catch { delay = 8000; }
      if (active) retry = window.setTimeout(() => { void visibleRefresh(); }, delay);
    };
    const onVisible = () => { void visibleRefresh(); };
    retry = window.setTimeout(onVisible, 0);
    window.addEventListener('visibilitychange', onVisible);
    window.addEventListener('ledger-balances-changed', onVisible);
    const invalidateReads = () => { revision.current++; };
    return () => {
      active = false;
      invalidateReads();
      clearTimeout(retry);
      window.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('ledger-balances-changed', onVisible);
    };
  }, [refresh, activeTab]);
  useEffect(() => {
    if (show !== 'money' || !activeTab || document.visibilityState === 'hidden') return;
    let active = true;
    const refreshStakes = () => { void request<{ market: LocalInvestmentView }>('/api/local-investments')
      .then(({ market }) => { if (active) setStakes(market); })
      .catch(() => { if (active) setStakes(null); }); };
    refreshStakes();
    const onBalances = (event: Event) => { if ((event as CustomEvent<{ chain?: string }>).detail?.chain === 'evm') refreshStakes(); };
    window.addEventListener('ledger-balances-changed', onBalances);
    return () => { active = false; window.removeEventListener('ledger-balances-changed', onBalances); };
  }, [request, show, activeTab]);

  const assets = latestRead?.assets ?? snapshot?.assets ?? null;
  const portfolio = latestRead?.portfolio ?? snapshot?.portfolio ?? null;
  const workflow = latestRead?.workflow ?? snapshot?.workflow ?? null;
  // Count only what belongs to the viewer: a landlord must not see the tenant's deposit as their own,
  // and unpaid payouts stay visible after the tenancy closes.
  const { locked, cashLocked } = depositHoldings(tenancies);
  const cashDeposits = tenancies.filter(t => t.chain && (t.role === 'tenant' || t.role === 'landlord'));
  const shareDeposits = tenancies.filter(t => t.shareDeposit && (t.role === 'tenant' || t.role === 'landlord') && BigInt(t.shareDeposit.lockedShares) > 0n);
  const onChain = cashDeposits[0] ?? shareDeposits[0];
  const depositSection = onChain ? `tenancy-${onChain.agreementId}` : 'home-tenancies';
  const rh = confirmedRobinhood(assets?.robinhood ?? null);
  const positions = workflow;
  const hasFreshTokenPrice = Boolean(positions && !positions.suspended && positions.price && !positions.price.stale
    && positions.priceAtomic !== null && BigInt(positions.priceAtomic) > 0n);
  const walletTestUsd = rh ? atomicUsd(rh.testUsdAtomic) : 0;
  const collateral = atomicUsd(positions?.loan?.valueAtomic);
  const debt = atomicUsd(positions?.loan?.debtAtomic);
  const lent = atomicUsd(positions?.lender?.valueAtomic);
  const parts = snapshot ? netPositionParts({
    lockedUsd: locked,
    walletCashUsd: atomicUsd(snapshot.portfolio.testUsdcAtomic) + snapshot.officialCashUsd,
    walletSharesUsd: snapshot.solanaStockUsd + snapshot.officialStockUsd,
    positions: snapshot.workflow,
  }) : null;
  const total = parts ? netPositionTotal(parts) : 0;
  const solanaShareValue = !portfolio ? null : 'status' in portfolio ? BigInt(portfolio.rawAtomic) === 0n ? 0 : null : portfolio.valueUsd;
  const officialTileValue = !readError && positions && shareValuationAvailable(positions)
    ? atomicUsd(positions.walletValueAtomic) + collateral - debt : null;
  const lockedReady = tenanciesLoaded && !tenancies.some(t => t.shareDeposit && BigInt(t.shareDeposit.lockedShares) > 0n && !t.shareDeposit.quote?.fresh);
  const complete = Boolean(snapshot && !readError && lockedReady);
  const checkedAt = snapshot ? new Date(snapshot.checkedAt).toLocaleString() : null;
  const balanceStatus = readError
    ? `${readError}${checkedAt ? ` Last complete wallet balance: ${checkedAt}.` : ''}`
    : !lockedReady ? 'Wallet balances read independently; Home deposit entitlement is not yet available.'
      : snapshot ? `${refreshing ? 'Checking for updates · ' : 'Last checked '}${checkedAt}` : 'Checking your test balances…';
  const read: HoldingsRead = { portfolio: portfolioSnapshot, ethBalance: rh?.ethBalance, refresh };
  const localHoldings = stakes?.state === 'ready' ? stakes.assets.filter(asset => asset.holdingRaw !== null && BigInt(asset.holdingRaw) > 0n) : [];

  if (show === 'summary') return <span className="today-money">
    {complete ? `${usd(total)} test value` : '— test value'} · <button type="button" className="text-button" onClick={() => goToSection(go, 'money', 'money-overview')}>Holdings →</button>
  </span>;
  return (
    <HoldingsContext value={read}>
    <section className={`card assets ${show}`} id="money-overview" tabIndex={-1} aria-busy={refreshing}>
      <div className="assets-head">
        <div className="assets-total"><span>Priced test-asset subtotal</span><strong>{complete ? `${usd(total)} test value` : '—'}</strong><small role="status">{balanceStatus}</small></div>
      </div>
      <NetPosition parts={parts && !readError ? { ...parts, locked: lockedReady ? locked : null } : { free: null, locked: lockedReady ? locked : null, pledged: null, lent: null, owed: null }} go={go} depositSection={depositSection} />
      <div className="asset-grid">
        {shareDeposits.map(t => <button key={t.agreementId} type="button" className="asset-tile clickable" onClick={() => goToSection(go, 'home', `tenancy-${t.agreementId}`)}><header><KeyRound size={18} /> TSLA locked in your deposit · Robinhood testnet</header><strong>{depositShares(t.shareDeposit!.lockedShares)} test TSLA</strong><span>{t.shareDeposit!.quote?.fresh ? `${depositUsd((BigInt(t.shareDeposit!.lockedShares) * BigInt(t.shareDeposit!.quote!.priceUsd6) / 10n ** 18n).toString())} USD at the quote` : 'USD valuation unavailable — fresh quote required'}</span><span>Open in Home →</span></button>)}
        {cashDeposits.length > 0 && <button type="button" className="asset-tile clickable" id="rental-deposit-holding" onClick={() => goToSection(go, 'home', depositSection)} aria-label="Open rental home and deposit">
          <header><KeyRound size={18} /> Rental home &amp; deposit · Solana devnet</header>
          <strong>{usd(cashLocked)} test value</strong>
          {cashDeposits.map(t => <span key={t.agreementId}>{t.property} · {{
            unfunded: 'Deposit not funded yet',
            paid_out: 'Paid out',
            no_entitlement: 'No remaining deposit entitlement',
            secured: 'Deposit secured',
            claim_owed: 'Approved claim or settlement payout owed to you',
            held_for_tenant: 'Held for the tenant; not your assets',
            not_owner: 'Not your deposit',
          }[cashDepositStatus(t)]}</span>)}
          <span className="text-button">Open in Home →</span>
        </button>}

        <article className="asset-tile" id="solana-holding" tabIndex={-1}>
          <header><LineChart size={18} /> tSPYx · Solana test shares</header>
          <strong>{solanaShareValue === null ? '—' : `${usd(solanaShareValue)} test value`}</strong>
          <span>{portfolio ? `${portfolio.shares.toFixed(4)} tSPYx · ${usd(atomicUsd(portfolio.testUsdcAtomic))} test USDC in wallet` : 'Balance not yet available'}</span>
          {portfolio && !('status' in portfolio) && <span>Reference price {usd(portfolio.referencePriceUsd)} per tSPYx · Jupiter price for mainnet SPYx, not a resale quote for this test token</span>}
          {portfolio && 'status' in portfolio && <span role="status">Reference price unavailable; share quantity and cash were read, but stock value cannot be shown.</span>}
          {portfolio && !('status' in portfolio) && portfolio.referencePriceStale && <span>Reference price as of {new Date(portfolio.referencePriceObservedAt).toLocaleString()} · live price unavailable</span>}
          {portfolio && portfolio.multiplier > 1 && <span className="asset-gain"><TrendingUp size={13} /> +{((portfolio.multiplier - 1) * 100).toFixed(2)} % from simulated distributions (test market)</span>}
          {solanaAction}
          <span>tSPYx cannot be pledged, borrowed against, sold or used elsewhere.</span>
        </article>

        {(rh && rh.tslaShares > 0 || positions?.loan && BigInt(positions.loan.sharesRaw) > 0n) && <article className="asset-tile" id="official-shares" tabIndex={-1}>
          <header><LineChart size={18} /> TSLA · official Robinhood test token</header>
          <strong>{officialTileValue === null ? '—' : `${usd(officialTileValue)} test value`}</strong>
          <span>{rh ? `${rh.tslaShares.toFixed(5)} TSLA in wallet · ${usd(walletTestUsd)} test USD (tUSDG) in Robinhood Chain wallet` : 'Balance not yet available'}</span>
          {positions && <span>Loan collateral: {(Number(positions.loan?.sharesRaw ?? '0') / 1e18).toFixed(5)} TSLA · debt {usd(debt)} test value. {hasFreshTokenPrice ? `Mirrored Robinhood TSLA token price: ${usd(atomicUsd(positions.priceAtomic))}.` : 'Fresh mirrored token price unavailable; no stock valuation shown.'}</span>}
          <button className="text-button" type="button" onClick={() => goToSection(go, 'money', 'share-workflows')}>Manage test TSLA &amp; loans</button>
        </article>}
        {lent > 0 && <article className="asset-tile"><header>Lent test dollars · shared pool</header><strong>{usd(lent)} test value</strong><span>Pool share value includes borrower interest and losses. Withdrawals depend on available pool cash.</span><button className="text-button" type="button" onClick={() => openShareWorkflow(go, 'lend')}>Manage lent test dollars</button></article>}
        {localHoldings.length > 0 && <article className="asset-tile"><header>tHOME and tWORK · fictional test units</header><strong>Outside subtotal</strong>{localHoldings.map(asset => <span key={asset.projectId}>{TEST_CITY_INVESTMENTS.find(project => project.id === asset.projectId)?.symbol ?? 'Test units'}: {(Number(BigInt(asset.holdingRaw!)) / 1e18).toFixed(4)} units</span>)}<button className="text-button" type="button" onClick={() => goToSection(go, 'money', 'local-investments')}>See your local stakes →</button></article>}
      </div>
    </section>
    {children}
    </HoldingsContext>
  );
}
