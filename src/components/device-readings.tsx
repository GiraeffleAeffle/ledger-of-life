'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, Sun, TrendingUp } from 'lucide-react';
import type { PublicAdapterConfig, SolarReading, ValidatorReading } from '@/server/adapters';
import { goToSection, type Area } from './areas';
import { useSectionTabActive } from './section-tabs';
import './device-readings.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Settled<T> = { ok: true; value: T } | { ok: false; error: string; code?: 'price_unavailable' } | null;
type DevicesResponse = { solar: Settled<SolarReading>; validator: Settled<ValidatorReading>; adapters: PublicAdapterConfig; homeAssistantPull: boolean };
const money = (value: number, currency: string) => value.toLocaleString('en-US', { style: 'currency', currency });

export function DeviceReadings({ request, go }: { request: Request; go: (area: Area) => void }) {
  const activeTab = useSectionTabActive();
  const [assets, setAssets] = useState<DevicesResponse | null>(null);
  const [readError, setReadError] = useState('');
  const [refreshing, setRefreshing] = useState(true);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    setRefreshing(true);
    try {
      const next = await request<DevicesResponse>('/api/assets?area=devices');
      if (current === revision.current) { setAssets(next); setReadError(''); }
    } catch (cause) {
      if (current === revision.current) setReadError(cause instanceof Error ? cause.message : 'Home devices unavailable.');
    } finally {
      if (current === revision.current) setRefreshing(false);
    }
  }, [request]);
  useEffect(() => {
    const visibleRefresh = () => { if (activeTab && document.visibilityState === 'visible') void refresh(); };
    const initial = setTimeout(visibleRefresh, 0);
    const interval = setInterval(visibleRefresh, 60_000);
    document.addEventListener('visibilitychange', visibleRefresh);
    // Invalidate in-flight reads on unmount; a helper keeps the ref access out of the cleanup expression.
    const invalidate = () => { revision.current++; };
    return () => { invalidate(); clearTimeout(initial); clearInterval(interval); document.removeEventListener('visibilitychange', visibleRefresh); };
  }, [refresh, activeTab]);
  const solar = assets?.solar?.ok ? assets.solar.value : null;
  const validator = assets?.validator?.ok ? assets.validator.value : null;

  return (
    <section className="card assets devices" id="device-readings" tabIndex={-1}>
      <div className="assets-head"><div><span className="eyebrow">THINGS YOU RUN · READ-ONLY</span><h2>Home solar and validator</h2><p className="small-copy">Live public or sensor readings. Not counted in the priced subtotal. Connections are configured in Me.</p></div></div>
      {readError && <p className="note" role="status">Device refresh unavailable; {assets ? 'showing the last checked readings' : 'no reading confirmed yet'}. {readError} <button className="text-button" type="button" onClick={() => void refresh()}>Retry device readings</button></p>}
      {refreshing && <p className="small-copy" role="status">Checking device readings…</p>}
      <div className="asset-grid">
        <article className="asset-tile" id="solar-reading" tabIndex={-1}>
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
              <strong>{assets?.adapters.homeAssistant || assets?.homeAssistantPull === false ? '—' : assets ? 'Connect' : '—'}</strong>
              <span>{assets?.solar && !assets.solar.ok ? assets.solar.error : assets?.homeAssistantPull === false ? 'This host does not connect to Home Assistant. Run Ledger of Life on your own network to use it.' : assets?.adapters.homeAssistant ? 'Home Assistant reading unavailable.' : assets ? 'Read your solar production from Home Assistant.' : readError ? 'Home energy connection could not be checked.' : 'Checking Home Assistant…'}</span>
            </>
          )}
          <button className="text-button" onClick={() => goToSection(go, 'me', 'adapter-home-assistant')}>{assets?.adapters.homeAssistant ? 'Manage Home Assistant in Me' : assets?.homeAssistantPull === false ? 'About Home Assistant in Me' : 'Connect Home Assistant in Me'} →</button>
        </article>
        <article className="asset-tile" id="validator-reading" tabIndex={-1}>
          <header><Cpu size={18} /> Validator · public mainnet data · not your test money</header>
          <span className="small-copy">A public validator identifier does not prove you own this stake. This reading is outside your priced test-asset subtotal.</span>
          {validator ? (
            <>
              <strong>{validator.stake.toLocaleString('en-US', { maximumFractionDigits: 3 })} {validator.unit}</strong>
              <span>{({ active_ongoing: 'Active', voting: 'Active, voting', delinquent: 'Delinquent', pending_queued: 'In activation queue', exited_unslashed: 'Exited' } as Record<string, string>)[validator.status] ?? validator.status}{validator.commission !== undefined ? ` · ${validator.commission}% commission` : ''}</span>
              {validator.rewardsRecent !== null && <span className="asset-gain"><TrendingUp size={13} /> {validator.rewardsRecent} {validator.unit} {validator.rewardsLabel}</span>}
            </>
          ) : (
            <>
              <strong>{assets?.adapters.validator ? '—' : assets ? 'Connect' : '—'}</strong>
              <span>{assets?.validator && !assets.validator.ok ? assets.validator.error : assets?.adapters.validator ? 'Validator reading unavailable.' : assets ? 'Read a public validator’s stake and rewards; its identifier does not prove ownership.' : readError ? 'Validator connection could not be checked.' : 'Checking validator…'}</span>
            </>
          )}
          <button className="text-button" onClick={() => goToSection(go, 'me', 'adapter-validator')}>{assets?.adapters.validator ? 'Manage validator in Me' : 'Connect validator in Me'} →</button>
        </article>
      </div>
    </section>
  );
}
