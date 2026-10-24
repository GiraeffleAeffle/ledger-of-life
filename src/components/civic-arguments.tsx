'use client';
import { useId, useMemo, useRef, useState } from 'react';
import { CIVIC_LIMITS, type CivicContribution } from '@/data/civic';
import type { CivicAiSource } from '@/data/civic-ai';
import { sourceAssertionLabel, sourceReviewLabel } from '@/data/city-source-evidence';
import { civicArgumentLayout, civicArgumentTree, CIVIC_STANCE_LABEL, type CivicArgumentNode } from './civic-argument-layout';

export function CivicArguments({ contributions, canReply, onReply }: {
  contributions: readonly CivicContribution[];
  canReply: boolean;
  onReply: (id: string) => void;
}) {
  const descriptionId = useId();
  const detailId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSunburst, setShowSunburst] = useState(true);
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const model = useMemo(() => {
    try {
      const roots = civicArgumentTree(contributions.filter((item) => item.stance !== 'discussion'));
      return { roots, segments: civicArgumentLayout(roots), error: '' };
    } catch {
      return { roots: [], segments: [], error: 'The argument hierarchy could not be displayed. Reload the topic before contributing.' };
    }
  }, [contributions]);
  const selected = model.segments.find((segment) => segment.node.contribution.id === selectedId)?.node ?? model.segments[0]?.node;
  const renderNodes = (nodes: CivicArgumentNode[]) => <ol className="civic-argument-list">{nodes.map((node) => <li key={node.contribution.id}>
    <button type="button" className={`civic-argument-row civic-stance-${node.contribution.stance}`} aria-pressed={selected?.contribution.id === node.contribution.id} aria-controls={detailId} onClick={() => setSelectedId(node.contribution.id)}>
      <strong>{node.number}. {CIVIC_STANCE_LABEL[node.contribution.stance]}</strong>
      <span>{node.contribution.text}</span>
      <small>{node.parentNumber === null ? 'Top-level argument' : `Reply to argument ${node.parentNumber}`} · select for details</small>
    </button>
    {node.children.length > 0 && renderNodes(node.children)}
  </li>)}</ol>;
  return <section className="civic-row" aria-label="Pro and con arguments">
    <div className="civic-toolbar"><h3>Weigh the arguments</h3><button type="button" aria-pressed={showSunburst} onClick={() => setShowSunburst(!showSunburst)}>{showSunburst ? 'Hide sunburst' : 'Show sunburst'}</button></div>
    <p id={descriptionId} className="small-copy">Area shows reply structure, not support, truth or votes. Terminal branches share angle equally; outer rings are replies. Pro and con labels refer to the topic question. The numbered list and sunburst show the same hierarchy.</p>
    {model.error && <p role="alert">{model.error}</p>}
    {!model.error && !model.roots.length && <p>No structured arguments yet. Add a pro or con argument to start the comparison.</p>}
    {model.roots.length > 0 && <>
      <div className={showSunburst ? 'civic-argument-explorer' : undefined}>
        {showSunburst && <div>
          <svg className="civic-sunburst" viewBox="-150 -150 300 300" role="group" aria-label="Argument sunburst" aria-describedby={descriptionId}>
            <circle r="26" className="civic-sunburst-center" />
            <text textAnchor="middle" y="4" className="civic-sunburst-title" aria-hidden="true">Topic</text>
            {model.segments.map((segment, index) => <path key={segment.node.contribution.id} ref={(element) => { paths.current[index] = element; }} d={segment.path}
              className={`civic-sector civic-stance-${segment.node.contribution.stance}`} role="button" tabIndex={selected?.contribution.id === segment.node.contribution.id ? 0 : -1}
              aria-label={`${segment.node.label}. ${segment.node.parentNumber === null ? 'Top-level argument' : `Reply to argument ${segment.node.parentNumber}`}`}
              aria-pressed={selected?.contribution.id === segment.node.contribution.id} aria-controls={detailId}
              onClick={() => setSelectedId(segment.node.contribution.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(segment.node.contribution.id); }
                const destination = event.key === 'Home' ? 0 : event.key === 'End' ? model.segments.length - 1 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % model.segments.length : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + model.segments.length - 1) % model.segments.length : null;
                if (destination !== null) { event.preventDefault(); setSelectedId(model.segments[destination].node.contribution.id); paths.current[destination]?.focus(); }
              }}><title>{segment.node.label}</title></path>)}
            {model.segments.filter((segment) => (segment.end - segment.start) * segment.inner > 20 && segment.outer - segment.inner > 14).map((segment) => {
              const radius = (segment.inner + segment.outer) / 2;
              const angle = (segment.start + segment.end) / 2;
              return <text key={segment.node.contribution.id} x={radius * Math.sin(angle)} y={-radius * Math.cos(angle) + 4} textAnchor="middle" className="civic-sector-number" aria-hidden="true">{segment.node.number}</text>;
            })}
          </svg>
          <p className="small-copy">Keyboard: Tab into the chart, arrow keys to explore, Home/End to jump. Or use the argument list below.</p>
        </div>}
        {selected && <article id={detailId} className="civic-selected-argument" aria-live="polite" aria-atomic="true">
          <h4>Argument {selected.number} · {CIVIC_STANCE_LABEL[selected.contribution.stance]}</h4>
          <p className="civic-user-text">{selected.contribution.text}</p>
          <p className="small-copy">{selected.parentNumber === null ? 'Replies to the topic question.' : `Replies to argument ${selected.parentNumber}.`} Posted {new Date(selected.contribution.createdAt).toLocaleString()}.</p>
          {canReply && selected.depth < CIVIC_LIMITS.depth - 1 && <button type="button" onClick={() => onReply(selected.contribution.id)}>Reply to argument {selected.number}</button>}
          {canReply && selected.depth >= CIVIC_LIMITS.depth - 1 && <p className="small-copy">Maximum reply depth reached. Add a top-level argument instead.</p>}
        </article>}
      </div>
      {renderNodes(model.roots)}
    </>}
  </section>;
}

export function CivicAiSources({ sources }: { sources: readonly CivicAiSource[] }) {
  return <div className="civic-ai-sources"><p className="small-copy">Server-selected source context, not independent fact-checking:</p>
    {sources.length ? <ul>{sources.map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a><span className="small-copy"> · {source.assertion ? 'document date' : 'as of'} {source.asOf} · {source.kind} · {sourceReviewLabel(source.reviewState, source.verification)}{source.assertion && ` · ${sourceAssertionLabel(source.assertion)}`}</span>
      {source.verification && <details><summary>Automated verification evidence</summary><p className="small-copy">{source.verification.meaning}. {source.verification.evidenceBasis}. {source.verification.metric} {source.verification.metricVersion} · {source.verification.model} · score {source.verification.score}, threshold {source.verification.threshold} · checked {source.verification.evaluatedAt}.</p><p className="small-copy">Source SHA-256: <code>{source.verification.sourceSha256}</code><br />Assertion SHA-256: <code>{source.verification.assertionHash}</code><br />Evaluation receipt SHA-256: <code>{source.verification.evidenceHash}</code></p></details>}
    </li>)}</ul> : <p className="small-copy">No sources were attached. Do not treat this answer as source-backed.</p>}
  </div>;
}

export function CivicAiAttribution({ metadata }: { metadata: NonNullable<CivicContribution['ai']> }) {
  return <header className="civic-ai-attribution"><strong>City AI · model-generated</strong><p className="small-copy">{metadata.model} · generated {new Date(metadata.generatedAt).toLocaleString()} · no municipal authority. Check important facts; this is not a human contribution or a vote.</p><CivicAiSources sources={metadata.sources} /></header>;
}
