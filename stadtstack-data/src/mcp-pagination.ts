import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {canonical} from './mcp-source-identity.ts';

const cursorKey = randomBytes(32); // Process-local signing secret; restarts expire cursors.
export function cursorBinding(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function readCursor(cursor: string | undefined, release: string, binding: string): string | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length > 2048) throw Error('Invalid cursor');
  const parts = cursor.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw Error('Invalid cursor');
  const signature = createHmac('sha256', cursorKey).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], 'base64url');
  if (supplied.toString('base64url') !== parts[1] || signature.length !== supplied.length || !timingSafeEqual(signature, supplied)) throw Error('Invalid or expired cursor');
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { throw Error('Invalid cursor'); }
  const payload = z.object({ v: z.literal(1), release: z.string(), binding: z.string(), after: z.string() }).strict().safeParse(decoded);
  if (!payload.success) throw Error('Invalid cursor');
  if (payload.data.release !== release || payload.data.binding !== binding) throw Error('Cursor release or filters mismatch');
  return payload.data.after;
}
export function writeCursor(release: string, binding: string, after: string): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, release, binding, after })).toString('base64url');
  return `${payload}.${createHmac('sha256', cursorKey).update(payload).digest('base64url')}`;
}
export function boundPage<T>(items: readonly T[], key: (item: T) => string, options: { cursor?: string; limit: number }, release: string, binding: string) {
  const after = readCursor(options.cursor, release, binding);
  let start = 0;
  if (after !== undefined) {
    const index = items.findIndex(item => key(item) === after);
    if (index < 0) throw Error('Cursor record not found in released query');
    start = index + 1;
  }
  const page = items.slice(start, start + options.limit);
  return { items: page, total: items.length, nextCursor: start + options.limit < items.length ? writeCursor(release, binding, key(page[page.length - 1])) : null };
}
