import { createHash, createPublicKey, randomUUID, verify as verifyEd25519 } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  address,
  getAddressEncoder,
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
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { walletFor } from './agreements.ts';
import { solanaConfiguration } from './solana-rpc.ts';
import { SolanaServiceError } from './solana-service.ts';
import { referencePrice, ReferencePriceUnavailable } from './reference-price.ts';
import type { Store } from './store.ts';
import { operatorTestCapability } from './test-capability.ts';

/**
 * Devnet test market for the tenant's personal portfolio: `tSPYx`, a Token-2022 copy of SPYx
 * (no value) with the xStocks scaled-UI-amount mechanism. Buys are one atomic transaction the
 * tenant approves once: test USDC to the test market maker, tSPYx back, at a recent mainnet
 * SPYx reference price. Nothing here touches the rental escrow.
 */
const TEST_USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const CLASSIC_TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SPYX_MAINNET = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const DECIMALS = 8;

type PreparedBuy = {
  id: string; subject: string; wallet: string; messageSha256: string;
  usdcInAtomic: string; rawOutAtomic: string; expiresAt: number; lastValidBlockHeight: string;
  state: 'prepared' | 'signed' | 'finalized' | 'failed';
  signedTxBase64?: string; signature?: string;
};
type BuyAccount = { activeId: string | null; activeState: 'prepared' | 'signed' | null; lastId: string | null; sponsoredCount: number };
const SPONSOR_ATTEMPTS = 5;
const MAX_SPONSOR_DEBIT_LAMPORTS = 10_000_000n;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function signingKey(wallet: string) {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(getAddressEncoder().encode(address(wallet))),
    ]),
    format: 'der',
    type: 'spki',
  });
}

async function buyAccount(store: Store, subject: string) {
  const key = `portfolio-buy-account:${subject}`;
  if (await store.get<BuyAccount>(key)) return key;
  try {
    await store.create<BuyAccount>(key, { activeId: null, activeState: null, lastId: null, sponsoredCount: 0 });
  } catch (error) {
    if (!(await store.get<BuyAccount>(key))) throw error;
  }
  return key;
}

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

async function marketRead(environment: Record<string, string | undefined>) {
  const config = solanaConfiguration(environment);
  if (!config || config.cluster !== 'devnet') return null;
  const dir = resolve(/* turbopackIgnore: true */ environment.SOLANA_TEST_SIGNER_DIR || '.testnet-secrets/test-signer');
  try {
    const { mint } = JSON.parse(await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ dir, 'market.json'), 'utf8')) as { mint: string };
    return { rpc: createSolanaRpcFromTransport(retryingTransport(config.rpcUrl)), rpcUrl: config.rpcUrl, mint: address(mint) };
  } catch {
    return null;
  }
}

async function market(environment: Record<string, string | undefined>) {
  if (!operatorTestCapability(environment)) return null;
  const observed = await marketRead(environment);
  if (!observed) return null;
  const dir = resolve(/* turbopackIgnore: true */ environment.SOLANA_TEST_SIGNER_DIR || '.testnet-secrets/test-signer');
  try {
    const maker = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ dir, 'market-maker.json'), 'utf8'))));
    return { ...observed, maker };
  } catch {
    return null;
  }
}

export interface PortfolioView {
  available: true;
  symbol: 'tSPYx';
  testUsdcAtomic: string;
  rawAtomic: string;
  shares: number;
  multiplier: number;
  referencePriceUsd: number;
  referencePriceObservedAt: string;
  referencePriceStale: boolean;
  valueUsd: number;
}
/** Confirmed amounts without a usable stock valuation (cash remains known). */
export type PortfolioPartial = Pick<PortfolioView, 'available' | 'symbol' | 'testUsdcAtomic' | 'rawAtomic' | 'shares' | 'multiplier'> & {
  status: 'price_unavailable';
  referencePriceUsd: null;
  referencePriceObservedAt: null;
  referencePriceStale: true;
  valueUsd: null;
};

/** Wallet balances remain observable even when Jupiter has no current price. */
export async function readPortfolioPosition(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  stockMint: Address,
): Promise<PortfolioView | PortfolioPartial> {
  const [usdcAta] = await findAssociatedTokenPda({ owner, mint: TEST_USDC, tokenProgram: CLASSIC_TOKEN });
  const [stockAta] = await findAssociatedTokenPda({ owner, mint: stockMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const balance = async (account: typeof usdcAta) => {
    const token = await fetchMaybeToken(rpc, account, { commitment: 'confirmed' });
    return token.exists ? token.data.amount.toString() : '0';
  };
  const [testUsdcAtomic, rawAtomic, mint, quote] = await Promise.all([
    balance(usdcAta), balance(stockAta), fetchMint(rpc, stockMint, { commitment: 'confirmed' }),
    referencePrice(SPYX_MAINNET).catch((error: unknown) => {
      if (!(error instanceof ReferencePriceUnavailable)) throw error;
      return null;
    }),
  ]);
  const config = mint.data.extensions.__option === 'Some'
    ? mint.data.extensions.value.find((item) => item.__kind === 'ScaledUiAmountConfig')
    : undefined;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const multiplier = !config || config.__kind !== 'ScaledUiAmountConfig' ? 1
    : now >= config.newMultiplierEffectiveTimestamp ? config.newMultiplier : config.multiplier;
  const shares = (Number(rawAtomic) / 10 ** DECIMALS) * multiplier;
  if (!quote) return { available: true, status: 'price_unavailable', symbol: 'tSPYx', testUsdcAtomic, rawAtomic,
    shares, multiplier, referencePriceUsd: null, referencePriceObservedAt: null, referencePriceStale: true, valueUsd: null };
  return { available: true, symbol: 'tSPYx', testUsdcAtomic, rawAtomic, shares, multiplier, referencePriceUsd: quote.usdPrice,
    referencePriceObservedAt: quote.observedAt, referencePriceStale: quote.stale, valueUsd: Number((shares * quote.usdPrice).toFixed(2)) };
}

const portfolioReads = new Map<string, { expiresAt: number; wallet: string; result: Promise<PortfolioView | PortfolioPartial> }>();

export async function readPortfolio(identity: VerifiedIdentity, environment = process.env): Promise<PortfolioView | PortfolioPartial | { available: false }> {
  const m = await marketRead(environment);
  if (!m) return { available: false };
  const owner = address(walletFor(identity, 'solana').address);
  const key = `${m.rpcUrl}:${m.mint}:${owner}`;
  const cached = portfolioReads.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const result = readPortfolioPosition(m.rpc, owner, m.mint);
  const entry = { expiresAt: Infinity, wallet: owner, result };
  portfolioReads.set(key, entry);
  if (portfolioReads.size > 128) portfolioReads.delete(portfolioReads.keys().next().value!);
  void result.then(
    () => { if (portfolioReads.get(key) === entry) entry.expiresAt = Date.now() + 4_000; },
    () => { if (portfolioReads.get(key) === entry) portfolioReads.delete(key); },
  );
  return result;
}

/** Builds an unsigned quote; only the person's wallet signs before server-side simulation. */
export async function prepareBuy(store: Store, identity: VerifiedIdentity, usdcInAtomic: unknown, environment = process.env) {
  const m = await market(environment);
  if (!m) throw new SolanaServiceError(503, 'market_unavailable', 'The devnet test market is not configured.');
  if (typeof usdcInAtomic !== 'string' || !/^[1-9]\d{0,8}$/.test(usdcInAtomic) || BigInt(usdcInAtomic) > 20_000_000n)
    throw new SolanaServiceError(400, 'invalid_amount', 'Invest between 0 and 20 test USDC.');
  const accountKey = await buyAccount(store, identity.subject);
  const account = (await store.get<BuyAccount>(accountKey))!;
  if (account.sponsoredCount >= SPONSOR_ATTEMPTS)
    throw new SolanaServiceError(429, 'sponsor_limit', 'This test account has used its sponsored purchase budget.');
  if (account.activeState === 'signed')
    throw new SolanaServiceError(409, 'buy_pending', 'Your existing purchase is still being checked.');
  const wallet = walletFor(identity, 'solana');
  const tenant = address(wallet.address);
  const quote = await referencePrice(SPYX_MAINNET);
  if (quote.stale) throw new SolanaServiceError(503, 'price_unavailable', 'A current reference price is required to prepare a purchase. Try again shortly.');
  const price = quote.usdPrice;
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
  const bytes = new Uint8Array(getTransactionEncoder().encode(compiled));
  const prepared: PreparedBuy = {
    id: randomUUID(), subject: identity.subject, wallet: wallet.address, messageSha256: sha(new Uint8Array(compiled.messageBytes)),
    usdcInAtomic, rawOutAtomic: rawOut.toString(), expiresAt: Date.now() + 60_000,
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(), state: 'prepared',
  };
  await store.create(`portfolio-buy:${prepared.id}`, prepared);
  await store.update<BuyAccount>(accountKey, (current) => {
    if (current.sponsoredCount >= SPONSOR_ATTEMPTS)
      throw new SolanaServiceError(429, 'sponsor_limit', 'This test account has used its sponsored purchase budget.');
    // A signed quote cannot be replaced, even if the response or confirmation timed out.
    if (current.activeState === 'signed' || current.activeId !== account.activeId)
      throw new SolanaServiceError(409, 'buy_pending', 'A purchase is already in progress.');
    return { ...current, activeId: prepared.id, activeState: 'prepared' };
  });
  return {
    id: prepared.id, walletId: wallet.id, feePayer: m.maker.address, expiresAt: new Date(prepared.expiresAt).toISOString(),
    transactionBase64: Buffer.from(bytes).toString('base64'), usdcInAtomic, rawOutAtomic: prepared.rawOutAtomic, referencePriceUsd: price,
  };
}

/** The signed bytes are persisted before broadcast and may safely be rebroadcast as the same transaction. */
export async function purchaseStatus(store: Store, identity: VerifiedIdentity, environment = process.env) {
  const account = await store.get<BuyAccount>(`portfolio-buy-account:${identity.subject}`);
  if (!account?.activeId || account.activeState !== 'signed') {
    const last = account?.lastId ? await store.get<PreparedBuy>(`portfolio-buy:${account.lastId}`) : null;
    if (last?.subject === identity.subject && (last.state === 'finalized' || last.state === 'failed'))
      return { state: last.state, id: last.id, signature: last.signature, rawOutAtomic: last.rawOutAtomic };
    return { state: 'none' as const };
  }
  const key = `portfolio-buy:${account.activeId}`;
  const purchase = await store.get<PreparedBuy>(key);
  if (!purchase?.signedTxBase64 || !purchase.signature)
    return { state: 'pending' as const, id: account.activeId };
  if (purchase.subject !== identity.subject) throw new SolanaServiceError(403, 'buy_owner', 'Purchase owner changed.');
  const m = await market(environment);
  if (!m) return { state: 'pending' as const, id: purchase.id, signature: purchase.signature };
  try {
    const { value } = await m.rpc.getSignatureStatuses([signature(purchase.signature)], { searchTransactionHistory: true }).send();
    const status = value[0];
    if (status?.err || status?.confirmationStatus === 'finalized') {
      const state = status.err ? 'failed' as const : 'finalized' as const;
      await store.update<PreparedBuy>(key, (current) => ({ ...current, state }));
      await store.update<BuyAccount>(`portfolio-buy-account:${identity.subject}`, (current) =>
        current.activeId === purchase.id ? { ...current, activeId: null, activeState: null, lastId: purchase.id } : current);
      if (state === 'finalized') {
        const wallet = walletFor(identity, 'solana').address;
        for (const [cacheKey, read] of portfolioReads)
          if (read.wallet === wallet) portfolioReads.delete(cacheKey);
      }
      return { state, id: purchase.id, signature: purchase.signature, rawOutAtomic: purchase.rawOutAtomic };
    }
    if (!status && BigInt(await m.rpc.getBlockHeight({ commitment: 'finalized' }).send()) <= BigInt(purchase.lastValidBlockHeight)) {
      // A send timeout may mean the RPC never received it. Rebroadcast only the same immutable bytes.
      await m.rpc.sendTransaction(purchase.signedTxBase64 as Parameters<typeof m.rpc.sendTransaction>[0], {
        encoding: 'base64', preflightCommitment: 'confirmed',
      }).send();
    }
  } catch {
    // RPC timeouts are ambiguous: never clear the reservation or offer a new buy.
  }
  return { state: 'pending' as const, id: purchase.id, signature: purchase.signature };
}

/** Verify the exact prepared quote and buyer signature, simulate and budget, then sign and persist. */
export async function submitBuy(store: Store, identity: VerifiedIdentity, id: unknown, signedTxBase64: unknown, environment = process.env) {
  const m = await market(environment);
  if (!m || typeof id !== 'string' || typeof signedTxBase64 !== 'string' || signedTxBase64.length > 1800)
    throw new SolanaServiceError(400, 'invalid_request', 'Invalid purchase.');
  const key = `portfolio-buy:${id}`;
  const prepared = await store.get<PreparedBuy>(key);
  if (!prepared || prepared.subject !== identity.subject) throw new SolanaServiceError(404, 'buy_unavailable', 'Purchase not found.');
  if (prepared.state !== 'prepared') return purchaseStatus(store, identity, environment);
  if (prepared.expiresAt < Date.now()) throw new SolanaServiceError(409, 'operation_expired', 'The quote expired. Try again.');
  const raw = Buffer.from(signedTxBase64, 'base64');
  if (raw.length > 1232 || raw.toString('base64') !== signedTxBase64)
    throw new SolanaServiceError(400, 'invalid_signature', 'Invalid transaction encoding.');
  const tx = getTransactionDecoder().decode(raw);
  if (sha(new Uint8Array(tx.messageBytes)) !== prepared.messageSha256 || Object.keys(tx.signatures).length !== 2)
    throw new SolanaServiceError(400, 'changed_message', 'The signed purchase differs from the quote.');
  const buyerSig = tx.signatures[address(prepared.wallet)];
  const makerSig = tx.signatures[m.maker.address];
  if (!buyerSig || !verifyEd25519(null, Buffer.from(tx.messageBytes), signingKey(prepared.wallet), Buffer.from(buyerSig)) ||
    (makerSig && makerSig.some((byte) => byte !== 0)))
    throw new SolanaServiceError(400, 'invalid_signature', 'Only your valid wallet signature may be submitted.');
  if (BigInt((await m.rpc.getBlockHeight({ commitment: 'confirmed' }).send())) >= BigInt(prepared.lastValidBlockHeight))
    throw new SolanaServiceError(409, 'operation_expired', 'The quote expired on the network. Try again.');
  const [before, simulation] = await Promise.all([
    m.rpc.getBalance(m.maker.address, { commitment: 'confirmed' }).send(),
    m.rpc.simulateTransaction(getBase64EncodedWireTransaction(tx), {
      encoding: 'base64', sigVerify: false, commitment: 'confirmed',
      accounts: { addresses: [m.maker.address], encoding: 'base64' },
    }).send(),
  ]);
  const after = simulation.value.accounts[0]?.lamports;
  if (simulation.value.err || after === undefined)
    throw new SolanaServiceError(409, 'buy_simulation_failed', 'The test purchase could not be simulated. Check your test USDC balance.');
  const debit = before.value - after;
  if (debit < 0n || debit > MAX_SPONSOR_DEBIT_LAMPORTS)
    throw new SolanaServiceError(429, 'sponsor_limit', 'The purchase exceeds the test fee sponsor budget.');
  const accountKey = await buyAccount(store, identity.subject);
  await store.update<BuyAccount>(accountKey, (current) => {
    if (current.activeId !== id || current.activeState !== 'prepared')
      throw new SolanaServiceError(409, 'buy_pending', 'Another purchase is already being checked.');
    if (current.sponsoredCount >= SPONSOR_ATTEMPTS)
      throw new SolanaServiceError(429, 'sponsor_limit', 'This test account has used its sponsored purchase budget.');
    return { ...current, activeId: id, activeState: 'signed', sponsoredCount: current.sponsoredCount + 1 };
  });
  const fullySigned = await partiallySignTransaction([m.maker.keyPair], tx);
  if (sha(new Uint8Array(fullySigned.messageBytes)) !== prepared.messageSha256)
    throw new Error('The fee payer changed the approved purchase.');
  const signedBuyer = fullySigned.signatures[address(prepared.wallet)];
  const signedMaker = fullySigned.signatures[m.maker.address];
  if (!signedBuyer || !Buffer.from(signedBuyer).equals(Buffer.from(buyerSig)) ||
    !signedMaker || !verifyEd25519(null, Buffer.from(fullySigned.messageBytes), signingKey(m.maker.address), Buffer.from(signedMaker)))
    throw new Error('Purchase signatures changed during sponsorship.');
  const txSignature = getBase58Decoder().decode(signedMaker);
  await store.update<PreparedBuy>(key, (current) => {
    if (current.state !== 'prepared' || current.messageSha256 !== prepared.messageSha256)
      throw new SolanaServiceError(409, 'buy_pending', 'The purchase was already signed.');
    return {
      ...current, state: 'signed', signedTxBase64: Buffer.from(getTransactionEncoder().encode(fullySigned)).toString('base64'),
      signature: txSignature,
    };
  });
  return purchaseStatus(store, identity, environment);
}
