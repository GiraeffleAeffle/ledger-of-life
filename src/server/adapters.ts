import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/errors.ts';
import type { Store } from './store.ts';

/**
 * Read-only adapters for other things people own that earn: home solar via Home Assistant and a
 * staking validator. Credentials stay on the server; nothing here moves money or tokenizes assets.
 */
export interface AdapterConfig {
  homeAssistant?: { url: string; token: string; entity?: string; pricePerKwh: number };
  validator?: { chain: 'solana' | 'ethereum' | 'gnosis'; id: string };
}
export interface PublicAdapterConfig {
  homeAssistant?: { url: string; entity?: string; pricePerKwh: number };
  validator?: AdapterConfig['validator'];
}
const key = (subject: string) => `adapters:${subject}`;
export const HOME_ASSISTANT_UNAVAILABLE_MESSAGE = 'This host does not connect to Home Assistant. Run Ledger of Life on your own network to use it.';

export function homeAssistantPullAllowed(environment: Record<string, string | undefined> = process.env): boolean {
  return environment.VERCEL === undefined && (environment.NODE_ENV !== 'production' || environment.ALLOW_HOME_ASSISTANT_PULL === '1');
}

export async function readAdapterConfig(store: Store, identity: VerifiedIdentity): Promise<PublicAdapterConfig> {
  const config = (await store.get<AdapterConfig>(key(identity.subject))) ?? {};
  return {
    homeAssistant: config.homeAssistant && { url: config.homeAssistant.url, entity: config.homeAssistant.entity, pricePerKwh: config.homeAssistant.pricePerKwh },
    validator: config.validator,
  };
}

export async function saveAdapterConfig(store: Store, identity: VerifiedIdentity, input: Record<string, unknown>) {
  const recordKey = key(identity.subject);
  if (!(await store.get<AdapterConfig>(recordKey))) {
    try {
      await store.create<AdapterConfig>(recordKey, {});
    } catch (error) {
      // Another connection may have created this person's record concurrently.
      if (!(await store.get<AdapterConfig>(recordKey))) throw error;
    }
  }
  await store.update<AdapterConfig>(recordKey, (current) => {
    const next: AdapterConfig = { ...current };
    if (input.kind === 'homeAssistant') {
      if (input.remove === true) delete next.homeAssistant;
      else {
        if (!homeAssistantPullAllowed()) throw new WorkflowError(HOME_ASSISTANT_UNAVAILABLE_MESSAGE);
        let url: URL;
        try {
          url = new URL(String(input.url));
        } catch {
          throw new WorkflowError('Enter your Home Assistant address, e.g. http://homeassistant.local:8123');
        }
        if (!['http:', 'https:'].includes(url.protocol)) throw new WorkflowError('Use an http(s) address.');
        const token = typeof input.token === 'string' && input.token.length > 20 ? input.token : current.homeAssistant?.token;
        if (!token) throw new WorkflowError('Paste a long-lived access token (Profile → Security in Home Assistant).');
        const entity = typeof input.entity === 'string' && /^sensor\.[a-z0-9_]+$/.test(input.entity) ? input.entity : undefined;
        const price = Number(input.pricePerKwh ?? 0.3);
        next.homeAssistant = { url: url.origin, token, entity, pricePerKwh: Number.isFinite(price) && price > 0 && price < 5 ? price : 0.3 };
      }
    } else if (input.kind === 'validator') {
      if (input.remove === true) delete next.validator;
      else {
        const chain = input.chain === 'ethereum' || input.chain === 'gnosis' ? input.chain : 'solana';
        const id = String(input.id ?? '').trim();
        if (chain === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id) : !/^(\d{1,8}|0x[0-9a-fA-F]{96})$/.test(id))
          throw new WorkflowError(chain === 'solana' ? 'Enter your vote account address.' : 'Enter your validator index or public key.');
        next.validator = { chain, id };
      }
    } else throw new WorkflowError('Choose an adapter.');
    return next;
  });
  return readAdapterConfig(store, identity);
}

type HaState = { entity_id: string; state: string; attributes: { device_class?: string; unit_of_measurement?: string; friendly_name?: string; state_class?: string } };
export interface SolarReading {
  entity: string;
  name: string;
  energyTodayKwh: number | null;
  powerW: number | null;
  valueToday: number | null;
  /** True when valueToday is kWh × the entered tariff rather than the home's own savings sensor. */
  valueEstimated: boolean;
  /** From the home's own monetary sensors (e.g. inverter savings), when present. */
  savings: { today: number | null; month: number | null; year: number | null } | null;
  currency: string;
}

/**
 * Ordinary private home addresses are allowed for local runs; tailnet and mapped-private
 * addresses are not. This check is best effort, not a security boundary: fetch re-resolves DNS.
 * Production builds do not reach it without operator opt-in.
 */
async function assertReachableHost(origin: string) {
  const { lookup } = await import('node:dns/promises');
  const { hostname } = new URL(origin);
  const addresses = await lookup(hostname.replace(/^\[|\]$/g, ''), { all: true }).catch(() => []);
  if (!addresses.length) throw new WorkflowError('That Home Assistant address cannot be resolved from the server.');
  for (const { address } of addresses) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    const hi = mappedHex ? Number.parseInt(mappedHex[1], 16) : 0;
    const lo = mappedHex ? Number.parseInt(mappedHex[2], 16) : 0;
    const ip = mappedHex ? `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}` : mapped?.[1] ?? address;
    const linkLocal = /^169\.254\./.test(ip) || /^fe80:/i.test(ip) || ip === '100.100.100.200' || /^fd00:ec2::/i.test(ip);
    const privateNet = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(ip) || ip === '::1' || /^f[cd]/i.test(ip);
    const tailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
    if (linkLocal || tailnet || (privateNet && (process.env.VERCEL || mapped !== null || mappedHex !== null))) throw new WorkflowError('That Home Assistant address is not allowed from this server.');
  }
}
async function homeAssistantStates(config: NonNullable<AdapterConfig['homeAssistant']>): Promise<HaState[]> {
  if (!homeAssistantPullAllowed()) throw new WorkflowError(HOME_ASSISTANT_UNAVAILABLE_MESSAGE);
  await assertReachableHost(config.url);
  const response = await fetch(`${config.url}/api/states`, {
    headers: { Authorization: `Bearer ${config.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401) throw new Error('Home Assistant rejected the token.');
  if (!response.ok) throw new Error(`Home Assistant answered ${response.status}.`);
  return response.json();
}

/** Daily readings only: lifetime counters must never be presented as today's consumption. */
export async function readHomeEnergy(config: NonNullable<AdapterConfig['homeAssistant']>) {
  const states = await homeAssistantStates(config);
  const daily = (sensor: HaState) => sensor.attributes.device_class === 'energy'
    && /today|daily/i.test(`${sensor.entity_id} ${sensor.attributes.friendly_name ?? ''}`)
    && ['Wh', 'kWh'].includes(sensor.attributes.unit_of_measurement ?? '')
    && Number.isFinite(Number(sensor.state)) && Number(sensor.state) >= 0;
  const consumption = states.find((sensor) => daily(sensor) && /consumption|usage|used/i.test(`${sensor.entity_id} ${sensor.attributes.friendly_name ?? ''}`));
  const solar = states.find((sensor) => daily(sensor) && /solar|pv|photovoltaic/i.test(`${sensor.entity_id} ${sensor.attributes.friendly_name ?? ''}`));
  const kwh = (sensor: HaState | undefined) => sensor ? Number((Number(sensor.state) * (sensor.attributes.unit_of_measurement === 'Wh' ? 0.001 : 1)).toFixed(2)) : null;
  return { consumptionTodayKwh: kwh(consumption), consumptionEntity: consumption?.entity_id ?? null, solarTodayKwh: kwh(solar) };
}

export async function readSolar(config: NonNullable<AdapterConfig['homeAssistant']>): Promise<SolarReading> {
  const states = await homeAssistantStates(config);
  const solarish = (s: HaState) => /solar|pv|photovolt|inverter|yield|production/i.test(`${s.entity_id} ${s.attributes.friendly_name ?? ''}`);
  const numeric = (s: HaState) => Number.isFinite(Number(s.state));
  const energy = (config.entity ? states.find((s) => s.entity_id === config.entity) : undefined)
    // Only sensors that are clearly per-day; lifetime counters (total_increasing without a period) would read as "today".
    ?? states.find((s) => s.attributes.device_class === 'energy' && solarish(s) && /today|daily/i.test(s.entity_id) && numeric(s));
  const power = states.find((s) => s.attributes.device_class === 'power' && solarish(s) && numeric(s));
  if (!energy && !power) throw new Error('No solar sensor found. Enter the sensor ID (e.g. sensor.solar_energy_today).');
  let currency = 'EUR';
  const money = (period: RegExp) => {
    const sensor = states.find((s) => s.attributes.device_class === 'monetary' && solarish(s) && /saving|earning|revenue/i.test(s.entity_id) && period.test(s.entity_id) && numeric(s));
    if (sensor && /^[A-Z]{3}$/.test(sensor.attributes.unit_of_measurement ?? '')) currency = sensor.attributes.unit_of_measurement!;
    return sensor ? Number(Number(sensor.state).toFixed(2)) : null;
  };
  const savings = { today: money(/daily|today|24h/), month: money(/monthly|month/), year: money(/yearly|year/) };
  const kwh = energy ? Number(energy.state) * (energy.attributes.unit_of_measurement === 'Wh' ? 0.001 : 1) : null;
  const watts = power ? Number(power.state) * (power.attributes.unit_of_measurement === 'kW' ? 1000 : 1) : null;
  return {
    entity: energy?.entity_id ?? power!.entity_id,
    name: energy?.attributes.friendly_name ?? power?.attributes.friendly_name ?? 'Solar',
    energyTodayKwh: kwh === null ? null : Number(kwh.toFixed(2)),
    powerW: watts === null ? null : Math.round(watts),
    valueToday: savings.today ?? (kwh === null ? null : Number((kwh * config.pricePerKwh).toFixed(2))),
    valueEstimated: savings.today === null,
    savings: savings.today === null && savings.month === null && savings.year === null ? null : savings,
    currency,
  };
}

export interface ValidatorReading { chain: 'solana' | 'ethereum' | 'gnosis'; id: string; status: string; stake: number; unit: 'SOL' | 'ETH' | 'GNO'; rewardsRecent: number | null; rewardsLabel: string; commission?: number }

async function solanaRpc(method: string, params: unknown[]) {
  const response = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? 'Solana RPC error');
  return body.result;
}

export async function readValidator(config: NonNullable<AdapterConfig['validator']>): Promise<ValidatorReading> {
  if (config.chain === 'solana') {
    const accounts = await solanaRpc('getVoteAccounts', [{ votePubkey: config.id }]);
    const entry = [...accounts.current, ...accounts.delinquent].find((a: { votePubkey: string }) => a.votePubkey === config.id);
    if (!entry) throw new Error('Vote account not found on Solana mainnet.');
    const reward = (await solanaRpc('getInflationReward', [[config.id]]).catch(() => [null]))[0];
    return {
      chain: 'solana', id: config.id, status: accounts.current.includes(entry) ? 'voting' : 'delinquent',
      stake: entry.activatedStake / 1e9, unit: 'SOL', commission: entry.commission,
      rewardsRecent: reward ? reward.amount / 1e9 : null, rewardsLabel: reward ? `epoch ${reward.epoch} commission` : 'last epoch',
    };
  }
  // Gnosis counts stake in mGNO on its beacon chain: 32 mGNO = 1 GNO.
  const gnosis = config.chain === 'gnosis';
  const api = gnosis ? 'https://gnosis-beacon-api.publicnode.com' : 'https://ethereum-beacon-api.publicnode.com';
  const response = await fetch(`${api}/eth/v1/beacon/states/head/validators/${config.id}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Validator not found on the ${gnosis ? 'Gnosis' : 'Ethereum'} beacon chain.`);
  const { data } = await response.json();
  const scale = gnosis ? 1e9 * 32 : 1e9;
  const balance = Number(data.balance) / scale;
  const effective = Number(data.validator.effective_balance) / scale;
  return {
    chain: gnosis ? 'gnosis' : 'ethereum', id: String(data.index), status: data.status, stake: balance, unit: gnosis ? 'GNO' : 'ETH',
    // Pending rewards above the effective balance (swept to the withdrawal address periodically).
    rewardsRecent: Number(Math.max(0, balance - effective).toFixed(5)), rewardsLabel: 'unswept rewards',
  };
}
