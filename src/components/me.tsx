'use client';
import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import type { PlaceEntry } from '@/server/timeline';
import { WalletAccessPanel } from '@/wallets';
import type { TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import { citySlug, type CityResult } from '@/server/city';
import { IdentityStrip } from './identity';
import type { Area } from './areas';
import { useLedgerConnections } from './use-ledger-connections';
import { LedgerAdapters } from './ledger-adapters';
import { AdapterSettings } from './adapter-settings';
import type { LedgerStateInputs } from './ledger-adapter-state';
import { MoreList, MoreRow, ScreenNote } from './blocks';

const emptyPlace = { city: '', from: '', to: '', note: '' };
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const STAGE_LABEL: Record<string, string> = {
  agreement: 'Agreement', space: 'Deposit space', deposit: 'Deposit', living: 'Living here', 'move-out': 'Move-out', paid: 'Paid out',
};

/** One source catalogue and one settings owner, alongside identity and private life history. */
export function MeArea({ request, tenancies, homeState, go }: {
  request: Request; tenancies: TenancyJourney[]; listings: PublicListing[];
  homeState: Pick<LedgerStateInputs, 'homeLoading' | 'homeError' | 'tenancyCount' | 'listingCount'>; go: (area: Area) => void;
}) {
  const connections = useLedgerConnections(request);
  const [city, setCity] = useState<CityResult | null>(null);
  const [cityError, setCityError] = useState('');
  const [places, setPlaces] = useState<PlaceEntry[]>([]);
  const [placeForm, setPlaceForm] = useState(emptyPlace);
  const [placeError, setPlaceError] = useState('');
  const [savingPlace, setSavingPlace] = useState(false);
  const [addingPlace, setAddingPlace] = useState(false);
  useEffect(() => {
    let active = true;
    request<{ city: CityResult }>('/api/city').then((r) => { if (active) { setCity(r.city); setCityError(''); } })
      .catch((cause) => { if (active) setCityError(cause instanceof Error ? cause.message : 'Your city could not be checked.'); });
    request<{ places: PlaceEntry[] }>('/api/timeline').then((r) => active && setPlaces(r.places)).catch(() => {});
    return () => { active = false; };
  }, [request]);

  const livingTenancy = tenancies.find((item) => item.stage === 'living' && item.chain?.phase === 'active');
  const inputs: LedgerStateInputs = {
    ...connections.facts, ...homeState,
    serviceChargeTarget: livingTenancy ? `service-charges-${livingTenancy.agreementId}` : undefined,
    cityId: city?.cityId ?? (city?.name ? citySlug(city.name) : ''),
    selectedCity: Boolean(city?.name),
    cityName: city?.name ?? '', cityLoading: !city && !cityError, cityError,
  };

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
      <section className="card account-settings" id="account-settings" tabIndex={-1}>
        <WalletAccessPanel />
      </section>
      <section className="card" id="life-timeline" tabIndex={-1}>
        <h2><History size={18} /> Life timeline</h2>
        <p className="small-copy">Private to your account · earlier places are your own statements.</p>
        <ol className="life-timeline">
          {city?.name && <li><strong>Now · {city.name}</strong><span>{city.source === 'home' ? 'From your home' : city.source === 'identity' ? 'From your EU wallet' : 'Chosen by you · not proof of residence'}</span></li>}
          {tenancies.map((t) => <li key={t.agreementId}><strong>{t.property}</strong><span>{STAGE_LABEL[t.stage] ?? t.stage} · {t.role} · recorded by this app</span></li>)}
        </ol>
        {(homeState.homeError || cityError) && <p className="small-copy" role="status">Home could not be checked.</p>}
        {!city?.name && tenancies.length === 0 && !homeState.homeLoading && !homeState.homeError && city !== null && !cityError && <p className="small-copy">No home recorded yet.</p>}
      </section>


      <MoreList>
      <MoreRow title="Earlier places" meta={`${places.length} recorded · add or remove a place`}>
        <ol className="life-timeline">
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
          </form>
        )}
      </MoreRow>
      </MoreList>
      <LedgerAdapters inputs={inputs} go={go} controls={{
        eudi: <IdentityStrip request={request} status={connections.identity} loading={connections.identityLoading}
          readError={connections.identityError} onStatusChange={connections.updateIdentity} onRefresh={connections.refreshIdentity} homeCity={city?.source === 'home'} />,
        homeAssistant: <AdapterSettings kind="homeAssistant" request={request} connection={connections.adapters} go={go} />,
        validator: <AdapterSettings kind="validator" request={request} connection={connections.adapters} go={go} />,
      }} />
      <ScreenNote>EU wallet proofs use test credentials, not a real identity check. Connection permissions are shown before you connect.</ScreenNote>
    </div>
  );
}
