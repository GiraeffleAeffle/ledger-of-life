'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicAdapterConfig } from '@/server/adapters';
import type { AuthorizedRequest } from './use-city-signals';

export const ADAPTER_CONFIG_CHANGED = 'ledger-of-life:adapter-config-changed';
type ConfigView = { request: AuthorizedRequest; config: PublicAdapterConfig | null; homeAssistantPull: boolean; loading: boolean; error: string };

/** Reads configuration without triggering Home Assistant, validator, prices or wallet reads. */
export function useAdapterConfig(request: AuthorizedRequest) {
  const [view, setView] = useState<ConfigView>(() => ({ request, config: null, homeAssistantPull: false, loading: true, error: '' }));
  const revision = useRef(0);
  const readConfig = useCallback(async () => {
    const current = ++revision.current;
    try {
      const { adapters, homeAssistantPull } = await request<{ adapters: PublicAdapterConfig; homeAssistantPull: boolean }>('/api/adapters');
      if (current === revision.current) setView({ request, config: adapters, homeAssistantPull: homeAssistantPull === true, loading: false, error: '' });
    } catch (cause) {
      if (current === revision.current) setView((previous) => ({
        request, config: previous.request === request ? previous.config : null, homeAssistantPull: previous.request === request ? previous.homeAssistantPull : false, loading: false,
        error: cause instanceof Error ? cause.message : 'Adapter settings unavailable.',
      }));
    }
  }, [request]);
  const refresh = useCallback(() => {
    setView((previous) => previous.request === request
      ? { ...previous, loading: true, error: '' }
      : { request, config: null, homeAssistantPull: false, loading: true, error: '' });
    return readConfig();
  }, [readConfig, request]);
  useEffect(() => {
    const pendingReads = revision;
    void readConfig();
    const changed = () => { void refresh(); };
    window.addEventListener(ADAPTER_CONFIG_CHANGED, changed);
    return () => {
      ++pendingReads.current;
      window.removeEventListener(ADAPTER_CONFIG_CHANGED, changed);
    };
  }, [readConfig, refresh]);
  return view.request === request ? { config: view.config, homeAssistantPull: view.homeAssistantPull, loading: view.loading, error: view.error, refresh } : { config: null, homeAssistantPull: false, loading: true, error: '', refresh };
}
