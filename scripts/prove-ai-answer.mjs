#!/usr/bin/env node
// Read-only evidence for one paid local-AI answer: what the request recorded and what the chain settled.
//
//   node scripts/prove-ai-answer.mjs 0x<settlement transaction hash>
//   LEDGER_BEARER=<access token> node scripts/prove-ai-answer.mjs <request id> [--origin https://ledger.stadtstack.eu]
//
// A settlement hash needs only the public Robinhood Chain testnet RPC (override: ROBINHOOD_TESTNET_RPC_URL).
// A request id is looked up in the app, which keeps requests private to their owner: pass the owner's access token in
// LEDGER_BEARER (never as an argument), or give the hash shown on the desk's receipt. The question and answer text are
// never printed. Nothing is sent to the chain.
import { createPublicClient, decodeFunctionData, getAddress, http, parseAbiItem } from 'viem';
import { x402UptoPermit2ProxyABI, x402UptoPermit2ProxyAddress } from '@x402/evm';

const RPC = process.env.ROBINHOOD_TESTNET_RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
const TOKEN = '0xA6e10E426A738aEF586dB5191177658D67C78A14'; // tUSDG
const PRICE = 100n; // atomic tUSDG per output token (src/domain/ai-pricing.ts)
const MAX_OUTPUT = 192n;
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const usdg = (atomic) => `${Number(atomic) / 1e6} tUSDG (${atomic} atomic)`;
const fail = (message) => { console.error(message); process.exit(1); };

const args = process.argv.slice(2);
const originIndex = args.indexOf('--origin');
const origin = originIndex >= 0 ? args.splice(originIndex, 2)[1] : 'https://ledger.stadtstack.eu';
const [input] = args;
if (!input || args.length !== 1) fail('Usage: node scripts/prove-ai-answer.mjs <0x settlement hash | request id> [--origin URL]');

let hash = /^0x[0-9a-fA-F]{64}$/.test(input) ? input : null;
let recordedTokens = null;
if (!hash) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) fail('Give a 0x… transaction hash or a request id (UUID).');
  const bearer = process.env.LEDGER_BEARER;
  if (!bearer) fail('Request records are private to their owner. Set LEDGER_BEARER to the owner\'s access token, or pass the settlement hash from the desk\'s receipt.');
  const response = await fetch(new URL(`/api/local-ai/requests/${input}`, origin), { headers: { Authorization: `Bearer ${bearer}` }, cache: 'no-store' });
  if (!response.ok && response.status !== 202) fail(`The app answered ${response.status} for that request.`);
  const { request } = await response.json();
  const usage = request.usage;
  console.log('Request', request.id);
  console.log('  state            ', request.state, '·', request.mode, '·', request.host ? `host ${request.host.name}${request.host.own ? ' (own)' : ''}` : 'direct');
  console.log('  created / expires', request.createdAt, '/', request.expiresAt);
  console.log('  token limit      ', request.maxOutputTokens);
  if (usage) {
    console.log('  input tokens     ', usage.inputTokens);
    console.log('  output tokens    ', usage.outputTokens);
    console.log('  wall time        ', `${(usage.wallMs / 1000).toFixed(2)} s`, usage.totalMs != null ? `(model total ${(usage.totalMs / 1000).toFixed(2)} s, load ${((usage.loadMs ?? 0) / 1000).toFixed(2)} s, decode ${((usage.evalMs ?? 0) / 1000).toFixed(2)} s)` : '');
    console.log('  decode rate      ', usage.tokensPerSecond != null ? `${usage.tokensPerSecond} tokens/s` : 'unavailable');
    recordedTokens = usage.outputTokens;
  } else console.log('  usage            none recorded');
  console.log('  payment          ', request.payment.state, request.payment.amountAtomic ? `· quoted ${usdg(request.payment.amountAtomic)}` : '');
  hash = request.payment.receipt?.transaction ?? null;
  if (!hash) { console.log('No settlement transaction is recorded for this request (free, own-host, unpaid or incomplete answers are never charged).'); process.exit(0); }
}

const client = createPublicClient({ transport: http(RPC) });
const chainId = await client.getChainId();
if (chainId !== 46630) fail(`RPC reports chain ${chainId}, not Robinhood Chain testnet (46630).`);
const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
const block = await client.getBlock({ blockNumber: receipt.blockNumber });
console.log('\nSettlement', hash);
console.log('  status           ', receipt.status, '· block', receipt.blockNumber.toString(), '·', new Date(Number(block.timestamp) * 1000).toISOString());

const isUpto = tx.to && getAddress(tx.to) === getAddress(x402UptoPermit2ProxyAddress);
let maximum = null, requested = null;
if (isUpto) {
  const decoded = decodeFunctionData({ abi: x402UptoPermit2ProxyABI, data: tx.input });
  if (decoded.functionName === 'settle') {
    maximum = decoded.args[0].permitted.amount;
    requested = decoded.args[1];
    console.log('  scheme           ', 'x402 upto via Permit2 proxy · signed maximum', usdg(maximum));
  }
} else console.log('  scheme           ', 'NOT the x402 upto proxy: this is not a per-token upto settlement');

const events = (await client.getLogs({ address: TOKEN, event: transfer, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber })).filter((log) => log.transactionHash === hash);
if (!events.length) fail('The transaction contains no tUSDG transfer.');
for (const event of events) console.log('  transfer         ', usdg(event.args.value), event.args.from, '→', event.args.to);
const settled = events.reduce((sum, event) => sum + event.args.value, 0n);
console.log('  settled amount   ', usdg(settled));
if (isUpto && settled % PRICE === 0n) console.log('  implied output   ', `${settled / PRICE} tokens at ${usdg(PRICE)} each`);
const checks = [];
if (receipt.status !== 'success') checks.push('the transaction reverted');
if (!isUpto) checks.push('it is not an upto settlement');
if (settled % PRICE !== 0n || settled / PRICE > MAX_OUTPUT) checks.push(`the amount is not a whole number of tokens up to ${MAX_OUTPUT}`);
if (requested !== null && requested !== settled) checks.push(`the settle call asked for ${usdg(requested)}`);
if (maximum !== null && settled > maximum) checks.push('the amount exceeds the signed maximum');
if (recordedTokens !== null && BigInt(recordedTokens) * PRICE !== settled) checks.push(`the request recorded ${recordedTokens} output tokens (${usdg(BigInt(recordedTokens) * PRICE)})`);
console.log(checks.length ? `\nDoes NOT match a per-token upto answer: ${checks.join('; ')}.` : '\nMatches a per-token upto answer: amount = output tokens × 0.0001 tUSDG, within the signed maximum.');
process.exit(checks.length ? 2 : 0);
