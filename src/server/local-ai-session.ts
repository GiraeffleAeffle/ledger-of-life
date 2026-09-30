import { randomBytes } from 'node:crypto';
import type { Store } from './store.ts';
import { AccessError } from './errors.ts';

const revokedKey = (token: string) => `local-ai:visitor-revoked:${token}`;
export interface VisitorLease { assertActive(): void; release(): void }
const sessions = globalThis as typeof globalThis & { __localAiVisitorLeases?: Map<string, Set<{ active: boolean }>> };
const leases = sessions.__localAiVisitorLeases ??= new Map();
/** The synchronous lease check fences answer persistence against same-replica revocation. */
export async function acquireVisitorLease(store: Store, token: string): Promise<VisitorLease> {
  const lease = { active: true };
  const group = leases.get(token) ?? new Set<{ active: boolean }>();
  leases.set(token, group); group.add(lease);
  const release = () => { group.delete(lease); if (!group.size) leases.delete(token); };
  const assertActive = () => { if (!lease.active) throw new AccessError('This private library session has ended. Start a new session.'); };
  try { await assertVisitorActive(store, token); assertActive(); }
  catch (error) { release(); throw error; }
  return { assertActive, release };
}
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
  for (const lease of leases.get(token) ?? []) lease.active = false;
  try { await store.create(revokedKey(token), { revokedAt: new Date().toISOString() }); }
  catch (error) { if (!await store.get(revokedKey(token))) throw error; }
}
export function visitorCookie(token: string, expired = false) {
  return `local_ai_visitor=${expired ? '' : token}; HttpOnly; SameSite=Strict; Path=/api/local-ai; Max-Age=${expired ? 0 : 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
