import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { solanaServicesFor } from '@/server/solana-tenancies';
import { SolanaServiceError } from '@/server/solana-service';
import { RecoveryError } from '@/server/recovery';
import { errorResponse, readBody, sameOrigin } from '@/server/http';

export const runtime = 'nodejs';
const response = (value: unknown) =>
  Response.json(value, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
function failure(error: unknown) {
  if (error instanceof SolanaServiceError || error instanceof RecoveryError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } },
    );
  return errorResponse(error);
}
async function service(request: Request) {
  const configured = (
    await solanaServicesFor(await getStore(), new URL(request.url).searchParams.get('agreement'))
  )?.initialization;
  if (!configured)
    throw new SolanaServiceError(
      503,
      'initialization_unavailable',
      'Configure the reviewed devnet deployment, accepted agreement and separate fee sponsor first.',
    );
  return configured;
}
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    return response(await (await service(request)).status(identity));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    const configured = await service(request);
    if (body.action === 'prepare' && Object.keys(body).length === 1)
      return response({ initialization: await configured.prepare(identity) });
    if (
      body.action === 'sign' &&
      typeof body.signedTxBase64 === 'string' &&
      Object.keys(body).length === 2
    )
      return response({ initialization: await configured.sign(identity, body.signedTxBase64) });
    if (body.action === 'reconcile' && Object.keys(body).length === 1)
      return response({ initialization: await configured.reconcile(identity) });
    if (body.action === 'retry' && Object.keys(body).length === 1)
      return response({ initialization: await configured.retry(identity) });
    throw new SolanaServiceError(400, 'invalid_action', 'Choose a supported initialization action.');
  } catch (error) {
    return failure(error);
  }
}
