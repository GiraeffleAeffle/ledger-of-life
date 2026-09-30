import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import {
  controlShareMarket, prepareShareAction, startShareMarket, submitShareTransaction,
} from '@/server/share-workflows';
import { addSimulatedShareYield, prepareDemoPosition, prepareShareEarnings, readShareOverview, startShareEarnings, submitShareEarnings } from '@/server/share-earnings';
import { operatorTestCapability } from '@/server/test-capability';

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
    const key = wallet.address.toLowerCase();
    let pending = pendingReads.get(key);
    if (!pending) {
      pending = getStore().then((store) => readShareOverview(store, wallet.address));
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
      return Response.json({ walletId: wallet.id, steps: await prepareShareAction(store, wallet.address, body.operation, typeof body.quantity === 'string' ? body.quantity : undefined) }, noStore);
    if (body.action === 'submit' && typeof body.signed === 'string')
      return Response.json(await submitShareTransaction(store, wallet.address, body.signed), noStore);
    if (body.action === 'earn_prepare' && typeof body.operation === 'string')
      return Response.json({ walletId: wallet.id, steps: await prepareShareEarnings(store, wallet.address, body.operation) }, noStore);
    if (body.action === 'earn_submit' && typeof body.signed === 'string')
      return Response.json(await submitShareEarnings(store, wallet.address, body.signed), noStore);
    if (!operatorTestCapability()) throw new Error('Test market controls are disabled.');
    if (body.action === 'prepare_demo') return Response.json({ result: await prepareDemoPosition(store, wallet.address) }, noStore);
    if (body.action === 'earn_start') return Response.json({ result: await startShareEarnings(store, wallet.address) }, noStore);
    if (body.action === 'earn_yield') return Response.json({ result: await addSimulatedShareYield(store, wallet.address) }, noStore);
    if (body.action === 'start') return Response.json({ deployment: await startShareMarket(store, wallet.address) }, noStore);
    if (body.action === 'control' && typeof body.operation === 'string')
      return Response.json(await controlShareMarket(store, wallet.address, body.operation, typeof body.requestId === 'string' ? body.requestId : undefined), noStore);
    throw new Error('Unknown share workflow action.');
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Please try again.' }, { status: 409 });
  } finally {
    if (affectedWallet) pendingReads.delete(affectedWallet);
  }
}
