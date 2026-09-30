import { LEDGER_ADAPTERS, type AdapterAction, type LedgerAdapter } from '../data/ledger-catalogue.ts';
import { adapterAction, adapterState, type DynamicHomeAction, type LedgerStateInputs } from './ledger-adapter-state.ts';

export interface SetupStep {
  adapter: LedgerAdapter;
  title: string;
  /** Optional steps never block "your ledger is set up". */
  optional: boolean;
  done: boolean;
  /** The read behind this step is running (a retry after the first load). Shown as "checking again", never as a task. */
  checking: boolean;
  /** The read behind this step failed, so nobody knows whether it is done. Shown as "could not check", never as a task. */
  checkFailed: boolean;
  /** The next step for this adapter given what the person has already done. */
  action: AdapterAction | DynamicHomeAction;
}

/**
 * Today's getting-started guide. It is not a second list: it is the adapters the catalogue marks `setup`,
 * in that order, each with the state and next action the Me directory already computes.
 */
export function setupSteps(inputs: LedgerStateInputs): SetupStep[] {
  return LEDGER_ADAPTERS.flatMap((adapter) => adapter.setup ? [{ adapter, ...adapter.setup }] : [])
    .sort((a, b) => a.order - b.order)
    .map(({ adapter, title, optional }) => {
      const state = adapterState(adapter, inputs);
      return {
        adapter, title, optional: Boolean(optional),
        done: state.configured,
        checking: Boolean(state.checking) && !state.configured,
        checkFailed: Boolean(state.checkFailed) && !state.configured,
        action: adapterAction(adapter, inputs),
      };
    });
}

/** The step to offer next: the first one that is genuinely still to do. A step being checked or that could not be checked is never it. */
export function nextSetupStep(steps: readonly SetupStep[]): SetupStep | undefined {
  return steps.find((step) => !step.done && !step.checkFailed && !step.checking);
}

/** True while any observation the guide depends on is still loading, so no step flashes as "to do". */
export function setupChecking(inputs: LedgerStateInputs) {
  return inputs.identityLoading || inputs.configLoading || inputs.cityLoading || inputs.homeLoading;
}
