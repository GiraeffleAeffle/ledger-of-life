'use client';
import { useEffect, useState } from 'react';
import { Building2, Cpu, History, KeyRound, Link2, Sun, Wallet } from 'lucide-react';
import type { PlaceEntry } from '@/server/timeline';
import { useRentalWallet } from '@/wallets';
import type { TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import type { PublicAdapterConfig } from '@/server/adapters';
import type { CityResult } from '@/server/city';
import { IdentityStrip } from './identity';
import type { Area } from './areas';


const emptyPlace = { city: '', from: '', to: '', note: '' };
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const STAGE_LABEL: Record<string, string> = {
  agreement: 'Agreement', space: 'Deposit space', deposit: 'Deposit', living: 'Living here', 'move-out': 'Move-out', paid: 'Paid out',
};

/** Me: identity, roles, life timeline and every connection with how real it is. */
export function MeArea({ request, tenancies, listings, go, openConnections }: {
  request: Request; tenancies: TenancyJourney[]; listings: PublicListing[]; go: (area: Area) => void; openConnections: () => void;
}) {
  const wallet = useRentalWallet();
  const [adapters, setAdapters] = useState<PublicAdapterConfig | null>(null);
  const [city, setCity] = useState<CityResult | null>(null);
  const [places, setPlaces] = useState<PlaceEntry[]>([]);
  const [placeForm, setPlaceForm] = useState(emptyPlace);
  const [placeError, setPlaceError] = useState('');
  const [savingPlace, setSavingPlace] = useState(false);
  const [addingPlace, setAddingPlace] = useState(false);
  useEffect(() => {
    let active = true;
    request<{ adapters: PublicAdapterConfig }>('/api/assets').then((r) => active && setAdapters(r.adapters)).catch(() => {});
    request<{ city: CityResult }>('/api/city').then((r) => active && setCity(r.city)).catch(() => {});
    request<{ places: PlaceEntry[] }>('/api/timeline').then((r) => active && setPlaces(r.places)).catch(() => {});
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
    { icon: Building2, name: 'City sources', state: city?.available ? city.name : city && 'name' in city && city.name ? city.name : 'No city chosen', level: 'Read-only public data', area: 'places' as Area },
  ];
  const memberships = [
    ...tenancies.map((t) => ({ key: t.agreementId, role: t.role, context: t.property })),
    ...listings.filter((l) => l.relation === 'landlord').map((l) => ({ key: l.id, role: 'landlord', context: l.title })),
    ...(city?.available ? [{ key: 'city', role: city.source === 'identity' ? 'city on identity' : 'chosen city', context: city.name }] : []),
  ];

  async function submitPlace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPlaceError('');
    setSavingPlace(true);
    try {
      const response = await request<{ places: PlaceEntry[] }>('/api/timeline', { action: 'add', ...placeForm });
      setPlaces(response.places);
      setPlaceForm(emptyPlace);
      setAddingPlace(false);
    } catch (error) {
      setPlaceError(error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setSavingPlace(false);
    }
  }

  async function deletePlace(id: string) {
    try {
      const response = await request<{ places: PlaceEntry[] }>('/api/timeline', { action: 'remove', id });
      setPlaces(response.places);
    } catch (error) {
      setPlaceError(error instanceof Error ? error.message : 'Please try again.');
    }
  }

  return (
    <div className="area-stack">
      <IdentityStrip request={request} />

      {memberships.length > 0 && (
        <section className="card">
          <h2><KeyRound size={18} /> Your roles</h2>
          <ul className="membership-list">
            {memberships.map((membership) => (
              <li key={membership.key}>
                <strong>{membership.role[0].toUpperCase() + membership.role.slice(1)}</strong> · {membership.context}
              </li>
            ))}
          </ul>
        </section>
      )}

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
          {places.toSorted((a, b) => b.to.localeCompare(a.to) || b.from.localeCompare(a.from)).map((place) => (
            <li key={place.id}>
              <strong>{place.city} · {place.from}–{place.to}</strong>
              <span>Your own statement{place.note ? ` · ${place.note}` : ''}</span>
              <button className="text-button" type="button" onClick={() => deletePlace(place.id)}>Remove</button>
            </li>
          ))}
        </ol>
        {!addingPlace ? (
          <button className="text-button" type="button" onClick={() => setAddingPlace(true)}>Add an earlier place</button>
        ) : (
          <form className="inline-form place-form" onSubmit={submitPlace}>
            <label>City<input required maxLength={80} value={placeForm.city} onChange={(event) => setPlaceForm({ ...placeForm, city: event.target.value })} /></label>
            <label>From<input required pattern="[0-9]{4}(-[0-9]{2})?" placeholder="YYYY or YYYY-MM" value={placeForm.from} onChange={(event) => setPlaceForm({ ...placeForm, from: event.target.value })} /></label>
            <label>To<input required pattern="[0-9]{4}(-[0-9]{2})?" placeholder="YYYY or YYYY-MM" value={placeForm.to} onChange={(event) => setPlaceForm({ ...placeForm, to: event.target.value })} /></label>
            <label>Note (optional)<input maxLength={140} value={placeForm.note} onChange={(event) => setPlaceForm({ ...placeForm, note: event.target.value })} /></label>
            {placeError && <span role="alert">{placeError}</span>}
            <div className="button-row">
              <button className="button primary" type="submit" disabled={savingPlace}>{savingPlace ? 'Adding…' : 'Add place'}</button>
              <button className="text-button" type="button" onClick={() => { setAddingPlace(false); setPlaceForm(emptyPlace); setPlaceError(''); }}>Cancel</button>
            </div>
            <span className="small-copy">Later, an EU wallet residence attestation could prove a place you lived.</span>
          </form>
        )}
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
