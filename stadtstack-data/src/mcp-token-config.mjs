// Shared by the server, private token CLI and approved deployment validation.
// Missing limits retain the legacy policy; token names never imply elevation.
export const DEFAULT_TOKEN_LIMITS = Object.freeze({ requestsPerMinute: 60, maxConcurrent: 4 });
export const MAX_TOKEN_LIMITS = Object.freeze({ requestsPerMinute: 300, maxConcurrent: 8 });

export function validateTokenRecords(value, { allowEmpty = false } = {}) {
  const invalid = () => { throw new Error('Invalid token hash configuration'); };
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 1000) invalid();
  const ids = new Set();
  const hashes = new Set();
  for (const record of value) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        !['id,sha256', 'id,limits,sha256'].includes(Object.keys(record).sort().join(',')) ||
        typeof record.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(record.id) ||
        typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256) ||
        ids.has(record.id) || hashes.has(record.sha256)) invalid();
    if (Object.hasOwn(record, 'limits')) {
      const policy = record.limits;
      if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
          Object.keys(policy).sort().join(',') !== 'maxConcurrent,requestsPerMinute' ||
          !Number.isSafeInteger(policy.requestsPerMinute) || policy.requestsPerMinute < 1 || policy.requestsPerMinute > MAX_TOKEN_LIMITS.requestsPerMinute ||
          !Number.isSafeInteger(policy.maxConcurrent) || policy.maxConcurrent < 1 || policy.maxConcurrent > MAX_TOKEN_LIMITS.maxConcurrent) invalid();
    }
    ids.add(record.id);
    hashes.add(record.sha256);
  }
  // Validate without materializing defaults or changing identity/digest bytes.
  return value;
}
