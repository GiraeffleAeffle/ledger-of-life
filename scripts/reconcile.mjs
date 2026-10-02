// Run from a scheduler or service; this process never has a tenant signing key.
const origin = process.env.APP_ORIGIN;
const secret = process.env.RECONCILE_SECRET;
if (!origin || !secret) throw new Error('APP_ORIGIN and RECONCILE_SECRET are required.');
const failures = [];
for (const scope of ['robinhood', 'solana', 'local-ai', 'price', 'building-income']) {
  try {
    let after = '';
    do {
      const url = new URL('/api/jobs/reconcile', origin);
      url.searchParams.set('scope', scope);
      if (after) url.searchParams.set('after', after);
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok)
        throw new Error(`Reconciliation for ${scope} returned HTTP ${response.status}`);
      const result = await response.json();
      console.log(JSON.stringify(result));
      after = result.nextCursor || '';
    } while (after);
  } catch (error) {
    failures.push({ scope, error: error instanceof Error ? error.message : 'Reconciliation failed.' });
  }
}
if (failures.length) {
  console.error(JSON.stringify({ failures }));
  process.exitCode = 1;
}
