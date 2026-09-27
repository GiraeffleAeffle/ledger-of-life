import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { readBody, sameOrigin } from '@/server/http';
import {
  controlShareMarket, prepareShareAction, readShareWorkflows, startShareMarket, submitShareTransaction,
} from '@/server/share-workflows';
import { addSimulatedShareYield, prepareDemoPosition, prepareShareEarnings, readShareEarnings, startShareEarnings, submitShareEarnings } from '@/server/share-earnings';
import { operatorTestCapability } from '@/server/test-capability';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

/** The signed-in wallet owns its positions; operator signers are never obtained from a request body. */
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    const wallet = identity.wallets.find((item) => item.chainType === 'ethereum');
    if (!wallet) throw new Error('Your account has no Robinhood Chain wallet yet.');
    const store = await getStore();
    const [workflow, earnings] = await Promise.all([readShareWorkflows(store, wallet.address), readShareEarnings(store, wallet.address)]);
    return Response.json({ workflow: { ...workflow, earnings } }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unavailable' }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const wallet = identity.wallets.find((item) => item.chainType === 'ethereum');
    if (!wallet) throw new Error('Your account has no Robinhood Chain wallet yet.');
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
      return Response.json(await controlShareMarket(store, wallet.address, body.operation), noStore);
    throw new Error('Unknown share workflow action.');
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Please try again.' }, { status: 409 });
  }
}
