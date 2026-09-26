'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Cpu, KeyRound, LineChart, Loader2, Sun, TrendingUp } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { TenancyJourney } from '@/server/journey';
import type { PortfolioView } from '@/server/portfolio';
import type { PublicAdapterConfig, SolarReading, ValidatorReading } from '@/server/adapters';
import type { RobinhoodHoldings } from '@/server/robinhood-demo';
import type { Area } from './areas';

type Settled<T> = { ok: true; value: T } | { ok: false; error: string } | null;
type AssetsResponse = { robinhood: Settled<RobinhoodHoldings>; solar: Settled<SolarReading>; validator: Settled<ValidatorReading>; adapters: PublicAdapterConfig };
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
export function AssetsOverview({ request, tenancies, testHelpers, show, go }: {
  request: Request; tenancies: TenancyJourney[]; testHelpers: boolean; show: 'money' | 'home' | 'summary'; go: (area: Area) => void;
}) {
  const wallet = useRentalWallet();
  const [assets, setAssets] = useState<AssetsResponse | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioView | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState<'solar' | 'validator' | null>(null);
  const [solarForm, setSolarForm] = useState({ url: 'http://homeassistant.local:8123', token: '', entity: '', pricePerKwh: '0.30' });
  const [validatorForm, setValidatorForm] = useState({ chain: 'gnosis', id: '' });

  const refresh = useCallback(async () => {
    const [a, p] = await Promise.all([
      request<AssetsResponse>('/api/assets'),
      request<{ portfolio: PortfolioView | { available: false } }>('/api/portfolio').catch(() => null),
    ]);
    setAssets(a);
    if (p?.portfolio.available) setPortfolio(p.portfolio);
  }, [request]);
  useEffect(() => {
    let active = true;
    Promise.all([
      request<AssetsResponse>('/api/assets'),
      request<{ portfolio: PortfolioView | { available: false } }>('/api/portfolio').catch(() => null),
    ]).then(([a, p]) => {
      if (!active) return;
      setAssets(a);
      if (p?.portfolio.available) setPortfolio(p.portfolio);
    }).catch(() => {});
    return () => { active = false; };
  }, [request]);

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
  const total = locked + (portfolio ? portfolio.valueUsd + atomicUsd(portfolio.testUsdcAtomic) : 0) + (rh ? rh.tslaValueUsd + atomicUsd(rh.testUsdAtomic) : 0);

  if (show === 'summary')
    return (
      <section className="card overview-tile clickable" onClick={() => go('money')}>
        <span className="eyebrow">MONEY · TEST NETWORKS</span>
        <strong className="overview-figure">{assets ? usd(total) : <Loader2 className="spin" size={20} />}</strong>
        <span className="small-copy">
          Deposit {usd(locked)} · stocks {usd((portfolio?.valueUsd ?? 0) + (rh?.tslaValueUsd ?? 0))}
          {validator ? ` · validator ${validator.stake.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${validator.unit}` : ''}
        </span>
        <span className="text-button">Open Money →</span>
      </section>
    );

  return (
    <section className={`card assets ${show}`}>
      {show === 'money' ? (
        <div className="assets-head">
          <div>
            <span className="eyebrow">EVERYTHING YOU OWN · TEST NETWORKS</span>
            <h2>{assets ? usd(total) : <Loader2 className="spin" size={20} />}</h2>
            <p className="small-copy">Your deposit, stocks and what your hardware earns. Test assets have no real value.</p>
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
          <span>{portfolio ? `${portfolio.shares.toFixed(4)} tSPYx (S&P 500 copy)` : 'Loading…'}</span>
          {portfolio && portfolio.multiplier > 1 && <span className="asset-gain"><TrendingUp size={13} /> +{((portfolio.multiplier - 1) * 100).toFixed(2)} % from simulated distributions (test market)</span>}
        </article>

        <article className="asset-tile">
          <header><LineChart size={18} /> Stocks · Robinhood Chain</header>
          <strong>{rh ? usd(rh.tslaValueUsd) : '—'}</strong>
          <span>{rh ? `${rh.tslaShares.toFixed(5)} TSLA (official test token) · ${usd(atomicUsd(rh.testUsdAtomic))} test USD` : assets?.robinhood && !assets.robinhood.ok ? assets.robinhood.error : 'Loading…'}</span>
          <div className="button-row">
            {testHelpers && (
              <button className="button test-helper" disabled={Boolean(busy)} onClick={() => run('earn', async () => {
                const { result } = await request<{ result: { releasedAtomic: string } }>('/api/assets', { action: 'robinhood_earn' });
                setMessage(`A Robinhood testnet deposit earned ${usd(atomicUsd(result.releasedAtomic))} of simulated yield (test tokens), released to your wallet.`);
              })}>
                {busy === 'earn' ? <Loader2 className="spin" size={14} /> : null} Earn on Robinhood (test)
              </button>
            )}
            {rh && BigInt(rh.testUsdAtomic) > 0n && (
              <button className="button primary" disabled={Boolean(busy)} onClick={() => run('buy', buyTsla)}>
                {busy === 'buy' ? <Loader2 className="spin" size={14} /> : null} Invest in TSLA <ArrowRight size={14} />
              </button>
            )}
          </div>
        </article>
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
