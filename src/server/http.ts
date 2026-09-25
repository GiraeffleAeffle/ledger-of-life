import { timingSafeEqual } from 'node:crypto';
import { WorkflowError } from '../domain/workflow.ts';
import { AccessError, ConflictError, type Access } from './workspaces.ts';
import { IdentityError } from '../wallets/identity-policy.ts';

export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  // Next's development server may rewrite Request.url to a different loopback
  // spelling. Only these local Host spellings are accepted here.
  const host = request.headers.get('host');
  if (
    process.env.NODE_ENV !== 'production' &&
    host &&
    /^(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/.test(host)
  )
    url.host = host;
  if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN)
    throw new Error('APP_ORIGIN is required.');
  const expected = process.env.APP_ORIGIN || url.origin;
  if (origin !== expected)
    throw new AccessError('This action must originate from the application.');
}

export async function readBody(request: Request, maxBytes = 24000): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new WorkflowError('Send JSON.');
  const reader = request.body?.getReader();
  if (!reader) throw new WorkflowError('Send a JSON body.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new WorkflowError('Request too large.');
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const result: unknown = JSON.parse(body);
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new WorkflowError('A JSON object is required.');
  return result as Record<string, unknown>;
}

export function demoSession(request: Request) {
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('rental_demo='))
    ?.slice('rental_demo='.length);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function demoAccess(request: Request, role: unknown): Access {
  const session = demoSession(request);
  if (!session) throw new AccessError('Open a demonstration before continuing.');
  if (role !== 'tenant' && role !== 'landlord' && role !== 'arbitrator')
    throw new WorkflowError('Select a demonstration role.');
  return { kind: 'demo', session, role };
}

export function requireJobSecret(request: Request) {
  const secret = process.env.RECONCILE_SECRET;
  const expected = `Bearer ${secret}`;
  const received = request.headers.get('authorization') || '';
  if (
    !secret ||
    Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  )
    throw new AccessError('Invalid reconciliation authorization.');
}

export function errorResponse(error: unknown) {
  const status =
    error instanceof IdentityError
      ? error.code === 'identity_unavailable'
        ? 503
        : 401
      : error instanceof AccessError
        ? 403
        : error instanceof ConflictError
          ? 409
          : error instanceof WorkflowError || error instanceof SyntaxError
            ? 400
            : 503;
  const message =
    status === 503
      ? 'This service is not configured or temporarily unavailable. Check the connection status and retry.'
      : error instanceof Error
        ? error.message
        : 'The request could not be completed.';
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}
