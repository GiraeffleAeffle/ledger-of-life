'use client';

import type { ReactNode } from 'react';
import { displayAmount } from '@/domain/assets';

export const money = (amount: string) => `$${displayAmount(amount)}`;

export function Badge({
  children,
  tone = 'green',
}: {
  children: ReactNode;
  tone?: 'green' | 'amber' | 'neutral';
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
