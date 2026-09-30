import { authenticated } from '@/server/authenticated';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { getStore } from '@/server/store';
import { prepareShareEarnings, readShareEarnings, shareEarningsEnabled, startShareEarnings, submitShareEarnings } from '@/server/share-earnings';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    if (!shareEarningsEnabled()) return Response.json({ enabled: false, earnings: null }, noStore);
    const wallet = identity.wallets.find((item) => item.chainType === 'ethereum');
    return Response.json({ enabled: true, earnings: wallet ? await readShareEarnings(await getStore(), wallet.address) : null }, noStore);
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  let identity;
  let body;
  try {
    sameOrigin(request);
    identity = await authenticated(request);
    body = await readBody(request);
    // Origin, identity and request-shape failures keep their normal HTTP mapping.
  } catch (error) { return errorResponse(error); }
  try {
    if (!shareEarningsEnabled()) throw new Error('The earnings rehearsal is available only in local test mode.');
    const wallet = identity.wallets.find((item) => item.chainType === 'ethereum');
    if (!wallet) throw new Error('Your account needs an Ethereum wallet.');
    const store = await getStore();
    if (body.action === 'setup') return Response.json({ earnings: await startShareEarnings(store, wallet.address) }, noStore);
    if (body.action === 'prepare' && typeof body.operation === 'string')
      return Response.json({ walletId: wallet.id, steps: await prepareShareEarnings(store, wallet.address, body.operation) }, noStore);
    if (body.action === 'submit' && typeof body.signed === 'string')
      return Response.json(await submitShareEarnings(store, wallet.address, body.signed), noStore);
    throw new Error('Unknown earnings action.');
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Please try again.' }, { status: 409, ...noStore });
  }
}
