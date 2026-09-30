/** How far a person is on the thread's four stages (src/data/path.ts), from what Today already reads. */
export type StageState = 'done' | 'in-progress' | 'todo' | 'unknown' | 'status';
export type PathProgress = { home: StageState; deposit: StageState; assets: StageState; city: StageState };

export type PathFacts = {
  homeLoading: boolean;
  /** A home or listing read failed; known records still count. */
  homeError: boolean;
  tenancies: readonly { stage: string; next?: { kind: string } }[];
  listings: readonly { relation: 'landlord' | 'applicant' | 'chosen' | null; status?: string }[];
  /** An explicit choice, including an explicitly chosen uncovered place; a bare slug is not a choice. */
  cityChosen: boolean;
  cityLoading: boolean;
  cityError: boolean;
};

const SECURED = new Set(['living', 'move-out', 'paid']);

/**
 * Stage 1 is done once a listing, application or tenancy exists; stage 2 once a deposit is locked (living or
 * later); stage 3 is a status, never "done"; stage 4 once a city is chosen. Known progress always counts,
 * but a stage that could not be read, or is still being read, is "unknown", never "to do".
 */
export function pathProgress(facts: PathFacts): PathProgress {
  const homeUnknown = facts.homeLoading || facts.homeError;
  const tenancies = facts.tenancies.filter((tenancy) => tenancy.next?.kind !== 'cancelled');
  const applied = tenancies.length > 0 || facts.listings.some((listing) => listing.relation !== null && listing.status !== 'closed');
  return {
    home: applied ? 'done' : homeUnknown ? 'unknown' : 'todo',
    deposit: tenancies.some((tenancy) => SECURED.has(tenancy.stage)) ? 'done'
      : tenancies.length > 0 ? 'in-progress' : homeUnknown ? 'unknown' : 'todo',
    assets: 'status',
    city: facts.cityChosen ? 'done' : facts.cityLoading || facts.cityError ? 'unknown' : 'todo',
  };
}
