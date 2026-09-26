import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/workflow.ts';
import type { Store } from './store.ts';

/**
 * Read-only adapters for other things people own that earn: home solar via Home Assistant and a
 * staking validator. Credentials stay on the server; nothing here moves money or tokenizes assets.
 */
export interface AdapterConfig {
  homeAssistant?: { url: string; token: string; entity?: string; pricePerKwh: number };
  validator?: { chain: 'solana' | 'ethereum'; id: string };
}
export interface PublicAdapterConfig {
  homeAssistant?: { url: string; entity?: string; pricePerKwh: number };
  validator?: AdapterConfig['validator'];
}
const key = (subject: string) => `adapters:${subject}`;

export async function readAdapterConfig(store: Store, identity: VerifiedIdentity): Promise<PublicAdapterConfig> {
  const config = (await store.get<AdapterConfig>(key(identity.subject))) ?? {};
  return {
    homeAssistant: config.homeAssistant && { url: config.homeAssistant.url, entity: config.homeAssistant.entity, pricePerKwh: config.homeAssistant.pricePerKwh },
    validator: config.validator,
  };
}

export async function saveAdapterConfig(store: Store, identity: VerifiedIdentity, input: Record<string, unknown>) {
  const current = (await store.get<AdapterConfig>(key(identity.subject))) ?? {};
  const next: AdapterConfig = { ...current };
  if (input.kind === 'homeAssistant') {
    if (input.remove === true) delete next.homeAssistant;
    else {
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
      const chain = input.chain === 'ethereum' ? 'ethereum' : 'solana';
      const id = String(input.id ?? '').trim();
      if (chain === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id) : !/^(\d{1,8}|0x[0-9a-fA-F]{96})$/.test(id))
        throw new WorkflowError(chain === 'solana' ? 'Enter your vote account address.' : 'Enter your validator index or public key.');
      next.validator = { chain, id };
    }
  } else throw new WorkflowError('Choose an adapter.');
  await store.update<AdapterConfig>(key(identity.subject), () => next).catch(async () => store.create(key(identity.subject), next));
  return readAdapterConfig(store, identity);
}

type HaState = { entity_id: string; state: string; attributes: { device_class?: string; unit_of_measurement?: string; friendly_name?: string; state_class?: string } };
export interface SolarReading { entity: string; name: string; energyTodayKwh: number | null; powerW: number | null; valueToday: number | null; currency: 'EUR' }

export async function readSolar(config: NonNullable<AdapterConfig['homeAssistant']>): Promise<SolarReading> {
  const response = await fetch(`${config.url}/api/states`, {
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401) throw new Error('Home Assistant rejected the token.');
  if (!response.ok) throw new Error(`Home Assistant answered ${response.status}.`);
  const states: HaState[] = await response.json();
  const solarish = (s: HaState) => /solar|pv|photovolt|inverter|yield|production/i.test(`${s.entity_id} ${s.attributes.friendly_name ?? ''}`);
  const numeric = (s: HaState) => Number.isFinite(Number(s.state));
  const energy = (config.entity ? states.find((s) => s.entity_id === config.entity) : undefined)
    ?? states.find((s) => s.attributes.device_class === 'energy' && solarish(s) && /today|daily|day/i.test(s.entity_id) && numeric(s))
    ?? states.find((s) => s.attributes.device_class === 'energy' && solarish(s) && numeric(s));
  const power = states.find((s) => s.attributes.device_class === 'power' && solarish(s) && numeric(s));
  if (!energy && !power) throw new Error('No solar sensor found. Enter the sensor ID (e.g. sensor.solar_energy_today).');
  const kwh = energy ? Number(energy.state) * (energy.attributes.unit_of_measurement === 'Wh' ? 0.001 : 1) : null;
  const watts = power ? Number(power.state) * (power.attributes.unit_of_measurement === 'kW' ? 1000 : 1) : null;
  return {
    entity: energy?.entity_id ?? power!.entity_id,
    name: energy?.attributes.friendly_name ?? power?.attributes.friendly_name ?? 'Solar',
    energyTodayKwh: kwh === null ? null : Number(kwh.toFixed(2)),
    powerW: watts === null ? null : Math.round(watts),
    valueToday: kwh === null ? null : Number((kwh * config.pricePerKwh).toFixed(2)),
    currency: 'EUR',
  };
}

export interface ValidatorReading { chain: 'solana' | 'ethereum'; id: string; status: string; stake: number; unit: 'SOL' | 'ETH'; rewardsRecent: number | null; rewardsLabel: string; commission?: number }

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
  const response = await fetch(`https://ethereum-beacon-api.publicnode.com/eth/v1/beacon/states/head/validators/${config.id}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Validator not found on the Ethereum beacon chain.');
  const { data } = await response.json();
  const balance = Number(data.balance) / 1e9;
  const effective = Number(data.validator.effective_balance) / 1e9;
  return {
    chain: 'ethereum', id: String(data.index), status: data.status, stake: balance, unit: 'ETH',
    // Pending rewards above the effective balance (swept to the withdrawal address periodically).
    rewardsRecent: Number(Math.max(0, balance - effective).toFixed(5)), rewardsLabel: 'unswept rewards',
  };
}
