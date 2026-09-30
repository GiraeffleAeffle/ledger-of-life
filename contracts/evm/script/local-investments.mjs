#!/usr/bin/env node
// Explicit TESTNET ONLY deployment/funding; never invoked by browsing or API reads.
// node --no-warnings --experimental-strip-types --env-file-if-exists=.env.local contracts/evm/script/local-investments.mjs setup --send
// node --no-warnings --experimental-strip-types --env-file-if-exists=.env.local contracts/evm/script/local-investments.mjs proof --wallet 0x...
// node --no-warnings --experimental-strip-types --env-file-if-exists=.env.local contracts/evm/script/local-investments.mjs fund --wallet 0x... --cash 10000000 --gas 300000000000000 --send
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, getAddress, getContractAddress, http, isAddress, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TEST_CITY_INVESTMENTS } from '../../../src/data/local-investments.ts';
import { ROBINHOOD_TESTNET } from '../../../src/server/robinhood-demo.ts';
import { executeFundingStep, publishInvestmentManifest } from '../../../src/server/local-investment-provisioning.ts';

const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const client = createPublicClient({ chain, transport: http() });
const folder = resolve(process.env.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet');
const journalFile = resolve(folder, 'local-investments-progress.json');
const manifestFile = resolve('contracts/evm/deployments/local-investments-46630.json');
const tokenAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function mint(address,uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
const deskAbi = parseAbi(['function owner() view returns (address)', 'function usd() view returns (address)', 'function stock() view returns (address)', 'function price() view returns (uint256)', 'event Bought(address indexed buyer,uint256 usdIn,uint256 stockOut)']);
const args = process.argv.slice(2);
const command = args.shift();
function option(name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function amount(value, max) { if (!value || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > max) throw new Error('Invalid bounded atomic amount.'); return BigInt(value); }
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function checkpoint(value) {
  await mkdir(dirname(journalFile), { recursive: true, mode: 0o700 });
  const temp = `${journalFile}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, journalFile);
}
async function operator() {
  if (!args.includes('--send')) throw new Error('Explicit --send required for deployment or funding.');
  const keyFile = resolve(folder, 'operator.key');
  if ((await stat(keyFile)).mode & 0o077) throw new Error('Operator key must be owner-only (chmod 600).');
  const account = privateKeyToAccount((await readFile(keyFile, 'utf8')).trim());
  return { account, wallet: createWalletClient({ chain, account, transport: http() }) };
}
async function receipt(hash) {
  const result = await client.waitForTransactionReceipt({ hash, confirmations: 3 });
  if (result.status !== 'success') throw new Error(`Testnet transaction failed: ${hash}`);
  return result;
}
async function codeHash(address) {
  const code = await client.getCode({ address });
  if (!code || code === '0x') throw new Error(`Contract has no deployed code: ${address}`);
  return keccak256(code);
}
async function validate(manifest) {
  if (manifest.version !== 1 || manifest.chainId !== 46630 || getAddress(manifest.cashAddress) !== ROBINHOOD_TESTNET.usd || manifest.cashCodeHash !== await codeHash(ROBINHOOD_TESTNET.usd)) throw new Error('Cash or chain manifest mismatch.');
  if (await client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'decimals' }) !== 6) throw new Error('Cash decimals mismatch.');
  for (const project of TEST_CITY_INVESTMENTS) {
    const asset = manifest.assets[project.id];
    if (!asset || asset.name !== project.name || asset.symbol !== project.symbol || asset.priceAtomic !== project.priceAtomicPerUnit || asset.totalSupplyRaw !== project.totalUnitsRaw ||
      asset.unitCodeHash !== await codeHash(asset.unitAddress) || asset.marketCodeHash !== await codeHash(asset.marketAddress)) throw new Error(`Manifest identity mismatch: ${project.id}`);
    const [name, symbol, decimals, supply, cash, stock, price, owner] = await Promise.all([
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'name' }),
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'symbol' }),
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'decimals' }),
      client.readContract({ address: asset.unitAddress, abi: tokenAbi, functionName: 'totalSupply' }),
      client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: 'usd' }),
      client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: 'stock' }),
      client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: 'price' }),
      client.readContract({ address: asset.marketAddress, abi: deskAbi, functionName: 'owner' }),
    ]);
    if (name !== project.name || symbol !== project.symbol || decimals !== 18 || supply.toString() !== project.totalUnitsRaw || cash.toLowerCase() !== ROBINHOOD_TESTNET.usd.toLowerCase() ||
      stock.toLowerCase() !== asset.unitAddress.toLowerCase() || price.toString() !== project.priceAtomicPerUnit || owner.toLowerCase() !== manifest.operator.toLowerCase()) throw new Error(`Deployed contract mismatch: ${project.id}`);
  }
}
// Checkpoint the deterministic CREATE address and nonce before broadcasting: interruption
// between RPC send and journal hash is recoverable without deploying a second issuer.
async function deployStage(journal, entry, kind, account, wallet, artifact, args) {
  const addressField = `${kind}Address`, hashField = `${kind}Hash`;
  const nonceField = `${kind}Nonce`, expectedField = `${kind}ExpectedAddress`;
  if (entry[addressField]) return entry[addressField];
  if (!entry[expectedField]) {
    const [pending, latest] = await Promise.all([
      client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    ]);
    if (pending !== latest) throw new Error('Operator has a pending transaction; wait for it before deploying another contract.');
    entry[nonceField] = latest;
    entry[expectedField] = getContractAddress({ from: account.address, nonce: BigInt(latest) });
    await checkpoint(journal);
  }
  const expected = entry[expectedField];
  const current = await client.getCode({ address: expected });
  if (current && current !== '0x') {
    if (entry[hashField] && (await receipt(entry[hashField])).contractAddress?.toLowerCase() !== expected.toLowerCase()) throw new Error('Deployed address does not match checkpoint.');
    entry[addressField] = expected; await checkpoint(journal); return expected;
  }
  if (!entry[hashField]) {
    const [pending, latest] = await Promise.all([
      client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    ]);
    if (pending !== entry[nonceField] || latest !== entry[nonceField]) throw new Error('A checkpointed deployment is in flight or operator nonce changed. Wait; never deploy over an uncertain nonce.');
    entry[hashField] = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args, nonce: entry[nonceField] });
    await checkpoint(journal);
  }
  const deployed = await receipt(entry[hashField]);
  if (deployed.contractAddress?.toLowerCase() !== expected.toLowerCase()) throw new Error('Deployed address does not match checkpoint.');
  entry[addressField] = expected; await checkpoint(journal);
  return expected;
}
if (await client.getChainId() !== 46630) throw new Error('Refusing anything but Robinhood testnet (46630).');
if (command === 'setup') {
  const { account, wallet } = await operator();
  const prior = await json(manifestFile);
  if (prior) {
    await validate(prior);
    console.log(JSON.stringify({ state: 'already_provisioned', manifest: manifestFile }));
  } else {
    const journal = (await json(journalFile)) || { version: 1, operator: account.address, chainId: 46630, assets: {} };
    if (journal.version !== 1 || journal.chainId !== 46630 || journal.operator.toLowerCase() !== account.address.toLowerCase()) throw new Error('Previous operator journal belongs to another key/network.');
    const unitArtifact = JSON.parse(await readFile(resolve('contracts/evm/out/FictionalCityUnit.sol/FictionalCityUnit.json'), 'utf8'));
    const deskArtifact = JSON.parse(await readFile(resolve('contracts/evm/out/TestnetMarket.sol/TestStockDesk.json'), 'utf8'));
    for (const project of TEST_CITY_INVESTMENTS) {
      const entry = journal.assets[project.id] ||= {};
      await deployStage(journal, entry, 'unit', account, wallet, unitArtifact, [project.name, project.symbol, BigInt(project.totalUnitsRaw)]);
      await deployStage(journal, entry, 'market', account, wallet, deskArtifact, [ROBINHOOD_TESTNET.usd, entry.unitAddress, BigInt(project.priceAtomicPerUnit)]);
      const inventory = await client.readContract({ address: entry.unitAddress, abi: tokenAbi, functionName: 'balanceOf', args: [entry.marketAddress] });
      if (inventory !== BigInt(project.totalUnitsRaw)) {
        const operatorBalance = await client.readContract({ address: entry.unitAddress, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
        if (inventory !== 0n || operatorBalance !== BigInt(project.totalUnitsRaw)) throw new Error('Inventory is neither unseeded nor intact; refuse to overwrite public history.');
        if (!entry.seedHash) {
          const [pending, latest] = await Promise.all([
            client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
            client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
          ]);
          if (pending !== latest) throw new Error('Inventory transfer or another operator transaction may be in flight; wait before retrying setup.');
          entry.seedHash = await wallet.writeContract({ address: entry.unitAddress, abi: tokenAbi, functionName: 'transfer', args: [entry.marketAddress, operatorBalance] });
          await checkpoint(journal);
        }
        await receipt(entry.seedHash);
        if (await client.readContract({ address: entry.unitAddress, abi: tokenAbi, functionName: 'balanceOf', args: [entry.marketAddress] }) !== BigInt(project.totalUnitsRaw)) throw new Error('Inventory transfer not observed.');
      }
    }
    const manifest = { version: 1, chainId: 46630, cashAddress: ROBINHOOD_TESTNET.usd, cashCodeHash: await codeHash(ROBINHOOD_TESTNET.usd), operator: account.address, assets: Object.fromEntries(await Promise.all(TEST_CITY_INVESTMENTS.map(async (project) => {
      const entry = journal.assets[project.id];
      return [project.id, { unitAddress: entry.unitAddress, marketAddress: entry.marketAddress, unitCodeHash: await codeHash(entry.unitAddress), marketCodeHash: await codeHash(entry.marketAddress), priceAtomic: project.priceAtomicPerUnit, totalSupplyRaw: project.totalUnitsRaw, name: project.name, symbol: project.symbol,
        deployment: { unitHash: entry.unitHash || null, deskHash: entry.marketHash || null, seedHash: entry.seedHash || null } }];
    }))) };
    await validate(manifest);
    await publishInvestmentManifest(manifestFile, manifest);
    console.log(JSON.stringify({ state: 'provisioned', manifest: manifestFile, projects: manifest.assets }));
  }
} else if (command === 'fund') {
  const owner = option('--wallet');
  if (!owner || !isAddress(owner)) throw new Error('Specify a fresh valid --wallet address.');
  const walletAddress = getAddress(owner);
  const cash = amount(option('--cash'), 10_000_000n);
  const gas = amount(option('--gas'), 300_000_000_000_000n);
  if (cash === 0n && gas === 0n) throw new Error('Specify positive bounded cash or gas.');
  const deployment = await json(manifestFile);
  if (!deployment) throw new Error('Run setup and publish its immutable manifest first.');
  await validate(deployment);
  const { account, wallet } = await operator();
  if (account.address.toLowerCase() === walletAddress.toLowerCase()) throw new Error('Fresh wallet must differ from the operator.');
  const record = (await json(journalFile)) || { version: 1, chainId: 46630, operator: account.address, assets: {} };
  record.funding ||= {};
  const entry = record.funding[walletAddress] ||= {};
  const [currentCash, currentGas, walletNonce] = await Promise.all([
    client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'balanceOf', args: [walletAddress] }),
    client.getBalance({ address: walletAddress }),
    client.getTransactionCount({ address: walletAddress, blockTag: 'pending' }),
  ]);
  if (!entry.cash?.hash && !entry.gas?.hash && walletNonce !== 0) throw new Error('Wallet already sent a transaction; fund only a fresh isolated test wallet.');
  const fundStage = async (kind, transaction) => {
    const step = entry[kind] ||= {};
    return executeFundingStep(step, async () => {
      const [pending, latest] = await Promise.all([
        client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      ]);
      if (pending !== latest) throw new Error('Operator has a pending transaction; verify it before funding.');
      const prepared = await wallet.prepareTransactionRequest({ ...transaction, account, nonce: latest, type: 'eip1559' });
      return wallet.signTransaction(prepared);
    }, () => checkpoint(record), client);
  };
  if (cash) {
    if (entry.cashAtomic && entry.cashAtomic !== cash.toString()) throw new Error('This wallet already has a different committed faucet amount.');
    if (currentCash !== 0n && !entry.cash?.hash) throw new Error('Wallet already has test cash; refusing a second faucet.');
    entry.cashAtomic = cash.toString();
    await fundStage('cash', { to: ROBINHOOD_TESTNET.usd, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [walletAddress, cash] }) });
  }
  if (gas) {
    if (entry.gasAtomic && entry.gasAtomic !== gas.toString()) throw new Error('This wallet already has a different committed native-gas amount.');
    if (currentGas !== 0n && !entry.gas?.hash) throw new Error('Wallet already has native gas; refusing a second faucet.');
    entry.gasAtomic = gas.toString();
    await fundStage('gas', { to: walletAddress, value: gas });
  }
  console.log(JSON.stringify({ state: 'funded', wallet: walletAddress, cashHash: entry.cash?.hash, gasHash: entry.gas?.hash }));
} else if (command === 'proof') {
  const owner = option('--wallet');
  if (!owner || !isAddress(owner)) throw new Error('Specify --wallet to observe.');
  const walletAddress = getAddress(owner);
  const deployment = await json(manifestFile);
  if (!deployment) throw new Error('Immutable manifest not provisioned.');
  await validate(deployment);
  const projects = {};
  for (const project of TEST_CITY_INVESTMENTS) {
    const entry = deployment.assets[project.id];
    projects[project.id] = { address: entry.unitAddress, desk: entry.marketAddress,
      holdingRaw: String(await client.readContract({ address: entry.unitAddress, abi: tokenAbi, functionName: 'balanceOf', args: [walletAddress] })),
      inventoryRaw: String(await client.readContract({ address: entry.unitAddress, abi: tokenAbi, functionName: 'balanceOf', args: [entry.marketAddress] })) };
  }
  const evidence = { network: 46630, wallet: walletAddress, manifest: manifestFile,
    cashAtomic: String(await client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'balanceOf', args: [walletAddress] })),
    nativeAtomic: String(await client.getBalance({ address: walletAddress })), projects };
  const transactionHash = option('--tx');
  if (transactionHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error('Invalid transaction hash.');
    const transaction = await client.getTransaction({ hash: transactionHash });
    const transactionReceipt = await client.getTransactionReceipt({ hash: transactionHash });
    const canonical = await client.getBlock({ blockNumber: transactionReceipt.blockNumber });
    const tip = await client.getBlockNumber();
    if (transaction.from.toLowerCase() !== walletAddress.toLowerCase() || transaction.hash !== transactionReceipt.transactionHash || transaction.blockHash !== transactionReceipt.blockHash || canonical.hash !== transactionReceipt.blockHash || tip < transactionReceipt.blockNumber + 2n || transactionReceipt.status !== 'success') throw new Error('Transaction lacks signed wallet/canonical confirmed successful receipt.');
    const buys = [];
    for (const project of TEST_CITY_INVESTMENTS) {
      const entry = deployment.assets[project.id];
      const logs = transactionReceipt.logs;
      for (const log of logs.filter((row) => row.address.toLowerCase() === entry.marketAddress.toLowerCase())) {
        let event;
        try { event = decodeEventLog({ abi: deskAbi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
        if (event.eventName !== 'Bought' || event.args.buyer.toLowerCase() !== walletAddress.toLowerCase()) continue;
        const expected = BigInt(event.args.usdIn) * 10n ** 18n / BigInt(entry.priceAtomic);
        let usdTransfer = 0, unitTransfer = 0;
        for (const effect of logs) {
          if (![entry.unitAddress.toLowerCase(), ROBINHOOD_TESTNET.usd.toLowerCase()].includes(effect.address.toLowerCase())) continue;
          let transfer;
          try { transfer = decodeEventLog({ abi: tokenAbi, data: effect.data, topics: effect.topics, strict: true }); } catch { continue; }
          if (transfer.eventName !== 'Transfer') continue;
          if (effect.address.toLowerCase() === ROBINHOOD_TESTNET.usd.toLowerCase() && transfer.args.from.toLowerCase() === walletAddress.toLowerCase() && transfer.args.to.toLowerCase() === entry.marketAddress.toLowerCase() && transfer.args.value === event.args.usdIn) usdTransfer++;
          if (effect.address.toLowerCase() === entry.unitAddress.toLowerCase() && transfer.args.from.toLowerCase() === entry.marketAddress.toLowerCase() && transfer.args.to.toLowerCase() === walletAddress.toLowerCase() && transfer.args.value === expected) unitTransfer++;
        }
        if (usdTransfer !== 1 || unitTransfer !== 1 || event.args.stockOut !== expected || transaction.to.toLowerCase() !== entry.marketAddress.toLowerCase()) throw new Error('Bought event lacks matching exact cash/unit transfers.');
        buys.push({ projectId: project.id, hash: transactionHash, cashAtomic: String(event.args.usdIn), unitsRaw: String(event.args.stockOut), block: String(transactionReceipt.blockNumber) });
      }
    }
    if (buys.length !== 1) throw new Error('Transaction is not exactly one verified fictional-unit purchase.');
    evidence.verifiedBuy = buys[0];
  }
  console.log(JSON.stringify(evidence, null, 2));
} else throw new Error('Usage: setup --send | fund --wallet ADDRESS --cash ATOMIC --gas WEI --send | proof --wallet ADDRESS [--tx HASH]');
