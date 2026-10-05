export const BUILDING_RENT_SHARE_BPS = 2000 as const;
export const RENT_BUILDING_ID = 'demo-neighbourhood-homes' as const;
export const BUILDING_RENT_MEANING = "A fixed 20 % of this test rent goes to the fictional building's tHOME stakers; the rest goes to the landlord. This simulates how a tokenized building could share net rental income; in a real building rent goes to the property owner under the lease.";
export type RobinhoodBuildingRent = { network?: 'robinhood-testnet'; buildingId: typeof RENT_BUILDING_ID; shareBps: typeof BUILDING_RENT_SHARE_BPS; landlordWallet: string; house?: never };
export type SolanaBuildingRent = { network: 'solana-devnet'; shareBps: typeof BUILDING_RENT_SHARE_BPS; landlordWallet: string; house: string; buildingId?: never };
export type BuildingRent = RobinhoodBuildingRent | SolanaBuildingRent;
export type RentTerms = BuildingRent & { rentMonthly: string };
export function splitBuildingRent(rentMonthly: string) {
  if (!/^[1-9][0-9]*$/.test(rentMonthly) || BigInt(rentMonthly) > 10_000_000_000n) throw new Error('Use a positive monthly test rent up to 10,000 test dollars.');
  const rent = BigInt(rentMonthly), building = rent * BigInt(BUILDING_RENT_SHARE_BPS) / 10000n;
  return { buildingRaw: building.toString(), landlordRaw: (rent - building).toString() };
}
export function berlinRentMonth(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(new Date(now));
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
}

/** A confirmed payment only describes the current Berlin calendar month. */
export function paidRentMonth(view: { month: string; role: 'tenant' | 'landlord'; payment: { month: string; state: string } | null }) {
  if (view.payment?.state !== 'confirmed' || view.payment.month !== view.month) return null;
  const [year, month] = view.month.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  const label = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' }).format(date);
  const next = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' }).format(new Date(Date.UTC(year, month, 1)));
  return { heading: `Rent for ${label} ${view.role === 'tenant' ? 'paid' : 'received'}`, nextDue: `Rent for ${next} can be paid from 1 ${next}, Berlin time.` };
}
