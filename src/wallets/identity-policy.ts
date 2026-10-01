export type WalletChainType = 'ethereum' | 'solana';

export interface VerifiedWallet {
  id: string;
  address: string;
  chainType: WalletChainType;
}

export interface VerifiedIdentity {
  subject: string;
  sessionId: string;
  expiresAt: number;
  wallets: VerifiedWallet[];
  passkeyCount: number;
}

export class IdentityError extends Error {
  readonly code: 'unauthenticated' | 'identity_unavailable' | 'wallet_not_user_owned';

  constructor(code: IdentityError['code'], message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export interface IdentityVerificationDependencies {
  appId: string;
  now?: () => number;
  verifyToken: (token: string) => Promise<{
    subject: string;
    appId: string;
    issuer: string;
    expiresAt: number;
    sessionId: string;
  }>;
  getUser: (subject: string) => Promise<{
    id: string;
    is_guest?: boolean;
    linked_accounts: ReadonlyArray<{
      type: string;
      id?: string | null;
      address?: string;
      chain_type?: string;
      wallet_client_type?: string;
      connector_type?: string;
      delegated?: boolean;
    }>;
  }>;
  getWallet: (id: string) => Promise<{
    id: string;
    address: string;
    chain_type: string;
    owner_id: string | null;
    additional_signers: ReadonlyArray<unknown>;
    automations?: ReadonlyArray<unknown>;
    archived_at?: number | null;
    imported_at?: number | null;
  }>;
  getOwner: (id: string) => Promise<{
    id: string;
    user_ids: ReadonlyArray<string> | null;
    authorization_keys: ReadonlyArray<unknown>;
    key_quorum_ids?: ReadonlyArray<string>;
    authorization_threshold: number | null;
  }>;
  isValidAddress: (address: string, chainType: WalletChainType) => boolean;
}


/** Only provider-verified identity enters here; application roles stay in our database. */
export function createIdentityVerifier(dependencies: IdentityVerificationDependencies) {
  const verified = new Map<string, { until: number; result: Promise<VerifiedIdentity> }>();
  const verify = async (token: string): Promise<VerifiedIdentity> => {
    if (!token || token.length > 16_384 || /\s/.test(token)) {
      throw new IdentityError('unauthenticated', 'Sign in to continue.');
    }

    let claims: Awaited<ReturnType<typeof dependencies.verifyToken>>;
    try {
      claims = await dependencies.verifyToken(token);
    } catch (cause) {
      if (cause instanceof IdentityError && cause.code === 'identity_unavailable') throw cause;
      throw new IdentityError(
        'unauthenticated',
        'Your session could not be verified. Sign in again.',
      );
    }
    const now = dependencies.now?.() ?? Date.now();
    if (
      claims.appId !== dependencies.appId ||
      claims.issuer !== 'privy.io' ||
      !claims.subject.startsWith('did:privy:') ||
      !claims.sessionId ||
      !Number.isFinite(claims.expiresAt) ||
      claims.expiresAt * 1000 <= now
    ) {
      throw new IdentityError(
        'unauthenticated',
        'Your session could not be verified. Sign in again.',
      );
    }

    let user: Awaited<ReturnType<typeof dependencies.getUser>>;
    try {
      user = await dependencies.getUser(claims.subject);
    } catch {
      throw new IdentityError(
        'identity_unavailable',
        'Account verification is temporarily unavailable.',
      );
    }
    if (user.id !== claims.subject || user.is_guest) {
      throw new IdentityError('unauthenticated', 'A verified personal account is required.');
    }

    const linkedWallets = user.linked_accounts.filter(
      (account) =>
        account.type === 'wallet' &&
        (account.wallet_client_type === 'privy' || account.wallet_client_type === 'privy-v2') &&
        account.connector_type === 'embedded',
    );
    const wallets: VerifiedWallet[] = [];
    for (const linked of linkedWallets) {
      // Legacy, imported, externally controlled and delegated accounts are not a
      // substitute for the agreed user-owned embedded wallet model.
      if (!linked.id || !linked.address || linked.delegated) {
        throw new IdentityError('wallet_not_user_owned', 'This account needs a user-owned wallet.');
      }
      if (linked.chain_type !== 'ethereum' && linked.chain_type !== 'solana') continue;
      const chainType = linked.chain_type;
      if (!dependencies.isValidAddress(linked.address, chainType)) {
        throw new IdentityError(
          'identity_unavailable',
          'The wallet address could not be verified.',
        );
      }
      let wallet: Awaited<ReturnType<typeof dependencies.getWallet>>;
      try {
        wallet = await dependencies.getWallet(linked.id);
      } catch {
        throw new IdentityError(
          'identity_unavailable',
          'Wallet ownership is temporarily unavailable.',
        );
      }
      const sameAddress =
        chainType === 'ethereum'
          ? wallet.address.toLowerCase() === linked.address.toLowerCase()
          : wallet.address === linked.address;
      if (
        wallet.id !== linked.id ||
        !sameAddress ||
        wallet.chain_type !== chainType ||
        !wallet.owner_id ||
        wallet.additional_signers.length !== 0 ||
        (wallet.automations?.length ?? 0) !== 0 ||
        wallet.archived_at != null ||
        wallet.imported_at != null
      ) {
        throw new IdentityError(
          'wallet_not_user_owned',
          'The wallet must be owned by you without additional signers.',
        );
      }
      if (wallet.owner_id !== claims.subject) {
        let owner: Awaited<ReturnType<typeof dependencies.getOwner>>;
        try {
          owner = await dependencies.getOwner(wallet.owner_id);
        } catch {
          throw new IdentityError(
            'identity_unavailable',
            'Wallet ownership is temporarily unavailable.',
          );
        }
        if (
          owner.id !== wallet.owner_id ||
          owner.user_ids?.length !== 1 ||
          owner.user_ids[0] !== claims.subject ||
          owner.authorization_keys.length !== 0 ||
          (owner.key_quorum_ids?.length ?? 0) !== 0 ||
          (owner.authorization_threshold !== null && owner.authorization_threshold !== 1)
        ) {
          throw new IdentityError(
            'wallet_not_user_owned',
            'The wallet must be owned by you without additional signers.',
          );
        }
      }
      if (!wallets.some((candidate) => candidate.id === wallet.id)) {
        wallets.push({ id: wallet.id, address: wallet.address, chainType });
      }
    }
    return {
      subject: claims.subject,
      sessionId: claims.sessionId,
      expiresAt: claims.expiresAt,
      wallets,
      passkeyCount: user.linked_accounts.filter((account) => account.type === 'passkey').length,
    };
  };
  // One provider read for simultaneous area requests. A short, positive-only
  // window limits stale ownership after a wallet or account is changed.
  return (token: string): Promise<VerifiedIdentity> => {
    const now = dependencies.now?.() ?? Date.now();
    const cached = verified.get(token);
    if (cached && cached.until > now) return cached.result;
    if (cached) verified.delete(token);
    const result = verify(token);
    const entry = { until: now + 30_000, result };
    verified.set(token, entry);
    if (verified.size > 128) verified.delete(verified.keys().next().value!);
    void result.then(
      (identity) => {
        if (verified.get(token) === entry)
          entry.until = Math.min(identity.expiresAt * 1000, (dependencies.now?.() ?? Date.now()) + 30_000);
      },
      () => { if (verified.get(token) === entry) verified.delete(token); },
    );
    return result;
  };
}
