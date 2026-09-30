export type SystemNodeId = 'resident' | 'enterprise' | 'work' | 'households' | 'housing' | 'builders' | 'public' | 'services' | 'wellbeing' | 'private-assets' | 'resources' | 'evidence' | 'feedback';
export type RelationMode = 'evidence' | 'proposed' | 'scenario';
export interface SystemNode { id: SystemNodeId; label: string; kind: 'person' | 'organization' | 'activity' | 'output' | 'outcome' | 'asset' | 'indicator'; capabilityIds: string[] }
export interface SystemRelation { from: SystemNodeId; to: SystemNodeId; label: string; mode: RelationMode }
export const SYSTEM_NODES: SystemNode[] = [
  { id: 'resident', label: 'Citizen capital', kind: 'person', capabilityIds: ['roles', 'local-investments'] },
  { id: 'enterprise', label: 'Local enterprise', kind: 'organization', capabilityIds: ['local-investments', 'home-tokens'] },
  { id: 'work', label: 'Wages & suppliers', kind: 'activity', capabilityIds: ['local-investments'] },
  { id: 'households', label: 'Households', kind: 'person', capabilityIds: ['timeline', 'welcome'] },
  { id: 'housing', label: 'Homes', kind: 'output', capabilityIds: ['home-tokens', 'service-charges'] },
  { id: 'builders', label: 'Local builders', kind: 'organization', capabilityIds: ['home-tokens'] },
  { id: 'public', label: 'Public budget', kind: 'organization', capabilityIds: ['budget', 'decisions'] },
  { id: 'services', label: 'Public services', kind: 'output', capabilityIds: ['budget', 'regional-shared-topics'] },
  { id: 'wellbeing', label: 'Quality of life', kind: 'outcome', capabilityIds: ['measurable', 'scales'] },
  { id: 'private-assets', label: 'Private assets & collateral', kind: 'asset', capabilityIds: ['stock-deposit', 'borrow-against-shares'] },
  { id: 'resources', label: 'Energy & devices', kind: 'asset', capabilityIds: ['devices'] },
  { id: 'evidence', label: 'Published evidence', kind: 'indicator', capabilityIds: ['city-news-feed'] },
  { id: 'feedback', label: 'What changed for me', kind: 'outcome', capabilityIds: ['today-cockpit'] },
];
export const SYSTEM_LOOP_IDS: readonly SystemNodeId[] = ['resident', 'enterprise', 'work', 'households', 'housing', 'builders', 'public', 'services', 'wellbeing'];
export const SYSTEM_RELATIONS: SystemRelation[] = [
  { from: 'resident', to: 'enterprise', label: 'may fund', mode: 'scenario' },
  { from: 'enterprise', to: 'work', label: 'allocates capacity', mode: 'scenario' },
  { from: 'work', to: 'households', label: 'may support', mode: 'scenario' },
  { from: 'households', to: 'housing', label: 'may need', mode: 'scenario' },
  { from: 'housing', to: 'builders', label: 'may commission', mode: 'scenario' },
  { from: 'builders', to: 'work', label: 'may purchase', mode: 'scenario' },
  { from: 'households', to: 'public', label: 'taxes allocated by law', mode: 'proposed' },
  { from: 'enterprise', to: 'public', label: 'trade tax less levy', mode: 'proposed' },
  { from: 'public', to: 'services', label: 'may fund', mode: 'scenario' },
  { from: 'services', to: 'wellbeing', label: 'effect requires measurement', mode: 'proposed' },
  { from: 'wellbeing', to: 'resident', label: 'may attract / retain', mode: 'scenario' },
  { from: 'wellbeing', to: 'enterprise', label: 'may support demand', mode: 'scenario' },
];
export interface ScenarioInputs {
  capital: number; wagesPercent: number; suppliersPercent: number; externalPercent: number;
  costPerJobYear: number; localReceipts: number; serviceCosts: number; redistribution: number;
}
export const DEFAULT_SCENARIO: ScenarioInputs = {
  capital: 100000, wagesPercent: 40, suppliersPercent: 25, externalPercent: 20,
  costPerJobYear: 50000, localReceipts: 6000, serviceCosts: 8500, redistribution: 1500,
};
export function scenarioAllocation(input: ScenarioInputs) {
  const reservePercent = 100 - input.wagesPercent - input.suppliersPercent - input.externalPercent;
  const wages = input.capital * input.wagesPercent / 100;
  const suppliers = input.capital * input.suppliersPercent / 100;
  const external = input.capital * input.externalPercent / 100;
  const reserve = input.capital - wages - suppliers - external;
  return {
    wages, suppliers, external, reserve, reservePercent,
    jobYears: wages / input.costPerJobYear,
    netLocal: input.localReceipts + input.redistribution - input.serviceCosts,
  };
}
