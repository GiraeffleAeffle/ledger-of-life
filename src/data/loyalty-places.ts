/** Owner-reviewed public records only; no customer identity, balances or wallet data. */
export interface LoyaltyMerchant {
  id: string;
  city: string;
  name: string;
  coordinates: [number, number];
  source: string;
  program: { id: string; name: string };
  network: 'sepolia';
  checkedAt: string;
}
export interface LoyaltyPlaces {
  state: 'needs_hosting' | 'no_verified_shops' | 'ready';
  merchants: LoyaltyMerchant[];
  links: { signup: string; collect: string; exchange: string } | null;
}

/** Used by both the accessible merchant list and the actual optional map layer. */
export function loyaltyMapMerchants(result: LoyaltyPlaces | null, city: string, enabled: boolean): LoyaltyMerchant[] {
  return enabled && result?.state === 'ready' ? result.merchants.filter((merchant) => merchant.city === city) : [];
}
