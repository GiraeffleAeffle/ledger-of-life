#!/usr/bin/env node

// Devnet test market for the investment half of the journey. xStocks do not exist on devnet,
// so this creates a Token-2022 copy ("tSPYx") with the same ScaledUiAmount mechanism xStocks use
// for corporate actions, and a test market maker that sells it atomically for test USDC at the
// live mainnet SPYx reference price. Test tokens have no value and are not xStocks.
//
//   node --env-file-if-exists=.env.local --experimental-strip-types scripts/solana-test-market.mjs \
//     setup | status | buy USDC_ATOMIC | dividend BPS | sell RAW_ATOMIC   [--send]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializeScaledUiAmountMintInstruction,
  getInitializeTokenMetadataInstruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
  getUpdateMultiplierScaledUiMintInstruction,
} from '@solana-program/token-2022';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TEST_USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const CLASSIC_TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SPYX_MAINNET = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const DECIMALS = 8;
const INVENTORY = 1_000n * 10n ** 8n; // 1,000 test shares held by the market maker

const [command = 'status', amountArg] = process.argv.slice(2);
const send = process.argv.includes('--send');
if (!['setup', 'status', 'buy', 'dividend', 'sell'].includes(command)) {
  console.error('Usage: solana-test-market.mjs setup|status|buy USDC_ATOMIC|dividend BPS|sell RAW_ATOMIC [--send]');
  process.exit(2);
}
const dir = resolve(process.env.SOLANA_TEST_SIGNER_DIR || '.testnet-secrets/test-signer');
const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com');
if ((await rpc.getGenesisHash().send()) !== DEVNET_GENESIS) throw new Error('The test market runs on devnet only');
const log = (value) => console.log(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

async function keypair(name, create = false) {
  const path = resolve(dir, `${name}.json`);
  try {
    return await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(path, 'utf8'))));
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const part = (key, field) => Buffer.from(key.export({ format: 'jwk' })[field], 'base64url');
    const bytes = [...part(privateKey, 'd'), ...part(publicKey, 'x')];
    await writeFile(path, JSON.stringify(bytes), { mode: 0o600, flag: 'wx' });
    return createKeyPairSignerFromBytes(new Uint8Array(bytes));
  }
}

async function submit(label, feePayer, signers, instructions) {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'finalized' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await partiallySignTransaction(signers.map((s) => s.keyPair), compileTransaction(message));
  const wire = getBase64EncodedWireTransaction(signed);
  const simulation = await rpc.simulateTransaction(wire, { encoding: 'base64', commitment: 'confirmed' }).send();
  if (simulation.value.err) throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)} ${simulation.value.logs?.slice(-3).join(' | ')}`);
  const signature = getBase58Decoder().decode(signed.signatures[feePayer]);
  if (!send) return log({ step: label, status: 'simulation-passed', signature });
  await rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  for (let attempt = 0; attempt < 60; attempt++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(value[0].err)}`);
    if (value[0]?.confirmationStatus === 'finalized') return log({ step: label, status: 'finalized', signature });
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error(`${label}: finality unknown for ${signature}; check before retrying`);
}

const ata = async (owner, mint, tokenProgram) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
async function balance(account) {
  try {
    return BigInt((await rpc.getTokenAccountBalance(account, { commitment: 'finalized' }).send()).value.amount);
  } catch {
    return 0n;
  }
}
async function referencePrice() {
  const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SPYX_MAINNET}`);
  const price = (await response.json())[SPYX_MAINNET]?.usdPrice;
  if (!response.ok || !(price > 0)) throw new Error('Mainnet SPYx reference price unavailable');
  return price;
}
function multiplierOf(mint) {
  const config = mint.data.extensions.__option === 'Some'
    ? mint.data.extensions.value.find((item) => item.__kind === 'ScaledUiAmountConfig')
    : undefined;
  if (!config) throw new Error('tSPYx has no scaled UI configuration');
  const now = BigInt(Math.floor(Date.now() / 1000));
  return now >= config.newMultiplierEffectiveTimestamp ? config.newMultiplier : config.multiplier;
}

const marketMaker = await keypair('market-maker', command === 'setup');
const tenant = await keypair('tenant');
const statePath = resolve(dir, 'market.json');

if (command === 'setup') {
  const existing = await readFile(statePath, 'utf8').catch(() => null);
  if (existing) throw new Error(`Market already set up: ${JSON.parse(existing).mint}`);
  const mint = await keypair('tspyx-mint', true);
  const deployer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(
    await readFile(resolve('.testnet-secrets/solana/deployer-keypair.json'), 'utf8'))));
  const metadata = { name: 'Test SPYx copy (no value)', symbol: 'tSPYx', uri: '' };
  const extensions = [
    extension('MetadataPointer', { authority: marketMaker.address, metadataAddress: mint.address }),
    extension('ScaledUiAmountConfig', {
      authority: marketMaker.address, multiplier: 1, newMultiplierEffectiveTimestamp: 0n, newMultiplier: 1,
    }),
  ];
  const space = BigInt(getMintSize(extensions));
  const rent = await rpc.getMinimumBalanceForRentExemption(
    BigInt(getMintSize([...extensions, extension('TokenMetadata', {
      updateAuthority: marketMaker.address, mint: mint.address, ...metadata, additionalMetadata: new Map(),
    })])),
  ).send();
  const inventory = await ata(marketMaker.address, mint.address, TOKEN_2022_PROGRAM_ADDRESS);
  await submit('fund market maker with 0.05 devnet SOL', deployer.address, [deployer], [
    getTransferSolInstruction({ source: deployer, destination: marketMaker.address, amount: 50_000_000n }),
  ]);
  if (!send) process.exit(0);
  await submit('create tSPYx mint with scaled UI amount', marketMaker.address, [marketMaker, mint], [
    getCreateAccountInstruction({ payer: marketMaker, newAccount: mint, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    getInitializeMetadataPointerInstruction({ mint: mint.address, authority: marketMaker.address, metadataAddress: mint.address }),
    getInitializeScaledUiAmountMintInstruction({ mint: mint.address, authority: marketMaker.address, multiplier: 1 }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: marketMaker.address, freezeAuthority: null }),
    getInitializeTokenMetadataInstruction({
      metadata: mint.address, updateAuthority: marketMaker.address, mint: mint.address, mintAuthority: marketMaker, ...metadata,
    }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer: marketMaker, ata: inventory, owner: marketMaker.address, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getMintToCheckedInstruction({ mint: mint.address, token: inventory, mintAuthority: marketMaker, amount: INVENTORY, decimals: DECIMALS }),
  ]);
  await writeFile(statePath, JSON.stringify({ mint: mint.address, marketMaker: marketMaker.address }, null, 2), { mode: 0o600 });
  log({ mint: mint.address, marketMaker: marketMaker.address, inventory: '1000 tSPYx' });
  process.exit(0);
}

const { mint: mintAddress } = JSON.parse(await readFile(statePath, 'utf8'));
const mintAccount = await fetchMint(rpc, address(mintAddress), { commitment: 'finalized' });
const multiplier = multiplierOf(mintAccount);
const [tenantUsdc, tenantStock, makerUsdc, makerStock] = await Promise.all([
  ata(tenant.address, TEST_USDC, CLASSIC_TOKEN),
  ata(tenant.address, mintAccount.address, TOKEN_2022_PROGRAM_ADDRESS),
  ata(marketMaker.address, TEST_USDC, CLASSIC_TOKEN),
  ata(marketMaker.address, mintAccount.address, TOKEN_2022_PROGRAM_ADDRESS),
]);
const price = await referencePrice();
// Price is per displayed share; displayed = raw * multiplier.
const priceMicro = BigInt(Math.round(price * 1e6));
const multiplierE9 = BigInt(Math.round(multiplier * 1e9));

if (command === 'status') {
  const raw = await balance(tenantStock);
  const shares = Number(raw) * multiplier / 1e8;
  log({
    mint: mintAccount.address, multiplier, referencePriceUsd: price,
    tenantUsdcAtomic: await balance(tenantUsdc), tenantRawAtomic: raw, tenantShares: shares,
    tenantValueUsd: Number((shares * price).toFixed(6)), makerInventoryRaw: await balance(makerStock),
  });
} else if (command === 'buy') {
  const usdcIn = BigInt(amountArg ?? '');
  if (usdcIn <= 0n || usdcIn > 20_000_000n) throw new Error('Buy between 0 and 20 test USDC (atomic units)');
  const rawOut = (usdcIn * 10n ** 8n * 10n ** 9n) / (priceMicro * multiplierE9);
  log({ quote: { usdcInAtomic: usdcIn, rawOutAtomic: rawOut, shares: Number(rawOut) * multiplier / 1e8, referencePriceUsd: price } });
  // One atomic transaction: the tenant pays test USDC and receives tSPYx, or nothing happens.
  await submit('tenant buys tSPYx from test market maker', marketMaker.address, [marketMaker, tenant], [
    getCreateAssociatedTokenIdempotentInstruction({ payer: marketMaker, ata: makerUsdc, owner: marketMaker.address, mint: TEST_USDC, tokenProgram: CLASSIC_TOKEN }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: marketMaker, ata: tenantStock, owner: tenant.address, mint: mintAccount.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    getTransferCheckedInstruction({ source: tenantUsdc, mint: TEST_USDC, destination: makerUsdc, authority: tenant, amount: usdcIn, decimals: 6 }, { programAddress: CLASSIC_TOKEN }),
    getTransferCheckedInstruction({ source: makerStock, mint: mintAccount.address, destination: tenantStock, authority: marketMaker, amount: rawOut, decimals: DECIMALS }),
  ]);
} else if (command === 'sell') {
  const rawIn = BigInt(amountArg ?? '');
  if (rawIn <= 0n || rawIn > (await balance(tenantStock))) throw new Error('Sell a positive amount within the holding');
  const usdcOut = (rawIn * priceMicro * multiplierE9) / (10n ** 8n * 10n ** 9n);
  log({ quote: { rawInAtomic: rawIn, usdcOutAtomic: usdcOut, referencePriceUsd: price } });
  await submit('tenant sells tSPYx to test market maker', marketMaker.address, [marketMaker, tenant], [
    getTransferCheckedInstruction({ source: tenantStock, mint: mintAccount.address, destination: makerStock, authority: tenant, amount: rawIn, decimals: DECIMALS }),
    getTransferCheckedInstruction({ source: makerUsdc, mint: TEST_USDC, destination: tenantUsdc, authority: marketMaker, amount: usdcOut, decimals: 6 }, { programAddress: CLASSIC_TOKEN }),
  ]);
} else {
  // xStocks reflect distributions by raising the multiplier: raw balances stay, displayed shares grow.
  const bps = Number(amountArg);
  if (!Number.isInteger(bps) || bps <= 0 || bps > 500) throw new Error('Use a distribution between 1 and 500 bps');
  const next = multiplier * (1 + bps / 10_000);
  log({ distribution: { bps, multiplierBefore: multiplier, multiplierAfter: next } });
  await submit('test distribution: raise tSPYx multiplier', marketMaker.address, [marketMaker], [
    getUpdateMultiplierScaledUiMintInstruction({
      mint: mintAccount.address, authority: marketMaker, multiplier: next, effectiveTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    }),
  ]);
}
