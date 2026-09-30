import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { prepareMarketAction, readSharedMarket, readUnhealthyLoans, submitMarketTransaction } from '@/server/shared-market';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
// Money and workflow detail mount together. Only share an in-progress read for
// the same authenticated wallet; never retain a snapshot across transactions.
const pendingReads = new Map<string, Promise<unknown>>();

/** The signed-in wallet owns its positions; operator signers are never obtained from a request body. */
export async function GET(request: Request) {
  let identity;
  try {
    identity = await authenticated(request);
  } catch (error) {
    return errorResponse(error);
  }
  const wallet = identity.wallets.find((item) => item.chainType === 'ethereum');
  if (!wallet) return Response.json({ error: 'Your account has no Robinhood Chain wallet yet.' }, { status: 400 });
  try {
    const query = new URL(request.url).searchParams;
    if (query.get('view') === 'unhealthy') {
      const pageSize = query.get('pageSize') ?? '20';
      if (!/^[1-9][0-9]?$/.test(pageSize)) throw new Error('Invalid liquidation page size.');
      const page = await readUnhealthyLoans(await getStore(), wallet.address, query.get('cursor') ?? '0', Number(pageSize));
      return Response.json({ page }, noStore);
    }
    const key = wallet.address.toLowerCase();
    let pending = pendingReads.get(key);
    if (!pending) {
      pending = readSharedMarket(wallet.address);
      pendingReads.set(key, pending);
      const clear = () => { if (pendingReads.get(key) === pending) pendingReads.delete(key); };
      void pending.then(clear, clear);
    }
    const workflow = await pending;
    return Response.json({ workflow }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Workflow positions unavailable.' }, { status: 503, ...noStore });
  }
}

export async function POST(request: Request) {
  let affectedWallet: string | undefined;
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const wallet = identity.wallets.find((item) => item.chainType === 'ethereum');
    if (!wallet) throw new Error('Your account has no Robinhood Chain wallet yet.');
    affectedWallet = wallet.address.toLowerCase();
    const body = await readBody(request);
    const store = await getStore();
    if (body.action === 'prepare' && typeof body.operation === 'string')
      return Response.json({ walletId: wallet.id, ...await prepareMarketAction(store, wallet.address, body.operation, typeof body.quantity === 'string' ? body.quantity : undefined, typeof body.borrower === 'string' ? body.borrower : undefined) }, noStore);
    if (body.action === 'submit' && typeof body.signed === 'string')
      return Response.json(await submitMarketTransaction(store, wallet.address, body.signed), noStore);
    throw new Error('Unknown share workflow action.');
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Please try again.' }, { status: 409 });
  } finally {
    if (affectedWallet) pendingReads.delete(affectedWallet);
  }
}
