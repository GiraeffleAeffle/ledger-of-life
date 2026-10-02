type Access = { identity: string | null; getAccessToken: () => Promise<string | null>; generation: number };

/** Rejects responses from a signed-out or replaced account without replaying requests. */
export async function authorizedRequest<T>(
  path: string,
  body: unknown,
  identity: string | null,
  current: () => Access | null,
): Promise<T> {
  const access = current();
  if (!identity || !access || access.identity !== identity) throw new Error('Sign in again to continue.');
  const isCurrent = () => {
    const latest = current();
    return latest?.generation === access.generation && latest.identity === identity;
  };
  const token = await access.getAccessToken();
  if (!isCurrent() || !token) throw new Error('Sign in again to continue.');
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!isCurrent()) throw new Error('Account changed while loading. Please try again.');
  if (!response.ok) throw Object.assign(new Error(data.error || 'Please try again.'), { code: data.code, status: response.status });
  return data as T;
}
