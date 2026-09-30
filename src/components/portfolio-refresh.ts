export interface PortfolioSnapshot<T> {
  view: T | null;
  checkedAt: number | null;
  unavailable: boolean;
}

/** Keeps settled holdings visible through outages and discards older read completions. */
export function createPortfolioRefresh<T extends { available: true }>(
  read: () => Promise<T | { available: false }>,
  publish: (snapshot: PortfolioSnapshot<T>) => void,
  now: () => number = Date.now,
) {
  let sequence = 0;
  let snapshot: PortfolioSnapshot<T> = { view: null, checkedAt: null, unavailable: false };
  return {
    async refresh(): Promise<boolean | null> {
      const current = ++sequence;
      try {
        const portfolio = await read();
        if (current !== sequence) return null;
        if (portfolio.available) {
          snapshot = { view: portfolio as T, checkedAt: now(), unavailable: false };
        } else {
          snapshot = { ...snapshot, unavailable: true };
        }
        publish(snapshot);
        return portfolio.available;
      } catch (error) {
        if (current !== sequence) return null;
        snapshot = { ...snapshot, unavailable: true };
        publish(snapshot);
        throw error;
      }
    },
    dispose() {
      ++sequence;
    },
  };
}
