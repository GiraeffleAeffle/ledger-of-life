/** Account setup needs a passkey and both embedded test-network wallets. */
export type SetupStep = 'loading' | 'account' | 'wallets' | 'done';

export function accountSetupStep(input: {
  /** The wallet SDK has answered whether anyone is signed in. */
  ready: boolean;
  authenticated: boolean;
  subject: string | null;
  passkeyCount: number;
  wallets: { chainType: string }[];
}): SetupStep {
  if (!input.ready) return 'loading';
  if (!input.authenticated || !input.subject || input.passkeyCount === 0) return 'account';
  const has = (chainType: string) => input.wallets.some((wallet) => wallet.chainType === chainType);
  return has('solana') && has('ethereum') ? 'done' : 'wallets';
}
