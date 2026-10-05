import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, defineChain, getAddress, http, keccak256, parseAbi, type Address } from 'viem';
import { PERMIT2_ADDRESS, x402UptoPermit2ProxyABI, x402UptoPermit2ProxyAddress } from '@x402/evm';
import { TEST_USDG_ADDRESS } from '../wallets/inference-token.ts';
import { ConflictError } from './errors.ts';
import type { LocalAiContext, LocalAiRequestUsage } from './local-ai-types.ts';
import type { Store } from './store.ts';
import { AI_PRICE, AI_MAX_OUTPUT } from '../domain/ai-pricing.ts';
import { boundedOutputTokens } from './local-ai-usage.ts';

export const AI_CHAIN = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
export const aiRpc = createPublicClient({ chain: AI_CHAIN, transport: http() });
export const aiTokenAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
export function inferenceMaximum(maxOutputTokens: number): bigint {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > AI_MAX_OUTPUT)
    throw new ConflictError('Invalid answer token limit.');
  return BigInt(maxOutputTokens) * AI_PRICE;
}
export function inferenceCharge(outputTokens: number | null, maximum: bigint): bigint {
  if (outputTokens === null || !Number.isSafeInteger(outputTokens) || outputTokens < 0)
    throw new ConflictError('Completed paid inference requires measured output tokens.');
  const amount = BigInt(outputTokens) * AI_PRICE;
  if (amount > maximum) throw new ConflictError('Inference usage exceeds the signed maximum. No inference payment was sent.');
  return amount;
}
export const AI_BUDGET = 100000n;
export const AI_CONTEXT_TOKENS = 8192;
export const AI_MODEL = process.env.LOCAL_AI_MODEL || 'qwen3.8:27b-ud-q3-k-xl';
export const AI_CONTRACT_HASHES = {
  permit2: '0x0117e0ed818bc3f2a8729ffc336c837e63e965f04b473047b39b35ad86aac259',
  proxy: '0x4662dc27323421a3698be49ac95f7b0dba141c238d31ef543248d1a11f8d8eec',
  token: '0x3e4adb6eab9d495c72d672fb619614979f38b422e49fcdb1b5e4c3b53744fe80',
} as const;
const deployment = 'contracts/evm/deployments/local-investments-46630.json';
export async function inferencePayee(): Promise<Address> {
  if (process.env.LOCAL_AI_PAY_TO) return getAddress(process.env.LOCAL_AI_PAY_TO);
  const manifest = JSON.parse(await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ process.env.LOCAL_INVESTMENTS_MANIFEST_FILE || deployment), 'utf8')) as { chainId: number; operator: string };
  if (manifest.chainId !== 46630) throw new ConflictError('Wrong recipient manifest network.');
  return getAddress(manifest.operator);
}
export async function assertInferenceContracts(rpc: typeof aiRpc = aiRpc) {
  const [chainId, permitCode, proxyCode, tokenCode, linked, decimals, name, symbol] = await Promise.all([
    rpc.getChainId(), rpc.getCode({ address: PERMIT2_ADDRESS }), rpc.getCode({ address: x402UptoPermit2ProxyAddress }),
    rpc.getCode({ address: TEST_USDG_ADDRESS }), rpc.readContract({ address: x402UptoPermit2ProxyAddress, abi: x402UptoPermit2ProxyABI, functionName: 'PERMIT2' }),
    rpc.readContract({ address: TEST_USDG_ADDRESS, abi: aiTokenAbi, functionName: 'decimals' }),
    rpc.readContract({ address: TEST_USDG_ADDRESS, abi: aiTokenAbi, functionName: 'name' }),
    rpc.readContract({ address: TEST_USDG_ADDRESS, abi: aiTokenAbi, functionName: 'symbol' }),
  ]);
  if (chainId !== 46630 || keccak256(permitCode || '0x') !== AI_CONTRACT_HASHES.permit2 || keccak256(proxyCode || '0x') !== AI_CONTRACT_HASHES.proxy ||
      keccak256(tokenCode || '0x') !== AI_CONTRACT_HASHES.token || linked.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase() ||
      decimals !== 6 || name !== 'Test USDG (no value)' || symbol !== 'tUSDG')
    throw new ConflictError('Inference payment contracts do not match the reviewed deployment.');
}
/** Read-only model discovery before displaying a paid quote; this does not guarantee inference succeeds. */
export async function assertInferenceAvailable(fetcher: typeof fetch = fetch) {
  const url = process.env.LOCAL_AI_OLLAMA_URL;
  if (!url) throw new ConflictError('Local inference host is not configured.');
  const response = await fetcher(`${url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new ConflictError('Local model discovery is unavailable.');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('models' in body) || !Array.isArray(body.models) ||
      !body.models.some((model: unknown) => model && typeof model === 'object' && 'name' in model && model.name === AI_MODEL))
    throw new ConflictError('Configured local Qwen model is not installed on the inference host.');
}
export const instructions: Record<LocalAiContext, string> = {
  general: 'Answer clearly and directly. Distinguish unknown facts from known facts. Do not invent local events, ownership rights or measured business returns.',
  housing: 'Explain housing and rental questions with practical next steps. Do not imply a demo token or a fictional share is a real tenancy or enforceable claim.',
  business: 'Explain company and local business questions plainly. Fictional demonstration units confer no legal ownership or membership; distinguish observed facts from scenarios.',
};
export async function runLocalInference(input: { prompt: string; context: LocalAiContext; maxOutputTokens: number }, fetcher: typeof fetch = fetch): Promise<{ answer: string; usage: LocalAiRequestUsage }> {
  const url = process.env.LOCAL_AI_OLLAMA_URL;
  if (!url) throw new Error('Local model endpoint is not configured.');
  const controller = new AbortController();
  const started = performance.now();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetcher(`${url.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ model: AI_MODEL, stream: false, think: false,
        messages: [{ role: 'system', content: instructions[input.context] }, { role: 'user', content: input.prompt }],
        options: { num_ctx: AI_CONTEXT_TOKENS, num_predict: input.maxOutputTokens, temperature: 0.35 } }),
    });
    if (!response.ok) throw new Error('The local model did not complete the answer. No inference payment was sent.');
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('done' in data) || data.done !== true ||
        !('done_reason' in data) || data.done_reason !== 'stop' ||
        !('message' in data) || !data.message || typeof data.message !== 'object' ||
        !('content' in data.message) || typeof data.message.content !== 'string' ||
        !data.message.content.trim() || data.message.content.length > 16000 ||
        ('error' in data && data.error) || ('model' in data && data.model !== AI_MODEL))
      throw new Error('The local model returned an incomplete answer. No inference payment was sent.');
    const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const duration = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value / 1e6 : null;
    const inputTokens = 'prompt_eval_count' in data ? count(data.prompt_eval_count) : null;
    const outputTokens = boundedOutputTokens('eval_count' in data ? data.eval_count : null, input.maxOutputTokens,
      data.message.content, 'thinking' in data.message ? data.message.thinking : null);
    const evalMs = 'eval_duration' in data ? duration(data.eval_duration) : null;
    return { answer: data.message.content.trim(), usage: {
      inputTokens, outputTokens, wallMs: Math.round(performance.now() - started),
      totalMs: 'total_duration' in data ? duration(data.total_duration) : null,
      loadMs: 'load_duration' in data ? duration(data.load_duration) : null, evalMs,
      tokensPerSecond: outputTokens !== null && evalMs && evalMs > 0 ? Math.round(outputTokens / evalMs * 100000) / 100 : null,
    } };
  } finally { clearTimeout(timeout); }
}
export async function reserveHost(store: Store, requestId: string): Promise<void> {
  try { await store.create('local-ai:host', { requestId, started: Date.now() }); return; } catch { /* inspect active lease */ }
  await store.update<{ requestId: string; started: number }>('local-ai:host', (slot) => {
    if (slot.requestId && Date.now() - slot.started < 150000)
      throw new ConflictError('Local inference is busy; retry shortly.');
    return { requestId, started: Date.now() };
  });
}
export async function releaseHost(store: Store, requestId: string): Promise<void> {
  await store.update<{ requestId: string; started: number }>('local-ai:host', (slot) =>
    slot.requestId === requestId ? { requestId: '', started: 0 } : slot);
}
