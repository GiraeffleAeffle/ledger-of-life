export interface HostScenario {
  hardwareEuro: number;
  amortizationMonths: number;
  averageWatts: number;
  hoursPerDay: number;
  electricityEuroPerKwh: number;
  otherMonthlyEuro: number;
  priceEuroPerAnswer: number;
  paidAnswersPerDay: number;
  freeAnswersPerDay: number;
}
export const DEFAULT_HOST_SCENARIO: HostScenario = {
  hardwareEuro: 1000, amortizationMonths: 36, averageWatts: 250, hoursPerDay: 8,
  electricityEuroPerKwh: 0.30, otherMonthlyEuro: 10, priceEuroPerAnswer: 0.01,
  paidAnswersPerDay: 100, freeAnswersPerDay: 50,
};
/** Planning in euros, deliberately separate from the actual test-token receipt ledger. */
export function hostEconomics(input: HostScenario, measuredWallMs: number | null) {
  if (Object.values(input).some((value) => !Number.isFinite(value) || value < 0) ||
      input.amortizationMonths < 1 || input.hoursPerDay > 24 ||
      !Number.isInteger(input.paidAnswersPerDay) || !Number.isInteger(input.freeAnswersPerDay)) return null;
  const days = 30;
  const electricityKwh = input.averageWatts / 1000 * input.hoursPerDay * days;
  const electricityEuro = electricityKwh * input.electricityEuroPerKwh;
  const hardwareEuro = input.hardwareEuro / input.amortizationMonths;
  const costsEuro = electricityEuro + hardwareEuro + input.otherMonthlyEuro;
  const grossEuro = input.paidAnswersPerDay * days * input.priceEuroPerAnswer;
  const answersPerDay = input.paidAnswersPerDay + input.freeAnswersPerDay;
  const computeHoursPerDay = measuredWallMs !== null && Number.isFinite(measuredWallMs) && measuredWallMs > 0
    ? answersPerDay * measuredWallMs / 3_600_000 : null;
  return {
    electricityKwh, electricityEuro, hardwareEuro, costsEuro, grossEuro, marginEuro: grossEuro - costsEuro,
    breakEvenPaidAnswersPerDay: input.priceEuroPerAnswer > 0 ? Math.ceil(costsEuro / (days * input.priceEuroPerAnswer)) : null,
    computeHoursPerDay,
    exceedsObservedCapacity: computeHoursPerDay === null ? null : computeHoursPerDay > input.hoursPerDay,
    allocatedCostEuroPerAnswer: answersPerDay > 0 ? costsEuro / (answersPerDay * days) : null,
  };
}
