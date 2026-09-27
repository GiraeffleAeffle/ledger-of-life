'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Cpu, KeyRound, LineChart, Loader2, Sun, TrendingUp } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { TenancyJourney } from '@/server/journey';
import type { PortfolioView } from '@/server/portfolio';
import type { PublicAdapterConfig, SolarReading, ValidatorReading } from '@/server/adapters';
import type { RobinhoodHoldings } from '@/server/robinhood-demo';
import type { Area } from './areas';

type Settled<T> = { ok: true; value: T } | { ok: false; error: string; code?: 'price_unavailable' } | null;
type AssetsResponse = { robinhood: Settled<RobinhoodHoldings>; solar: Settled<SolarReading>; validator: Settled<ValidatorReading>; adapters: PublicAdapterConfig };
type SharePositions = {
  enabled: boolean;
  testUsdAtomic: string;
  fakeStock: null | { symbol: 'tTSLA'; walletRaw: string; walletValueAtomic: string; priceAtomic: string };
  deposit: { valueAtomic: string } | null;
  loan: { valueAtomic: string; debtAtomic: string } | null;
};
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type BuyStep = { description: string; transaction: { chainId: 46630; to: string; data: string; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } };

const usd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const atomicUsd = (atomic: string | undefined) => Number(atomic ?? '0') / 1e6;
const money = (value: number, currency: string) => value.toLocaleString('en-US', { style: 'currency', currency });
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
 * Holdings and read-only adapters, rendered per area: Money shows the total and every holding,
 * Home shows home energy, Overview shows a short summary that opens Money.
 */
export function AssetsOverview({ request, tenancies, show, go }: {
  request: Request; tenancies: TenancyJourney[]; show: 'money' | 'home' | 'summary'; go: (area: Area) => void;
}) {
  const wallet = useRentalWallet();
  const [assets, setAssets] = useState<AssetsResponse | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioView | null>(null);
  const [portfolioUnavailable, setPortfolioUnavailable] = useState(false);
  const [portfolioChecked, setPortfolioChecked] = useState(false);
  const [workflow, setWorkflow] = useState<SharePositions | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<'loading' | 'available' | 'unavailable'>('loading');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState<'solar' | 'validator' | null>(null);
  const [solarForm, setSolarForm] = useState({ url: 'http://homeassistant.local:8123', token: '', entity: '', pricePerKwh: '0.30' });
  const [validatorForm, setValidatorForm] = useState({ chain: 'gnosis', id: '' });

  const refresh = useCallback(async () => {
    const [a, p, w] = await Promise.all([
      request<AssetsResponse>(show === 'home' ? '/api/assets?area=home' : '/api/assets'),
      show === 'home' ? Promise.resolve(null) : request<{ portfolio: PortfolioView | { available: false } }>('/api/portfolio').catch(() => null),
      show === 'home' ? Promise.resolve(null) : request<{ workflow: SharePositions }>('/api/share-workflows').catch(() => null),
    ]);
    setAssets(a);
    if (show !== 'home') {
      setPortfolio(p?.portfolio.available ? p.portfolio : null);
      setPortfolioUnavailable(p === null);
      setPortfolioChecked(true);
      setWorkflow(w?.workflow.enabled ? w.workflow : null);
      setWorkflowStatus(w?.workflow.enabled ? 'available' : 'unavailable');
    }
  }, [request, show]);
  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryAssets: ReturnType<typeof setTimeout> | undefined;
    let assetsRevision = 0;
    let workflowRevision = 0;
    async function loadAssets() {
      const revision = ++assetsRevision;
      clearTimeout(retryAssets);
      try {
        const a = await request<AssetsResponse>(show === 'home' ? '/api/assets?area=home' : '/api/assets');
        if (!active || revision !== assetsRevision) return;
        setAssets(a);
        if (show !== 'home' && a.robinhood && (!a.robinhood.ok || a.robinhood.value.referencePriceStale))
          retryAssets = setTimeout(loadAssets, a.robinhood.ok || a.robinhood.code === 'price_unavailable' ? 60_000 : 8000);
      } catch {}
    }
    void loadAssets();
    if (show !== 'home') {
      async function loadPortfolio() {
        try {
          const { portfolio } = await request<{ portfolio: PortfolioView | { available: false } }>('/api/portfolio');
          if (!active) return;
          setPortfolio(portfolio.available ? portfolio : null);
          setPortfolioUnavailable(false);
          setPortfolioChecked(true);
          if (portfolio.available && portfolio.referencePriceStale) retry = setTimeout(loadPortfolio, 60_000);
        } catch {
          if (!active) return;
          setPortfolioUnavailable(true);
          setPortfolioChecked(true);
          retry = setTimeout(loadPortfolio, 8000);
        }
      }
      void loadPortfolio();
      async function loadWorkflow() {
        const revision = ++workflowRevision;
        setWorkflowStatus('loading');
        try {
          const { workflow } = await request<{ workflow: SharePositions }>('/api/share-workflows');
          if (!active || revision !== workflowRevision) return;
          setWorkflow(workflow.enabled ? workflow : null);
          setWorkflowStatus(workflow.enabled ? 'available' : 'unavailable');
        } catch {
          if (!active || revision !== workflowRevision) return;
          setWorkflow(null);
          setWorkflowStatus('unavailable');
        }
      }
      void loadWorkflow();
      const reloadShareBalances = () => { void loadAssets(); void loadWorkflow(); };
      window.addEventListener('ledger-share-workflows-changed', reloadShareBalances);
      return () => { active = false; clearTimeout(retry); clearTimeout(retryAssets); window.removeEventListener('ledger-share-workflows-changed', reloadShareBalances); };
    }
    return () => { active = false; clearTimeout(retry); clearTimeout(retryAssets); };
  }, [request, show]);

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    setMessage('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy('');
    }
  }
  async function buyTsla() {
    const { walletId, steps } = await request<{ walletId: string; steps: BuyStep[] }>('/api/assets', { action: 'robinhood_prepare_buy' });
    for (const step of steps) {
      const signed = await wallet.signEvmTransaction({
        operationId: `rh-${step.transaction.nonce}`, walletId, description: step.description,
        expiresAt: new Date(Date.now() + 120_000).toISOString(), transaction: step.transaction,
      });
      await request('/api/assets', { action: 'robinhood_submit', signed });
    }
    setMessage('Bought test TSLA with your Robinhood earnings.');
  }

  // Count only what belongs to the viewer: a landlord must not see the tenant's deposit as their own,
  // and unpaid payouts stay visible after the tenancy closes.
  const entitled = tenancies
    .map((t) => ({ t, value: t.chain ? entitlementUsd(t.role, t.chain) : 0 }))
    .filter(({ value }) => value > 0);
  const locked = entitled.reduce((sum, { value }) => sum + value, 0);
  const claimed = tenancies.filter((t) => t.role === 'tenant').reduce((sum, t) => sum + atomicUsd(t.chain?.releasedAtomic), 0);
  const asTenant = entitled.filter(({ t }) => t.role === 'tenant').length;
  const rh = assets?.robinhood?.ok ? assets.robinhood.value : null;
  const solar = assets?.solar?.ok ? assets.solar.value : null;
  const validator = assets?.validator?.ok ? assets.validator.value : null;
  const robinhoodUnavailable = Boolean(assets?.robinhood && !assets.robinhood.ok);
  const robinhoodError = assets?.robinhood && !assets.robinhood.ok
    ? assets.robinhood.code === 'price_unavailable' ? 'Reference price temporarily unavailable; retrying…' : assets.robinhood.error
    : null;
  const unavailableHoldings = portfolioUnavailable
    ? robinhoodUnavailable ? 'Solana portfolio and Robinhood holdings' : 'Solana portfolio'
    : robinhoodUnavailable ? 'Robinhood holdings' : '';
  const positions = workflowStatus === 'available' ? workflow : null;
  // Both endpoints read the same test-USD wallet. The workflow's top-level walletValueAtomic
  // repeats fakeStock.walletValueAtomic once the fake token is deployed; never add both.
  const walletTestUsd = rh ? atomicUsd(rh.testUsdAtomic) : atomicUsd(positions?.testUsdAtomic);
  const robinhoodValue = (rh?.tslaValueUsd ?? 0) + walletTestUsd;
  const fakeStockWalletValue = atomicUsd(positions?.fakeStock?.walletValueAtomic);
  const pledged = atomicUsd(positions?.deposit?.valueAtomic);
  const collateral = atomicUsd(positions?.loan?.valueAtomic);
  const debt = atomicUsd(positions?.loan?.debtAtomic);
  const fakeStockValue = fakeStockWalletValue + pledged + collateral - debt;
  const total = locked + (portfolio ? portfolio.valueUsd + atomicUsd(portfolio.testUsdcAtomic) : 0) + robinhoodValue + fakeStockValue;
  const totalLoading = !assets || !portfolioChecked || workflowStatus === 'loading';

  if (show === 'summary')
    return (
      <div className="today-money">
        <span className="eyebrow">TEST MONEY · NO REAL VALUE</span>
        <strong className="overview-figure">{totalLoading ? <Loader2 className="spin" size={20} /> : unavailableHoldings ? '—' : usd(total)}</strong>
        <span className="small-copy">
          {unavailableHoldings ? `${unavailableHoldings} temporarily unavailable; retrying…` : `Deposit ${usd(locked)} · stocks ${usd((portfolio?.valueUsd ?? 0) + robinhoodValue + fakeStockValue)}`}
          {validator ? ` · validator ${validator.stake.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${validator.unit}` : ''}
        </span>
        {positions?.fakeStock && <span className="small-copy">tTSLA · fake test stock (test market price): {usd(fakeStockWalletValue)} in wallet · {usd(pledged)} pledged · {usd(collateral)} loan collateral · loan −{usd(debt)}</span>}
        {portfolio?.referencePriceStale && <span className="small-copy">Solana reference price as of {new Date(portfolio.referencePriceObservedAt).toLocaleString()}</span>}
        {rh?.referencePriceStale && <span className="small-copy">Robinhood reference price as of {new Date(rh.referencePriceObservedAt).toLocaleString()}</span>}
        {workflowStatus === 'unavailable' && <span className="small-copy" role="status">Workflow positions unavailable; wallet-only values shown.</span>}
        <button className="text-button" onClick={() => go('money')}>Open Money →</button>
      </div>
    );

  return (
    <section className={`card assets ${show}`}>
      {show === 'money' ? (
        <div className="assets-head">
          <div>
            <span className="eyebrow">EVERYTHING YOU OWN · TEST NETWORKS</span>
            <h2>{totalLoading ? <Loader2 className="spin" size={20} /> : unavailableHoldings ? '—' : usd(total)}</h2>
            <p className="small-copy">{unavailableHoldings ? `${unavailableHoldings} temporarily unavailable; retrying…` : 'Your deposit, stocks and what your hardware earns. Test assets have no real value.'}</p>
            {positions?.fakeStock && <p className="small-copy">Fake tTSLA shares and contract-held positions use the simulated test market price; open loan debt is subtracted.</p>}
            {(portfolio?.referencePriceStale || rh?.referencePriceStale) && <p className="small-copy">Total includes last known stock prices; observation times below.</p>}
            {workflowStatus === 'unavailable' && <p className="small-copy" role="status">Workflow positions unavailable; wallet-only values shown.</p>}
          </div>
        </div>
      ) : (
        <div className="assets-head"><div><span className="eyebrow">HOME ENERGY · READ-ONLY</span></div></div>
      )}
      {message && <p className="note" role="status">{message}</p>}
      <div className="asset-grid">
        {show === 'money' && <>
        <article className="asset-tile clickable" onClick={() => go('home')}>
          <header><KeyRound size={18} /> Rental home & deposit</header>
          <strong>{usd(locked)}</strong>
          <span>{entitled.length === 0 ? 'No active deposit' : asTenant === entitled.length
            ? `Your deposit for ${asTenant} home${asTenant > 1 ? 's' : ''}, earning in lending`
            : 'Your deposits plus approved claims and payouts owed to you'}</span>
          {claimed > 0 && <span className="asset-gain"><TrendingUp size={13} /> {usd(claimed)} earnings claimed</span>}
          {tenancies.some((t) => t.chain) && <span className="text-button">Open in Home →</span>}
        </article>

        <article className="asset-tile">
          <header><LineChart size={18} /> Stocks · Solana</header>
          <strong>{portfolio ? usd(portfolio.valueUsd) : '—'}</strong>
          <span>{portfolio ? `${portfolio.shares.toFixed(4)} tSPYx (S&P 500 copy)` : portfolioUnavailable ? 'Temporarily unavailable; retrying…' : 'Loading…'}</span>
          {portfolio?.referencePriceStale && <span>Reference price as of {new Date(portfolio.referencePriceObservedAt).toLocaleString()} · live price unavailable</span>}
          {portfolio && portfolio.multiplier > 1 && <span className="asset-gain"><TrendingUp size={13} /> +{((portfolio.multiplier - 1) * 100).toFixed(2)} % from simulated distributions (test market)</span>}
        </article>

        <article className="asset-tile">
          <header><LineChart size={18} /> Stocks · Robinhood Chain</header>
          <strong>{!assets || workflowStatus === 'loading' ? 'Loading…' : rh ? usd(robinhoodValue) : '—'}</strong>
          <span>{rh ? `${rh.tslaShares.toFixed(5)} TSLA (official test token) · ${usd(walletTestUsd)} test USD in wallet` : robinhoodError ?? 'Loading…'}</span>
          {workflowStatus === 'unavailable' && <span role="status">Workflow positions unavailable; wallet-only values shown.</span>}
          {rh?.referencePriceStale && <span>Reference price as of {new Date(rh.referencePriceObservedAt).toLocaleString()} · live price unavailable</span>}
          <div className="button-row">
            {rh && BigInt(rh.testUsdAtomic) > 0n && (
              <button className="button primary" disabled={Boolean(busy) || rh.referencePriceStale} onClick={() => run('buy', buyTsla)}>
                {busy === 'buy' ? <Loader2 className="spin" size={14} /> : null} Invest in TSLA <ArrowRight size={14} />
              </button>
            )}
          </div>
        </article>
        {positions?.fakeStock && <article className="asset-tile">
          <header><LineChart size={18} /> tTSLA · fake test stock (test market price)</header>
          <strong>{usd(fakeStockValue)}</strong>
          <span>{(Number(positions.fakeStock.walletRaw) / 1e18).toFixed(5)} tTSLA in wallet · simulated price {usd(atomicUsd(positions.fakeStock.priceAtomic))} per share</span>
          <span>In wallet {usd(fakeStockWalletValue)} · pledged for a deposit {usd(pledged)} · loan collateral {usd(collateral)} · loan −{usd(debt)}</span>
        </article>}
        </>}

        {show === 'home' && (
        <article className="asset-tile">
          <header><Sun size={18} /> Home solar</header>
          {solar ? (
            <>
              <strong>{solar.valueToday !== null ? `${solar.valueEstimated ? '≈ ' : ''}${money(solar.valueToday, solar.currency)} today` : `${solar.powerW} W now`}</strong>
              <span>{solar.energyTodayKwh !== null ? `${solar.energyTodayKwh} kWh today` : ''}{solar.powerW !== null ? ` · ${solar.powerW} W now` : ''}</span>
              {solar.savings && (solar.savings.month !== null || solar.savings.year !== null) && (
                <span className="asset-gain"><TrendingUp size={13} /> {solar.savings.month !== null ? `${money(solar.savings.month, solar.currency)} this month` : ''}{solar.savings.month !== null && solar.savings.year !== null ? ' · ' : ''}{solar.savings.year !== null ? `${money(solar.savings.year, solar.currency)} this year` : ''}</span>
              )}
              <span className="small-copy">via Home Assistant · {solar.entity}</span>
            </>
          ) : (
            <>
              <strong>Connect</strong>
              <span>{assets?.solar && !assets.solar.ok ? assets.solar.error : 'Read your solar production from Home Assistant.'}</span>
            </>
          )}
          <button className="text-button" onClick={() => setOpen(open === 'solar' ? null : 'solar')}>{assets?.adapters.homeAssistant ? 'Settings' : 'Connect Home Assistant'}</button>
          {open === 'solar' && (
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run('solar', async () => {
              await request('/api/assets', { action: 'save_adapter', kind: 'homeAssistant', url: solarForm.url, token: solarForm.token, entity: solarForm.entity, pricePerKwh: Number(solarForm.pricePerKwh) });
              setOpen(null);
            }); }}>
              <label>Home Assistant address<input value={solarForm.url} onChange={(e) => setSolarForm({ ...solarForm, url: e.target.value })} /></label>
              <label>Long-lived access token<input type="password" placeholder={assets?.adapters.homeAssistant ? 'saved, leave empty to keep' : 'Profile → Security → create token'} value={solarForm.token} onChange={(e) => setSolarForm({ ...solarForm, token: e.target.value })} /></label>
              <label>Sensor (optional)<input placeholder="sensor.solar_energy_today" value={solarForm.entity} onChange={(e) => setSolarForm({ ...solarForm, entity: e.target.value })} /></label>
              <label>Value per kWh (€)<input inputMode="decimal" value={solarForm.pricePerKwh} onChange={(e) => setSolarForm({ ...solarForm, pricePerKwh: e.target.value })} /></label>
              <button className="button primary" disabled={Boolean(busy)}>Save</button>
            </form>
          )}
        </article>
        )}

        {show === 'money' && (
        <article className="asset-tile">
          <header><Cpu size={18} /> Validator</header>
          {validator ? (
            <>
              <strong>{validator.stake.toLocaleString('en-US', { maximumFractionDigits: 3 })} {validator.unit}</strong>
              <span>{({ active_ongoing: 'Active', voting: 'Active, voting', delinquent: 'Delinquent', pending_queued: 'In activation queue', exited_unslashed: 'Exited' } as Record<string, string>)[validator.status] ?? validator.status}{validator.commission !== undefined ? ` · ${validator.commission}% commission` : ''}</span>
              {validator.rewardsRecent !== null && <span className="asset-gain"><TrendingUp size={13} /> {validator.rewardsRecent} {validator.unit} {validator.rewardsLabel}</span>}
            </>
          ) : (
            <>
              <strong>Connect</strong>
              <span>{assets?.validator && !assets.validator.ok ? assets.validator.error : 'Show the stake and rewards of your validator.'}</span>
            </>
          )}
          <button className="text-button" onClick={() => setOpen(open === 'validator' ? null : 'validator')}>{assets?.adapters.validator ? 'Settings' : 'Connect validator'}</button>
          {open === 'validator' && (
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run('validator', async () => {
              await request('/api/assets', { action: 'save_adapter', kind: 'validator', ...validatorForm });
              setOpen(null);
            }); }}>
              <label>Network<select value={validatorForm.chain} onChange={(e) => setValidatorForm({ ...validatorForm, chain: e.target.value })}><option value="gnosis">Gnosis</option><option value="ethereum">Ethereum</option><option value="solana">Solana</option></select></label>
              <label>{validatorForm.chain === 'solana' ? 'Vote account' : 'Validator index or public key'}<input value={validatorForm.id} onChange={(e) => setValidatorForm({ ...validatorForm, id: e.target.value })} /></label>
              <button className="button primary" disabled={Boolean(busy)}>Save</button>
            </form>
          )}
        </article>
        )}
      </div>
    </section>
  );
}
