'use client';
import { useEffect, useState } from 'react';
import { Building2, Cpu, History, KeyRound, Link2, Sun, Wallet } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { TenancyJourney } from '@/server/journey';
import type { PublicAdapterConfig } from '@/server/adapters';
import type { CityResult } from '@/server/city';
import { IdentityStrip } from './identity';
import type { Area } from './areas';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const STAGE_LABEL: Record<string, string> = {
  agreement: 'Agreement', space: 'Deposit space', deposit: 'Deposit', living: 'Living here', 'move-out': 'Move-out', paid: 'Paid out',
};

/** Me: identity, roles, life timeline and every connection with how real it is. */
export function MeArea({ request, role, tenancies, onChangeRole, go, openConnections }: {
  request: Request; role: string; tenancies: TenancyJourney[]; onChangeRole: () => void; go: (area: Area) => void; openConnections: () => void;
}) {
  const wallet = useRentalWallet();
  const [adapters, setAdapters] = useState<PublicAdapterConfig | null>(null);
  const [city, setCity] = useState<CityResult | null>(null);
  useEffect(() => {
    let active = true;
    request<{ adapters: PublicAdapterConfig }>('/api/assets').then((r) => active && setAdapters(r.adapters)).catch(() => {});
    request<{ city: CityResult }>('/api/city').then((r) => active && setCity(r.city)).catch(() => {});
    return () => { active = false; };
  }, [request]);

  const solana = wallet.wallets.find((w) => w.chainType === 'solana');
  const evm = wallet.wallets.find((w) => w.chainType === 'ethereum');
  const short = (a?: string) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : 'not created yet');
  const connections = [
    { icon: Wallet, name: 'Solana wallet (devnet)', state: short(solana?.address), level: 'Test network' },
    { icon: Wallet, name: 'Robinhood Chain wallet (testnet)', state: short(evm?.address), level: 'Test network' },
    { icon: Sun, name: 'Home Assistant', state: adapters?.homeAssistant ? 'Connected' : 'Not connected', level: 'Read-only, live', area: 'home' as Area },
    { icon: Cpu, name: 'Validator', state: adapters?.validator ? `${adapters.validator.chain} · ${adapters.validator.id}` : 'Not connected', level: 'Read-only, live', area: 'money' as Area },
    { icon: Building2, name: 'Stadtstack atlas', state: city?.available ? city.name : city && 'name' in city && city.name ? city.name : 'No city chosen', level: 'Read-only, research preview', area: 'places' as Area },
  ];

  return (
    <div className="area-stack">
      <IdentityStrip request={request} />

      <section className="card">
        <h2><KeyRound size={18} /> Your roles</h2>
        <p>You use the app as <strong>{role}</strong>. In a tenancy your role comes from the agreement itself, not from this choice.</p>
        <button className="text-button" onClick={onChangeRole}>Change role</button>
      </section>

      <section className="card">
        <h2><History size={18} /> Life timeline</h2>
        <p className="small-copy">Private to you. Others only ever see derived facts, such as “all deposits returned”.</p>
        <ol className="life-timeline">
          {city?.available && (
            <li><strong>Now · {city.name}</strong><span>{city.source === 'identity' ? 'City from your EU wallet' : 'City you chose'}</span></li>
          )}
          {tenancies.map((t) => (
            <li key={t.agreementId}>
              <strong>{t.property}</strong>
              <span>Tenancy as {t.role} · {STAGE_LABEL[t.stage] ?? t.stage} · recorded by this app</span>
            </li>
          ))}
          <li className="planned"><strong>Earlier places</strong><span>Planned: add where you lived before (labeled as your own statement), later proven by a residence attestation.</span></li>
        </ol>
      </section>

      <section className="card">
        <h2><Link2 size={18} /> Connections</h2>
        <div className="connection-list">
          {connections.map((c) => (
            <div key={c.name} className="connection-row">
              <c.icon size={16} />
              <span><strong>{c.name}</strong> · {c.state}</span>
              <span className="connection-level">{c.level}</span>
              {c.area && <button className="text-button" onClick={() => go(c.area!)}>Manage</button>}
            </div>
          ))}
        </div>
        <button className="text-button" onClick={openConnections}>Connections & proof →</button>
      </section>
    </div>
  );
}
