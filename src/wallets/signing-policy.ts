import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isAddress as isSolanaAddress,
} from '@solana/kit';
import { decodeFunctionData, isAddress as isEthereumAddress, parseAbi } from 'viem';
import { PERMIT2_ADDRESS } from '@x402/evm';
import { TEST_USDG_ADDRESS } from './inference-token.ts';
import { validateShareDepositTransaction } from './share-deposit-signing.ts';
import type {
  EvmSigningRequest,
  RentalWallet,
  SigningReview,
  SolanaSigningRequest,
} from './types.ts';

function assertFreshReview(review: SigningReview, now: number) {
  if (!review.operationId.trim() || !review.description.trim()) {
    throw new Error('Review an operation before signing.');
  }
  const expiry = Date.parse(review.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) {
    throw new Error('This request has expired. Refresh it before signing.');
  }
}

function assertWallet(
  wallet: RentalWallet | undefined,
  id: string,
  chainType: 'ethereum' | 'solana',
) {
  if (!wallet || wallet.id !== id || wallet.chainType !== chainType || !wallet.connected) {
    throw new Error('Your selected wallet is not available. Sign in again.');
  }
  return wallet;
}

/**
 * Privy reads a transaction's gas limit from `gasLimit`. A server that prepares `gas` (viem's name) would have that
 * field ignored: Privy estimates its own limit, and the server then rejects the signature as a different transaction.
 */
export function privyTransaction(
  transaction: EvmSigningRequest['transaction'] & { gas?: string | number | bigint },
): EvmSigningRequest['transaction'] {
  const { gas, ...rest } = transaction;
  if (gas === undefined) return rest;
  if (rest.gasLimit !== undefined && BigInt(rest.gasLimit) !== BigInt(gas))
    throw new Error('The prepared transaction names two different gas limits.');
  return { ...rest, gasLimit: rest.gasLimit ?? `0x${BigInt(gas).toString(16)}` };
}

export function validateEvmSigningRequest(
  request: EvmSigningRequest,
  wallet: RentalWallet | undefined,
  now = Date.now(),
) {
  assertFreshReview(request, now);
  const selected = assertWallet(wallet, request.walletId, 'ethereum');
  const transaction = request.transaction;
  if (transaction.chainId !== 4663 && transaction.chainId !== 46630) {
    throw new Error('This wallet flow supports Robinhood Chain only.');
  }
  if (!isEthereumAddress(transaction.to))
    throw new Error('The transaction destination is invalid.');
  if (transaction.from && transaction.from.toLowerCase() !== selected.address.toLowerCase()) {
    throw new Error('The transaction was prepared for another wallet.');
  }
  if (request.operationId.startsWith('share-deposit:')) {
    if (!request.shareDeposit) throw new Error('Review the bound share deposit call before signing.');
    validateShareDepositTransaction(transaction, request.shareDeposit, selected.address);
  } else if (request.shareDeposit) {
    throw new Error('Share deposit reviews require a share deposit operation.');
  }
  if (request.operationId.startsWith('local-ai-approval:')) {
    const tx = transaction;
    const decoded = decodeFunctionData({
      abi: parseAbi(['function approve(address,uint256) returns (bool)']),
      data: tx.data as `0x${string}`,
    });
    if (tx.chainId !== 46630 || tx.to.toLowerCase() !== TEST_USDG_ADDRESS.toLowerCase() ||
        decoded.functionName !== 'approve' || decoded.args[0].toLowerCase() !== PERMIT2_ADDRESS.toLowerCase() ||
        decoded.args[1] !== 100000n || (tx.value !== undefined && BigInt(tx.value) !== 0n) ||
        typeof tx.nonce !== 'number' || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 ||
        !tx.gasLimit || BigInt(tx.gasLimit) > 120000n ||
        !tx.maxFeePerGas || BigInt(tx.maxFeePerGas) <= 0n ||
        BigInt(tx.maxFeePerGas) > 100000000000n ||
        (tx.maxPriorityFeePerGas !== undefined && BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas)))
      throw new Error('Inference approval exceeds the finite reviewed testnet allowance.');
  }
  return selected;
}

export function validateSolanaSigningRequest(
  request: SolanaSigningRequest,
  wallet: RentalWallet | undefined,
  now = Date.now(),
) {
  assertFreshReview(request, now);
  const selected = assertWallet(wallet, request.walletId, 'solana');
  if (request.chain !== 'solana:mainnet' && request.chain !== 'solana:devnet') {
    throw new Error('The Solana network is not supported.');
  }
  if (!isSolanaAddress(request.feePayer) || request.feePayer === selected.address) {
    throw new Error('This flow requires a separate fee sponsor.');
  }
  if (request.transaction.length <= 64 || request.transaction.length > 1232) {
    throw new Error('The Solana transaction is invalid.');
  }
  const transaction = getTransactionDecoder().decode(request.transaction);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.staticAccounts[0] !== request.feePayer) {
    throw new Error('The transaction fee payer does not match the sponsor.');
  }
  if (!(selected.address in transaction.signatures)) {
    throw new Error('The transaction was prepared for another wallet.');
  }
  return { wallet: selected, messageBytes: transaction.messageBytes };
}

export function assertUnchangedSolanaMessage(before: Uint8Array, signed: Uint8Array) {
  const after = getTransactionDecoder().decode(signed).messageBytes;
  if (before.length !== after.length || before.some((byte, index) => byte !== after[index])) {
    throw new Error('The signed transaction differs from the reviewed request.');
  }
}
