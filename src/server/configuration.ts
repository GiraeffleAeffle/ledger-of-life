export function connectionStatus(environment: Record<string, string | undefined>) {
  return {
    identity: Boolean(environment.NEXT_PUBLIC_PRIVY_APP_ID && environment.PRIVY_APP_SECRET),
    persistence: environment.DATABASE_URL
      ? 'postgres'
      : environment.NODE_ENV !== 'production' || environment.ALLOW_LOCAL_STORE === '1'
        ? 'local-sqlite'
        : 'unconfigured',
    robinhood: {
      rpc: Boolean(environment.ROBINHOOD_RPC_URL),
      escrow: Boolean(environment.ROBINHOOD_ESCROW_ADDRESS),
      sponsor: Boolean(environment.ROBINHOOD_SPONSOR_PRIVATE_KEY),
      trading: Boolean(environment.ZEROX_API_KEY && environment.ZEROX_RWA_ENABLED === '1'),
    },
    solana: {
      rpc: Boolean(environment.SOLANA_RPC_URL),
      deployment: Boolean(environment.SOLANA_DEPLOYMENT_MANIFEST),
      sponsor: Boolean(environment.SOLANA_SPONSOR_KEYPAIR),
      trading: Boolean(environment.JUPITER_API_KEY),
    },
    reconciliation: Boolean(environment.RECONCILE_SECRET),
  };
}
