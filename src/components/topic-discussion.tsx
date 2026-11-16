'use client';

import { useId, useRef, useState } from 'react';
import { DISCUSSION_SIDES, DISCUSSION_THEMES, TOPIC_ARGUMENTS, type TopicArgument } from '../data/topic-discussion';
import { TOPIC_SOURCES } from '../data/topic-flow-demo';
import { discussionLayout, focusedArguments, moveSegmentIndex, sectorPath, segmentHighlighted, type DiscussionFocus } from './topic-discussion-model';
import './topic-discussion.css';

const SEGMENTS = discussionLayout();
export interface TopicDiscussionProps {
  initialArgumentId?: string;
  onArgumentSelect?: (id: string) => void;
  onSource?: (id: string) => void;
}

export function TopicDiscussion({ initialArgumentId, onArgumentSelect, onSource }: TopicDiscussionProps) {
  const headingId = useId();
  const [focus, setFocus] = useState<DiscussionFocus>(() => TOPIC_ARGUMENTS.some((argument) => argument.id === initialArgumentId) ? { kind: 'argument', id: initialArgumentId! } : null);
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const visible = focusedArguments(focus);
  const select = (next: DiscussionFocus) => {
    setFocus(next);
    if (next?.kind === 'argument') onArgumentSelect?.(next.id);
  };
  const focusLabel = focus ? SEGMENTS.find((segment) => segment.kind === focus.kind && segment.id === focus.id)?.label : 'Alle Perspektiven';

  function renderArgument(argument: TopicArgument) {
    const children = visible.filter((child) => child.parentId === argument.id);
    return <li key={argument.id} className={`b70-tree-item${focus?.id === argument.id ? ' b70-tree-selected' : ''}`}>
      <article>
        <button type="button" className="b70-tree-title" aria-pressed={focus?.kind === 'argument' && focus.id === argument.id} onClick={() => select({ kind: 'argument', id: argument.id })}>{argument.title}</button>
        <p className="b70-tree-voice">{argument.voice} · {argument.role} <span>Beispiel, erfunden</span></p>
        <p>{argument.text}</p>
        {argument.sourceIds.length > 0 && <div className="b70-tree-sources"><small>Quellenkontext · kein Beleg für diese Meinung</small><ul>{argument.sourceIds.map((id) => {
          const source = TOPIC_SOURCES.find((entry) => String(entry.id) === id);
          return source ? <li key={id}><a href={source.url} target="_blank" rel="noreferrer" onClick={() => onSource?.(id)}>{source.title} ↗</a></li> : null;
        })}</ul></div>}
      </article>
      {children.length > 0 && <ol className="b70-tree-replies" aria-label="Unterargumente">{children.map(renderArgument)}</ol>}
    </li>;
  }

  return <section className="b70-discussion" aria-labelledby={headingId}>
    <header className="b70-discussion-header"><p className="b70-discussion-eyebrow">18 Stimmen · Beispiel, erfunden</p><h2 id={headingId}>Solarpark statt Acker – was bringt das unserem Dorf?</h2><p>Eine erfundene Diskussion zum Erkunden, keine Befragung. Alle Namen, Rollen und Meinungen sind Beispiele, keine Aussagen realer Personen oder Amtsträger.</p></header>
    <div className="b70-discussion-grid">
      <div className="b70-chart-panel">
        {focus && <div className="b70-chart-focus"><strong>{focusLabel}</strong><button type="button" onClick={() => document.getElementById(`${headingId}-tree`)?.scrollIntoView({ block: 'start', behavior: 'auto' })}>{visible.length} Argumente im Baum ansehen ↓</button></div>}
        <svg className="b70-chart" viewBox="0 0 400 400" role="group" aria-label="Argumentkarte: innen Seiten, mittig Themen, außen Argumente">
          {SEGMENTS.map((segment, index) => <path key={`${segment.kind}-${segment.id}`} ref={(element) => { paths.current[index] = element; }} d={sectorPath(segment)} fill={DISCUSSION_SIDES.find((side) => side.id === segment.side)?.color} className={`b70-chart-segment b70-chart-${segment.kind}${segmentHighlighted(segment, focus) ? ' b70-chart-highlighted' : ''}`} role="button" tabIndex={index === keyboardIndex ? 0 : -1} aria-label={`${segment.kind === 'side' ? 'Seite' : segment.kind === 'theme' ? 'Thema' : 'Argument'}: ${segment.label}`} aria-pressed={focus?.kind === segment.kind && focus.id === segment.id} onFocus={() => setKeyboardIndex(index)} onClick={() => select({ kind: segment.kind, id: segment.id })} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select({ kind: segment.kind, id: segment.id }); }
            else if (event.key === 'Escape') { event.preventDefault(); select(null); }
            else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = moveSegmentIndex(index, event.key, SEGMENTS.length); setKeyboardIndex(next); paths.current[next]?.focus(); }
          }}><title>{segment.label} · Strukturgewicht {segment.weight}</title></path>)}
          <text x="200" y="196" textAnchor="middle" className="b70-chart-center">18 Stimmen</text><text x="200" y="215" textAnchor="middle" className="b70-chart-center-small">erfunden</text>
        </svg>
        <div className="b70-chart-legend">{DISCUSSION_SIDES.map((side) => <button key={side.id} type="button" aria-pressed={focus?.kind === 'side' && focus.id === side.id} onClick={() => select({ kind: 'side', id: side.id })}><span style={{ background: side.color }} />{side.label}</button>)}</div>
        <p className="b70-chart-caption">Innen: Seiten · Mitte: Themen · Außen: Argumente. Größe = 1 + direkte Unterargumente + Quellenverweise. Keine Stimmen, keine Zustimmung.</p>
        <p className="b70-chart-help">Antippen zum Eingrenzen. Tastatur: Pfeile wechseln Segmente, Enter wählt, Esc setzt zurück.</p>
      </div>
      <div className="b70-tree" id={`${headingId}-tree`}>
        <div className="b70-tree-toolbar"><p role="status" aria-live="polite">{focusLabel} · {visible.length} von {TOPIC_ARGUMENTS.length} Argumenten</p><button type="button" onClick={() => select(null)} disabled={!focus}>Alles zeigen</button></div>
        {DISCUSSION_SIDES.map((side) => {
          const themes = DISCUSSION_THEMES.filter((theme) => theme.side === side.id && visible.some((argument) => argument.themeId === theme.id));
          return themes.length > 0 && <section className="b70-tree-side" key={side.id}><h3><button type="button" onClick={() => select({ kind: 'side', id: side.id })}>{side.label}</button></h3>{themes.map((theme) => <section className="b70-tree-theme" key={theme.id}><h4><button type="button" onClick={() => select({ kind: 'theme', id: theme.id })}>{theme.label}</button></h4><ol className="b70-tree-arguments">{visible.filter((argument) => argument.themeId === theme.id && !argument.parentId).map(renderArgument)}</ol></section>)}</section>;
        })}
      </div>
    </div>
  </section>;
}
