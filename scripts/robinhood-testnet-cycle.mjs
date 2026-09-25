#!/usr/bin/env node

// Robinhood Chain TESTNET (46630) test-signer cycle: deposit -> test vault -> test yield ->
// earnings release -> official testnet Stock Token purchase -> claim -> settlement.
// Keys live in the ignored .testnet-secrets/robinhood-testnet/ directory. Dry run unless --send.
//
//   node scripts/robinhood-testnet-cycle.mjs [--send] [--fork]
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, formatEther, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com';
const TSLA = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E'; // Robinhood testnet faucet Stock Token
const TSLAX_MAINNET = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'; // price reference only
const INVENTORY = 10n ** 16n; // 0.01 TSLA for the test desk
const MIN_GAS = 10n ** 15n; // 0.001 ETH covers deployment, three top-ups and ~20 transactions
const send = process.argv.includes('--send');
const dir = resolve(process.env.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet');
const keys = Object.fromEntries(await Promise.all(['operator', 'tenant', 'landlord', 'arbitrator'].map(
  async (role) => [role, (await readFile(resolve(dir, `${role}.key`), 'utf8')).trim()])));
const operator = privateKeyToAccount(keys.operator).address;
const client = createPublicClient({ transport: http(RPC) });
if ((await client.getChainId()) !== 46630) throw new Error('Robinhood Chain testnet (46630) only');

const [eth, tsla] = await Promise.all([
  client.getBalance({ address: operator }),
  client.readContract({ address: TSLA, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [operator] }),
]);
const priceResponse = await fetch(`https://lite-api.jup.ag/price/v3?ids=${TSLAX_MAINNET}`);
const usdPrice = (await priceResponse.json())[TSLAX_MAINNET]?.usdPrice;
if (!(usdPrice > 0)) throw new Error('TSLA reference price unavailable');
console.log(JSON.stringify({ operator, eth: formatEther(eth), tslaRaw: tsla.toString(), referencePriceUsd: usdPrice }));
if (eth < MIN_GAS || tsla < INVENTORY) {
  console.log(JSON.stringify({
    blocked: 'operator needs test ETH and test TSLA',
    action: `Request both at https://faucet.testnet.chain.robinhood.com for ${operator}`,
    needs: { eth: formatEther(MIN_GAS), tslaRaw: INVENTORY.toString() },
  }));
  process.exit(1);
}

const result = spawnSync('forge', [
  'script', 'script/RobinhoodTestnetCycle.s.sol', '--rpc-url', RPC, '--slow', '--gas-estimate-multiplier', '200', ...(send ? ['--broadcast'] : []),
], {
  cwd: resolve('contracts/evm'),
  encoding: 'utf8',
  env: {
    ...process.env,
    RH_OPERATOR_KEY: keys.operator,
    RH_TENANT_KEY: keys.tenant,
    RH_LANDLORD_KEY: keys.landlord,
    RH_ARBITRATOR_KEY: keys.arbitrator,
    RH_STOCK_TOKEN: TSLA,
    RH_STOCK_PRICE: String(Math.round(usdPrice * 1e6)),
    RH_DESK_INVENTORY: INVENTORY.toString(),
  },
});
const output = `${result.stdout}\n${result.stderr}`;
const line = output.split('\n').find((text) => text.includes('Result({'));
if (result.status !== 0 || !line) {
  console.error(output.split('\n').filter((text) => /Error|revert|fail/i.test(text)).slice(0, 8).join('\n'));
  process.exit(1);
}
const fields = Object.fromEntries([...line.matchAll(/(\w+): (0x[0-9a-fA-F]{40}|\d+)/g)].map((m) => [m[1], m[2]]));
console.log(JSON.stringify({ status: send ? 'broadcast' : 'simulation-passed', ...fields }));
if (send) console.log(JSON.stringify({ transactions: 'contracts/evm/broadcast/RobinhoodTestnetCycle.s.sol/46630/run-latest.json' }));
