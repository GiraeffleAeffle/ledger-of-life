import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/errors.ts';
import { getAgreement } from './agreements.ts';
import { HOME_ASSISTANT_UNAVAILABLE_MESSAGE, homeAssistantPullAllowed, readHomeEnergy, type AdapterConfig } from './adapters.ts';
import type { Store } from './store.ts';
import { AccessError } from './errors.ts';

const EXAMPLE_WEEK_KWH = [5.8, 6.2, 6.4, 6.1, 5.9, 6.6, 6.4];
const DEFAULT_PREPAYMENT_CENTS = 15000;
const key = (agreementId: string) => `service-charges:${agreementId}`;

export interface ServiceChargeView {
  agreementId: string;
  property: string;
  role: 'tenant' | 'landlord' | 'arbitrator';
  prepaymentCents: number;
  consumption: {
    dailyKwh: number;
    source: 'home_assistant' | 'example';
    sensor: string | null;
    exampleWeekKwh: number[] | null;
    solarTodayKwh: number | null;
    adapterUnavailable: boolean;
    adapterUnavailableReason: string | null;
  };
  items: { name: string; annualBuildingCents: number; allocation: string; annualShareCents: number }[];
  estimatedMonthlyCostCents: number;
  balanceCents: number;
  projectedReleaseCents: number;
}

/** A prototype statement, never an invoice: only the demo prepayment is stored. */
export async function readServiceCharges(
  store: Store,
  identity: VerifiedIdentity,
  agreementId: string,
  energyReader: typeof readHomeEnergy = readHomeEnergy,
): Promise<ServiceChargeView> {
  const agreement = await getAgreement(store, agreementId, identity);
  const saved = await store.get<{ prepaymentCents: number }>(key(agreementId));
  const config = (await store.get<AdapterConfig>(`adapters:${identity.subject}`))?.homeAssistant;
  const reading = config && homeAssistantPullAllowed() ? await energyReader(config).catch(() => null) : null;
  const realConsumption = reading?.consumptionTodayKwh !== null && reading?.consumptionTodayKwh !== undefined
    && Number.isFinite(reading.consumptionTodayKwh) && reading.consumptionTodayKwh <= 200;
  const dailyKwh = realConsumption ? reading.consumptionTodayKwh! : 6.2;
  const items = [
    { name: 'Heating', annualBuildingCents: 720000, allocation: 'm² · 55 of 480 example m²', annualShareCents: Math.round(720000 * 55 / 480) },
    { name: 'Water & cleaning', annualBuildingCents: 180000, allocation: 'Units · 1 of 6 example homes', annualShareCents: 180000 / 6 },
    { name: 'Electricity', annualBuildingCents: 240000, allocation: `Consumption · ${dailyKwh.toFixed(2)} of 36 example kWh/day`, annualShareCents: Math.round(240000 * dailyKwh / 36) },
  ];
  const estimatedMonthlyCostCents = Math.round(items.reduce((sum, item) => sum + item.annualShareCents, 0) / 12);
  const prepaymentCents = saved?.prepaymentCents ?? DEFAULT_PREPAYMENT_CENTS;
  const balanceCents = prepaymentCents - estimatedMonthlyCostCents;
  return {
    agreementId, property: agreement.property, role: agreement.role, prepaymentCents,
    consumption: {
      dailyKwh, source: realConsumption ? 'home_assistant' : 'example',
      sensor: realConsumption ? reading!.consumptionEntity : null,
      exampleWeekKwh: realConsumption ? null : EXAMPLE_WEEK_KWH,
      solarTodayKwh: reading?.solarTodayKwh ?? null,
      adapterUnavailable: Boolean(config && !reading),
      adapterUnavailableReason: config && !homeAssistantPullAllowed() ? HOME_ASSISTANT_UNAVAILABLE_MESSAGE : null,
    },
    items, estimatedMonthlyCostCents, balanceCents, projectedReleaseCents: Math.max(0, balanceCents),
  };
}

/** The agreement's recorded landlord alone may edit this test prepayment. No funds move. */
export async function saveServiceChargePrepayment(store: Store, identity: VerifiedIdentity, agreementId: string, prepaymentCents: number) {
  const agreement = await getAgreement(store, agreementId, identity);
  if (agreement.role !== 'landlord') throw new AccessError('Only this tenancy’s landlord can set the test prepayment.');
  if (!Number.isSafeInteger(prepaymentCents) || prepaymentCents < 0 || prepaymentCents > 100000)
    throw new WorkflowError('Enter a monthly test prepayment between €0 and €1,000.');
  const record = { prepaymentCents };
  if (await store.get(key(agreementId))) await store.update(key(agreementId), () => record);
  else await store.create(key(agreementId), record);
  return readServiceCharges(store, identity, agreementId);
}
