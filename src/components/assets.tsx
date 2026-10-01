'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, LineChart, TrendingUp } from 'lucide-react';
import type { TenancyJourney } from '@/server/journey';
import { SOLANA_TEST_USDC_MINT } from '@/finance/solana/manifest';
import type { PortfolioPartial, PortfolioView } from '@/server/portfolio';
import { goToSection, openShareWorkflow, type Area } from './areas';
import { NetPosition, NetPositionStrip } from './net-position';
import { RealityChips } from './reality-chip';
import { confirmedRobinhood, netPositionParts, netPositionTotal, shareValuationAvailable, usd, type RobinhoodRead, type SharePositionAmounts } from './money-valuation';
import { TEST_EXIT_NOTICE } from './money-guidance';
import type { LocalInvestmentView } from '@/server/local-investments';
import { TEST_CITY_INVESTMENTS } from '@/data/local-investments';
import { useRentalWallet } from '@/wallets';
import { useSectionTabActive } from './section-tabs';
import { depositShares, depositUsd } from './share-deposit';
import { depositHoldings } from './deposit-holdings';

type AssetsResponse = { robinhood: RobinhoodRead };
type SharePositions = SharePositionAmounts & { enabled: boolean; testUsdAtomic: string | null };
type PricedPortfolio = PortfolioView | PortfolioPartial;
type MoneySnapshot = { assets: AssetsResponse; portfolio: PricedPortfolio; workflow: SharePositions; lockedUsd: number; officialCashUsd: number; officialStockUsd: number; solanaStockUsd: number; checkedAt: number };
type LatestRead = { assets: AssetsResponse | null; portfolio: PricedPortfolio | null; workflow: SharePositions | null; checkedAt: number };
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
import { DepositYield } from './deposit-yield';

const atomicUsd = (atomic: string | null | undefined) => Number(atomic ?? '0') / 1e6;

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
    const lockedAtRead = depositHoldings(tenanciesRef.current).locked;
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
      !official ? 'Robinhood wallet balances' : null,
      !solana ? 'Solana wallet balances' : 'status' in solana && BigInt(solana.rawAtomic) > 0n ? 'tSPYx price' : null,
      !workflow || !shareValuationAvailable(workflow) ? 'fresh shared-market TSLA valuation' : null,
      tenanciesRef.current.some(t => t.shareDeposit && BigInt(t.shareDeposit.lockedShares) > 0n && !t.shareDeposit.quote?.fresh) ? 'fresh locked-deposit TSLA valuation' : null,
    ].filter((issue): issue is string => issue !== null);
    if (issues.length) {
      setReadError(`Live valuation incomplete: ${issues.join(', ')} unavailable.`);
    } else if (assets && official && solana && workflow) {
      setSnapshot({ assets, portfolio: solana, workflow, lockedUsd: lockedAtRead,
        officialCashUsd: atomicUsd(official.testUsdAtomic),
        officialStockUsd: 0,
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
  const { cashEntitled, locked, cashLocked, cashTenantCount } = depositHoldings(tenancies);
  const lastLockedRef = useRef(locked);
  useEffect(() => {
    if (lastLockedRef.current === locked) return;
    lastLockedRef.current = locked;
    const timer = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [locked, refresh]);
  const claimed = tenancies.filter((t) => t.role === 'tenant').reduce((sum, t) => sum + atomicUsd(t.chain?.releasedAtomic), 0);
  const asTenant = cashTenantCount;
  const onChain = tenancies.find((t) => t.chain);
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
    lockedUsd: snapshot.lockedUsd,
    walletCashUsd: atomicUsd(snapshot.portfolio.testUsdcAtomic) + snapshot.officialCashUsd,
    walletSharesUsd: snapshot.solanaStockUsd + snapshot.officialStockUsd,
    positions: snapshot.workflow,
  }) : null;
  const total = parts ? netPositionTotal(parts) : 0;
  const solanaShareValue = !portfolio ? null : 'status' in portfolio ? BigInt(portfolio.rawAtomic) === 0n ? 0 : null : portfolio.valueUsd;
  const officialTileValue = !readError && positions && shareValuationAvailable(positions)
    ? atomicUsd(positions.walletValueAtomic) + collateral - debt : null;
  const checkedAt = snapshot ? new Date(snapshot.checkedAt).toLocaleString() : null;
  const entitlementChanged = Boolean(snapshot && snapshot.lockedUsd !== locked);
  const balanceStatus = readError
    ? `${readError}${entitlementChanged ? ' Home deposit changed since this complete balance.' : ''}${checkedAt ? ` Last complete balance: ${checkedAt}.` : ''}`
    : entitlementChanged ? `Home deposit changed; checking a new complete balance. Last complete balance: ${checkedAt}.`
      : snapshot ? `${refreshing ? 'Checking for updates · ' : 'Last checked '}${checkedAt}` : 'Checking your test balances…';

  if (show === 'summary')
    return (
      <div className="today-money">
        <strong className="overview-figure">{snapshot && !readError ? `${usd(total)} test value` : '—'} <span>priced test-asset subtotal</span></strong>
        <RealityChips levels={['testnet_simulated']} />
        <span role="status">{balanceStatus}</span>
        {portfolio && !('status' in portfolio) && portfolio.referencePriceStale && <span>Solana reference price as of {new Date(portfolio.referencePriceObservedAt).toLocaleString()}</span>}
        {parts && !readError && <NetPositionStrip parts={parts} />}
        <details><summary>What is included</summary>
          <p>{snapshot ? 'The parts above add up to the subtotal. Robinhood Chain test USD (tUSDG) is counted once.' : 'No complete subtotal yet.'}
            {' Validator stake (Money → Devices & income) is public mainnet data and is not part of this subtotal. Local project units are excluded: their test issue price is not a resale or market quote.'}</p>
          {positions && !readError && shareValuationAvailable(positions) && <p>Shared market: {usd(collateral)} loan collateral · {usd(lent)} lent · debt −{usd(debt)}. {hasFreshTokenPrice ? 'Wallet and collateral use the same fresh mirrored token price.' : 'No fresh mirrored token price is available; confirmed zero-stock positions do not need a stock quote.'}</p>}
        </details>
        <button className="text-button" onClick={() => go('money')}>See priced test assets →</button>
      </div>
    );

  const solanaAddress = wallet.wallets.find((item) => item.chainType === 'solana')?.address;
  const robinhoodAddress = wallet.wallets.find((item) => item.chainType === 'ethereum')?.address;
  async function copyAddress(address: string, chain: string) {
    try { await navigator.clipboard.writeText(address); setCopied(chain); }
    catch { setCopied('Copy failed; select the address instead.'); }
  }
  return (
    <section className={`card assets ${show}`} id="money-overview" tabIndex={-1}>
      <div className="assets-head">
        <div>
          <span className="money-network-badge">YOUR HOLDINGS</span>
          <h2>What you have</h2>
          <p className="small-copy">Test networks · no real money. Your home deposit, shares and cash, followed by optional actions.</p>
        </div>
        <div className="assets-total"><span>Priced test-asset subtotal</span><strong>{snapshot && !readError ? `${usd(total)} test value` : '—'}</strong><small role="status">{balanceStatus}</small><p>Test dollars anyone can mint have no monetary value. Local fictional units are outside this subtotal.</p></div>
      </div>
      <dl className="holdings-positions" aria-label="Free, locked, pledged, lent and owed test positions">
        {([
          ['free', 'Free', 'In your wallets'],
          ['locked', 'Locked', 'Your Home deposit entitlement'],
          ['pledged', 'Pledged', 'Test TSLA loan collateral'],
          ['lent', 'Lent', 'Your shared-pool claim'],
          ['owed', 'Owed', 'Debt subtracted from subtotal'],
        ] as const).map(([key, label, meaning]) => <div key={key}><dt>{label}</dt><dd>{parts && !readError ? `${key === 'owed' ? '−' : ''}${usd(parts[key])} test value` : 'Unavailable'}</dd><small>{meaning}</small></div>)}
      </dl>
      {parts && !readError && <details className="holdings-breakdown"><summary>How this subtotal is counted</summary><NetPosition parts={parts} go={go} depositSection={depositSection} /></details>}
      <div className="asset-grid">
        {tenancies.filter(t => t.shareDeposit && BigInt(t.shareDeposit.lockedShares) > 0n).map(t => <button key={t.agreementId} type="button" className="asset-tile clickable" onClick={() => goToSection(go, 'home', `tenancy-${t.agreementId}`)}><header><KeyRound size={18} /> TSLA locked in your deposit · Robinhood testnet</header><strong>{depositShares(t.shareDeposit!.lockedShares)} test TSLA</strong><span>{t.shareDeposit!.quote?.fresh ? `${depositUsd((BigInt(t.shareDeposit!.lockedShares) * BigInt(t.shareDeposit!.quote!.priceUsd6) / 10n ** 18n).toString())} USD at the quote` : 'USD valuation unavailable — fresh quote required'}</span><span>{t.role === 'tenant' ? 'Locked in your deposit, not spendable wallet balance and never loan collateral.' : 'Held for this tenancy, not your wallet balance. Only your decided award is your entitlement.'}</span><span>Settlement in TSLA; no yield. Open in Home →</span></button>)}
        <button type="button" className="asset-tile clickable" id="rental-deposit-holding" onClick={() => goToSection(go, 'home', depositSection)} aria-label="Open rental home and deposit">
          <header><KeyRound size={18} /> Rental home &amp; deposit · Solana devnet</header>
          <strong>{usd(cashLocked)} test value</strong>
          <span>{cashEntitled.length === 0 && !tenancies.some((t) => t.chain) ? 'No active deposit' : asTenant > 0
            ? tenancies.some((t) => t.role === 'tenant' && t.chain && t.chain.depositMint !== SOLANA_TEST_USDC_MINT)
              ? `Your deposit for ${asTenant} home${asTenant > 1 ? 's' : ''} is supplied to lending. Devnet lending pays nothing; deposit earnings here are simulated.`
              : `Your deposit for ${asTenant} home${asTenant > 1 ? 's' : ''} stays in cash escrow. This site pays labelled simulated yield in tUSDC; earnings belong to you.`
            : 'Deposit assets are held for a tenancy where you are landlord or arbitrator; they are not yours. Only an approved claim or settlement payout may be owed to you.'}</span>
          {tenancies.some((t) => t.chain && t.role !== 'tenant') && <span>Held for your tenancy: {usd(tenancies.reduce((sum, t) => sum + (t.role !== 'tenant' && t.chain ? atomicUsd(t.chain.lendingValueAtomic) + atomicUsd(t.chain.escrowAtomic) : 0), 0))} test value · not yours</span>}
          {claimed > 0 && <span className="asset-gain"><TrendingUp size={13} /> {usd(claimed)} test deposit earnings claimed (simulated)</span>}
          {tenancies.filter((t) => t.role === 'tenant' && t.chain?.depositMint === SOLANA_TEST_USDC_MINT && t.chain.simulatedYield).map((t) => <DepositYield key={t.agreementId} view={t.chain!.simulatedYield!} requiredAtomic={t.requiredSecurity} tenant compact />)}
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
          {positions && <span>Loan collateral: {(Number(positions.loan?.sharesRaw ?? '0') / 1e18).toFixed(5)} TSLA · debt {usd(debt)} test value. {hasFreshTokenPrice ? `Mirrored Robinhood TSLA token price: ${usd(atomicUsd(positions.priceAtomic))}.` : 'Fresh mirrored token price unavailable; no stock valuation shown.'}</span>}
          <button className="text-button" type="button" onClick={() => goToSection(go, 'money', 'share-workflows')}>Manage test TSLA &amp; loans</button>
        </article>
        <article className="asset-tile"><header>Lent test dollars · shared pool</header><strong>{positions ? `${usd(lent)} test value` : '—'}</strong><span>Pool share value includes borrower interest and losses. Withdrawals depend on available pool cash.</span><button className="text-button" type="button" onClick={() => openShareWorkflow(go, 'lend')}>Manage lent test dollars</button></article>
        <article className="asset-tile"><header>tHOME and tWORK · fictional test units</header><strong>Outside subtotal</strong>{stakes?.state === 'ready' ? stakes.assets.map((asset) => <span key={asset.projectId}>{TEST_CITY_INVESTMENTS.find((project) => project.id === asset.projectId)?.symbol ?? 'Test units'}: {asset.holdingRaw === null ? 'unavailable' : (Number(BigInt(asset.holdingRaw)) / 1e18).toFixed(4)} units · fictional test issuer</span>) : <span>{stakes ? 'Local stake balances unavailable.' : 'Checking wallet units…'}</span>}<span>Test issue prices are not resale prices, and these units grant no property or company rights.</span><button className="text-button" type="button" onClick={() => goToSection(go, 'money', 'local-investments')}>See your local stakes →</button></article>
      </div>
      <details className="money-funds">
        <summary>Wallet addresses &amp; funding networks</summary>
        <div className="money-funds-wallets">
          <div><strong>For the Solana deposit or tSPYx: test tokens on Solana devnet</strong><p>{solanaAddress ? <><code>{solanaAddress}</code> <button className="text-button" type="button" onClick={() => void copyAddress(solanaAddress, 'Solana')}>Copy Solana address</button></> : 'Connect your Solana wallet in Me.'}</p><p>A new Home deposit uses test USDC (tUSDC) from this site: Get test USDC in the Test money card below. tSPYx and older tenancies use Circle&apos;s devnet USDC from the <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer">Circle faucet (Solana Devnet)</a>. Robinhood test dollars cannot fund a Solana deposit.</p></div>
          <div><strong>For Robinhood tasks: test ETH for fees, plus test TSLA or tUSDG</strong><p>{robinhoodAddress ? <><code>{robinhoodAddress}</code> <button className="text-button" type="button" onClick={() => void copyAddress(robinhoodAddress, 'Robinhood Chain')}>Copy Robinhood address</button></> : 'Connect your Robinhood Chain wallet in Me.'}</p><p>Borrowing uses test TSLA; lending uses test dollars, not TSLA. Funding help appears beside the selected task in Shares &amp; loans.</p></div>
        </div>
        {copied && <p role="status">{copied === 'Copy failed; select the address instead.' ? copied : `${copied} address copied.`}</p>}
      </details>
      <p className="small-copy">{TEST_EXIT_NOTICE}</p>
    </section>
  );
}
