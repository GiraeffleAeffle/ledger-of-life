import { authenticated } from '@/server/authenticated';
import { IdentityError } from '@/server/identity';
import { readBody, sameOrigin } from '@/server/http';
import { readServiceCharges, saveServiceChargePrepayment } from '@/server/service-charges';
import { getStore } from '@/server/store';
import { AccessError } from '@/server/workspaces';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    const agreementId = new URL(request.url).searchParams.get('agreement') ?? '';
    return Response.json({ account: await readServiceCharges(await getStore(), identity, agreementId) }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unavailable' }, { status: error instanceof IdentityError ? 401 : error instanceof AccessError ? 403 : 400 });
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    if (body.action !== 'set_prepayment' || typeof body.agreementId !== 'string') throw new Error('Choose a tenancy.');
    return Response.json({ account: await saveServiceChargePrepayment(await getStore(), identity, body.agreementId, body.prepaymentCents as number) }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Please try again.' }, { status: error instanceof IdentityError ? 401 : error instanceof AccessError ? 403 : 409 });
  }
}
