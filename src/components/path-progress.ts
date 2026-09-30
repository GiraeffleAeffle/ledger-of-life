/** How far a person is on the thread's four stages (src/data/path.ts), from what Today already reads. */
export type StageState = 'done' | 'in-progress' | 'todo' | 'unknown' | 'status';
export type PathProgress = { home: StageState; deposit: StageState; assets: StageState; city: StageState };

export type PathFacts = {
  homeLoading: boolean;
  /** A home or listing read failed; known records still count. */
  homeError: boolean;
  tenancies: readonly { stage: string }[];
  listings: readonly { relation: 'landlord' | 'applicant' | 'chosen' | null }[];
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
  const applied = facts.tenancies.length > 0 || facts.listings.some((listing) => listing.relation !== null);
  return {
    home: applied ? 'done' : homeUnknown ? 'unknown' : 'todo',
    deposit: facts.tenancies.some((tenancy) => SECURED.has(tenancy.stage)) ? 'done'
      : facts.tenancies.length > 0 ? 'in-progress' : homeUnknown ? 'unknown' : 'todo',
    assets: 'status',
    city: facts.cityChosen ? 'done' : facts.cityLoading || facts.cityError ? 'unknown' : 'todo',
  };
}
