#!/usr/bin/env node
// Explicit testnet deployment only. Dry runs never sign or broadcast transactions.
import { readFile, writeFile, rename, mkdir, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, encodeFunctionData, getAddress, getContractAddress, http, isAddress, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
if (args[0] !== 'setup') throw new Error('Usage: shared-market.mjs setup --updater ADDRESS [--send]');
const send = args.includes('--send');
const updaterInput = option('--updater') || process.env.ROBINHOOD_PRICE_UPDATER_ADDRESS;
if (!updaterInput || !isAddress(updaterInput)) throw new Error('Specify the separate public --updater ADDRESS (no updater secret is read).');
const updater = getAddress(updaterInput);
const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const client = createPublicClient({ chain, transport: http() });
const folder = resolve(process.env.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet');
const journalFile = resolve(folder, 'shared-market-progress.json');
const manifestFile = resolve('contracts/evm/deployments/shared-market-46630.json');
const usd = getAddress('0xA6e10E426A738aEF586dB5191177658D67C78A14');
const stock = getAddress('0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E');
const source = { chainId: 4663, feed: getAddress('0x4A1166a659A55625345e9515b32adECea5547C38') };
const sourceClient = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const sourceStock = getAddress('0x322F0929c4625eD5bAd873c95208D54E1c003b2d');
const collateralIssuerPins = {
  beacon: getAddress('0x1dF3cA0fD30ED5eeb09eB01938f4E9c5196E6Ca5'),
  implementation: getAddress('0xBd14156E05c6AF28ad39aA53a2AB8eB9CDf657DA'),
  registry: getAddress('0x1dF3cA0fD30ED5eeb09eB01938f4E9c5196E6Ca5'),
  codeHashes: { beacon: '0x404e8188c4b1d0c9804205e0da253d11570e9d48d03964962cb689072b1735d2', implementation: '0x137f26aacb7b1675d89017cebbf5018515c7bf4b87ae1848984494a56f3e1912', registry: '0x404e8188c4b1d0c9804205e0da253d11570e9d48d03964962cb689072b1735d2' },
};
const burn = getAddress('0x000000000000000000000000000000000000dEaD');
const seedAssets = 10_000_000_000n;
const pins = { usd: '0x3e4adb6eab9d495c72d672fb619614979f38b422e49fcdb1b5e4c3b53744fe80', stock: '0x2f367e6a678e7b30ab613d5963e541e6f4d3ca586de76e2f441fbfeb1a27c440' };
// Reviewed Solc 0.8.28 / repository Foundry settings. Re-review after any source/compiler change.
const reviewedArtifacts = {
  MirroredPriceFeed: {
    creationHash: '0xeb0fe48933ffc373b3d37ca8be0b0a8a93a9b81a422592eb4a618acc8756dc13',
    runtimeTemplateHash: '0xe7a3ea1caa39dbb7e1da57a49fe1ea1ce60e6d4e792b97c99ffa81cd9cd3ef78',
    immutableRanges: [238, 425, 538, 577, 616, 739, 952, 1202].map(start => ({ start, length: 32 })),
  },
  SharedLendingPool: {
    creationHash: '0xa883ef5e4899fa45124bd677ee5455a342335e1e7a1e821f24b06f834d965536',
    runtimeTemplateHash: '0x7ff694df7c8d4041397ff9ca2977faaac929b772265c743c4ce6d68faf01ef75',
    immutableRanges: [984, 1221, 1610, 1687, 2488, 2744, 3982, 4595, 5323, 5502, 6476, 7805, 8257].map(start => ({ start, length: 32 })),
  },
};
const parameterGetters = { borrowAprBps: ['BORROW_APR_BPS', 500n], borrowApyBps: ['BORROW_APY_BPS', 513n], maxBorrowLtvBps: ['MAX_LTV_BPS', 5000n], liquidationLtvBps: ['LIQUIDATION_LTV_BPS', 8000n], liquidationBonusBps: ['LIQUIDATION_BONUS_BPS', 1000n], liquidationCloseFactorBps: ['CLOSE_FACTOR_BPS', 5000n], maxUtilizationBps: ['MAX_UTILIZATION_BPS', 9000n], normalMaxPriceAgeSeconds: ['NORMAL_MAX_PRICE_AGE', 93600n], weekendMaxPriceAgeSeconds: ['WEEKEND_MAX_PRICE_AGE', 266400n], shareVirtualOffset: ['SHARE_VIRTUAL_OFFSET', 1000000000000n], minBorrowAssets: ['MIN_BORROW', 1000000n], maxBorrowerPage: ['MAX_BORROWER_PAGE', 100n] };
const feedGetters = { decimals: 8n, MAX_STEP_BPS: 2000n, MIN_PUSH_INTERVAL: 3600n, WINDOW: 3600n };
const tokenAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function paused() view returns (bool)', 'function uiMultiplier() view returns (uint256)', 'function mint(address,uint256)', 'function approve(address,uint256) returns (bool)']);
const poolAbi = parseAbi(['function deposit(uint256,address) returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const registryAbi = parseAbi(['function ACCESS_CONTROLLED_REGISTRY() view returns (address)', 'function isBlocked(address) view returns (bool)']);
const sourceAbi = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)', 'function decimals() view returns (uint8)', 'function uiMultiplier() view returns (uint256)', 'function oraclePaused() view returns (bool)']);
async function initialPrice() {
  if (await sourceClient.getChainId() !== source.chainId) throw new Error('Source RPC chain mismatch');
  const [round, decimals, mainnetMultiplier, testnetMultiplier, oraclePaused, sourceName, sourceSymbol, sourceDecimals, paused] = await Promise.all([
    sourceClient.readContract({ address: source.feed, abi: sourceAbi, functionName: 'latestRoundData' }),
    sourceClient.readContract({ address: source.feed, abi: sourceAbi, functionName: 'decimals' }),
    sourceClient.readContract({ address: sourceStock, abi: sourceAbi, functionName: 'uiMultiplier' }),
    client.readContract({ address: stock, abi: tokenAbi, functionName: 'uiMultiplier' }),
    sourceClient.readContract({ address: sourceStock, abi: sourceAbi, functionName: 'oraclePaused' }),
    sourceClient.readContract({ address: sourceStock, abi: tokenAbi, functionName: 'name' }),
    sourceClient.readContract({ address: sourceStock, abi: tokenAbi, functionName: 'symbol' }),
    sourceClient.readContract({ address: sourceStock, abi: tokenAbi, functionName: 'decimals' }),
    sourceClient.readContract({ address: sourceStock, abi: tokenAbi, functionName: 'paused' }),
  ]);
  if (sourceName !== 'Tesla • Robinhood Token' || sourceSymbol !== 'TSLA' || sourceDecimals !== 18) throw new Error('Mainnet source stock must be official Tesla / Robinhood Token, TSLA, with 18 decimals');
  const now = (await sourceClient.getBlock()).timestamp;
  const weekday = (now / 86400n + 4n) % 7n;
  const maxAge = weekday === 6n || weekday === 0n || (weekday === 1n && now % 86400n < 43200n) ? 266400n : 93600n;
  if (decimals !== 8 || paused || oraclePaused || round[0] === 0n || round[1] <= 0n || round[3] === 0n || round[3] > now || now - round[3] > maxAge || round[4] < round[0] || mainnetMultiplier <= 0n || testnetMultiplier <= 0n) throw new Error('Unusable initial mainnet source price');
  const answer = (round[1] * 10n ** 18n / mainnetMultiplier) * testnetMultiplier / 10n ** 18n;
  if (answer === 0n || answer > 100000000000000n) throw new Error('Initial converted price outside feed bounds');
  return { initialAnswer: answer.toString(), sourceRoundId: round[0].toString(), sourceUpdatedAt: round[3].toString(), rawMainnetAnswer: round[1].toString(), mainnetMultiplier: mainnetMultiplier.toString(), testnetMultiplier: testnetMultiplier.toString(), stock: sourceStock, stockIdentity: { name: sourceName, symbol: sourceSymbol, decimals: sourceDecimals, paused, oraclePaused } };
}
function immutableRanges(artifact) {
  return Object.values(artifact.deployedBytecode.immutableReferences).flat().sort((a, b) => a.start - b.start);
}
function normalizeRuntime(code, ranges) {
  let normalized = code;
  for (const { start, length } of ranges) normalized = normalized.slice(0, 2 + start * 2) + '0'.repeat(length * 2) + normalized.slice(2 + (start + length) * 2);
  return normalized;
}
async function assertRuntime(name, address) {
  const code = await client.getCode({ address });
  if (!code || code.length !== artifacts[name].deployedBytecode.object.length || keccak256(normalizeRuntime(code, reviewedArtifacts[name].immutableRanges)) !== reviewedArtifacts[name].runtimeTemplateHash) throw new Error(`${name} reviewed runtime template mismatch`);
}
async function verifyMarket(oracle, pool, expectedInitialAnswer, seedRequired) {
  await assertRuntime('MirroredPriceFeed', oracle);
  await assertRuntime('SharedLendingPool', pool);
  const read = (address, artifact, functionName, args = []) => client.readContract({ address, abi: artifacts[artifact].abi, functionName, args });
  const addressChecks = [[oracle, 'MirroredPriceFeed', 'updater', updater], [oracle, 'MirroredPriceFeed', 'stock', stock], [oracle, 'MirroredPriceFeed', 'sourceFeed', source.feed], [pool, 'SharedLendingPool', 'usd', usd], [pool, 'SharedLendingPool', 'asset', usd], [pool, 'SharedLendingPool', 'stock', stock], [pool, 'SharedLendingPool', 'oracle', oracle]];
  const observed = {};
  for (const [address, artifact, getter, expected] of addressChecks) {
    const value = await read(address, artifact, getter);
    if (getAddress(value) !== expected) throw new Error(`Deployed ${artifact}.${getter} wiring mismatch`);
    observed[`${artifact}.${getter}`] = getAddress(value);
  }
  const sourceChainId = await read(oracle, 'MirroredPriceFeed', 'sourceChainId');
  if (sourceChainId !== BigInt(source.chainId)) throw new Error('Deployed source chain mismatch');
  observed.sourceChainId = Number(sourceChainId);
  const initialAnswer = await read(oracle, 'MirroredPriceFeed', 'initialAnswer');
  if (initialAnswer !== BigInt(expectedInitialAnswer)) throw new Error('Deployed initial price anchor mismatch');
  const feedParameters = { initialAnswer: initialAnswer.toString() };
  for (const [getter, expected] of Object.entries(feedGetters)) {
    const value = BigInt(await read(oracle, 'MirroredPriceFeed', getter));
    if (value !== expected) throw new Error(`Deployed feed.${getter} parameter mismatch`);
    feedParameters[getter] = Number(value);
  }
  feedParameters.initialBandMin = (initialAnswer - initialAnswer * BigInt(feedParameters.MAX_STEP_BPS) / 10000n).toString();
  feedParameters.initialBandMax = (initialAnswer + initialAnswer * BigInt(feedParameters.MAX_STEP_BPS) / 10000n).toString();
  const parameters = {};
  for (const [label, [getter, expected]] of Object.entries(parameterGetters)) {
    const value = await read(pool, 'SharedLendingPool', getter);
    if (value !== expected) throw new Error(`Deployed pool.${getter} parameter mismatch`);
    parameters[label] = label === 'shareVirtualOffset' ? value.toString() : Number(value);
  }
  if (await read(pool, 'SharedLendingPool', 'decimals') !== 18) throw new Error('Lender share decimals mismatch');
  let seed;
  if (seedRequired) {
    const [cash, totalAssets, totalSupply, burnedShares, deployerShares, debt, borrowShares, tokenBalance, allowance] = await Promise.all([
      ...['cash', 'totalAssets', 'totalSupply'].map(getter => read(pool, 'SharedLendingPool', getter)),
      read(pool, 'SharedLendingPool', 'balanceOf', [burn]), read(pool, 'SharedLendingPool', 'balanceOf', [account.address]),
      read(pool, 'SharedLendingPool', 'totalBorrowAssets'), read(pool, 'SharedLendingPool', 'totalBorrowShares'),
      client.readContract({ address: usd, abi: parseAbi(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)']), functionName: 'balanceOf', args: [pool] }),
      client.readContract({ address: usd, abi: parseAbi(['function allowance(address,address) view returns(uint256)']), functionName: 'allowance', args: [account.address, pool] }),
    ]);
    const expectedShares = seedAssets * BigInt(parameters.shareVirtualOffset);
    if (cash !== seedAssets || totalAssets !== seedAssets || tokenBalance !== seedAssets || totalSupply !== expectedShares || burnedShares !== expectedShares || deployerShares !== 0n || debt !== 0n || borrowShares !== 0n || allowance !== 0n) throw new Error('Exact burned seed/cash/share/debt state mismatch');
    seed = { receiver: burn, assets: cash.toString(), shares: burnedShares.toString(), deployerShares: deployerShares.toString() };
  }
  return { observed, parameters, feedParameters, seed };
}
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function atomic(path, value) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, path); }
async function codeHash(address) { const code = await client.getCode({ address }); if (!code || code === '0x') throw new Error(`Missing code: ${address}`); return keccak256(code); }
async function assertAssets(pool, deployer) {
  for (const [kind, address] of Object.entries({ usd, stock })) if (await codeHash(address) !== pins[kind]) throw new Error(`${kind} runtime hash mismatch`);
  const read = (address, functionName, args = []) => client.readContract({ address, abi: tokenAbi, functionName, args });
  const registry = await client.readContract({ address: stock, abi: registryAbi, functionName: 'ACCESS_CONTROLLED_REGISTRY' });
  const word = await client.getStorageAt({ address: stock, slot: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' });
  const beacon = getAddress(`0x${word.slice(-40)}`);
  const implementation = getAddress(await client.readContract({ address: beacon, abi: parseAbi(['function implementation() view returns(address)']), functionName: 'implementation' }));
  const collateralIssuer = { beacon, implementation, registry: getAddress(registry), codeHashes: {} };
  for (const kind of ['beacon', 'implementation', 'registry']) {
    if (collateralIssuer[kind] !== collateralIssuerPins[kind]) throw new Error(`Official collateral issuer ${kind} address mismatch`);
    collateralIssuer.codeHashes[kind] = await codeHash(collateralIssuer[kind]);
    if (collateralIssuer.codeHashes[kind] !== collateralIssuerPins.codeHashes[kind]) throw new Error(`Official collateral issuer ${kind} code mismatch`);
  }
  const blockedAt = address => client.readContract({ address: registry, abi: registryAbi, functionName: 'isBlocked', args: [address] });
  const [name, symbol, decimals, usdDecimals, paused, multiplier, blocked, deployerBlocked] = await Promise.all([read(stock, 'name'), read(stock, 'symbol'), read(stock, 'decimals'), read(usd, 'decimals'), read(stock, 'paused'), read(stock, 'uiMultiplier'), blockedAt(pool), blockedAt(deployer)]);
  if (name !== 'Tesla' || symbol !== 'TSLA' || decimals !== 18 || usdDecimals !== 6 || paused || blocked || deployerBlocked || multiplier !== 10n ** 18n) throw new Error('Official asset identity, transfer restrictions, or multiplier mismatch');
  return collateralIssuer;
}
if (await client.getChainId() !== 46630) throw new Error('Refusing non-testnet RPC');
const keyFile = resolve(folder, 'shared-market-deployer.key');
const keyStat = await lstat(keyFile);
if (!keyStat.isFile() || (keyStat.mode & 0o077) || (process.getuid && keyStat.uid !== process.getuid())) throw new Error('Deployer key must be a regular file owned by the current user with owner-only permissions (chmod 600)');
const account = privateKeyToAccount((await readFile(keyFile, 'utf8')).trim());
if (updater === account.address || updater === '0x0000000000000000000000000000000000000000') throw new Error('Updater must be a separate nonzero address');
const artifacts = {};
for (const name of ['MirroredPriceFeed', 'SharedLendingPool']) {
  artifacts[name] = await json(resolve(process.env.SHARED_MARKET_ARTIFACTS_DIR || 'contracts/evm/out', `${name}.sol/${name}.json`));
  if (!artifacts[name]?.bytecode?.object || artifacts[name].bytecode.object === '0x') throw new Error(`Build ${name} with forge build first`);
  const artifact = artifacts[name], reviewed = reviewedArtifacts[name];
  if (keccak256(artifact.bytecode.object) !== reviewed.creationHash || keccak256(artifact.deployedBytecode.object) !== reviewed.runtimeTemplateHash || JSON.stringify(immutableRanges(artifact)) !== JSON.stringify(reviewed.immutableRanges)) throw new Error(`Unreviewed ${name} creation/runtime artifact`);
}
let journal = await json(journalFile);
if (journal && (journal.version !== 1 || journal.chainId !== 46630 || journal.deployer !== account.address || journal.updater !== updater)) throw new Error('Journal key/network/updater mismatch');
if (journal?.bootstrap && journal.bootstrap.stock !== sourceStock) throw new Error('Journal bootstrap stock does not match official mainnet TSLA; refusing obsolete multiplier basis');
journal ||= { version: 1, chainId: 46630, deployer: account.address, updater, steps: {} };
const [latest, pending] = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: account.address, blockTag })));
const oracle = journal.steps.oracle?.address || getContractAddress({ from: account.address, nonce: BigInt(latest) });
const pool = journal.steps.pool?.address || getContractAddress({ from: account.address, nonce: BigInt(journal.steps.oracle ? journal.steps.oracle.nonce + 1 : latest + 1) });
const collateralIssuer = await assertAssets(pool, account.address);
const bootstrap = journal.bootstrap || await initialPrice();
if (!journal.bootstrap) {
  if (Object.keys(journal.steps).length) throw new Error('Old journal lacks the immutable initial price anchor');
  journal.bootstrap = bootstrap;
  if (send) await atomic(journalFile, journal);
}
const calls = [
  ['oracle', null, encodeDeployData({ ...artifacts.MirroredPriceFeed, bytecode: artifacts.MirroredPriceFeed.bytecode.object, args: [updater, stock, source.feed, BigInt(source.chainId), BigInt(bootstrap.initialAnswer)] })],
  ['pool', null, encodeDeployData({ ...artifacts.SharedLendingPool, bytecode: artifacts.SharedLendingPool.bytecode.object, args: [usd, stock, oracle] })],
  ['mint', usd, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [account.address, seedAssets] })],
  ['approve', usd, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [pool, seedAssets] })],
  ['deposit', pool, encodeFunctionData({ abi: poolAbi, functionName: 'deposit', args: [seedAssets, burn] })],
];
if (!send) {
  console.log(JSON.stringify({ state: 'dry_run', chainId: chain.id, deployer: account.address, updater, oracle, pool, source, bootstrap, expectedParameters: Object.fromEntries(Object.entries(parameterGetters).map(([key, [, value]]) => [key, value.toString()])), reviewedArtifacts, assetCodeHashes: pins, collateralIssuer, seed: { assets: seedAssets.toString(), receiver: burn }, confirmations: 3, pendingNonce: pending, latestNonce: latest, writes: 0, steps: calls.map(([name, to, data]) => ({ name, to, calldataHash: keccak256(data) })) }, null, 2));
} else {
  const prior = await json(manifestFile);
  if (prior) {
    if (prior.deployer !== account.address || prior.updater !== updater || prior.chainId !== 46630) throw new Error('Existing manifest identity mismatch');
    for (const kind of ['usd', 'stock', 'oracle', 'pool']) if (await codeHash(prior[kind]) !== prior.codeHashes[kind]) throw new Error('Existing manifest code hash mismatch');
    await assertAssets(prior.pool, account.address);
    await verifyMarket(prior.oracle, prior.pool, prior.feedParameters.initialAnswer, false);
    console.log(JSON.stringify({ state: 'already_provisioned', manifest: manifestFile }));
  } else {
    const wallet = createWalletClient({ chain, account, transport: http() });
    for (const [name, to, data] of calls) {
      let step = journal.steps[name];
      if (!step) {
        const [nonce, pendingNonce] = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: account.address, blockTag })));
        if (nonce !== pendingNonce) throw new Error('Pending deployer transaction; refusing uncertain nonce');
        const prepared = await wallet.prepareTransactionRequest({ account, to: to || undefined, data, nonce });
        const serialized = await wallet.signTransaction(prepared);
        step = journal.steps[name] = { nonce, serialized, hash: keccak256(serialized), calldataHash: keccak256(data), ...(to ? {} : { address: getContractAddress({ from: account.address, nonce: BigInt(nonce) }) }) };
        if (!to && step.address !== (name === 'oracle' ? oracle : pool)) throw new Error('Deployment nonce changed; rerun setup before signing');
        await atomic(journalFile, journal);
      }
      if (step.calldataHash !== keccak256(data)) throw new Error('Journal calldata differs from current deployment');
      if (!step.confirmed) {
        let transaction;
        try { transaction = await client.getTransaction({ hash: step.hash }); } catch (e) { if (e.name !== 'TransactionNotFoundError') throw e; }
        if (!transaction) {
          if (await client.getTransactionCount({ address: account.address, blockTag: 'latest' }) > step.nonce) throw new Error('Nonce consumed without journal transaction; refusing replacement');
          await wallet.sendRawTransaction({ serializedTransaction: step.serialized });
        }
        const receipt = await client.waitForTransactionReceipt({ hash: step.hash, confirmations: 3 });
        if (receipt.status !== 'success' || (!to && receipt.contractAddress?.toLowerCase() !== step.address.toLowerCase())) throw new Error(`Deployment step failed: ${name}`);
        step.blockNumber = receipt.blockNumber.toString(); step.confirmed = true;
        await atomic(journalFile, journal);
      }
      if (name === 'oracle') await assertRuntime('MirroredPriceFeed', oracle);
      if (name === 'pool') {
        await assertAssets(pool, account.address);
        await verifyMarket(oracle, pool, bootstrap.initialAnswer, false);
      }
    }
    const verified = await verifyMarket(oracle, pool, bootstrap.initialAnswer, true);
    const verifiedIssuer = await assertAssets(pool, account.address);
    const manifest = { version: 1, chainId: await client.getChainId(), deployer: account.address, usd: verified.observed['SharedLendingPool.usd'], stock: verified.observed['SharedLendingPool.stock'], oracle: verified.observed['SharedLendingPool.oracle'], pool, updater: verified.observed['MirroredPriceFeed.updater'], source: { chainId: verified.observed.sourceChainId, feed: verified.observed['MirroredPriceFeed.sourceFeed'] }, parameters: verified.parameters, feedParameters: verified.feedParameters, bootstrap, reviewedArtifacts, collateralIssuer: verifiedIssuer, codeHashes: { usd: await codeHash(usd), stock: await codeHash(stock), oracle: await codeHash(oracle), pool: await codeHash(pool) }, deploymentBlock: journal.steps.pool.blockNumber, deployment: { oracleTransactionHash: journal.steps.oracle.hash, poolTransactionHash: journal.steps.pool.hash }, seed: { ...verified.seed, mintTransactionHash: journal.steps.mint.hash, approveTransactionHash: journal.steps.approve.hash, depositTransactionHash: journal.steps.deposit.hash } };
    await atomic(manifestFile, manifest);
    console.log(JSON.stringify({ state: 'provisioned', manifest: manifestFile }));
  }
}
