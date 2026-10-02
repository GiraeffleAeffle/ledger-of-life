'use client';
import { ArrowRight } from 'lucide-react';
import { goToSection, type Area } from './areas';
import { netPositionTotal, usd, type NetPositionParts } from './money-valuation';
import './net-position.css';

type PartKey = keyof NetPositionParts;
const PARTS: { key: PartKey; label: string; short: string; meaning: string }[] = [
  { key: 'free', label: 'Free to use', short: 'Free', meaning: 'Test cash and shares in your own wallets, available for supported actions.' },
  { key: 'locked', label: 'Locked in a tenancy', short: 'Locked', meaning: 'Your deposit entitlement or approved unpaid claim. Open Home for deposit status and records.' },
  { key: 'pledged', label: 'Pledged as collateral', short: 'Pledged', meaning: 'Official test TSLA held in the shared loan pool, valued at the same mirrored token price as wallet TSLA. Repayment unlocks collateral; liquidation can take some.' },
  { key: 'lent', label: 'Lent to the shared pool', short: 'Lent', meaning: 'Your pool claim includes borrower interest and losses. Withdrawals are limited by available cash.' },
  { key: 'owed', label: 'Owed on your loan', short: 'Owed', meaning: 'Test USD (tUSDG) borrowed against shares, subtracted here. Borrowed test cash appears once in Free to use.' },
];
type PositionRead = { [K in PartKey]: number | null };
/** Reserve Free and pending Home entitlement; optional positions appear only when confirmed nonzero. */
const shown = (parts: PositionRead) => PARTS.filter(({ key }) => key === 'free' || key === 'locked' && parts[key] === null || parts[key] !== null && parts[key] !== 0);
const signed = (key: PartKey, amount: number) => `${key === 'owed' ? '−' : ''}${usd(amount)} test value`;

/** What the subtotal is made of: one row per part, bars from a shared zero line, arithmetic that adds up. */
export function NetPosition({ parts, go, depositSection }: { parts: PositionRead; go: (area: Area) => void; depositSection: string }) {
  const rows = shown(parts);
  const complete = Object.values(parts).every(value => value !== null);
  const scale = Math.max((parts.free ?? 0) + (parts.locked ?? 0) + (parts.pledged ?? 0) + (parts.lent ?? 0), parts.owed ?? 0, 0.01);
  const opens: Partial<Record<PartKey, () => void>> = {
    locked: () => goToSection(go, 'home', depositSection),
    pledged: () => goToSection(go, 'money', 'share-workflows'),
    lent: () => goToSection(go, 'money', 'share-workflows'),
    owed: () => goToSection(go, 'money', 'share-workflows'),
  };
  return (
    <section className="net-position" aria-label="What your subtotal is made of">
      <ul>
        {rows.map(({ key, label, meaning }) => (
          <li key={key} className={`tone-${key}`}>
            <span className="net-position-label">{label}</span>
            <span className="net-position-bar" aria-hidden="true">{(parts[key] ?? 0) > 0 && <span style={{ width: `${((parts[key] ?? 0) / scale) * 100}%` }} />}</span>
            <strong className="net-position-amount">{parts[key] === null ? 'Unavailable' : signed(key, parts[key])}</strong>
            <span className="net-position-meaning">{meaning}{opens[key] && <> <button type="button" className="text-button" onClick={opens[key]}>Open <ArrowRight size={13} /></button></>}</span>
          </li>
        ))}
        {complete && <li className="net-position-total">
          <span className="net-position-label">Adds up to</span>
          <span className="net-position-sum">{rows.length > 1 ? 'Free + locked + pledged + lent − owed' : 'Nothing locked, pledged, lent or owed'}</span>
          <strong className="net-position-amount">{usd(netPositionTotal(parts as NetPositionParts))} test value</strong>
        </li>}
      </ul>
    </section>
  );
}

/** The same parts as one line for Today: a strip of what is counted, then each part with its amount. */
export function NetPositionStrip({ parts }: { parts: NetPositionParts }) {
  const counted = PARTS.filter(({ key }) => key !== 'owed' && parts[key] > 0);
  return (
    <div className="net-strip">
      {counted.length > 0 && <div className="net-strip-bar" aria-hidden="true">{counted.map(({ key }) => <span key={key} className={`tone-${key}`} style={{ flexGrow: parts[key] }} />)}</div>}
      <ul>{shown(parts).map(({ key, short }) => <li key={key} className={`tone-${key}`}>{short} <strong>{signed(key, parts[key])}</strong></li>)}</ul>
    </div>
  );
}
