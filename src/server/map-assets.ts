const UPSTREAM = 'https://tiles.openfreemap.org';
const PREFIX = '/api/map';
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_BYTES = 24 * 1024 * 1024;
const TTL = 60 * 60 * 1000;
const cache = new Map<string, { body: Uint8Array; type: string; expires: number }>();
let cacheBytes = 0;

export function allowedMapPath(path: string, templates = false): boolean {
  if (path.length > 512 || /[\\?#\x00-\x1f]/.test(path) || path.includes('..')) return false;
  if (path === '/styles/liberty' || path === '/planet') return true;
  if (/^\/sprites\/ofm_[a-z0-9]+\/ofm(?:@2x)?(?:\.(?:json|png))?$/.test(path)) return true;
  if (/^\/fonts\/[A-Za-z0-9 ,_-]{1,160}\/(?:\d+-\d+|\{range\})\.pbf$/.test(path)) return templates || !path.includes('{');
  if (templates && path === '/fonts/{fontstack}/{range}.pbf') return true;
  const match = path.match(/^\/(?:planet\/\d{8}_\d{6}_pt|natural_earth\/ne2sr)\/(\d+|\{z\})\/(\d+|\{x\})\/(\d+|\{y\})\.(pbf|png)$/);
  if (!match || (path.startsWith('/planet/') ? match[4] !== 'pbf' : match[4] !== 'png')) return false;
  if (templates && match[1] === '{z}' && match[2] === '{x}' && match[3] === '{y}') return true;
  const [z, x, y] = match.slice(1, 4).map(Number);
  return Number.isInteger(z) && z >= 0 && z <= 22 && Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
}

export function rewriteMapAssets(value: unknown, key = '', origin = ''): unknown {
  if (typeof value === 'string' && ['url', 'tiles', 'glyphs', 'sprite'].includes(key)) {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== UPSTREAM || url.search || url.hash || !allowedMapPath(path, true)) throw new Error('Unsupported map asset');
    const local = PREFIX + url.pathname.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
    // MapLibre 6 requires an absolute sprite base URL.
    return key === 'sprite' && origin ? new URL(local, origin).href : local;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteMapAssets(item, key, origin));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rewriteMapAssets(item, name, origin)]));
  return value;
}

export async function mapAssetResponse(path: string, origin = ''): Promise<Response> {
  if (!allowedMapPath(path) || /\/ofm(?:@2x)?$/.test(path)) return new Response('Not found', { status: 404 });
  const cacheKey = path.startsWith('/styles/') ? origin + path : path;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return respond(cached.body, cached.type);
  try {
    // No browser headers, cookies, IP forwarding or redirects reach the provider.
    const upstream = await fetch(UPSTREAM + path.split('/').map(encodeURIComponent).join('/'), {
      redirect: 'error', signal: AbortSignal.timeout(10_000), cache: 'no-store',
    });
    if (!upstream.ok || !upstream.body) return new Response('Map asset unavailable', { status: 502 });
    if (Number(upstream.headers.get('content-length')) > MAX_BYTES) throw new Error('Map asset too large');
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Map asset too large'); }
      chunks.push(value);
    }
    let body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const json = path === '/planet' || path.startsWith('/styles/') || path.endsWith('.json');
    const type = json ? 'application/json' : path.endsWith('.png') ? 'image/png' : 'application/x-protobuf';
    if (json) body = new TextEncoder().encode(JSON.stringify(rewriteMapAssets(JSON.parse(new TextDecoder().decode(body)), '', origin)));
    if (cached) { cache.delete(cacheKey); cacheBytes -= cached.body.byteLength; }
    while (cacheBytes + body.byteLength > CACHE_BYTES || cache.size >= 128) {
      const key = cache.keys().next().value;
      if (key === undefined) break;
      cacheBytes -= cache.get(key)!.body.byteLength;
      cache.delete(key);
    }
    cache.set(cacheKey, { body, type, expires: Date.now() + TTL });
    cacheBytes += body.byteLength;
    return respond(body, type);
  } catch {
    return new Response('Map asset unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

function respond(body: Uint8Array, type: string): Response {
  return new Response(body as Uint8Array<ArrayBuffer>, { headers: {
    'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff',
  } });
}
