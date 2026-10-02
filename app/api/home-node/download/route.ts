import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export const runtime = 'nodejs';
export async function GET() {
  const bytes = await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ process.cwd(), 'home-node/home-node.mjs'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return new Response(bytes, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Disposition': 'attachment; filename="home-node.mjs"', 'X-Content-SHA256': sha256, ETag: `"${sha256}"`, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
}
export async function HEAD() {
  const response = await GET();
  return new Response(null, { headers: response.headers });
}
