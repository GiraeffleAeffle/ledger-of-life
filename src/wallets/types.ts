import type { UnsignedTransactionRequest } from '@privy-io/react-auth';
import type { WalletChainType } from './identity-policy.ts';
import type { RecoverySignature } from './recovery.ts';
import type { EscrowSigningRequest } from './escrow-signing.ts';
import type { InferencePaymentSigningRequest } from '../server/local-ai-types.ts';

export interface RentalWallet {
  id: string;
  address: string;
  chainType: WalletChainType;
  connected: boolean;
}

export interface SigningReview {
  operationId: string;
  description: string;
  expiresAt: string;
}

export interface EvmSigningRequest extends SigningReview {
  walletId: string;
  transaction: UnsignedTransactionRequest & { chainId: 4663 | 46630; to: string };
}

export interface SolanaSigningRequest extends SigningReview {
  walletId: string;
  chain: 'solana:mainnet' | 'solana:devnet';
  transaction: Uint8Array;
  feePayer: string;
}

export interface RentalWalletAccess {
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  subject: string | null;
  wallets: RentalWallet[];
  passkeyCount: number;
  backupLoginLinked: boolean;
  backupEmail: string | null;
  busy: boolean;
  error: string | null;
  loginWithPasskey: () => Promise<void>;
  signupWithPasskey: () => Promise<void>;
  loginWithBackup: () => void;
  addPasskey: () => Promise<void>;
  addBackupEmail: () => void;
  createMissingWallets: () => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  signEvmTransaction: (request: EvmSigningRequest) => Promise<`0x${string}`>;
  signSolanaTransaction: (request: SolanaSigningRequest) => Promise<Uint8Array>;
  signRecoveryChallenge: (
    chainType: WalletChainType,
    message: string,
  ) => Promise<RecoverySignature>;
  signEvmTypedData: (request: EscrowSigningRequest) => Promise<string>;
  signInferencePayment: (request: InferencePaymentSigningRequest) => Promise<`0x${string}`>;
}
