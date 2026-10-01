import type { UnsignedTransactionRequest } from '@privy-io/react-auth';
import type { WalletChainType } from './identity-policy.ts';
import type { EscrowSigningRequest } from './escrow-signing.ts';
import type { InferencePaymentSigningRequest } from '../server/local-ai-types.ts';
import type { ShareDepositSigningReview } from './share-deposit-signing.ts';

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
  shareDeposit?: ShareDepositSigningReview;
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
  hasLinkedEmail: boolean;
  busy: boolean;
  error: string | null;
  loginWithPasskey: () => Promise<void>;
  signupWithPasskey: () => Promise<void>;
  addPasskey: () => Promise<void>;
  removeEmail: () => Promise<void>;
  createMissingWallets: () => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  signEvmTransaction: (request: EvmSigningRequest) => Promise<`0x${string}`>;
  signSolanaTransaction: (request: SolanaSigningRequest) => Promise<Uint8Array>;
  signEvmTypedData: (request: EscrowSigningRequest) => Promise<string>;
  signInferencePayment: (request: InferencePaymentSigningRequest) => Promise<`0x${string}`>;
}
