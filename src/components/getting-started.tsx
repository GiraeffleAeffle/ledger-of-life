'use client';
import { Fragment, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { Area } from './areas';
import type { LedgerStateInputs } from './ledger-adapter-state';
import { activateAdapterAction } from './ledger-adapters';
import { RealityChips } from './reality-chip';
import { nextSetupStep, setupChecking, setupSteps } from './setup-steps';
import './getting-started.css';

const hiddenKey = (accountId: string) => `ledger-of-life:getting-started:v1:${accountId}`;
function readHidden(accountId: string) {
  try { return typeof window !== 'undefined' && localStorage.getItem(hiddenKey(accountId)) === '1'; } catch { return false; }
}

/**
 * The first thing a new person sees on Today: what this is, and the next few steps in order.
 * Each step is an adapter from the shared catalogue, so its explanation and reality level are the ones Me shows.
 * Hiding is remembered on this device per account and never affects any connection.
 * A step whose reading failed says so and offers `retry` when there is one; it is never offered as something to do.
 */
export function GettingStarted({ inputs, accountId, go, retry }: { inputs: LedgerStateInputs; accountId: string; go: (area: Area) => void; retry?: Partial<Record<string, () => void>> }) {
  const [hidden, setHidden] = useState(() => readHidden(accountId));
  const [settled, setSettled] = useState(false);
  if (!settled && !setupChecking(inputs)) setSettled(true);
  if (hidden || !settled) return null;
  const steps = setupSteps(inputs);
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) return null;
  const essentialsLeft = steps.some((step) => !step.done && !step.optional);
  const next = nextSetupStep(steps);
  function hide() {
    try { localStorage.setItem(hiddenKey(accountId), '1'); } catch { /* the guide still hides for this visit */ }
    setHidden(true);
  }
  return (
    <section className="getting-started" aria-label="Getting started">
      <header>
        <div className="getting-started-eyebrow-row">
          <span className="eyebrow">GETTING STARTED · {done} OF {steps.length} DONE</span>
          <button type="button" className="text-button" onClick={hide}>Hide this guide</button>
        </div>
        <h2>{essentialsLeft ? 'Set up your ledger' : 'Your ledger is set up. Optional next steps'}</h2>
        <p>Ledger of Life keeps your home, your money and your city in one place. The money features run on test networks with test tokens, so no real money moves.</p>
      </header>
      <ol>
        {steps.map((step, index) => {
          const retryStep = step.checkFailed || step.checking ? retry?.[step.adapter.id] : undefined;
          return (
            <Fragment key={step.adapter.id}>
            {step.optional && !steps[index - 1]?.optional && <li className="getting-started-optional-label" aria-hidden="true">Optional</li>}
            <li className={step.done ? 'done' : step.checkFailed || step.checking ? 'unchecked' : step === next ? 'next' : ''}>
              <span className="getting-started-mark" aria-hidden="true">{step.done ? <Check size={14} /> : index + 1}</span>
              <div className="getting-started-copy">
                <strong>{step.title}{step.optional && <em>optional</em>}<span className="sr-only">{step.done ? ' (done)' : ''}</span></strong>
                <p role="status" className={step.checking || step.checkFailed ? undefined : 'sr-only'}>
                  {step.checking ? 'Checking again…' : step.checkFailed ? 'We could not check this just now, so we do not know whether it is done.' : ''}
                </p>
                {step === next && <>
                  <p>{step.adapter.explain.brings}</p>
                  <div className="getting-started-meta"><span>{step.adapter.explain.effort}</span><RealityChips levels={[step.adapter.explain.reality]} /></div>
                </>}
              </div>
              {retryStep ? <button type="button" className="button secondary" aria-disabled={step.checking || undefined} onClick={() => { if (!step.checking) retryStep(); }}>Try again</button>
                : !step.done && !step.checking && (
                  <button type="button" className={step === next ? 'button primary' : 'button secondary'}
                    onClick={() => activateAdapterAction(step.action, go)}>{step.action.label} <ArrowRight size={15} /></button>
                )}
            </li>
            </Fragment>
          );
        })}
      </ol>
      <p className="small-copy getting-started-return">You can find these steps again in Me → Your adapters.</p>
    </section>
  );
}
