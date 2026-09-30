import type { RobinhoodHoldings, RobinhoodPartialHoldings } from '@/server/robinhood-demo';

export type SharePositionAmounts = {
  fakeStock: { walletValueAtomic: string } | null;
  deposit: { valueAtomic: string } | null;
  loan: { valueAtomic: string; debtAtomic: string } | null;
};
/** The API marks an absent quote as unsuccessful but still includes confirmed
 * wallet quantities. Other errors have no trustworthy balance payload. */
export type RobinhoodRead =
  | { ok: true; value: RobinhoodHoldings }
  | { ok: false; code: 'price_unavailable'; error: string; value: RobinhoodPartialHoldings }
  | { ok: false; code?: 'price_unavailable'; error: string; value?: never }
  | null;

export function confirmedRobinhood(read: RobinhoodRead): RobinhoodHoldings | RobinhoodPartialHoldings | null {
  if (!read) return null;
  if (read.ok) return read.value;
  return read.code === 'price_unavailable' && 'value' in read ? read.value ?? null : null;
}

/** The cash balance is known without a quote; only a nonzero TSLA balance
 * makes this wallet's dollar total unavailable. */
export function officialWalletUsd(read: RobinhoodRead): number | null {
  const balance = confirmedRobinhood(read);
  if (!balance) return null;
  if ('status' in balance && BigInt(balance.tslaRaw) !== 0n) return null;
  return ('status' in balance ? 0 : balance.tslaValueUsd) + Number(balance.testUsdAtomic) / 1e6;
}

/** The three things a share position is made of, in test-USD atomic units. One split, so the
 * total and its breakdown cannot drift apart. */
export function sharePositionParts(position: SharePositionAmounts | null) {
  return {
    walletAtomic: BigInt(position?.fakeStock?.walletValueAtomic ?? '0'),
    pledgedAtomic: BigInt(position?.deposit?.valueAtomic ?? '0') + BigInt(position?.loan?.valueAtomic ?? '0'),
    debtAtomic: BigInt(position?.loan?.debtAtomic ?? '0'),
  };
}

/** On-chain test-USD atomic units: holdings move between wallet and contracts,
 * while outstanding borrowing offsets the test USD received by the wallet. */
export function netSharePositionsAtomic(position: SharePositionAmounts | null): bigint {
  const { walletAtomic, pledgedAtomic, debtAtomic } = sharePositionParts(position);
  return walletAtomic + pledgedAtomic - debtAtomic;
}

/** What the priced subtotal is made of, in USD. Every part is counted once and the parts add up to the subtotal. */
export type NetPositionParts = {
  /** Cash and shares in the person's own wallets. */
  free: number;
  /** The rental deposit entitlement, held by the tenancy until it settles. */
  locked: number;
  /** Shares a contract holds as collateral for a share-backed deposit or a loan. */
  pledged: number;
  /** Test USD borrowed against shares and still to repay; subtracted. Always zero or positive. */
  owed: number;
};

const toCents = (usd: number) => Math.round(usd * 100);

export function netPositionParts(input: {
  lockedUsd: number; walletCashUsd: number; walletSharesUsd: number; positions: SharePositionAmounts | null;
}): NetPositionParts {
  const { walletAtomic, pledgedAtomic, debtAtomic } = sharePositionParts(input.positions);
  // Whole cents per part, so the parts shown always add up to the total shown.
  return {
    free: toCents(input.walletCashUsd + input.walletSharesUsd + Number(walletAtomic) / 1e6) / 100,
    locked: toCents(input.lockedUsd) / 100,
    pledged: toCents(Number(pledgedAtomic) / 1e6) / 100,
    owed: toCents(Number(debtAtomic) / 1e6) / 100,
  };
}

export function netPositionTotal(parts: NetPositionParts): number {
  return (toCents(parts.free) + toCents(parts.locked) + toCents(parts.pledged) - toCents(parts.owed)) / 100;
}

export const usd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function defaultBuyAmount(balanceAtomic: bigint): string {
  const amount = balanceAtomic < 5_000_000n ? balanceAtomic : 5_000_000n;
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
