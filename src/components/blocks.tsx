'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import './blocks.css';

/**
 * Shared layout blocks for every area, one pattern per job:
 * - Hero: the one thing a screen is about, a picture beside its title, status and key numbers;
 * - StatusLine: whether anything needs the person;
 * - Figures/Figure: two to four key numbers;
 * - ActionBox: the one step that needs this person now;
 * - MoreList/MoreRow: rarely needed tools and records, closed and not loaded until opened;
 * - ScreenNote: the screen's single honesty line.
 */

export type Tone = 'ok' | 'action' | 'waiting' | 'alert' | 'neutral';

export function Hero({ id, visual, title, subtitle, status, children, className = '' }: {
  id?: string; visual?: ReactNode; title: ReactNode; subtitle?: ReactNode; status?: ReactNode; children?: ReactNode; className?: string;
}) {
  return <section id={id} tabIndex={id ? -1 : undefined} className={`hero-card${visual ? '' : ' hero-card--plain'}${className ? ` ${className}` : ''}`}>
    {visual && <div className="hero-visual">{visual}</div>}
    <div className="hero-body">
      <header className="hero-head"><h2>{title}</h2>{subtitle && <p className="hero-subtitle">{subtitle}</p>}</header>
      {status}
      {children}
    </div>
  </section>;
}

export function StatusLine({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <p className={`status-line status-line--${tone}`}><span className="status-line-dot" aria-hidden="true" />{children}</p>;
}

export function Figures({ label, children }: { label?: string; children: ReactNode }) {
  return <dl className="figures" aria-label={label}>{children}</dl>;
}

export function Figure({ label, value, unit, note, action, tone = 'neutral' }: {
  label: ReactNode; value: ReactNode; unit?: ReactNode; note?: ReactNode; action?: ReactNode; tone?: Tone;
}) {
  return <div className={`figure${tone === 'neutral' ? '' : ` figure--${tone}`}`}>
    <dt>{label}</dt>
    <dd className="figure-main"><span className="figure-value">{value}</span>{unit && <span className="figure-unit">{unit}</span>}</dd>
    {note && <dd className="figure-note">{note}</dd>}
    {action && <dd className="figure-action">{action}</dd>}
  </div>;
}

/** `level` 2 when the box sits directly under the page h1 (no h2 before it). */
export function ActionBox({ title, tone = 'action', level = 3, children }: { title: ReactNode; tone?: Tone; level?: 2 | 3; children?: ReactNode }) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return <div className={`action-box action-box--${tone}`}><Heading className="action-box-title">{title}</Heading>{children}</div>;
}

export function MoreList({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return <div className="more-list">{title && <h3 className="more-list-title">{title}</h3>}{children}</div>;
}

/**
 * A closed row whose content mounts on first open. Put deep-link ids here: `goToSection` opens it.
 * `defaultOpen` only ever opens: a row never snaps shut when its state changes (or after the person opened it),
 * and it opens when `defaultOpen` later turns true.
 */
export function MoreRow({ id, title, meta, defaultOpen = false, children }: {
  id?: string; title: ReactNode; meta?: ReactNode; defaultOpen?: boolean; children: ReactNode;
}) {
  const row = useRef<HTMLDetailsElement>(null);
  const [initiallyOpen] = useState(defaultOpen);
  const [opened, setOpened] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen && row.current && !row.current.open) row.current.open = true; }, [defaultOpen]);
  return <details ref={row} className="more-row" id={id} tabIndex={id ? -1 : undefined} open={initiallyOpen || undefined}
    onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>
      <span className="more-row-title">{title}</span>
      {meta && <span className="more-row-meta">{meta}</span>}
      <ChevronRight className="more-row-chevron" size={16} aria-hidden="true" />
    </summary>
    <div className="more-row-body">{opened ? children : null}</div>
  </details>;
}

export function ScreenNote({ children }: { children: ReactNode }) {
  return <p className="screen-note">{children}</p>;
}
