'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRentalWallet } from '@/wallets';
import type { IdentityStatus } from '@/server/eudi';
import type { AuthorizedRequest } from './use-city-signals';
import { useAdapterConfig } from './use-adapter-config';

type IdentityView = { request: AuthorizedRequest; value: IdentityStatus | null; loading: boolean; error: string };

/** Account/configuration observations only. Never probes balances, signs or starts identity verification. */
export function useLedgerConnections(request: AuthorizedRequest) {
  const wallet = useRentalWallet();
  const adapters = useAdapterConfig(request);
  const [identity, setIdentity] = useState<IdentityView>({ request, value: null, loading: true, error: '' });
  const revision = useRef(0);
  const readIdentity = useCallback(() => {
    const current = ++revision.current;
    return request<{ identity: IdentityStatus }>('/api/eudi').then(({ identity: value }) => {
      if (current === revision.current) setIdentity({ request, value, loading: false, error: '' });
    }, (cause: unknown) => {
      if (current === revision.current) setIdentity({ request, value: null, loading: false, error: cause instanceof Error ? cause.message : 'Identity proof could not be checked.' });
    });
  }, [request]);
  const refreshIdentity = useCallback(() => {
    setIdentity((previous) => ({ request, value: previous.request === request ? previous.value : null, loading: true, error: '' }));
    return readIdentity();
  }, [readIdentity, request]);
  useEffect(() => {
    const pendingReads = revision;
    void readIdentity();
    return () => { ++pendingReads.current; };
  }, [readIdentity]);
  const updateIdentity = useCallback((value: IdentityStatus) => {
    ++revision.current;
    setIdentity({ request, value, loading: false, error: '' });
  }, [request]);
  const currentIdentity = identity.request === request ? identity.value : null;
  const identityLoading = identity.request !== request || identity.loading;
  const identityError = identity.request === request ? identity.error : '';
  return {
    wallet,
    adapters,
    identity: currentIdentity,
    identityLoading,
    identityError,
    updateIdentity,
    refreshIdentity,
    facts: {
      accountReady: wallet.ready,
      authenticated: wallet.authenticated,
      solanaLinked: wallet.wallets.some((item) => item.chainType === 'solana'),
      robinhoodLinked: wallet.wallets.some((item) => item.chainType === 'ethereum'),
      identity: currentIdentity,
      identityLoading,
      identityError,
      config: adapters.config,
      homeAssistantPull: adapters.homeAssistantPull,
      configLoading: adapters.loading,
      configError: adapters.error,
    },
  };
}
