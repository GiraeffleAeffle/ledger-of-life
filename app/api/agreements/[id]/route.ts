import { authenticated } from '@/server/authenticated';
import {
  getAgreement,
  inviteToAgreement,
  joinAgreement,
  acceptAgreement,
  addAgreementRecord,
  previewAgreementInvitation,
} from '@/server/agreements';
import { getStore } from '@/server/store';
import { readBody, sameOrigin, errorResponse } from '@/server/http';
import { WorkflowError } from '@/domain/errors';
import { cancelAgreement } from '@/server/tenancy-cancellation';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    return Response.json(
      {
        agreement: await getAgreement(
          await getStore(),
          (await context.params).id,
          await authenticated(request),
        ),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    const store = await getStore();
    const { id } = await context.params;
    if (body.action === 'cancel')
      return Response.json(
        { agreement: await cancelAgreement(store, id, identity) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    if (body.action === 'preview' && (body.role === 'tenant' || body.role === 'arbitrator') && typeof body.token === 'string')
      return Response.json(
        { invitation: await previewAgreementInvitation(store, id, body.role, body.token) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    if (body.action === 'invite' && (body.role === 'tenant' || body.role === 'arbitrator'))
      return Response.json(
        { invitation: await inviteToAgreement(store, id, identity, body.role) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    if (
      body.action === 'join' &&
      (body.role === 'tenant' || body.role === 'arbitrator') &&
      typeof body.token === 'string'
    )
      return Response.json(
        { agreement: await joinAgreement(store, id, identity, body.role, body.token) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    if (body.action === 'accept' && typeof body.digest === 'string')
      return Response.json(
        { agreement: await acceptAgreement(store, id, identity, body.digest) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    if (body.action === 'record' && typeof body.name === 'string' && typeof body.body === 'string')
      return Response.json(
        { agreement: await addAgreementRecord(store, id, identity, body.name, body.body, typeof body.operationId === 'string' ? body.operationId : undefined) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    throw new WorkflowError('Choose an invitation, join, acceptance, cancellation or evidence action.');
  } catch (error) {
    return errorResponse(error);
  }
}
