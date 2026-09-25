import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  getBase58Decoder,
  signature,
} from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { walletFor } from './agreements.ts';
import { solanaConfiguration } from './solana-rpc.ts';
import { SolanaServiceError } from './solana-service.ts';
import type { Store } from './store.ts';

/**
 * Devnet test market for the tenant's personal portfolio: `tSPYx`, a Token-2022 copy of SPYx
 * (no value) with the xStocks scaled-UI-amount mechanism. Buys are one atomic transaction the
 * tenant approves once: test USDC to the test market maker, tSPYx back, at the live mainnet
 * SPYx reference price. Nothing here touches the rental escrow.
 */
const TEST_USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const CLASSIC_TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SPYX_MAINNET = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const DECIMALS = 8;

type PreparedBuy = { id: string; subject: string; wallet: string; messageSha256: string; usdcInAtomic: string; rawOutAtomic: string; expiresAt: number };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Public devnet RPC rate-limits bursts; rate-limited calls were not processed, so retry them. */
function retryingTransport(url: string) {
  const transport = createDefaultRpcTransport({ url });
  return (async (config: Parameters<typeof transport>[0]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(config);
      } catch (error) {
        const context = error && typeof error === 'object' && 'context' in error ? error.context : null;
        const limited = Boolean(context && typeof context === 'object' && 'statusCode' in context && context.statusCode === 429);
        if (!limited || attempt >= 5) throw error;
        const pause = Promise.withResolvers<void>();
        setTimeout(pause.resolve, 400 * 2 ** attempt);
        await pause.promise;
      }
    }
  }) as typeof transport;
}

async function market(environment: Record<string, string | undefined>) {
  const config = solanaConfiguration(environment);
  if (!config || config.cluster !== 'devnet' || environment.SOLANA_TEST_SIGNER_MODE !== '1') return null;
  const dir = resolve(environment.SOLANA_TEST_SIGNER_DIR || '.testnet-secrets/test-signer');
  try {
    const { mint } = JSON.parse(await readFile(resolve(dir, 'market.json'), 'utf8')) as { mint: string };
    const maker = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(resolve(dir, 'market-maker.json'), 'utf8'))));
    return { rpc: createSolanaRpcFromTransport(retryingTransport(config.rpcUrl)), mint: address(mint), maker };
  } catch {
    return null;
  }
}

async function referencePrice() {
  const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SPYX_MAINNET}`, { signal: AbortSignal.timeout(8000) });
  const body: Record<string, { usdPrice?: number }> = await response.json();
  const price = body[SPYX_MAINNET]?.usdPrice;
  if (!response.ok || !price || !(price > 0)) throw new SolanaServiceError(503, 'price_unavailable', 'The reference price is unavailable. Retry shortly.');
  return price;
}

export interface PortfolioView {
  available: true;
  symbol: 'tSPYx';
  testUsdcAtomic: string;
  rawAtomic: string;
  shares: number;
  multiplier: number;
  referencePriceUsd: number;
  valueUsd: number;
}

export async function readPortfolio(identity: VerifiedIdentity, environment = process.env): Promise<PortfolioView | { available: false }> {
  const m = await market(environment);
  if (!m) return { available: false };
  const owner = address(walletFor(identity, 'solana').address);
  const [usdcAta] = await findAssociatedTokenPda({ owner, mint: TEST_USDC, tokenProgram: CLASSIC_TOKEN });
  const [stockAta] = await findAssociatedTokenPda({ owner, mint: m.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const balance = async (account: typeof usdcAta) => {
    try {
      return (await m.rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send()).value.amount;
    } catch {
      return '0';
    }
  };
  const [testUsdcAtomic, rawAtomic, mint, referencePriceUsd] = await Promise.all([
    balance(usdcAta), balance(stockAta), fetchMint(m.rpc, m.mint, { commitment: 'confirmed' }), referencePrice(),
  ]);
  const config = mint.data.extensions.__option === 'Some'
    ? mint.data.extensions.value.find((item) => item.__kind === 'ScaledUiAmountConfig')
    : undefined;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const multiplier = !config || config.__kind !== 'ScaledUiAmountConfig' ? 1
    : now >= config.newMultiplierEffectiveTimestamp ? config.newMultiplier : config.multiplier;
  const shares = (Number(rawAtomic) / 10 ** DECIMALS) * multiplier;
  return { available: true, symbol: 'tSPYx', testUsdcAtomic, rawAtomic, shares, multiplier, referencePriceUsd, valueUsd: Number((shares * referencePriceUsd).toFixed(2)) };
}

/** Builds the atomic buy, co-signed by the market maker (fee payer); the tenant signs next. */
export async function prepareBuy(store: Store, identity: VerifiedIdentity, usdcInAtomic: unknown, environment = process.env) {
  const m = await market(environment);
  if (!m) throw new SolanaServiceError(503, 'market_unavailable', 'The devnet test market is not configured.');
  if (typeof usdcInAtomic !== 'string' || !/^[1-9]\d{0,8}$/.test(usdcInAtomic) || BigInt(usdcInAtomic) > 20_000_000n)
    throw new SolanaServiceError(400, 'invalid_amount', 'Invest between 0 and 20 test USDC.');
  const wallet = walletFor(identity, 'solana');
  const tenant = address(wallet.address);
  const price = await referencePrice();
  const mint = await fetchMint(m.rpc, m.mint, { commitment: 'confirmed' });
  const view = await readPortfolio(identity, environment);
  const multiplier = 'multiplier' in view ? view.multiplier : 1;
  const rawOut = (BigInt(usdcInAtomic) * 10n ** 17n) / (BigInt(Math.round(price * 1e6)) * BigInt(Math.round(multiplier * 1e9)));
  if (rawOut <= 0n) throw new SolanaServiceError(400, 'invalid_amount', 'The amount is too small.');
  const [tenantUsdc] = await findAssociatedTokenPda({ owner: tenant, mint: TEST_USDC, tokenProgram: CLASSIC_TOKEN });
  const [tenantStock] = await findAssociatedTokenPda({ owner: tenant, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const [makerUsdc] = await findAssociatedTokenPda({ owner: m.maker.address, mint: TEST_USDC, tokenProgram: CLASSIC_TOKEN });
  const [makerStock] = await findAssociatedTokenPda({ owner: m.maker.address, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const { value: lifetime } = await m.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(m.maker.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(lifetime, msg),
    (msg) => appendTransactionMessageInstructions([
      getCreateAssociatedTokenIdempotentInstruction({ payer: m.maker, ata: makerUsdc, owner: m.maker.address, mint: TEST_USDC, tokenProgram: CLASSIC_TOKEN }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: m.maker, ata: tenantStock, owner: tenant, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      getTransferCheckedInstruction({ source: tenantUsdc, mint: TEST_USDC, destination: makerUsdc, authority: createNoopSigner(tenant), amount: BigInt(usdcInAtomic), decimals: 6 }, { programAddress: CLASSIC_TOKEN }),
      getTransferCheckedInstruction({ source: makerStock, mint: mint.address, destination: tenantStock, authority: m.maker, amount: rawOut, decimals: DECIMALS }),
    ], msg),
  );
  const compiled = compileTransaction(message);
  const makerSigned = await partiallySignTransaction([m.maker.keyPair], compiled);
  const bytes = new Uint8Array(getTransactionEncoder().encode(makerSigned));
  const prepared: PreparedBuy = {
    id: randomUUID(), subject: identity.subject, wallet: wallet.address, messageSha256: sha(new Uint8Array(compiled.messageBytes)),
    usdcInAtomic, rawOutAtomic: rawOut.toString(), expiresAt: Date.now() + 60_000,
  };
  await store.create(`portfolio-buy:${prepared.id}`, prepared);
  return {
    id: prepared.id, walletId: wallet.id, feePayer: m.maker.address, expiresAt: new Date(prepared.expiresAt).toISOString(),
    transactionBase64: Buffer.from(bytes).toString('base64'), usdcInAtomic, rawOutAtomic: prepared.rawOutAtomic, referencePriceUsd: price,
  };
}

/** Accepts only the exact prepared message, signed by the tenant, then broadcasts and confirms. */
export async function submitBuy(store: Store, identity: VerifiedIdentity, id: unknown, signedTxBase64: unknown, environment = process.env) {
  const m = await market(environment);
  if (!m || typeof id !== 'string' || typeof signedTxBase64 !== 'string')
    throw new SolanaServiceError(400, 'invalid_request', 'Invalid purchase.');
  const prepared = await store.get<PreparedBuy>(`portfolio-buy:${id}`);
  if (!prepared || prepared.subject !== identity.subject) throw new SolanaServiceError(404, 'buy_unavailable', 'Purchase not found.');
  if (prepared.expiresAt < Date.now()) throw new SolanaServiceError(409, 'operation_expired', 'The quote expired. Try again.');
  const tx = getTransactionDecoder().decode(Buffer.from(signedTxBase64, 'base64'));
  if (sha(new Uint8Array(tx.messageBytes)) !== prepared.messageSha256)
    throw new SolanaServiceError(400, 'changed_message', 'The signed purchase differs from the quote.');
  if (!tx.signatures[address(prepared.wallet)] || !tx.signatures[m.maker.address])
    throw new SolanaServiceError(400, 'invalid_signature', 'The purchase is not fully signed.');
  const wire = getBase64EncodedWireTransaction(tx);
  const txSignature = signature(getBase58Decoder().decode(tx.signatures[m.maker.address]!));
  await m.rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  for (let attempt = 0; attempt < 30; attempt++) {
    const { value } = await m.rpc.getSignatureStatuses([txSignature]).send();
    if (value[0]?.err) throw new SolanaServiceError(502, 'buy_failed', 'The purchase failed on the network.');
    if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') return { signature: txSignature, rawOutAtomic: prepared.rawOutAtomic };
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 1500);
    await pause.promise;
  }
  throw new SolanaServiceError(504, 'buy_pending', 'The purchase is still confirming.');
}
