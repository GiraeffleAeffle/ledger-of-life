import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { readPriceJob, shapePriceJob } from '@/server/price-job-health';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { prepareMarketAction, readSharedMarket, readUnhealthyLoans, submitMarketTransaction } from '@/server/shared-market';
import { solanaSharesConfiguration } from '@/server/solana-shares-config';
import { readSolanaSharedMarket, prepareSolanaMarketAction, submitSolanaMarketAction, reconcileSolanaMarketAction, cancelSolanaMarketAction, readSolanaUnhealthyLoans } from '@/server/shared-market-solana';
import { walletFor } from '@/server/agreements';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
const pendingReads = new Map<string, Promise<unknown>>();

/** The identity, never request data, selects the personal signing wallet. */
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request), query = new URL(request.url).searchParams;
    const selection = query.get('network');
    if (selection !== null && selection !== 'robinhood' && selection !== 'solana-devnet') throw new Error('Unknown test-network pool.');
    const manifest = selection === 'robinhood' ? null : await solanaSharesConfiguration();
    if (selection === 'solana-devnet' && !manifest) throw new Error('Solana shares are not configured.');
    if (manifest) {
      const wallet = walletFor(identity, 'solana'), store = await getStore(), options = { manifest };
      if (query.get('view') === 'unhealthy') {
        const pageSize = query.get('pageSize') ?? '20';
        if (!/^[1-9][0-9]?$/.test(pageSize)) throw new Error('Invalid liquidation page size.');
        return Response.json({ page: await readSolanaUnhealthyLoans(store, identity, query.get('cursor') ?? '0', Number(pageSize), options) }, noStore);
      }
      const key = `solana:${identity.subject}:${wallet.address}`;
      let pending = pendingReads.get(key);
      if (!pending) {
        pending = readSolanaSharedMarket(store, identity, options); pendingReads.set(key, pending);
        const clear = () => { if (pendingReads.get(key) === pending) pendingReads.delete(key); }; void pending.then(clear, clear);
      }
      return Response.json({ workflow: await pending }, noStore);
    }
    const wallet = walletFor(identity, 'robinhood');
    if (query.get('view') === 'unhealthy') {
      const pageSize = query.get('pageSize') ?? '20';
      if (!/^[1-9][0-9]?$/.test(pageSize)) throw new Error('Invalid liquidation page size.');
      return Response.json({ page: await readUnhealthyLoans(await getStore(), wallet.address, query.get('cursor') ?? '0', Number(pageSize)) }, noStore);
    }
    const key = `robinhood:${wallet.address.toLowerCase()}`;
    let pending = pendingReads.get(key);
    if (!pending) {
      pending = readSharedMarket(wallet.address); pendingReads.set(key, pending);
      const clear = () => { if (pendingReads.get(key) === pending) pendingReads.delete(key); }; void pending.then(clear, clear);
    }
    const workflow = await pending as Record<string, unknown>;
    const priceJob = await getStore().then(readPriceJob).then(record => shapePriceJob(record, Math.floor(Date.now() / 1000))).catch(() => null);
    return Response.json({ workflow: { ...workflow, network: 'robinhood', priceJob } }, noStore);
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  let affectedKey: string | undefined;
  try {
    sameOrigin(request);
    const identity = await authenticated(request), body = await readBody(request), store = await getStore();
    if (body.network !== undefined && body.network !== 'robinhood' && body.network !== 'solana-devnet') throw new Error('Unknown test-network pool.');
    const manifest = body.network === 'robinhood' ? null : await solanaSharesConfiguration();
    if (body.network === 'solana-devnet' && !manifest) throw new Error('Solana shares are not configured.');
    if (manifest) {
      const wallet = walletFor(identity, 'solana'); affectedKey = `solana:${identity.subject}:${wallet.address}`;
      const options = { manifest };
      if (body.action === 'prepare') return Response.json(await prepareSolanaMarketAction(store, identity, body, options), noStore);
      if (typeof body.id !== 'string') throw new Error('The exact reviewed operation ID is required.');
      if (body.action === 'submit' && typeof body.signedTransactionBase64 === 'string') return Response.json(await submitSolanaMarketAction(store, identity, body.id, body.signedTransactionBase64, options), noStore);
      if (body.action === 'reconcile') return Response.json(await reconcileSolanaMarketAction(store, identity, body.id, options), noStore);
      if (body.action === 'cancel') return Response.json(await cancelSolanaMarketAction(store, identity, body.id, options), noStore);
      throw new Error('Unknown Solana lending action.');
    }
    const wallet = walletFor(identity, 'robinhood'); affectedKey = `robinhood:${wallet.address.toLowerCase()}`;
    if (body.action === 'prepare' && typeof body.operation === 'string') return Response.json({ walletId: wallet.id, ...await prepareMarketAction(store, wallet.address, body.operation, typeof body.quantity === 'string' ? body.quantity : undefined, typeof body.borrower === 'string' ? body.borrower : undefined) }, noStore);
    if (body.action === 'submit' && typeof body.signed === 'string') return Response.json(await submitMarketTransaction(store, wallet.address, body.signed), noStore);
    throw new Error('Unknown share workflow action.');
  } catch (error) { return errorResponse(error); }
  finally { if (affectedKey) pendingReads.delete(affectedKey); }
}
