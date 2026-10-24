'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSectionTabActive } from './section-tabs';
import { useDisclosureActive } from './blocks';
import { FINANCIAL_RECOVERY_CHECKS, observeFinancialRefresh, singleFlight, withAutomaticRefresh } from './financial-refresh';

/** UI refreshes invalidate in-flight snapshots; shared raw fetches may opt into join-only reads. */
export function useSerializedRead<T, Args extends unknown[]>(read: (...args: Args) => Promise<T>, invalidate = true) {
  const [controller] = useState(() => {
    let current = read;
    return {
      request: singleFlight((...args: Args) => current(...args)),
      update: (next: typeof read) => { current = next; },
    };
  });
  useLayoutEffect(() => { controller.update(read); }, [controller, read]);
  return invalidate ? controller.request.invalidate : controller.request;
}

export function useFinancialRefresh(read: () => Promise<unknown>, { enabled = true, chain, pendingKey, initial = true, intervalMs, identity }: {
  enabled?: boolean; chain?: 'solana' | 'evm'; pendingKey?: string | null; initial?: boolean; intervalMs?: number; identity?: string;
} = {}) {
  const selected = useSectionTabActive();
  const disclosed = useDisclosureActive();
  const activity = useRef(false);
  useLayoutEffect(() => {
    activity.current = enabled && selected && disclosed;
    return () => { activity.current = false; };
  }, [enabled, selected, disclosed]);
  const [eligible] = useState(() => () => activity.current && document.visibilityState === 'visible');
  const refresh = useSerializedRead(read);
  const recovery = useRef<{ key: string; remaining: number } | undefined>(undefined);
  const wasActive = useRef(false);
  useEffect(() => {
    if (pendingKey && recovery.current?.key !== pendingKey) recovery.current = { key: pendingKey, remaining: FINANCIAL_RECOVERY_CHECKS };
    const active = enabled && selected && disclosed;
    const returning = active && !wasActive.current;
    wasActive.current = active;
    if (!active) return;
    return observeFinancialRefresh(() => withAutomaticRefresh(eligible, refresh), {
      visible: () => document.visibilityState === 'visible',
      later: (run, delay) => { const timer = window.setTimeout(run, delay); return () => window.clearTimeout(timer); },
      onVisible: run => { document.addEventListener('visibilitychange', run); return () => document.removeEventListener('visibilitychange', run); },
      onBalance: run => {
        const changed = (event: Event) => run((event as CustomEvent<{ chain?: string }>).detail?.chain);
        window.addEventListener('ledger-balances-changed', changed);
        return () => window.removeEventListener('ledger-balances-changed', changed);
      },
    }, { chain, initial: initial || returning, intervalMs, recovery: pendingKey ? recovery.current : undefined });
  }, [enabled, selected, disclosed, chain, pendingKey, initial, intervalMs, identity, refresh, eligible]);
}
