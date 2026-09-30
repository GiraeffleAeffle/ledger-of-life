'use client';
import { useEffect, useState } from 'react';
import { History, KeyRound } from 'lucide-react';
import type { PlaceEntry } from '@/server/timeline';
import { WalletAccessPanel } from '@/wallets';
import type { TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import { citySlug, type CityResult } from '@/server/city';
import { IdentityStrip } from './identity';
import type { Area } from './areas';
import { RecoveryStepView, useRecoveryFlow } from './recovery-step';
import { useRecoveryRequired, type AuthorizedRequest } from './use-recovery';
import { useLedgerConnections } from './use-ledger-connections';
import { LedgerAdapters } from './ledger-adapters';
import { AdapterSettings } from './adapter-settings';
import type { LedgerStateInputs } from './ledger-adapter-state';

const emptyPlace = { city: '', from: '', to: '', note: '' };
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const STAGE_LABEL: Record<string, string> = {
  agreement: 'Agreement', space: 'Deposit space', deposit: 'Deposit', living: 'Living here', 'move-out': 'Move-out', paid: 'Paid out',
};

/** One source catalogue and one settings owner, alongside identity and private life history. */
export function MeArea({ request, tenancies, listings, homeState, go }: {
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
    selectedCity: Boolean(city?.cityId || (city?.source === 'chosen' && city?.name)),
    cityName: city?.name ?? '', cityLoading: !city && !cityError, cityError,
  };
  const memberships = [
    ...tenancies.map((t) => ({ key: t.agreementId, role: t.role, context: t.property })),
    ...listings.filter((l) => l.relation === 'landlord').map((l) => ({ key: l.id, role: 'landlord', context: l.title })),
    ...(city?.name && (city.available || city.cityId || city.source === 'chosen') ? [{ key: 'city', role: city.source === 'identity' ? 'city on identity' : 'chosen city', context: city.name }] : []),
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
      <section className="card account-settings" id="account-settings" tabIndex={-1}>
        <h2>Account, wallets &amp; recovery</h2>
        <AccountSettings request={request} />
      </section>
      <IdentityStrip request={request} status={connections.identity} loading={connections.identityLoading}
        readError={connections.identityError} onStatusChange={connections.updateIdentity} onRefresh={connections.refreshIdentity} />
      <LedgerAdapters inputs={inputs} go={go} />
      <AdapterSettings request={request} connection={connections.adapters} />

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

      <section className="card" id="life-timeline" tabIndex={-1}>
        <h2><History size={18} /> Life timeline</h2>
        <p className="small-copy">Private to your account. Tenancy records are recorded by this app; earlier places are your own statements. Choosing a city does not record a move or prove residence.</p>
        <ol className="life-timeline">
          {city?.cityId && (
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
          </form>
        )}
      </section>

    </div>
  );
}

function AccountSettings({ request }: { request: Request }) {
  const required = useRecoveryRequired();
  const { recovery, view } = useRecoveryFlow(request as AuthorizedRequest, required === true);
  return <div className="area-stack">
    <WalletAccessPanel recoveryProof={recovery.identity?.recoveryProof ?? undefined} />
    {required && <details className="card operation-section">
      <summary>Same-wallet recovery check · before your first tenancy wallet action</summary>
      <RecoveryStepView {...view} />
    </details>}
  </div>;
}
