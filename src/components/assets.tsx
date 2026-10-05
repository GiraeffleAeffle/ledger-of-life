'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { Hero, Figure, Figures, MoreList, MoreRow, ScreenNote, StatusLine } from './blocks';

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

/** Wallet value and independently readable holdings. */
export function AssetsOverview({ request, tenancies, tenanciesLoaded = true, go, solanaAction, children }: {
  request: Request; tenancies: TenancyJourney[]; tenanciesLoaded?: boolean; go: (area: Area) => void;
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
      request<{ workflow: SharePositions }>('/api/share-workflows?network=robinhood').then(result => {
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
      !official ? 'Shares wallet balances' : null,
      !solana ? 'Deposit wallet balances' : 'status' in solana && BigInt(solana.rawAtomic) > 0n ? 'tSPYx price' : null,
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
    if (!activeTab || document.visibilityState === 'hidden') return;
    let active = true;
    const refreshStakes = () => { void request<{ market: LocalInvestmentView }>('/api/local-investments')
      .then(({ market }) => { if (active) setStakes(market); })
      .catch(() => { if (active) setStakes(null); }); };
    refreshStakes();
    const onBalances = (event: Event) => { if ((event as CustomEvent<{ chain?: string }>).detail?.chain === 'evm') refreshStakes(); };
    window.addEventListener('ledger-balances-changed', onBalances);
    return () => { active = false; window.removeEventListener('ledger-balances-changed', onBalances); };
  }, [request, activeTab]);

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
  const lockedReady = tenanciesLoaded && !tenancies.some(t => t.shareDeposit && BigInt(t.shareDeposit.lockedShares) > 0n && !t.shareDeposit.quote?.fresh);
  const complete = Boolean(snapshot && !readError && lockedReady);
  const balanceStatus = complete ? 'Your test balances are up to date' : refreshing ? 'Checking your test balances…'
    : !portfolio ? 'Total unavailable right now: test-share holdings could not be read.'
    : !rh ? 'Total unavailable right now: wallet balances could not be read.'
    : !positions || !shareValuationAvailable(positions) ? 'Total unavailable right now: the test-TSLA price could not be read.'
    : !lockedReady ? 'Total unavailable right now: the deposit value could not be read.'
    : 'Total unavailable right now: some values could not be read.';
  const read: HoldingsRead = { portfolio: portfolioSnapshot, ethBalance: rh?.ethBalance, refresh };
  const localHoldings = stakes?.state === 'ready' ? stakes.assets.filter(asset => asset.holdingRaw !== null && BigInt(asset.holdingRaw) > 0n) : [];

  const noTestMoney = Boolean(rh && portfolio && walletTestUsd === 0 && atomicUsd(portfolio.testUsdcAtomic) === 0);
  return (
    <HoldingsContext value={read}>
      <section className="assets" id="money-overview" tabIndex={-1} aria-busy={refreshing}>
        <Hero title="Total test value" status={<StatusLine tone={complete ? 'ok' : readError ? 'alert' : 'waiting'}>{balanceStatus}</StatusLine>}>
          {complete && parts && <>
            <Figures><Figure label="What you own, less what you owe" value={usd(total)} /></Figures>
            <NetPosition parts={parts} />
          </>}
        </Hero>
        <section className="card holdings-list" aria-labelledby="holdings-title">
          <h2 id="holdings-title">What you own</h2>
          <div className="holding-row" id="rental-deposit-holding">
            <div><strong>Rental deposit</strong><span>{!tenanciesLoaded ? 'Deposit status unavailable' : cashDeposits.length || shareDeposits.length ? cashDeposits.map(t => ({ unfunded: 'Not funded', paid_out: 'Paid out', no_entitlement: 'No remaining entitlement', secured: 'Secured', claim_owed: 'Payout owed to you', held_for_tenant: 'Held for the tenant', not_owner: 'Not your deposit' }[cashDepositStatus(t)])).join(' · ') || 'Test TSLA secured' : 'No deposit recorded'}</span></div>
            <strong>{!tenanciesLoaded ? '—' : <>{usd(cashLocked)}{shareDeposits.map(t => <span key={t.agreementId}> · {depositShares(t.shareDeposit!.lockedShares)} TSLA</span>)}</>}</strong>
            <button className="text-button" onClick={() => goToSection(go, 'home', depositSection)}>Home →</button>
          </div>
          <div className="holding-row" id="solana-holding" tabIndex={-1}>
            <div><strong>tSPYx</strong><span>{solanaShareValue === null ? 'Value unavailable' : 'Test shares'}</span></div><strong>{portfolio ? `${portfolio.shares.toFixed(4)} tSPYx` : '—'}</strong>
            <details className="holding-buy"><summary>Buy</summary>{solanaAction}</details>
          </div>
          <TslaHoldingRow request={request} earlierUnits={rh?.tslaShares ?? null} earlierLocked={positions?.loan?.sharesRaw ?? null} go={go} />
          <div className="holding-row"><div><strong>tUSDG</strong><span>{rh ? 'Free to use' : 'Balance unavailable'}</span></div><strong>{rh ? usd(walletTestUsd) : '—'}</strong><button className="text-button" onClick={() => goToSection(go, 'money', 'test-money')}>Get test money →</button></div>
          <div className="holding-row"><div><strong>Lent test dollars</strong><span>{!positions?.lender ? 'Balance unavailable' : lent ? 'Withdrawals depend on pool cash' : 'Nothing lent yet'}</span></div><strong>{positions?.lender ? usd(lent) : '—'}</strong><button className="text-button" onClick={() => openShareWorkflow(go, 'lend')}>Lend →</button></div>
          <div className="holding-row" id="fake-shares" tabIndex={-1}><div><strong>tHOME / tWORK</strong><span>{stakes?.network.chainId === 'solana-devnet' ? 'Solana devnet · fictional units · outside total' : 'Earlier Robinhood test units · outside total'}</span></div><strong>{localHoldings.length || stakes?.assets.some(asset => BigInt(asset.stakedRaw ?? '0') > 0n) ? (stakes?.assets ?? []).filter(asset => asset.holdingRaw != null && BigInt(asset.holdingRaw) + BigInt(asset.stakedRaw ?? '0') > 0n).map(asset => `${(Number(BigInt(asset.holdingRaw!) + BigInt(asset.stakedRaw ?? '0')) / 10 ** asset.unitDecimals).toFixed(4)} ${TEST_CITY_INVESTMENTS.find(project => project.id === asset.projectId)?.symbol ?? 'units'}`).join(' · ') : stakes?.state === 'ready' ? 'No units in wallet or staked' : 'Verified units unavailable'}</strong><button className="text-button" onClick={() => goToSection(go, 'money', 'local-investments')}>Local stakes →</button></div>
        </section>
        <MoreList>
          <MoreRow id="test-money" title="Get test money" meta={noTestMoney ? 'Your test-dollar balances are empty' : 'Faucets and funding help'} defaultOpen={noTestMoney}>{children}</MoreRow>
          <MoreRow title="Valuation details" meta="Prices, reading status and exact deposit values">
            <p>{readError || 'Wallet values use the last complete reading.'}{snapshot && ` Checked ${new Date(snapshot.checkedAt).toLocaleString()}.`}</p>
            <p>Loan debt: {positions?.loan ? usd(debt) : 'unavailable'}. Collateral value: {positions?.loan?.valueAtomic == null ? positions?.loan && BigInt(positions.loan.sharesRaw) > 0n ? 'unavailable (stale price)' : 'unavailable' : usd(collateral)}.</p>
            {portfolio && !('status' in portfolio) && <p>tSPYx reference price: {usd(portfolio.referencePriceUsd)}. Jupiter price for mainnet SPYx, not a resale quote. {portfolio.referencePriceStale && 'The reference price is stale.'} Simulated distribution multiplier: {portfolio.multiplier}. tSPYx cannot be pledged, borrowed against, sold or used elsewhere.</p>}
            {shareDeposits.map(t => <p key={t.agreementId}>{t.property}: {depositShares(t.shareDeposit!.lockedShares)} TSLA · {t.shareDeposit!.quote?.fresh ? `${depositUsd((BigInt(t.shareDeposit!.lockedShares) * BigInt(t.shareDeposit!.quote!.priceUsd6) / 10n ** 18n).toString())} USD at the quote` : 'Fresh quote unavailable'}</p>)}
          </MoreRow>
        </MoreList>
        <ScreenNote>Test assets have no monetary value. Fictional local units have no value or rights. Simulated distributions are not returns; deposit earnings belong to the tenant.</ScreenNote>
      </section>
    </HoldingsContext>
  );
}

/** Keep six-decimal devnet shares outside the earlier eighteen-decimal valuation. */
function TslaHoldingRow({ request, earlierUnits, earlierLocked, go }: { request: Request; earlierUnits: number | null; earlierLocked: string | null; go: (area: Area) => void }) {
  const activeTab = useSectionTabActive();
  const [view, setView] = useState<{ network?: 'solana-devnet'; sharesRaw: string | null; loan: { sharesRaw: string } | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const read = async () => {
      if (!activeTab || document.visibilityState !== 'visible') return;
      try {
        const { workflow } = await request<{ workflow: { network?: 'solana-devnet'; sharesRaw: string | null; loan: { sharesRaw: string } | null } }>('/api/share-workflows');
        if (live) { setView(workflow); setError(''); }
      } catch (cause) { if (live) { setView(null); setError(cause instanceof Error ? cause.message : 'Test-TSLA balances unavailable.'); } }
    };
    void read(); const timer = setInterval(() => void read(), 60_000);
    window.addEventListener('ledger-balances-changed', read);
    document.addEventListener('visibilitychange', read);
    return () => { live = false; clearInterval(timer); window.removeEventListener('ledger-balances-changed', read); document.removeEventListener('visibilitychange', read); };
  }, [request, activeTab]);
  const solana = view?.network === 'solana-devnet';
  return <div className="holding-row" id="official-shares" tabIndex={-1}>
    <div><strong>{solana ? 'tTSLA · Solana devnet' : 'TSLA · Robinhood testnet'}</strong>
      <span>{solana ? view.loan ? `${(Number(view.loan.sharesRaw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} tTSLA locked as collateral · test shares, no value · outside earlier total` : 'Collateral unavailable' : earlierLocked !== null ? `${depositShares(earlierLocked)} TSLA pledged as collateral` : 'Collateral unavailable'}</span>
      {solana && <span>Earlier Robinhood wallet: {earlierUnits === null ? 'unavailable' : `${earlierUnits.toFixed(4)} TSLA`} · locked: {earlierLocked === null ? 'unavailable' : `${depositShares(earlierLocked)} TSLA`}. Separate token and valuation.</span>}
      {error && <span role="alert">{error}</span>}
    </div>
    <strong>{solana ? view.sharesRaw === null ? '—' : `${(Number(view.sharesRaw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} tTSLA` : earlierUnits === null ? '—' : `${earlierUnits.toFixed(4)} TSLA`}</strong>
    <button className="text-button" onClick={() => goToSection(go, 'money', 'share-workflows')}>Borrow &amp; lend →</button>
  </div>;
}
