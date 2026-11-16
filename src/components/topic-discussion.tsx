'use client';

import { useId, useRef, useState } from 'react';
import { DISCUSSION_SIDES, TOPIC_ARGUMENTS } from '../data/topic-discussion';
import { TOPIC_SOURCES } from '../data/topic-flow-demo';
import { discussionKeyAction, discussionLayout, discussionTree, focusedArguments, replyLabel, sectorPath, type DiscussionNode } from './topic-discussion-model';
import './topic-discussion.css';

const TREE = discussionTree();
const SEGMENTS = discussionLayout();
export interface TopicDiscussionProps {
  initialArgumentId?: string;
  onArgumentSelect?: (id: string) => void;
  onSource?: (id: string) => void;
}

function ancestorPath(id: string): Set<string> {
  const path = new Set<string>();
  let argument = TOPIC_ARGUMENTS.find((entry) => entry.id === id);
  while (argument) {
    path.add(argument.id);
    argument = TOPIC_ARGUMENTS.find((entry) => entry.id === argument!.parentId);
  }
  return path;
}

export function TopicDiscussion({ initialArgumentId, onArgumentSelect, onSource }: TopicDiscussionProps) {
  const headingId = useId();
  const treeId = `${headingId}-tree`;
  const initialId = TOPIC_ARGUMENTS.find((argument) => argument.id === initialArgumentId)?.id ?? null;
  const [focusId, setFocusId] = useState<string | null>(initialId);
  const [treeOpen, setTreeOpen] = useState(Boolean(initialId));
  const [openThreads, setOpenThreads] = useState(() => initialId ? ancestorPath(initialId) : new Set<string>());
  const [keyboardIndex, setKeyboardIndex] = useState(() => Math.max(0, SEGMENTS.findIndex((segment) => segment.id === initialId)));
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const treeHeading = useRef<HTMLHeadingElement>(null);
  const visibleIds = new Set(focusedArguments(focusId).map((argument) => argument.id));
  const preview = TOPIC_ARGUMENTS.find((argument) => argument.id === focusId) ?? TREE[0]!.argument;
  const previewSegment = SEGMENTS.find((segment) => segment.id === preview.id)!;
  const select = (id: string | null) => {
    setFocusId(id);
    setOpenThreads(id ? ancestorPath(id) : new Set());
    setTreeOpen(Boolean(id));
    if (id) onArgumentSelect?.(id);
  };
  const openTree = () => {
    setTreeOpen(true);
    if (!focusId) select(preview.id);
    requestAnimationFrame(() => {
      treeHeading.current?.focus({ preventScroll: true });
      treeHeading.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  };

  function renderArgument(node: DiscussionNode) {
    const { argument } = node;
    const children = node.children.filter((child) => visibleIds.has(child.argument.id));
    const side = DISCUSSION_SIDES.find((entry) => entry.id === argument.side)!;
    return <li key={argument.id} className={`b70-tree-item${focusId === argument.id ? ' b70-tree-selected' : ''}`}>
      <article style={{ borderInlineStartColor: side.color }}>
        <span className="b70-tree-stance">{side.label}</span>
        <button type="button" className="b70-tree-title" aria-pressed={focusId === argument.id} onClick={() => select(argument.id)}>{argument.title}</button>
        <p className="b70-tree-summary">{argument.summary}</p>
        <details className="b70-argument-details">
          <summary>Stimme &amp; Quellenkontext</summary>
          <p className="b70-tree-voice">{argument.voice} · {argument.role}<span>Beispiel, erfunden</span></p>
          <p>{argument.text}</p>
          {argument.sourceIds.length > 0 ? <div className="b70-tree-sources"><small>Quellenkontext · kein Beleg für diese Meinung</small><ul>{argument.sourceIds.map((id) => {
            const source = TOPIC_SOURCES.find((entry) => String(entry.id) === id);
            return source ? <li key={id}><a href={source.url} target="_blank" rel="noreferrer" onClick={() => onSource?.(id)}>{source.title} ↗</a></li> : null;
          })}</ul></div> : <p className="b70-tree-context-note">Kein Quellenverweis zu diesem erfundenen Beitrag.</p>}
        </details>
        {node.replyCount === 0 && <p className="b70-tree-unanswered">Keine Antwort</p>}
      </article>
      {children.length > 0 && <details className="b70-thread-replies" open={openThreads.has(argument.id)} onToggle={(event) => {
        const open = event.currentTarget.open;
        setOpenThreads((previous) => {
          if (previous.has(argument.id) === open) return previous;
          const next = new Set(previous);
          if (open) next.add(argument.id);
          else next.delete(argument.id);
          return next;
        });
      }}>
        <summary>{replyLabel(node.replyCount)}{children.length !== node.children.length ? ' · ausgewählter Zweig' : ''}</summary>
        <ol className="b70-tree-replies" aria-label={`Antworten auf „${argument.title}“`}>{children.map(renderArgument)}</ol>
      </details>}
    </li>;
  }

  return <section className="b70-discussion" aria-labelledby={headingId} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); select(null); paths.current[keyboardIndex]?.focus(); }
  }}>
    <header className="b70-discussion-header"><p className="b70-discussion-eyebrow">18 Stimmen · Beispiel, erfunden</p><h2 id={headingId}>Solarpark: Was spricht dafür, was dagegen?</h2><p>Erfundene Namen und Meinungen, keine Befragung.</p></header>
    <div className="b70-discussion-grid">
      <div className="b70-chart-panel">
        <svg className="b70-chart" viewBox="0 0 400 400" role="group" aria-label="Antwortbaum: innen Gesprächsanfänge, nach außen deren Antworten">
          {SEGMENTS.map((segment, index) => <path key={segment.id} ref={(element) => { paths.current[index] = element; }} d={sectorPath(segment)} fill={DISCUSSION_SIDES.find((side) => side.id === segment.side)!.color} className={`b70-chart-segment${visibleIds.has(segment.id) ? ' b70-chart-highlighted' : ''}`} role="button" tabIndex={index === keyboardIndex ? 0 : -1} aria-label={`${segment.label} · ${DISCUSSION_SIDES.find((side) => side.id === segment.side)!.label} · ${replyLabel(segment.replyCount)} · Ring ${segment.depth + 1}`} aria-pressed={focusId === segment.id} aria-controls={treeId} onFocus={() => setKeyboardIndex(index)} onClick={() => { setKeyboardIndex(index); select(segment.id); }} onKeyDown={(event) => {
            const action = discussionKeyAction(index, event.key, SEGMENTS);
            if (!action) return;
            event.preventDefault();
            event.stopPropagation();
            if (action.type === 'select') select(action.id);
            else if (action.type === 'reset') select(null);
            else { setKeyboardIndex(action.index); paths.current[action.index]?.focus(); }
          }}><title>{segment.label} · {replyLabel(segment.replyCount)} · Strukturgewicht {segment.weight}</title></path>)}
          <text x="200" y="197" textAnchor="middle" className="b70-chart-center">18 Stimmen</text><text x="200" y="214" textAnchor="middle" className="b70-chart-center-small">erfunden</text>
        </svg>
        <ul className="b70-chart-legend" aria-label="Haltung jedes einzelnen Beitrags">{DISCUSSION_SIDES.map((side) => <li key={side.id}><span style={{ background: side.color }} />{side.label}</li>)}</ul>
        <p className="b70-chart-caption">Innen: Anfang · außen: Antworten · Lücken: offene Zweige.<br />Breite: Beiträge + Quellenkontext, keine Stimmen.</p>
        <details className="b70-chart-guide"><summary>Karte &amp; Tastatur erklären</summary><p>Jedes Segment ist ein Beitrag; seine Farbe zeigt nur dessen Haltung. Antworten können widersprechen. Jeder Beitrag zählt 1 plus Quellenverweise; ein Zweig addiert alle enthaltenen Beiträge. Eigene Gewichtsanteile bleiben außerhalb frei, unbeantwortete Beiträge werden nicht weitergezeichnet.</p><p>Links/rechts: im Ring wechseln. Hoch: zum Elternbeitrag. Runter: zur ersten Antwort. Enter: auswählen. Escape: zurücksetzen. Pos1/Ende: erster/letzter Beitrag.</p></details>
      </div>
      <div className="b70-discussion-threads">
        <div className="b70-thread-preview">
          <div className="b70-thread-preview-meta"><span>{focusId ? 'Ausgewählter Beitrag' : 'Ein Gesprächsanfang'}</span><button type="button" onClick={() => select(null)} disabled={!focusId}>Zurücksetzen</button></div>
          <h3>{preview.title}</h3><p>{preview.summary}</p>
          <div className="b70-thread-preview-actions"><span role="status" aria-live="polite">{replyLabel(previewSegment.replyCount)}</span><button type="button" aria-controls={treeId} onClick={openTree}>Zum Antwortbaum ↓</button></div>
        </div>
        <details className="b70-tree-browser" open={treeOpen} onToggle={(event) => setTreeOpen(event.currentTarget.open)}>
          <summary>{focusId ? 'Ausgewählten Zweig ansehen' : `${TREE.length} Gesprächsanfänge ansehen`}</summary>
          <div className="b70-tree" id={treeId}>
            <h3 ref={treeHeading} tabIndex={-1}>{focusId ? 'Dein Zweig mit Vorgeschichte' : 'Gesprächsanfänge'}</h3>
            <ol className="b70-tree-arguments" aria-label="Verschachtelter Antwortbaum">{TREE.filter((node) => visibleIds.has(node.argument.id)).map(renderArgument)}</ol>
          </div>
        </details>
      </div>
    </div>
  </section>;
}
