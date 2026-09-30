'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, LineChart, TrendingUp } from 'lucide-react';
import type { TenancyJourney } from '@/server/journey';
import type { PortfolioPartial, PortfolioView } from '@/server/portfolio';
import { goToSection, type Area } from './areas';
import { NetPosition, NetPositionStrip } from './net-position';
import { RealityChips } from './reality-chip';
import { confirmedRobinhood, netPositionParts, netPositionTotal, netSharePositionsAtomic, usd, type RobinhoodRead } from './money-valuation';
import { needsTestFunds, TEST_EXIT_NOTICE } from './money-guidance';
import type { LocalInvestmentView } from '@/server/local-investments';
import { TEST_CITY_INVESTMENTS } from '@/data/local-investments';
import { useRentalWallet } from '@/wallets';
import { RobinhoodBuy } from './robinhood-buy';
import { useSectionTabActive } from './section-tabs';

type AssetsResponse = { robinhood: RobinhoodRead };
type SharePositions = {
  enabled: boolean;
  testUsdAtomic: string;
  fakeStock: null | { symbol: 'tTSLA'; walletRaw: string; walletValueAtomic: string; priceAtomic: string };
  deposit: { sharesRaw: string; valueAtomic: string } | null;
  loan: { sharesRaw: string; valueAtomic: string; debtAtomic: string } | null;
};
type PricedPortfolio = PortfolioView | PortfolioPartial;
type MoneySnapshot = { assets: AssetsResponse; portfolio: PricedPortfolio; workflow: SharePositions; lockedUsd: number; officialCashUsd: number; officialStockUsd: number; solanaStockUsd: number; checkedAt: number };
type LatestRead = { assets: AssetsResponse | null; portfolio: PricedPortfolio | null; workflow: SharePositions | null; checkedAt: number };
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;

const atomicUsd = (atomic: string | undefined) => Number(atomic ?? '0') / 1e6;
type Chain = NonNullable<TenancyJourney['chain']>;
/** What of one tenancy belongs to the viewer, in USD. Before settlement the tenant owns the deposit and
 * earnings minus approved claims; after settlement each side owns what is owed and not yet paid. */
function entitlementUsd(role: TenancyJourney['role'], c: Chain): number {
  const settled = c.phase === 'settling' || c.phase === 'closed';
  if (role === 'tenant')
    return settled
      ? atomicUsd(c.tenantOwedAtomic) - atomicUsd(c.tenantPaidAtomic)
      : Math.max(0, atomicUsd(c.lendingValueAtomic) + atomicUsd(c.escrowAtomic) - atomicUsd(c.approvedClaimAtomic));
  if (role === 'landlord')
    return settled ? atomicUsd(c.landlordOwedAtomic) - atomicUsd(c.landlordPaidAtomic) : atomicUsd(c.approvedClaimAtomic);
  return 0;
}

/**
 * Holdings and the Today summary; device readings live in DeviceReadings.
 */
export function AssetsOverview({ request, tenancies, show, go, solanaAction }: {
  request: Request; tenancies: TenancyJourney[]; show: 'money' | 'summary'; go: (area: Area) => void; solanaAction?: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<MoneySnapshot | null>(null);
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const [copied, setCopied] = useState('');
  const [latestRead, setLatestRead] = useState<LatestRead | null>(null);
  const [readError, setReadError] = useState('');
  const [stakes, setStakes] = useState<LocalInvestmentView | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const revision = useRef(0);
  const tenanciesRef = useRef(tenancies);
  useEffect(() => { tenanciesRef.current = tenancies; }, [tenancies]);

  const refresh = useCallback(async () => {
    const current = ++revision.current;
    setRefreshing(true);
    const lockedAtRead = tenanciesRef.current.reduce((sum, tenancy) =>
      sum + (tenancy.chain ? entitlementUsd(tenancy.role, tenancy.chain) : 0), 0);
    // Commit a net worth only after every source settles. A wallet transfer and its
    // collateral read must never appear as two different points in time.
    const [assetResult, portfolioResult, workflowResult] = await Promise.allSettled([
      request<AssetsResponse>('/api/assets?area=holdings'),
      request<{ portfolio: PricedPortfolio | { available: false } }>('/api/portfolio'),
      request<{ workflow: SharePositions }>('/api/share-workflows'),
    ]);
    if (current !== revision.current) return;
    const assets = assetResult.status === 'fulfilled' ? assetResult.value : null;
    const official = confirmedRobinhood(assets?.robinhood ?? null);
    const portfolioResponse = portfolioResult.status === 'fulfilled' ? portfolioResult.value.portfolio : null;
    const solana = portfolioResponse?.available ? portfolioResponse : null;
    const workflow = workflowResult.status === 'fulfilled' ? workflowResult.value.workflow : null;
    setLatestRead({ assets, portfolio: solana, workflow, checkedAt: Date.now() });
    const issues = [
      !official ? 'Robinhood wallet balances' : 'status' in official && BigInt(official.tslaRaw) > 0n ? 'official TSLA price' : null,
      !solana ? 'Solana wallet balances' : 'status' in solana && BigInt(solana.rawAtomic) > 0n ? 'tSPYx price' : null,
      !workflow ? 'share-backed positions' : null,
    ].filter((issue): issue is string => issue !== null);
    if (issues.length) {
      setReadError(`Live valuation incomplete: ${issues.join(', ')} unavailable.`);
    } else if (assets && official && solana && workflow) {
      setSnapshot({ assets, portfolio: solana, workflow, lockedUsd: lockedAtRead,
        officialCashUsd: atomicUsd(official.testUsdAtomic),
        officialStockUsd: 'status' in official ? 0 : official.tslaValueUsd,
        solanaStockUsd: 'status' in solana ? 0 : solana.valueUsd,
        checkedAt: Date.now() });
      setReadError('');
    }
    setRefreshing(false);
  }, [request]);
  useEffect(() => {
    const visibleRefresh = () => { if (activeTab && document.visibilityState === 'visible') void refresh(); };
    const initial = setTimeout(visibleRefresh, 0);
    const interval = setInterval(visibleRefresh, 60_000);
    window.addEventListener('visibilitychange', visibleRefresh);
    window.addEventListener('ledger-balances-changed', visibleRefresh);
    const invalidate = () => { revision.current++; };
    return () => {
      invalidate();
      clearTimeout(initial);
      clearInterval(interval);
      window.removeEventListener('visibilitychange', visibleRefresh);
      window.removeEventListener('ledger-balances-changed', visibleRefresh);
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
  const entitled = tenancies
    .map((t) => ({ t, value: t.chain ? entitlementUsd(t.role, t.chain) : 0 }))
    .filter(({ value }) => value > 0);
  const locked = entitled.reduce((sum, { value }) => sum + value, 0);
  const lastLockedRef = useRef(locked);
  useEffect(() => {
    if (lastLockedRef.current === locked) return;
    lastLockedRef.current = locked;
    const timer = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [locked, refresh]);
  const claimed = tenancies.filter((t) => t.role === 'tenant').reduce((sum, t) => sum + atomicUsd(t.chain?.releasedAtomic), 0);
  const asTenant = entitled.filter(({ t }) => t.role === 'tenant').length;
  const onChain = tenancies.find((t) => t.chain);
  const depositSection = onChain ? `tenancy-${onChain.agreementId}` : 'home-tenancies';
  const rh = confirmedRobinhood(assets?.robinhood ?? null);
  const officialQuote = rh && !('status' in rh) ? rh : null;
  const positions = workflow;
  // Workflow walletValueAtomic overlaps wallet stock value. Official TSLA held by
  // the older share market belongs to the official tile, not the new fake tile.
  const walletTestUsd = rh ? atomicUsd(rh.testUsdAtomic) : 0;
  const shareNetUsd = Number(netSharePositionsAtomic(positions)) / 1e6;
  const officialContractNet = positions && !positions.fakeStock ? shareNetUsd : 0;
  const fakeStockWalletValue = atomicUsd(positions?.fakeStock?.walletValueAtomic);
  const pledged = atomicUsd(positions?.deposit?.valueAtomic);
  const collateral = atomicUsd(positions?.loan?.valueAtomic);
  const debt = atomicUsd(positions?.loan?.debtAtomic);
  const fakeStockValue = positions?.fakeStock ? shareNetUsd : 0;
  const hasLegacyPosition = Boolean(positions && !positions.fakeStock &&
    (BigInt(positions.deposit?.sharesRaw ?? '0') > 0n || BigInt(positions.loan?.sharesRaw ?? '0') > 0n ||
      BigInt(positions.loan?.debtAtomic ?? '0') > 0n || BigInt(positions.deposit?.valueAtomic ?? '0') > 0n));
  const parts = snapshot ? netPositionParts({
    lockedUsd: snapshot.lockedUsd,
    walletCashUsd: atomicUsd(snapshot.portfolio.testUsdcAtomic) + snapshot.officialCashUsd,
    walletSharesUsd: snapshot.solanaStockUsd + snapshot.officialStockUsd,
    positions: snapshot.workflow,
  }) : null;
  const total = parts ? netPositionTotal(parts) : 0;
  const solanaShareValue = !portfolio ? null : 'status' in portfolio ? BigInt(portfolio.rawAtomic) === 0n ? 0 : null : portfolio.valueUsd;
  const officialSharesInWallet = !rh ? null : 'status' in rh ? BigInt(rh.tslaRaw) === 0n ? 0 : null : rh.tslaValueUsd;
  const officialTileValue = officialSharesInWallet === null ? null : officialSharesInWallet + officialContractNet;
  const checkedAt = snapshot ? new Date(snapshot.checkedAt).toLocaleString() : null;
  const entitlementChanged = Boolean(snapshot && snapshot.lockedUsd !== locked);
  const balanceStatus = readError
    ? `${readError}${entitlementChanged ? ' Home deposit changed since this complete balance.' : ''}${checkedAt ? ` Last complete balance: ${checkedAt}.` : ''}`
    : entitlementChanged ? `Home deposit changed; checking a new complete balance. Last complete balance: ${checkedAt}.`
      : snapshot ? `${refreshing ? 'Checking for updates · ' : 'Last checked '}${checkedAt}` : 'Checking your test balances…';

  if (show === 'summary')
    return (
      <div className="today-money">
        <strong className="overview-figure">{snapshot ? `${usd(total)} test value` : '—'} <span>priced test-asset subtotal</span></strong>
        <RealityChips levels={['testnet_simulated']} />
        <span role="status">{balanceStatus}</span>
        {portfolio && !('status' in portfolio) && portfolio.referencePriceStale && <span>Solana reference price as of {new Date(portfolio.referencePriceObservedAt).toLocaleString()}</span>}
        {officialQuote?.referencePriceStale && <span>Robinhood reference price as of {new Date(officialQuote.referencePriceObservedAt).toLocaleString()}</span>}
        {parts && <NetPositionStrip parts={parts} />}
        <details><summary>What is included</summary>
          <p>{snapshot ? 'The parts above add up to the subtotal. Robinhood Chain test USD (tUSDG) is counted once.' : 'No complete subtotal yet.'}
            {' Validator stake (Money → Devices & income) is public mainnet data and is not part of this subtotal. Local project units are excluded: their test issue price is not a resale or market quote.'}</p>
          {positions?.fakeStock && <p>tTSLA · fake test stock at simulated price: {usd(fakeStockWalletValue)} wallet · {usd(pledged)} pledged · {usd(collateral)} loan collateral · debt −{usd(debt)}</p>}
          {hasLegacyPosition && <p>Official TSLA test positions: {usd(pledged)} pledged · {usd(collateral)} loan collateral · debt −{usd(debt)} (simulated collateral price)</p>}
        </details>
        <button className="text-button" onClick={() => go('money')}>See priced test assets →</button>
      </div>
    );

  const solanaAddress = wallet.wallets.find((item) => item.chainType === 'solana')?.address;
  const robinhoodAddress = wallet.wallets.find((item) => item.chainType === 'ethereum')?.address;
  const noCash = needsTestFunds(portfolio?.testUsdcAtomic ?? null, rh?.testUsdAtomic ?? null);
  async function copyAddress(address: string, chain: string) {
    try { await navigator.clipboard.writeText(address); setCopied(chain); }
    catch { setCopied('Copy failed; select the address instead.'); }
  }
  return (
    <section className={`card assets ${show}`} id="money-overview" tabIndex={-1}>
      <p className="small-copy">{TEST_EXIT_NOTICE}</p>
      <details className="money-funds" key={noCash ? 'empty' : 'funded'} open={noCash}>
        <summary>{noCash ? 'Get test funds' : 'Need more test funds?'}</summary>
        <div className="money-funds-wallets">
          <div><strong>Solana devnet wallet · test USDC</strong><p>{solanaAddress ? <><code>{solanaAddress}</code> <button className="text-button" type="button" onClick={() => void copyAddress(solanaAddress, 'Solana')}>Copy</button></> : 'Connect your Solana wallet in Me.'}</p><p>Use the <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer">Circle faucet (Solana Devnet)</a> to request test USDC.</p></div>
          <div><strong>Robinhood Chain wallet · test USD (tUSDG)</strong><p>{robinhoodAddress ? <><code>{robinhoodAddress}</code> <button className="text-button" type="button" onClick={() => void copyAddress(robinhoodAddress, 'Robinhood Chain')}>Copy</button></> : 'Connect your Robinhood Chain wallet in Me.'}</p><p>{positions === null ? 'Operator test tools could not be checked yet.' : positions.enabled ? 'Test USD comes from operator test tools when on, or by borrowing against example shares in Shares & loans; example shares and test ETH for network fees come from the operator test tools.' : 'This server has the operator test tools off, so test USD and example shares cannot be created here.'}</p></div>
        </div>
        {copied && <p role="status">{copied === 'Copy failed; select the address instead.' ? copied : `${copied} address copied.`}</p>}
      </details>
      <div className="assets-head">
        <div>
          <span className="money-network-badge">YOUR HOLDINGS</span>
          <h2>What you hold, what is locked</h2>
          <p className="small-copy">See your home deposit, shares and cash in one place.</p>
        </div>
        <div className="assets-total"><span>Priced test-asset subtotal</span><strong>{snapshot ? `${usd(total)} test value` : '—'}</strong><small role="status">{balanceStatus}</small><details><summary>What this counts</summary><p>{snapshot ? 'The parts listed below add up to this figure.' : 'No complete subtotal yet.'} Robinhood Chain and Solana are separate test networks. Robinhood Chain test USD (tUSDG) is counted once. Local project units are excluded: their test issue price is not a resale or market quote.</p></details></div>
        {positions?.fakeStock && <p className="small-copy assets-valuation-note">tTSLA wallet and contract positions use a simulated test price; loan debt is subtracted once.</p>}
        {((portfolio && !('status' in portfolio) && portfolio.referencePriceStale) || officialQuote?.referencePriceStale) && <p className="small-copy assets-valuation-note">Last known stock reference prices; observation times below.</p>}
      </div>
      {parts && <NetPosition parts={parts} go={go} depositSection={depositSection} />}
      <div className="asset-grid">
        <button type="button" className="asset-tile clickable" id="rental-deposit-holding" onClick={() => goToSection(go, 'home', depositSection)} aria-label="Open rental home and deposit">
          <header><KeyRound size={18} /> Rental home &amp; deposit · Solana devnet</header>
          <strong>{usd(locked)} test value</strong>
          <span>{entitled.length === 0 && !tenancies.some((t) => t.chain) ? 'No active deposit' : asTenant > 0
            ? `Your deposit for ${asTenant} home${asTenant > 1 ? 's' : ''} is supplied to lending. Devnet lending pays nothing; deposit earnings here are simulated.`
            : 'Deposit assets are held for a tenancy where you are landlord or arbitrator; they are not yours. Only an approved claim or settlement payout may be owed to you.'}</span>
          {tenancies.some((t) => t.chain && t.role !== 'tenant') && <span>Held for your tenancy: {usd(tenancies.reduce((sum, t) => sum + (t.role !== 'tenant' && t.chain ? atomicUsd(t.chain.lendingValueAtomic) + atomicUsd(t.chain.escrowAtomic) : 0), 0))} test value · not yours</span>}
          {claimed > 0 && <span className="asset-gain"><TrendingUp size={13} /> {usd(claimed)} test deposit earnings claimed (simulated)</span>}
          {tenancies.some((t) => t.chain) && <span className="text-button">Open in Home →</span>}
        </button>

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

        <article className="asset-tile" id="official-shares" tabIndex={-1}>
          <header><LineChart size={18} /> TSLA · official Robinhood test token</header>
          <strong>{officialTileValue === null ? '—' : `${usd(officialTileValue)} test value`}</strong>
          <span>{rh ? `${rh.tslaShares.toFixed(5)} TSLA in wallet · ${usd(walletTestUsd)} test USD (tUSDG) in Robinhood Chain wallet` : 'Balance not yet available'}</span>
          {rh && 'status' in rh && <span role="status">Official TSLA reference price unavailable; wallet quantity and cash were read.</span>}
          {hasLegacyPosition && <span>Contract-held official TSLA at simulated collateral price: {(Number(positions?.deposit?.sharesRaw ?? '0') / 1e18).toFixed(5)} TSLA pledged ({usd(pledged)}) · {(Number(positions?.loan?.sharesRaw ?? '0') / 1e18).toFixed(5)} TSLA loan collateral ({usd(collateral)}) · loan −{usd(debt)}</span>}
          {officialQuote?.referencePriceStale && <span>Reference price as of {new Date(officialQuote.referencePriceObservedAt).toLocaleString()} · live price unavailable</span>}
          {officialQuote && <span>Reference price {usd(officialQuote.referencePriceUsd)} per test TSLA · Jupiter price for mainnet TSLAx, not a resale quote for this test token</span>}
          {officialQuote && (BigInt(officialQuote.testUsdAtomic) === 0n
            ? <p className="small-copy">No test USD (tUSDG) in this Robinhood Chain wallet yet. It comes from borrowing against example shares in Shares &amp; loans, or from the operator test tools when they are on.</p>
            : <RobinhoodBuy request={request} testUsdAtomic={officialQuote.testUsdAtomic}
                pausedReason={!latestRead?.assets ? 'Robinhood Chain wallet read unavailable; buying is paused until its balance is checked.' : !latestRead?.workflow ? 'Share positions unavailable; buying is paused until they refresh.' : officialQuote.referencePriceStale ? 'The TSLA reference price is out of date, so buying is paused. Try again shortly.' : ''}
                debtUsd={debt}
                blocksExampleShares={Boolean(positions?.enabled && !positions.fakeStock && !positions.deposit && !positions.loan && BigInt(officialQuote.tslaRaw) === 0n)}
                onPrepareExamples={() => goToSection(go, 'money', 'ownership-journey')} />)}
        </article>
        {positions?.fakeStock && <article className="asset-tile" id="fake-shares" tabIndex={-1}>
          <header><LineChart size={18} /> tTSLA · fake test stock (test market price)</header>
          <strong>{usd(fakeStockValue)} simulated test value</strong>
          <span>{(Number(positions.fakeStock.walletRaw) / 1e18).toFixed(5)} tTSLA in wallet · simulated price {usd(atomicUsd(positions.fakeStock.priceAtomic))} per share</span>
          <span>In wallet {usd(fakeStockWalletValue)} · pledged for a deposit {usd(pledged)} · loan collateral {usd(collateral)} · loan −{usd(debt)}</span>
        </article>}
        <article className="asset-tile"><header>tHOME and tWORK · fictional test units</header><strong>Outside subtotal</strong>{stakes?.state === 'ready' ? stakes.assets.map((asset) => <span key={asset.projectId}>{TEST_CITY_INVESTMENTS.find((project) => project.id === asset.projectId)?.symbol ?? 'Test units'}: {asset.holdingRaw === null ? 'unavailable' : (Number(BigInt(asset.holdingRaw)) / 1e18).toFixed(4)} units · fictional test issuer</span>) : <span>{stakes ? 'Local stake balances unavailable.' : 'Checking wallet units…'}</span>}<span>Test issue prices are not resale prices, and these units grant no property or company rights.</span><button className="text-button" type="button" onClick={() => goToSection(go, 'money', 'local-investments')}>See your local stakes →</button></article>
      </div>
    </section>
  );
}
