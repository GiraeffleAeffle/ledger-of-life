'use client';
import { usd, type NetPositionParts } from './money-valuation';
import './net-position.css';

type PositionRead = { [K in keyof NetPositionParts]: number | null };
/** Collateral remains owned, but is locked until the loan releases it. */
export function NetPosition({ parts }: { parts: PositionRead }) {
  const segments = [
    { key: 'free', label: 'Free', value: parts.free },
    { key: 'locked', label: 'Locked', value: parts.locked === null || parts.pledged === null ? null : parts.locked + parts.pledged },
    { key: 'lent', label: 'Lent', value: parts.lent },
    { key: 'owed', label: 'Owed', value: parts.owed },
  ];
  const total = segments.reduce((sum, part) => sum + (part.value ?? 0), 0);
  return <div className="net-position" aria-label="Free, locked, lent and owed test value">
    <div className="net-position-stack" aria-hidden="true">{segments.map(part => <span key={part.key} className={`tone-${part.key}`} style={{ flexGrow: total ? (part.value ?? 0) : 0 }} />)}</div>
    <ul>{segments.map(part => <li key={part.key} className={`tone-${part.key}`}><i aria-hidden="true" />{part.label} <strong>{part.value === null ? '—' : usd(part.value)}</strong></li>)}</ul>
  </div>;
}
