import type { PaymentRequired, SettleResponse } from '@x402/core/types';
import type { EvmSigningRequest } from '../wallets/types.ts';

export type LocalAiMode = 'paid' | 'library';
export type LocalAiContext = 'general' | 'housing' | 'business';
export interface LocalAiRequestUsage {
  inputTokens: number | null; outputTokens: number | null; wallMs: number;
  totalMs: number | null; loadMs: number | null; evalMs: number | null; tokensPerSecond: number | null;
}
export interface InferencePaymentReview {
  walletId: string; operationId: string; description: string; expiresAt: string;
  requestId: string; requestFingerprint: `0x${string}`; resourceUrl: string;
  chainId: 46630; asset: `0x${string}`; payTo: `0x${string}`; amountAtomic: string;
  maxOutputTokens: number; facilitatorAddress: `0x${string}`;
}
export interface InferencePaymentSigningRequest extends InferencePaymentReview {
  nonce: string; validAfter: string; deadline: string;
}
export interface SolanaInferenceReview {
  walletId: string; operationId: string; requestId: string; requestFingerprint: string;
  description: string; expiresAt: string; network: 'solana-devnet';
  asset: string; payer: string; source: string; delegate: string;
  payTo: string; route: 'house' | 'wallet'; hostOwnerSubject: string | null;
  maxOutputTokens: number; amountAtomic: string; priceAtomic: string;
}
export interface SolanaInferenceApproval {
  walletId: string; operationId: string; description: string; expiresAt: string;
  chain: 'solana:devnet'; feePayer: string; transactionBase64: string;
}
export interface LocalAiApproval {
  id: string; state: 'review' | 'pending' | 'completed' | 'failed' | 'expired';
  budgetAtomic: string; request: EvmSigningRequest | null; hash: string | null; error: string | null;
  solanaRequest?: SolanaInferenceApproval | null;
}
export interface ConnectorHostStatus {
  id: string; name: string; own: boolean; payoutWallet: string | null; models: string[];
  lastHeartbeat: number | null; state: 'pending' | 'active' | 'revoked' | 'suspended';
  kind?: 'operator' | 'community';
  ollamaReachable: boolean; awake: boolean; availability: 'online' | 'asleep' | 'offline';
  canWake?: boolean;
  freePublicAnswers?: boolean;
}
export interface LocalAiRequest {
  id: string; mode: LocalAiMode;
  state: 'payment_required' | 'approval_required' | 'ready' | 'running' | 'settling' | 'completed' | 'failed' | 'interrupted' | 'expired';
  model: string; prompt: string; maxOutputTokens: number; requestFingerprint: string;
  createdAt: string; expiresAt: string; answer: string | null; purgedAt?: string | null; usage: LocalAiRequestUsage | null; error: string | null;
  payment: { state: 'none' | 'quoted' | 'authorized' | 'pending' | 'settled' | 'failed'; amountAtomic: string; receipt: SettleResponse | null };
  review: InferencePaymentReview | null; paymentRequired: PaymentRequired | null; approval: LocalAiApproval | null;
  solanaReview?: SolanaInferenceReview | null;
  host?: { id: string; name: string; own: boolean; payoutWallet: string | null; kind?: 'operator' | 'community' };
  hostScope?: 'own' | 'city'; publicQuestion?: boolean;
}
export interface LocalAiServiceStatus {
  configured: boolean; reachable: boolean; model: string; contextTokens: number; maxOutputTokens: number;
  lastSuccessAt: string | null; modelResident: boolean; vramBytes: number | null; hardwareLabel: string;
  paidEnabled: boolean; error: string | null;
  price: null | { network: 'eip155:46630' | 'solana-devnet'; asset: string; symbol: string; decimals: 6; amountAtomic: string; payTo: string; permit2: string; proxy: string; approvalBudgetAtomic: string };
  wallet: null | { walletId: string; address: string; cashAtomic: string | null; nativeAtomic: string | null; allowanceAtomic: string | null; error: string | null };
  library: { enabled: boolean; maxOutputTokens: number; remainingRequests: number | null };
  hosts?: ConnectorHostStatus[]; hostPairingAllowed?: boolean;
  mode?: 'direct' | 'connector'; availability?: 'online' | 'asleep' | 'offline'; ownHostAvailable?: boolean;
}
export interface LocalAiUsageSummary {
  successfulPaidRequests: number; successfulLibraryRequests: number; failedRequests: number; pendingPayments: number;
  successfulOwnRequests?: number;
  knownInputTokens: number; knownOutputTokens: number; requestsWithoutUsage: number;
  meanWallMs: number | null; meanTokensPerSecond: number | null; settledAtomic: string;
  asset: string | null; network: string | null; model: string; lastSuccessAt: string | null;
}
