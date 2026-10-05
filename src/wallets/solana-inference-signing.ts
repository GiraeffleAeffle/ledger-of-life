import { address, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { AI_PRICE, AI_MAX_OUTPUT } from '../domain/ai-pricing.ts';
import type { LocalAiApproval, LocalAiRequest } from '../server/local-ai-types.ts';
import type { RentalWallet, SolanaSigningRequest } from './types.ts';

/** Inspect the entire finite SPL approve, not merely a server-provided operation label. */
export async function prepareSolanaInferenceApproval(request: LocalAiRequest, approval: LocalAiApproval, wallet: RentalWallet | undefined, now = Date.now()): Promise<SolanaSigningRequest> {
  const review = request.solanaReview, signing = approval.solanaRequest;
  if (!review || !signing || request.mode !== 'paid' || approval.state !== 'review' ||
      review.requestId !== request.id || review.requestFingerprint !== request.requestFingerprint ||
      !wallet?.connected || wallet.chainType !== 'solana' || wallet.id !== review.walletId || wallet.address !== review.payer ||
      signing.walletId !== review.walletId || signing.operationId !== `local-ai-approval:${request.id}` ||
      signing.chain !== 'solana:devnet' || signing.feePayer !== review.delegate || review.delegate === review.payer ||
      review.asset !== SOLANA_TEST_USDC_MINT || review.priceAtomic !== AI_PRICE.toString() ||
      !Number.isSafeInteger(review.maxOutputTokens) || review.maxOutputTokens < 1 || review.maxOutputTokens > AI_MAX_OUTPUT ||
      review.amountAtomic !== (BigInt(review.maxOutputTokens) * AI_PRICE).toString() || approval.budgetAtomic !== review.amountAtomic ||
      !signing.description || !Number.isFinite(Date.parse(signing.expiresAt)) || Date.parse(signing.expiresAt) <= now ||
      Date.parse(signing.expiresAt) > now + 120_000 || Date.parse(review.expiresAt) <= now)
    throw new Error('The Solana approval does not match this question, maximum price and wallet.');
  const [source] = await findAssociatedTokenPda({ owner: address(review.payer), mint: address(review.asset), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  if (source !== review.source) throw new Error('The allowance source is not your test USDC account.');
  const binary = atob(signing.transactionBase64);
  const transaction = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (transaction.length > 1232 || transaction.length < 64) throw new Error('Invalid Solana approval transaction.');
  const decoded = getTransactionDecoder().decode(transaction);
  const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const ix = message.instructions[0];
  if (message.staticAccounts[0] !== review.delegate || message.header.numSignerAccounts !== 2 ||
      message.header.numReadonlySignerAccounts !== 1 || message.instructions.length !== 1 ||
      ('addressTableLookups' in message && message.addressTableLookups?.length) ||
      Object.keys(decoded.signatures).length !== 2 || !(review.payer in decoded.signatures) ||
      Object.values(decoded.signatures).some(signature => signature?.some(byte => byte !== 0)) ||
      !ix || message.staticAccounts[ix.programAddressIndex] !== TOKEN_PROGRAM_ADDRESS || ix.accountIndices?.length !== 3 ||
      message.staticAccounts[ix.accountIndices[0]] !== review.source ||
      message.staticAccounts[ix.accountIndices[1]] !== review.delegate ||
      message.staticAccounts[ix.accountIndices[2]] !== review.payer ||
      !ix.data || ix.data.length !== 9 || ix.data[0] !== 4 ||
      new DataView(Uint8Array.from(ix.data).buffer).getBigUint64(1, true).toString() !== review.amountAtomic)
    throw new Error('Only the exact one-answer SPL delegate approval may be signed.');
  return { walletId: signing.walletId, operationId: signing.operationId, description: signing.description,
    expiresAt: signing.expiresAt, chain: 'solana:devnet', feePayer: signing.feePayer, transaction };
}
