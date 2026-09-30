import { REALITY, type RealityLevel } from '@/data/reality';
import './reality-chip.css';

/** How real one section is. Definitions remain available on touch and to assistive technology. */
export function RealityChips({ levels }: { levels: RealityLevel[] }) {
  return <div className="reality-levels">
    <ul className="reality-chips" aria-label="How real this is">
      {levels.map((level) => <li key={level} className={`reality-chip ${level}`} aria-label={`${REALITY[level].label}: ${REALITY[level].meaning}`}>{REALITY[level].label}</li>)}
    </ul>
    <details className="reality-meaning"><summary aria-label="What the labels mean"><span aria-hidden="true">i</span></summary>
      <dl>{levels.map((level) => <div key={level}><dt>{REALITY[level].label}</dt><dd>{REALITY[level].meaning}</dd></div>)}</dl>
    </details>
  </div>;
}
