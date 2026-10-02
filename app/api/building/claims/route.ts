import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { prepareBuildingAction, readBuildingPosition, submitBuildingAction } from '@/server/building-revenue-claims';
import { prepareBuildingReinvest, readBuildingReinvest, startBuildingReinvest, submitBuildingReinvest } from '@/server/building-revenue-reinvest';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request), wallet = identity.wallets.find(wallet => wallet.chainType === 'ethereum');
    if (!wallet) throw new Error('Your account has no Robinhood wallet.');
    const store = await getStore();
    return Response.json({ ...await readBuildingPosition(store, wallet.address), reinvest: await readBuildingReinvest(store, identity) }, noStore);
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request), wallet = identity.wallets.find(wallet => wallet.chainType === 'ethereum');
    if (!wallet) throw new Error('Your account has no Robinhood wallet.');
    const body = await readBody(request), store = await getStore();
    if (body.action === 'reinvest_start') return Response.json({ reinvest: await startBuildingReinvest(store, identity) }, noStore);
    if (body.action === 'reinvest_prepare') return Response.json({ reinvest: await prepareBuildingReinvest(store, identity) }, noStore);
    if (body.action === 'reinvest_submit' && typeof body.stepId === 'string' && typeof body.signedTransaction === 'string')
      return Response.json({ reinvest: await submitBuildingReinvest(store, identity, body.stepId, body.signedTransaction) }, noStore);
    if (body.action === 'prepare' && typeof body.operation === 'string') {
      if (body.quantity !== undefined && typeof body.quantity !== 'string') throw new Error('Quantity must be atomic tHOME text.');
      return Response.json(await prepareBuildingAction(store, wallet.address, wallet.id, body.operation, body.quantity as string | undefined), noStore);
    }
    if (body.action === 'submit' && typeof body.planId === 'string' && typeof body.signedTransaction === 'string')
      return Response.json(await submitBuildingAction(store, wallet.address, body.planId, body.signedTransaction), noStore);
    throw new Error('Unknown building staking action.');
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Building action unavailable.' }, { status: 409, ...noStore }); }
}
