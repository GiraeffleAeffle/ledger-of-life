/**
 * Where a person stands in account setup: passkey, backup email, then both wallets.
 * The second-browser recovery proof is not part of it. It is asked when a wallet first acts on a
 * tenancy (see recovery-step.tsx), so a person can look around, choose a city and read before that.
 */
export type SetupStep = 'loading' | 'account' | 'backup' | 'wallets' | 'done';

export function accountSetupStep(input: {
  /** The wallet SDK has answered whether anyone is signed in. */
  ready: boolean;
  authenticated: boolean;
  subject: string | null;
  passkeyCount: number;
  backupLoginLinked: boolean;
  wallets: { chainType: string }[];
  /** Whether this server asks for a backup email and a recovery proof; null until it has answered. */
  recoveryRequired: boolean | null;
}): SetupStep {
  if (!input.ready || input.recoveryRequired === null) return 'loading';
  if (!input.authenticated || !input.subject || input.passkeyCount === 0) return 'account';
  if (input.recoveryRequired && !input.backupLoginLinked) return 'backup';
  const has = (chainType: string) => input.wallets.some((wallet) => wallet.chainType === chainType);
  return has('solana') && has('ethereum') ? 'done' : 'wallets';
}
