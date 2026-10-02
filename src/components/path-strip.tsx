'use client';
import type { ReactNode } from 'react';

/** Four concise references; each row's destination belongs to the status it describes. */
export function PathStrip({ children }: { children: ReactNode }) {
  return <ol className="ledger-overview" aria-label="Your current status">{children}</ol>;
}
