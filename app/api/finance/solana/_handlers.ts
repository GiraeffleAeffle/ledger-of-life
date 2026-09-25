import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { SolanaServiceError } from '@/server/solana-service';
import { solanaServicesFor } from '@/server/solana-tenancies';
import { RecoveryError } from '@/server/recovery';
import { errorResponse, readBody, sameOrigin } from '@/server/http';

const response = (value: unknown) =>
  Response.json(value, {
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' },
  });
function failure(error: unknown) {
  if (error instanceof SolanaServiceError || error instanceof RecoveryError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } },
    );
  if (error instanceof Error && /simulation failed|Simulation bank changed/i.test(error.message))
    return Response.json(
      { error: 'The network rejected this step in a dry run. Refresh and try again; if it persists, check your test USDC balance.', code: 'simulation_failed' },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  if (error instanceof Error && error.message === 'RPC unavailable')
    return Response.json({ error: 'The test network is busy. Try again in a moment.', code: 'rpc_busy' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return errorResponse(error);
}
export async function solanaGet(request: Request, id?: string) {
  try {
    const identity = await authenticated(request);
    const service = (
      await solanaServicesFor(await getStore(), new URL(request.url).searchParams.get('agreement'))
    )?.service;
    if (!service)
      return response({
        available: false,
        reason:
          'Configure and verify a test escrow deployment, accepted agreement and fee sponsor first.',
      });
    return response(
      id ? { operation: await service.get(identity, id) } : await service.snapshot(identity),
    );
  } catch (error) {
    return failure(error);
  }
}
export async function solanaPost(
  request: Request,
  action: 'prepare' | 'authorize' | 'reconcile' | 'retry',
  id?: string,
) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const service = (
      await solanaServicesFor(await getStore(), new URL(request.url).searchParams.get('agreement'))
    )?.service;
    if (!service)
      throw new SolanaServiceError(
        503,
        'solana_unavailable',
        'A verified test escrow, accepted agreement and fee sponsor must be configured first.',
      );
    const body = await readBody(request);
    const fields =
      action === 'prepare'
        ? ['requestId', 'action']
        : action === 'authorize'
          ? ['signedTxBase64']
          : [];
    if (Object.keys(body).some((key) => !fields.includes(key)))
      throw new SolanaServiceError(
        400,
        'unexpected_fields',
        'Unexpected financial operation fields.',
      );
    if (action === 'prepare') {
      if (typeof body.requestId !== 'string')
        throw new SolanaServiceError(
          400,
          'request_id_required',
          'Provide a stable request identifier.',
        );
      return response({ operation: await service.prepare(identity, body.requestId, body.action) });
    }
    if (!id) throw new SolanaServiceError(400, 'operation_required', 'An operation is required.');
    if (action === 'authorize') {
      if (typeof body.signedTxBase64 !== 'string')
        throw new SolanaServiceError(400, 'signature_required', 'Return the signed transaction.');
      return response({ operation: await service.authorize(identity, id, body.signedTxBase64) });
    }
    if (action === 'retry') return response({ operation: await service.retry(identity, id) });
    return response({ operation: await service.reconcile(identity, id) });
  } catch (error) {
    return failure(error);
  }
}
