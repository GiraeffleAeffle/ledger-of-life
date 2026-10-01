import { authenticated } from '@/server/authenticated';
import { claimDepositYield } from '@/server/deposit-yield';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { getStore } from '@/server/store';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    if (typeof body.agreementId !== 'string' || typeof body.requestId !== 'string'
      || Object.keys(body).some((key) => key !== 'agreementId' && key !== 'requestId'))
      return Response.json({ error: 'Choose a tenancy and a stable claim request id; no amount or recipient is accepted.' }, { status: 400 });
    return Response.json(await claimDepositYield(await getStore(), identity, body.agreementId, body.requestId), {
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' },
    });
  } catch (error) { return errorResponse(error); }
}
