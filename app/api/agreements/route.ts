import { authenticated } from '@/server/authenticated';
import { createAgreement } from '@/server/agreements';
import { getStore } from '@/server/store';
import { readBody, sameOrigin, errorResponse } from '@/server/http';
import { isNetwork } from '@/domain/assets';
import { WorkflowError } from '@/domain/errors';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    if (
      typeof body.property !== 'string' ||
      typeof body.requiredSecurity !== 'string' ||
      typeof body.releaseAllowed !== 'boolean'
    )
      throw new WorkflowError('A property label, atomic amount and release policy are required.');
    if (!isNetwork(body.network)) throw new WorkflowError('Choose a supported network.');
    return Response.json(
      {
        agreement: await createAgreement(await getStore(), identity, {
          network: body.network,
          property: body.property,
          requiredSecurity: body.requiredSecurity,
          releaseAllowed: body.releaseAllowed,
        }),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
