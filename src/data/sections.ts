import type { Area } from '../components/areas';

/**
 * Static jump targets, one entry per working surface, mapped to the only area that renders it.
 * Dynamic targets (`tenancy-<id>`, `listing-<id>`, `service-charges-<id>`) stay Home-local and are not listed.
 * The `money-*` entries are the tabs of the Money area; the others are cards inside a tab or an area.
 * This module has no runtime imports so the placement invariants can be tested without the UI.
 */
export const SECTIONS = {
  'account-settings': 'me', 'identity-eudi': 'me', 'life-timeline': 'me', 'ledger-adapters': 'me',
  'adapter-home-assistant': 'me', 'adapter-validator': 'me',
  'home-tenancies': 'home', 'home-options': 'home', 'past-tenancies': 'home', 'deposit-options': 'home',
  'money-holdings': 'money', 'money-shares': 'money', 'money-stakes': 'money', 'money-devices': 'money',
  'money-overview': 'money', 'solana-holding': 'money', 'rental-deposit-holding': 'money', 'official-shares': 'money', 'fake-shares': 'money',
  'ownership-journey': 'money', 'share-workflows': 'money', 'local-investments': 'money', 'test-money': 'money',
  'device-readings': 'money', 'solar-reading': 'money', 'validator-reading': 'money', 'local-ai': 'money',
  'personal-map': 'places', 'selected-project': 'places', 'project-browser': 'places', 'followed-projects': 'places',
  'city-choice': 'places', 'city-system': 'places', 'city-news': 'places', 'regional-topics': 'places',
  'local-readings': 'places', 'community-discovery': 'places', 'public-decisions': 'places',
  'selected-capability': 'ideas', 'stock-deposit-illustration': 'ideas',
} as const satisfies Record<string, Area>;
export type SectionId = keyof typeof SECTIONS;
