import { authenticated } from '@/server/authenticated';
import { prepareBuy, purchaseStatus, readPortfolio, submitBuy } from '@/server/portfolio';
import { SolanaServiceError } from '@/server/solana-service';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };
function failure(error: unknown) {
  if (error instanceof SolanaServiceError)
    return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  return errorResponse(error);
}
export async function GET(request: Request) {
  try {
    return Response.json({ portfolio: await readPortfolio(await authenticated(request)) }, noStore);
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    const store = await getStore();
    if (body.action === 'prepare_buy') return Response.json({ buy: await prepareBuy(store, identity, body.usdcInAtomic) }, noStore);
    if (body.action === 'submit_buy') return Response.json({ result: await submitBuy(store, identity, body.id, body.signedTxBase64) }, noStore);
    if (body.action === 'purchase_status') return Response.json({ result: await purchaseStatus(store, identity) }, noStore);
    throw new SolanaServiceError(400, 'invalid_action', 'Choose prepare_buy, submit_buy or purchase_status.');
  } catch (error) {
    return failure(error);
  }
}
