import { EXPLAINER_CAPTIONS, SOLAR_REFERENCE } from '../data/topic-explainer.ts';

/** Illustration only: all generation is assumed eligible and exported, to one municipality. */
export function solarScenario(capacityMwp: number, operatorOffer: boolean) {
  const capacityKwp = capacityMwp * 1000;
  const annualKwh = capacityKwp * SOLAR_REFERENCE.annualKwhPerKwp;
  return {
    capacityKwp,
    annualKwh,
    annualMwh: annualKwh / 1000,
    householdEquivalents: annualKwh / SOLAR_REFERENCE.householdAnnualKwh,
    maximumGrossMunicipalEuro: operatorOffer ? annualKwh * SOLAR_REFERENCE.maximumEuroPerEligibleKwh : 0,
  };
}

export function nextExplainerCaption(index: number) {
  return Math.min(index + 1, EXPLAINER_CAPTIONS.length - 1);
}
