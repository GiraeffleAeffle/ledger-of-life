import { randomBytes } from 'node:crypto';
import type { Store } from './store.ts';
import { AccessError } from './errors.ts';

const revokedKey = (token: string) => `local-ai:visitor-revoked:${token}`;
export function visitorToken(request: Request) {
  return request.headers.get('cookie')?.match(/(?:^|;\s*)local_ai_visitor=([a-f0-9]{64})(?:;|$)/)?.[1] ?? null;
}
export function newVisitorToken() {
  return randomBytes(32).toString('hex');
}
export async function assertVisitorActive(store: Store, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token) || await store.get(revokedKey(token)))
    throw new AccessError('This private library session has ended. Start a new session.');
}
export async function revokeVisitor(store: Store, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AccessError('Invalid private library session.');
  try { await store.create(revokedKey(token), { revokedAt: new Date().toISOString() }); }
  catch (error) { if (!await store.get(revokedKey(token))) throw error; }
}
export function visitorCookie(token: string, expired = false) {
  return `local_ai_visitor=${expired ? '' : token}; HttpOnly; SameSite=Strict; Path=/api/local-ai; Max-Age=${expired ? 0 : 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
