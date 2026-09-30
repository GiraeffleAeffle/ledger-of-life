import { formatEther, getAddress, type Address } from 'viem';
import { readSharedMarket, sharedMarketRpc, SHARED_TOKEN_ABI } from './shared-market.ts';

export const ROBINHOOD_TESTNET = {
  tsla: getAddress('0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E'),
  usd: getAddress('0xA6e10E426A738aEF586dB5191177658D67C78A14'),
};

export interface RobinhoodHoldings {
  address: Address;
  testUsdAtomic: string;
  tslaRaw: string;
  tslaShares: number;
  tslaValueUsd: number;
  ethBalance: string;
  referencePriceUsd: number;
  referencePriceObservedAt: string;
  referencePriceStale: boolean;
}
export type RobinhoodPartialHoldings = Pick<RobinhoodHoldings,
  'address' | 'testUsdAtomic' | 'tslaRaw' | 'tslaShares' | 'ethBalance'> & { status: 'price_unavailable' };

/** Wallet and loan valuations deliberately use the same copied mainnet token price. */
export async function robinhoodHoldings(
  owner: string,
  readClient: Pick<typeof sharedMarketRpc, 'getBalance' | 'readContract'> = sharedMarketRpc,
  marketReader: typeof readSharedMarket = readSharedMarket,
): Promise<RobinhoodHoldings | RobinhoodPartialHoldings> {
  const address = getAddress(owner);
  const [market, eth, usd, tsla] = await Promise.all([
    marketReader(address).catch(() => null), readClient.getBalance({ address }),
    readClient.readContract({ address: ROBINHOOD_TESTNET.usd, abi: SHARED_TOKEN_ABI, functionName: 'balanceOf', args: [address] }),
    readClient.readContract({ address: ROBINHOOD_TESTNET.tsla, abi: SHARED_TOKEN_ABI, functionName: 'balanceOf', args: [address] }),
  ]);
  const balances = {
    address, testUsdAtomic: usd.toString(), tslaRaw: tsla.toString(),
    tslaShares: Number(tsla) / 1e18, ethBalance: formatEther(eth),
  };
  if (!market?.price || !market.priceAtomic || BigInt(market.priceAtomic) <= 0n || market.price.stale)
    return { ...balances, status: 'price_unavailable' };
  return {
    ...balances, tslaValueUsd: Number(tsla * BigInt(market.priceAtomic) / 10n ** 18n) / 1e6,
    referencePriceUsd: Number(market.priceAtomic) / 1e6,
    referencePriceObservedAt: new Date(Number(market.price.sourceUpdatedAt) * 1000).toISOString(),
    referencePriceStale: market.price.stale,
  };
}
