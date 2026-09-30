'use client';
import { Check } from 'lucide-react';
import { STAGES, type StageId } from '@/data/path';
import { goToSection, type Area } from './areas';
import type { PathProgress, StageState } from './path-progress';
import './path-strip.css';

const STATE_LABEL: Record<StageState, string> = {
  done: 'Done', 'in-progress': 'In progress', todo: 'To do', unknown: 'Not known yet', status: 'See your status',
};

/** Where each stage is operated; a finished city stage opens its news rather than the chooser. */
function target(stage: StageId, state: StageState): { area: Area; section?: string } {
  if (stage === 'home') return { area: 'home', section: 'home-options' };
  if (stage === 'deposit') return { area: 'home', section: 'deposit-options' };
  if (stage === 'assets') return { area: 'money' };
  return { area: 'places', section: state === 'done' ? 'city-news' : 'city-choice' };
}

/** The four stages of the thread with this person's place on them. Links, not tasks: the next step leads. */
export function PathStrip({ progress, go }: { progress: PathProgress; go: (area: Area) => void }) {
  return <ol className="path-strip" aria-label="Your path">
    {STAGES.map((stage) => {
      const state = progress[stage.id];
      const where = target(stage.id, state);
      return <li key={stage.id} className={`path-stage ${state}`}>
        <button type="button" onClick={() => (where.section ? goToSection(go, where.area, where.section) : go(where.area))}>
          <span className="path-stage-mark" aria-hidden="true">{state === 'done' ? <Check size={14} /> : stage.number}</span>
          <span className="path-stage-copy"><strong>{stage.name}</strong><small>{STATE_LABEL[state]}</small></span>
        </button>
      </li>;
    })}
  </ol>;
}
