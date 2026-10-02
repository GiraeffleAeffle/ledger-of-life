import { REALITY, type RealityLevel } from '@/data/reality';
import './reality-chip.css';

/** How real one section is. Definitions remain available on touch and to assistive technology. */
export function RealityChips({ levels }: { levels: RealityLevel[] }) {
  return <div className="reality-levels">
    <ul className="reality-chips" aria-label="How real this is">
      {levels.map((level) => <li key={level} className={`reality-chip ${level}`} aria-label={`${REALITY[level].label}: ${REALITY[level].meaning}`}>{REALITY[level].label}</li>)}
    </ul>
  </div>;
}
