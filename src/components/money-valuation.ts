import type { RobinhoodHoldings, RobinhoodPartialHoldings } from '@/server/robinhood-demo';

export type SharePositionAmounts = {
  deployment: unknown | null;
  price: { stale: boolean } | null;
  suspended: boolean;
  sharesRaw: string | null;
  priceAtomic: string | null;
  walletValueAtomic: string | null;
  loan: { sharesRaw: string; valueAtomic: string | null; debtAtomic: string } | null;
  lender: { valueAtomic: string } | null;
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

/** A nonzero stock holding requires a deployed, fresh mirrored quote. Cash and
 * lender claims remain independently readable when stock pricing is frozen. */
export function shareValuationAvailable(position: SharePositionAmounts | null): boolean {
  if (!position || position.sharesRaw === null) return false;
  const walletHasStock = BigInt(position.sharesRaw) > 0n;
  const collateralHasStock = BigInt(position.loan?.sharesRaw ?? '0') > 0n;
  if (!walletHasStock && !collateralHasStock) return true;
  return Boolean(position.deployment && position.price && !position.price.stale
    && !position.suspended && position.priceAtomic !== null && BigInt(position.priceAtomic) > 0n
    && (!walletHasStock || position.walletValueAtomic !== null)
    && (!collateralHasStock || position.loan?.valueAtomic !== null));
}

function sharePositionParts(position: SharePositionAmounts | null) {
  if (!shareValuationAvailable(position)) return null;
  return {
    walletAtomic: BigInt(position?.walletValueAtomic ?? '0'),
    pledgedAtomic: BigInt(position?.loan?.valueAtomic ?? '0'),
    lentAtomic: BigInt(position?.lender?.valueAtomic ?? '0'),
    debtAtomic: BigInt(position?.loan?.debtAtomic ?? '0'),
  };
}

/** What the priced subtotal is made of, in USD. Every part is counted once and the parts add up to the subtotal. */
export type NetPositionParts = {
  /** Cash and shares in the person's own wallets. */
  free: number;
  /** The rental deposit entitlement, held by the tenancy until it settles. */
  locked: number;
  /** Official test TSLA the shared loan pool holds as collateral. */
  pledged: number;
  /** Claims on the shared pool, including accrued interest and losses. */
  lent: number;
  /** Test USD borrowed against shares and still to repay; subtracted. Always zero or positive. */
  owed: number;
};

const toCents = (usd: number) => Math.round(usd * 100);

export function netPositionParts(input: {
  lockedUsd: number; walletCashUsd: number; walletSharesUsd: number; positions: SharePositionAmounts | null;
}): NetPositionParts | null {
  const amounts = sharePositionParts(input.positions);
  if (!amounts) return null;
  const { walletAtomic, pledgedAtomic, lentAtomic, debtAtomic } = amounts;
  // Whole cents per part, so the parts shown always add up to the total shown.
  return {
    free: toCents(input.walletCashUsd + input.walletSharesUsd + Number(walletAtomic) / 1e6) / 100,
    locked: toCents(input.lockedUsd) / 100,
    pledged: toCents(Number(pledgedAtomic) / 1e6) / 100,
    lent: toCents(Number(lentAtomic) / 1e6) / 100,
    owed: toCents(Number(debtAtomic) / 1e6) / 100,
  };
}

export function netPositionTotal(parts: NetPositionParts): number {
  return (toCents(parts.free) + toCents(parts.locked) + toCents(parts.pledged) + toCents(parts.lent) - toCents(parts.owed)) / 100;
}

export const usd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
