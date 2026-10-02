export type AgriPvInputs = {
  plantSizeMWp: number;
  annualProductionKWh: number;
  investmentEuro: number;
  electricityPriceEuroPerKWh: number;
  areaHectares: number;
  cropRevenueEuroPerHectare: number;
  operatingCostPercent: number;
  ticketEuro: number;
};

/** Calculator bounds, not engineering or investment guidance. Production is an independent input. */
export const AGRI_PV_INPUT_BOUNDS: Record<keyof AgriPvInputs, readonly [number, number]> = {
  plantSizeMWp: [0, 1_000],
  annualProductionKWh: [0, 2_000_000_000],
  investmentEuro: [1, 10_000_000_000],
  electricityPriceEuroPerKWh: [0, 1],
  areaHectares: [0, 100_000],
  cropRevenueEuroPerHectare: [0, 100_000],
  operatingCostPercent: [0, 100],
  ticketEuro: [0, 10_000_000_000],
};

export type AgriPvResult = {
  electricityRevenueEuro: number;
  cropRevenueEuro: number;
  operatingCostsEuro: number;
  netIncomeEuro: number;
  ticketFraction: number;
  ticketElectricityEuro: number;
  ticketCropEuro: number;
  ticketCostsEuro: number;
  ticketNetEuro: number;
  /** Simple annual net-income/ticket ratio; zero for a zero ticket, not an IRR. */
  simpleRatioPercent: number;
};

export function simulateAgriPv(inputs: AgriPvInputs): AgriPvResult {
  for (const key of Object.keys(AGRI_PV_INPUT_BOUNDS) as (keyof AgriPvInputs)[]) {
    const [min, max] = AGRI_PV_INPUT_BOUNDS[key];
    const value = inputs[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new RangeError(`${key} must be a finite number between ${min} and ${max}.`);
    }
  }
  if (inputs.ticketEuro > inputs.investmentEuro) throw new RangeError('Ticket cannot exceed the total investment.');
  const electricityRevenueEuro = inputs.annualProductionKWh * inputs.electricityPriceEuroPerKWh;
  const cropRevenueEuro = inputs.areaHectares * inputs.cropRevenueEuroPerHectare;
  const operatingCostsEuro = (electricityRevenueEuro + cropRevenueEuro) * inputs.operatingCostPercent / 100;
  const netIncomeEuro = electricityRevenueEuro + cropRevenueEuro - operatingCostsEuro;
  const ticketFraction = inputs.ticketEuro / inputs.investmentEuro;
  return {
    electricityRevenueEuro, cropRevenueEuro, operatingCostsEuro, netIncomeEuro, ticketFraction,
    ticketElectricityEuro: electricityRevenueEuro * ticketFraction,
    ticketCropEuro: cropRevenueEuro * ticketFraction,
    ticketCostsEuro: operatingCostsEuro * ticketFraction,
    ticketNetEuro: netIncomeEuro * ticketFraction,
    simpleRatioPercent: inputs.ticketEuro === 0 ? 0 : netIncomeEuro / inputs.investmentEuro * 100,
  };
}
