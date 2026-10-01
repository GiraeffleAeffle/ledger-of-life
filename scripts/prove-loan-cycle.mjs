// Read-only evidence for a hosted loan-against-shares run: node scripts/prove-loan-cycle.mjs <wallet> <txHash>...
// Uses the public Robinhood Chain testnet RPC only. It signs nothing, sends nothing and needs no key.
import { readFile } from 'node:fs/promises';
import { createPublicClient, decodeFunctionData, getAddress, http, isHash, parseAbi } from 'viem';

const RPC = 'https://rpc.testnet.chain.robinhood.com';
const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
const [walletArgument, ...hashes] = process.argv.slice(2);
if (!walletArgument || hashes.length === 0) {
  console.error('Usage: node scripts/prove-loan-cycle.mjs <wallet> <txHash> [<txHash>...]');
  process.exit(2);
}
let wallet;
try { wallet = getAddress(walletArgument); } catch { console.error('The wallet is not a valid address.'); process.exit(2); }
const badHash = hashes.find((hash) => !isHash(hash));
if (badHash) { console.error(`Not a transaction hash: ${badHash}`); process.exit(2); }

const manifest = JSON.parse(await readFile(new URL('../contracts/evm/deployments/shared-market-46630.json', import.meta.url), 'utf8'));
const client = createPublicClient({ transport: http(RPC, { timeout: 15000, retryCount: 1 }) });
const poolAbi = parseAbi([
  'function market() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,uint256)',
  'function position(address) view returns (uint256,uint256,uint256,uint256,uint256,bool)',
  'function depositCollateral(uint256)', 'function withdrawCollateral(uint256)', 'function borrow(uint256)', 'function repay(uint256)',
  'function deposit(uint256,address) returns (uint256)', 'function withdraw(uint256,address,address) returns (uint256)', 'function redeem(uint256,address,address) returns (uint256)', 'function liquidate(address,uint256)',
]);
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const feedAbi = parseAbi(['function latest() view returns (uint80,int256,uint256,uint256,uint256)']);
const decode = (data) => {
  for (const abi of [poolAbi, tokenAbi]) {
    try {
      const call = decodeFunctionData({ abi, data });
      return { function: call.functionName, args: (call.args ?? []).map(String) };
    } catch { /* try the next ABI */ }
  }
  return null;
};
const known = { [manifest.pool.toLowerCase()]: 'pool', [manifest.stock.toLowerCase()]: 'test TSLA', [manifest.usd.toLowerCase()]: 'tUSDG' };
const seconds = (value) => Number(value);
const iso = (unix) => new Date(unix * 1000).toISOString();

const chainId = await client.getChainId();
if (chainId !== manifest.chainId) throw new Error(`RPC reports chain ${chainId}, expected ${manifest.chainId}.`);
const latestBlock = await client.getBlock({ blockTag: 'latest' });

const transactions = [];
for (const hash of hashes) {
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash }).catch(() => null),
    client.getTransaction({ hash }).catch(() => null),
  ]);
  if (!receipt || !transaction) { transactions.push({ hash, found: false, explorer: `${EXPLORER}/tx/${hash}` }); continue; }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  transactions.push({
    hash, found: true, explorer: `${EXPLORER}/tx/${hash}`,
    status: receipt.status, blockNumber: receipt.blockNumber.toString(), blockTime: iso(seconds(block.timestamp)),
    from: getAddress(receipt.from), fromIsWallet: getAddress(receipt.from) === wallet,
    to: receipt.to ? getAddress(receipt.to) : null, target: receipt.to ? known[receipt.to.toLowerCase()] ?? 'other contract' : null,
    nativeValue: transaction.value.toString(), call: decode(transaction.input), gasUsed: receipt.gasUsed.toString(), logCount: receipt.logs.length,
  });
}

const [stockBalance, usdBalance, ethBalance, position, market, price] = await Promise.all([
  client.readContract({ address: manifest.stock, abi: tokenAbi, functionName: 'balanceOf', args: [wallet] }),
  client.readContract({ address: manifest.usd, abi: tokenAbi, functionName: 'balanceOf', args: [wallet] }),
  client.getBalance({ address: wallet }),
  client.readContract({ address: manifest.pool, abi: poolAbi, functionName: 'position', args: [wallet] }),
  client.readContract({ address: manifest.pool, abi: poolAbi, functionName: 'market' }),
  client.readContract({ address: manifest.oracle, abi: feedAbi, functionName: 'latest' }),
]);
const now = seconds(latestBlock.timestamp);
const sourceTime = seconds(price[2]);
const copiedTime = seconds(price[4]);

console.log(JSON.stringify({
  kind: 'loan-against-shares-chain-evidence', readOnly: true, rpc: RPC, chainId,
  observedAtBlock: latestBlock.number.toString(), observedAt: iso(now), wallet,
  deployment: { pool: manifest.pool, oracle: manifest.oracle, stock: manifest.stock, usd: manifest.usd },
  transactions,
  allTransactionsConfirmed: transactions.every((item) => item.found && item.status === 'success'),
  walletBalances: { testTslaRaw: stockBalance.toString(), tUsdgAtomic: usdBalance.toString(), ethWei: ethBalance.toString() },
  position: { collateralSharesRaw: position[0].toString(), debtAtomic: position[1].toString(), collateralValueAtomic: position[2].toString(), ltvBps: Number(position[3]), availableToBorrowAtomic: position[4].toString(), priceFresh: position[5] },
  pool: { cashAtomic: market[0].toString(), totalAssetsAtomic: market[1].toString(), borrowedAtomic: market[2].toString(), utilizationBps: Number(market[3]), priceAtomic: market[6].toString(), priceFresh: market[8] },
  mirroredPrice: { sourceRoundId: price[0].toString(), sourceUpdatedAt: iso(sourceTime), sourceAgeSeconds: now - sourceTime, copiedAt: iso(copiedTime), copyAgeSeconds: now - copiedTime },
  note: 'Chain reads at the latest block. This script does not judge whether a run qualifies as evidence.',
}, null, 2));
