import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { Store } from './store.ts';
import type { Listing } from './listings.ts';
import { agreementRole, type Agreement } from './agreements.ts';
import { identityStatus } from './eudi.ts';
import { readCity, type CityResult } from './city.ts';
import { homeCityId } from '../components/city-coverage.ts';
import { readSignalsCatalogue } from './city-signals.ts';

/** A rented-out or arbitrated property never supplies the person's home city. */
export async function personCity(store: Store, identity: VerifiedIdentity): Promise<CityResult> {
  const [agreementRows, rows, status] = await Promise.all([
    store.scan<Agreement>('agreement:', '', 200), store.scan<Listing>('listing:', '', 200), identityStatus(store, identity),
  ]);
  // City inference is a record read, not a chain journey: no escrow services are needed.
  const agreement = agreementRows.map((row) => row.value)
    .filter((item) => !item.cancelled && item.parties.tenant?.subject === identity.subject &&
      (item.network === 'solana' || item.depositForm?.kind === 'shares') && item.home?.city && agreementRole(item, identity) === 'tenant')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const listings = rows.map((row) => row.value).filter((item) => item.landlord.subject !== identity.subject && item.status !== 'closed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const listing = listings.find((item) => item.applications.some((application) => application.subject === identity.subject && application.id === item.chosenApplicationId))
    ?? listings.find((item) => item.status === 'open' && item.applications.some((application) => application.subject === identity.subject));
  const home = agreement?.home ? { ...agreement.home, title: agreement.property }
    : listing?.details.city ? { city: listing.details.city, title: listing.title, location: listing.location } : undefined;
  if (home) {
    let cityId = homeCityId(home.city);
    if (!cityId && home.location) {
      const { lat, lon } = home.location;
      const catalogue = await readSignalsCatalogue();
      cityId = catalogue.cities.find((city) => lon >= city.bbox[0] && lon <= city.bbox[2] && lat >= city.bbox[1] && lat <= city.bbox[3])?.id ?? null;
    }
    return readCity(store, identity, status.state === 'verified' ? status.statement.city : undefined, { ...home, cityId });
  }
  return readCity(store, identity, status.state === 'verified' ? status.statement.city : undefined);
}
