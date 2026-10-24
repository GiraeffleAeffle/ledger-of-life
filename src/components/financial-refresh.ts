export const FINANCIAL_RECOVERY_CHECKS = 15;
export const FINANCIAL_RECOVERY_INTERVAL_MS = 4000;

type RefreshDemand = { explicit: boolean; eligibility: Set<() => boolean> };
let automaticEligibility: (() => boolean) | undefined;

/** Synchronous dispatch scope only: eligibility is captured by queues, never held across await. */
export function withAutomaticRefresh<T>(eligible: (() => boolean) | undefined, dispatch: () => T): T {
  const previous = automaticEligibility;
  automaticEligibility = eligible;
  try { return dispatch(); }
  finally { automaticEligibility = previous; }
}

function mergeDemand(demand: RefreshDemand) {
  if (!automaticEligibility) demand.explicit = true;
  else demand.eligibility.add(automaticEligibility);
}

function demandCanStart(demand: RefreshDemand) {
  if (demand.explicit) return true;
  for (const eligible of demand.eligibility) if (eligible()) return true;
  return false;
}

/** Join shared fetches, or invalidate them and coalesce a burst into one trailing fresh read. */
export function singleFlight<T, Args extends unknown[]>(read: (...args: Args) => Promise<T>) {
  let pending: Promise<T> | undefined;
  let pendingArgs: Args | undefined;
  let pendingDemand: RefreshDemand | undefined;
  let queued: { args: Args; demand: RefreshDemand; promise: Promise<T> } | undefined;
  const start = (args: Args, demand: RefreshDemand): Promise<T> => {
    pendingArgs = args;
    pendingDemand = demand;
    pending = Promise.resolve().then(() => {
      if (!demandCanStart(demand)) throw new Error('Automatic refresh paused because its view is inactive.');
      // Nested caller serializers inherit the eligibility of this automatic demand.
      return withAutomaticRefresh(demand.explicit ? undefined : () => demandCanStart(demand), () => read(...args));
    }).finally(() => { pending = undefined; pendingArgs = undefined; pendingDemand = undefined; });
    return pending;
  };
  const invalidate = (...args: Args): Promise<T> => {
    if (queued) { queued.args = args; mergeDemand(queued.demand); return queued.promise; }
    if (!pending) return run(...args);
    const demand: RefreshDemand = { explicit: false, eligibility: new Set() };
    mergeDemand(demand);
    const launch = () => {
      const next = queued!;
      queued = undefined;
      return start(next.args, next.demand);
    };
    queued = { args, demand, promise: pending.then(launch, launch) };
    return queued.promise;
  };
  const run = (...args: Args): Promise<T> => {
    if (queued) { mergeDemand(queued.demand); return queued.promise; }
    if (pending && pendingArgs && (args.length !== pendingArgs.length || args.some((arg, index) => !Object.is(arg, pendingArgs![index]))))
      return invalidate(...args);
    if (pending && pendingDemand) { mergeDemand(pendingDemand); return pending; }
    const demand: RefreshDemand = { explicit: false, eligibility: new Set() };
    mergeDemand(demand);
    return start(args, demand);
  };
  return Object.assign(run, { invalidate });
}

type RefreshEnvironment = {
  visible: () => boolean;
  later: (run: () => void, delay: number) => () => void;
  onVisible: (run: () => void) => () => void;
  onBalance: (run: (chain?: string) => void) => () => void;
};

/** Display reads have no clock cadence. Only a saved pending operation gets bounded checks. */
export function observeFinancialRefresh(read: () => Promise<unknown>, environment: RefreshEnvironment, options: {
  chain?: 'solana' | 'evm'; initial?: boolean; recovery?: { remaining: number }; intervalMs?: number;
}) {
  let stopped = false;
  let running = false;
  let dirty = false;
  let cancelTimer = () => {};
  const schedule = () => {
    cancelTimer();
    if (!stopped && environment.visible() && (options.recovery?.remaining ?? 0) > 0)
      cancelTimer = environment.later(() => { void update(true); }, options.intervalMs ?? FINANCIAL_RECOVERY_INTERVAL_MS);
  };
  const update = async (automatic = false) => {
    if (stopped || !environment.visible()) return;
    if (running) { if (!automatic) dirty = true; return; }
    if (automatic) {
      if (!options.recovery || options.recovery.remaining <= 0) return;
      options.recovery.remaining--;
    }
    cancelTimer();
    running = true;
    try { await read(); } catch { /* The read owner exposes errors; never infer a zero or failed receipt. */ }
    finally {
      running = false;
      if (dirty && !stopped && environment.visible()) {
        dirty = false;
        cancelTimer = environment.later(() => { void update(); }, 0);
      } else { dirty = false; schedule(); }
    }
  };
  const removeVisible = environment.onVisible(() => {
    cancelTimer();
    // Returning to a view is one explicit reading, not a renewed recovery allowance.
    if (environment.visible()) void update();
  });
  const removeBalance = environment.onBalance(chain => {
    // Completion events refresh displays; receipt polling already owns its saved identity.
    if (!options.recovery && (!options.chain || !chain || chain === options.chain)) void update();
  });
  if (options.initial !== false) cancelTimer = environment.later(() => { void update(); }, 0);
  else schedule();
  return () => { stopped = true; cancelTimer(); removeVisible(); removeBalance(); };
}
