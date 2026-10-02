import type { AdapterAction, LedgerAdapter } from '../data/ledger-catalogue';
import type { PublicAdapterConfig } from '../server/adapters';
import type { IdentityStatus } from '../server/eudi';

export type LedgerStateInputs = {
  accountReady: boolean;
  authenticated: boolean;
  solanaLinked: boolean;
  robinhoodLinked: boolean;
  identity: IdentityStatus | null;
  identityLoading: boolean;
  identityError: string;
  config: PublicAdapterConfig | null;
  homeAssistantPull?: boolean;
  configLoading: boolean;
  configError: string;
  homeLoading: boolean;
  homeError: string;
  tenancyCount: number;
  listingCount?: number;
  serviceChargeTarget?: `service-charges-${string}`;
  cityId: string;
  selectedCity?: boolean;
  cityName: string;
  cityLoading: boolean;
  cityError: string;
};
/**
 * `checking`: the app is reading this right now (first load or a retry). `checkFailed`: the read failed, so the app does
 * not know whether it is done. Neither is ever a task for the person.
 */
export type AdapterState = { label: string; tone: 'ready' | 'setup' | 'unknown' | 'planned'; configured: boolean; checking?: boolean; checkFailed?: boolean };

/** Maturity, configuration and provider health are intentionally different facts. */
export function adapterState(adapter: LedgerAdapter, input: LedgerStateInputs): AdapterState {
  if (adapter.connection === 'future') return {
    label: adapter.maturity === 'illustration' ? 'Explore an illustration' : 'On the roadmap',
    tone: 'planned', configured: false,
  };
  // The model runs on the operator's host, which this directory never probes; "available" would be a guess.
  if (adapter.connection === 'host') return { label: 'Depends on the operator’s host', tone: 'unknown', configured: false };
  if (adapter.connection === 'homeAssistant' || adapter.connection === 'validator') {
    if (input.configLoading) return { label: 'Checking configuration…', tone: 'unknown', configured: false, checking: true };
    if (input.configError || !input.config) return { label: 'Configuration unavailable', tone: 'unknown', configured: false, checkFailed: true };
    const configured = Boolean(input.config[adapter.connection]);
    return adapter.connection === 'homeAssistant' && input.homeAssistantPull === false
      ? { label: configured ? 'Saved · unavailable on this host' : 'Unavailable on this host', tone: 'unknown', configured }
      : { label: configured ? 'Configured' : 'Can connect', tone: configured ? 'ready' : 'setup', configured };
  }
  if (adapter.connection === 'eudi') {
    if (input.identityLoading) return { label: 'Checking proof…', tone: 'unknown', configured: false, checking: true };
    if (input.identityError || !input.identity) return { label: 'Proof status unavailable', tone: 'unknown', configured: false, checkFailed: true };
    if (input.identity.state === 'verified') return { label: 'Test adult proof verified', tone: 'ready', configured: true };
    return { label: input.identity.state === 'pending' ? 'Verification in progress' : 'Optional proof to add', tone: 'setup', configured: false };
  }
  if (adapter.connection === 'account') return !input.accountReady
    ? { label: 'Checking account…', tone: 'unknown', configured: false, checking: true }
    : { label: input.authenticated ? 'Signed in' : 'Sign in required', tone: input.authenticated ? 'ready' : 'setup', configured: input.authenticated };
  if (adapter.connection === 'solana' || adapter.connection === 'robinhood') {
    if (!input.accountReady) return { label: 'Checking wallet…', tone: 'unknown', configured: false, checking: true };
    const linked = adapter.connection === 'solana' ? input.solanaLinked : input.robinhoodLinked;
    return { label: linked ? 'Wallet linked' : 'Wallet setup needed', tone: linked ? 'ready' : 'setup', configured: linked };
  }
  if (adapter.connection === 'tenancy') {
    const progress = input.tenancyCount > 0 || (input.listingCount ?? 0) > 0;
    const label = input.tenancyCount ? `${input.tenancyCount} ${input.tenancyCount === 1 ? 'tenancy' : 'tenancies'}`
      : input.listingCount ? `${input.listingCount} ${input.listingCount === 1 ? 'listing or application' : 'listings or applications'}` : 'Start with a home';
    if (input.homeError) return { label: progress ? `${label} · some readings unavailable` : 'Home could not be checked', tone: 'unknown', configured: progress, checkFailed: !progress };
    if (input.homeLoading) return { label: 'Checking Home…', tone: 'unknown', configured: false, checking: true };
    return { label, tone: progress ? 'ready' : 'setup', configured: progress };
  }
  if (adapter.connection === 'city') {
    if (input.selectedCity || input.cityName) return { label: 'City known', tone: 'ready', configured: true };
    if (input.cityLoading) return { label: 'Checking city…', tone: 'unknown', configured: false, checking: true };
    if (input.cityError) return { label: 'City/source check unavailable', tone: 'unknown', configured: false, checkFailed: true };
    return { label: 'Choose a city', tone: 'setup', configured: false };
  }
  return { label: 'Available in your account', tone: 'ready', configured: true };
}

/** A jump into one tenancy's own service-charge card; its id is dynamic, so it is not in `SECTIONS`. */
export type DynamicHomeAction = { kind: 'area'; area: 'home'; section: `service-charges-${string}`; label: string };

/** The contextual destination for a connection in Me's directory. */
export function adapterAction(adapter: LedgerAdapter, inputs: LedgerStateInputs): AdapterAction | DynamicHomeAction {
  if (adapter.settings && !adapterState(adapter, inputs).configured)
    return { kind: 'area', area: 'me', section: adapter.settings, label: inputs.configError ? 'Check configuration' : adapter.connection === 'homeAssistant' && inputs.homeAssistantPull === false ? 'About Home Assistant on this host' : `Connect ${adapter.id === 'homeAssistant' ? 'Home Assistant' : 'validator'}` };
  if ((adapter.connection === 'solana' && !inputs.solanaLinked) || (adapter.connection === 'robinhood' && !inputs.robinhoodLinked))
    return { kind: 'area', area: 'me', section: 'account-settings', label: 'Set up my wallet' };
  if (adapter.connection === 'tenancy' && !inputs.homeLoading && !inputs.homeError && !inputs.tenancyCount && !inputs.listingCount)
    return { kind: 'area', area: 'home', section: 'home-options', label: 'Find or add a home' };
  if (adapter.id === 'service-charges') return inputs.serviceChargeTarget
    ? { kind: 'area', area: 'home', section: inputs.serviceChargeTarget, label: 'Open this home’s service charges' }
    : { kind: 'area', area: 'home', section: 'home-tenancies', label: 'Open tenancy details' };
  // While the city could not be read, "choose my city" would ask for something the person may already have done.
  if (adapter.connection === 'city' && !inputs.selectedCity && !inputs.cityName && !inputs.cityLoading && !inputs.cityError)
    return { kind: 'area', area: 'places', section: 'city-choice', label: 'Choose my city' };
  return adapter.action;
}
