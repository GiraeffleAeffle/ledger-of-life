export interface ReferencePrice {
  usdPrice: number;
  observedAt: string;
  stale: boolean;
}

export class ReferencePriceUnavailable extends Error {
  constructor() {
    super('The reference price is temporarily unavailable. Try again shortly.');
  }
}

const PRICE_TTL_MS = 60_000;
type PriceEntry = { quote?: ReferencePrice; expiresAt: number; inFlight?: Promise<ReferencePrice> };
const prices = new Map<string, PriceEntry>();

/** One Jupiter read per mint per minute, shared across wallets and both test networks. */
export function referencePrice(mint: string): Promise<ReferencePrice> {
  const now = Date.now();
  const entry: PriceEntry = prices.get(mint) ?? { expiresAt: 0 };
  if (entry.expiresAt > now) return entry.quote ? Promise.resolve(entry.quote) : Promise.reject(new ReferencePriceUnavailable());
  if (entry.inFlight) return entry.inFlight;

  const load = (async (): Promise<ReferencePrice> => {
    try {
      const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new ReferencePriceUnavailable();
      const body: Record<string, { usdPrice?: number }> = await response.json();
      const usdPrice = body?.[mint]?.usdPrice;
      if (typeof usdPrice !== 'number' || !Number.isFinite(usdPrice) || usdPrice <= 0)
        throw new ReferencePriceUnavailable();
      const quote = { usdPrice, observedAt: new Date(Date.now()).toISOString(), stale: false };
      entry.quote = quote;
      entry.expiresAt = Date.now() + PRICE_TTL_MS;
      return quote;
    } catch {
      // Keep the last observed value and its original timestamp; do not hammer a throttled feed.
      entry.quote = entry.quote && { ...entry.quote, stale: true };
      entry.expiresAt = Date.now() + PRICE_TTL_MS;
      if (entry.quote) return entry.quote;
      throw new ReferencePriceUnavailable();
    } finally {
      entry.inFlight = undefined;
    }
  })();
  entry.inFlight = load;
  prices.set(mint, entry);
  return load;
}
