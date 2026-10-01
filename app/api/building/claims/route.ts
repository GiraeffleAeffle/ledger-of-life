import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { prepareBuildingAction, readBuildingPosition, submitBuildingAction } from '@/server/building-revenue-claims';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request), wallet = identity.wallets.find(wallet => wallet.chainType === 'ethereum');
    if (!wallet) throw new Error('Your account has no Robinhood wallet.');
    return Response.json(await readBuildingPosition(await getStore(), wallet.address), noStore);
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request), wallet = identity.wallets.find(wallet => wallet.chainType === 'ethereum');
    if (!wallet) throw new Error('Your account has no Robinhood wallet.');
    const body = await readBody(request), store = await getStore();
    if (body.action === 'prepare' && typeof body.operation === 'string') {
      if (body.quantity !== undefined && typeof body.quantity !== 'string') throw new Error('Quantity must be atomic tHOME text.');
      return Response.json(await prepareBuildingAction(store, wallet.address, wallet.id, body.operation, body.quantity as string | undefined), noStore);
    }
    if (body.action === 'submit' && typeof body.planId === 'string' && typeof body.signedTransaction === 'string')
      return Response.json(await submitBuildingAction(store, wallet.address, body.planId, body.signedTransaction), noStore);
    throw new Error('Unknown building staking action.');
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Building action unavailable.' }, { status: 409, ...noStore }); }
}
