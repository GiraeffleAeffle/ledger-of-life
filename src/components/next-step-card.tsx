'use client';
import { ArrowRight } from 'lucide-react';
import { goToSection, type Area } from './areas';
import type { NextStep, NextStepTarget } from './next-step';
import './next-step-card.css';

/** A compact reminder linking to the area that owns the action. */
export function NextStepCard({ step, go }: { step: NextStep; go: (area: Area) => void }) {
  const open = (target: NextStepTarget) => (target.section ? goToSection(go, target.area, target.section) : go(target.area));
  return <section className="next-step-card" aria-label="Your next step" aria-live="polite">
    <p className="next-step-title">{step.title}</p>
    {step.detail && <p className="next-step-detail">{step.detail}</p>}
    {(step.action || step.choices?.length) && <div className="next-step-actions">
      {step.action && <button type="button" className="button primary" onClick={() => open(step.action!.target)}>
        {step.action.label} <ArrowRight size={16} aria-hidden="true" />
      </button>}
      {step.choices?.map((choice) => <button key={choice.label} type="button" className="button secondary" onClick={() => open(choice.target)}>
        {choice.label}
      </button>)}
    </div>}
  </section>;
}
