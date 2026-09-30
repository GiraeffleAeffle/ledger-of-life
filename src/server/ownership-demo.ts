import { createPublicClient, defineChain, encodeFunctionData, getAddress, http, keccak256, parseAbi, type Address } from 'viem';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { walletFor } from './agreements.ts';
import { executeFundingStep, type SignedFundingStep } from './local-investment-provisioning.ts';
import { ownershipProvisioner, readShareWorkflows, startShareMarket, type WorkflowDeployment } from './share-workflows.ts';
import type { Store } from './store.ts';
import { operatorTestCapability } from './test-capability.ts';
import { acquireOperatorNonceLane, releaseOperatorNonceLane } from './operator-nonce-lane.ts';
import { reviewedOperatorFees, reviewedOperatorGas } from './ownership-gas.ts';

const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const rpc = createPublicClient({ chain, transport: http() });
const tokenAbi = parseAbi(['function mint(address,uint256)']);
const twoShares = 2n * 10n ** 18n;
const gasFloor = 100_000_000_000_000n;
const gasGrant = 300_000_000_000_000n;
type Preparation = { owner: Address; provisioner: Address; state: 'reserved' | 'paused' | 'ready'; stock?: Address; mint?: SignedFundingStep; gas?: SignedFundingStep };
export type OwnershipPreparation = { state: 'ready'; sharesRaw: string; gasGrantAtomic: string; market: string };
export type OwnershipPreparationStatus = { state: 'none' | Preparation['state'] };
export async function readOwnershipPreparation(store: Store, identity: VerifiedIdentity): Promise<OwnershipPreparationStatus> {
  const owner = getAddress(walletFor(identity, 'robinhood').address);
  const entry = await store.get<Preparation>(keyFor(owner));
  if (entry && entry.owner.toLowerCase() !== owner.toLowerCase()) throw new Error('Example-share reservation does not belong to this wallet.');
  return { state: entry?.state ?? 'none' };
}
const active = new Set<string>();
const keyFor = (owner: Address) => `ownership-example:${owner.toLowerCase()}`;
const marketKey = (owner: Address) => `share-workflows:${owner.toLowerCase()}`;
type ShareState = { sharesRaw: string; loan: { sharesRaw: string; debtAtomic: string } | null; deposit: { state: number } | null };
/** Already locked shares, debt and active deposit claims are never reset or treated as a blank slate. */
export function assertEmptySharePosition(position: ShareState) {
  if (BigInt(position.sharesRaw) !== 0n || BigInt(position.loan?.sharesRaw ?? '0') !== 0n || BigInt(position.loan?.debtAtomic ?? '0') !== 0n ||
    (position.deposit && position.deposit.state > 0 && position.deposit.state < 5))
    throw new Error('This account already has shares, locked collateral, a loan or a deposit. Continue with that position instead.');
}

/** POST only: one durable reservation for an empty personal share position. Neither tenancy nor cash is modified. */
export async function prepareOwnershipExample(store: Store, identity: VerifiedIdentity): Promise<OwnershipPreparation> {
  if (!operatorTestCapability()) throw new Error('Example-share preparation is disabled outside operator-approved test mode.');
  const owner = getAddress(walletFor(identity, 'robinhood').address);
  const signer = await ownershipProvisioner();
  const key = keyFor(owner);
  if (active.has(key)) throw new Error('Example shares are being prepared; wait for the current transaction to settle.');
  active.add(key);
  try {
    let entry = await store.get<Preparation>(key);
    if (!entry) {
      const current = await store.get<WorkflowDeployment | { status: 'starting' }>(marketKey(owner));
      if (current?.status === 'starting') throw new Error('Existing test market setup has an unresolved transaction; no new setup was started.');
      if (current && !current.stock) throw new Error('This older share market cannot be upgraded or reset. Your existing positions remain unchanged.');
      const position = await readShareWorkflows(store, owner);
      assertEmptySharePosition(position);
      try { await store.create(key, { owner, provisioner: signer.address, state: 'reserved' } satisfies Preparation); }
      catch (error) {
        if (await store.get(key)) throw new Error('An example-share preparation is already reserved for this wallet; retry after it settles.');
        throw error;
      }
      entry = await store.get<Preparation>(key);
    }
    if (!entry || entry.owner !== owner || entry.provisioner?.toLowerCase() !== signer.address.toLowerCase())
      throw new Error('The reserved provisioner changed; no new shares were minted.');
    const operation = `ownership-example:${owner.toLowerCase()}`;
    await acquireOperatorNonceLane(store, signer.address, operation);
    if (entry.state === 'ready') {
      await releaseOperatorNonceLane(store, signer.address, operation);
      return { state: 'ready', sharesRaw: twoShares.toString(), gasGrantAtomic: entry.gas?.hash ? gasGrant.toString() : '0', market: entry.stock! };
    }
    let market = await store.get<WorkflowDeployment | { status: 'starting' }>(marketKey(owner));
    if (!market || market.status === 'starting') market = await startShareMarket(store, owner, operation);
    if (market.status !== 'ready' || !market.stock) throw new Error('The test share market is unresolved; no mint was submitted.');
    const stock = market.stock;
    if (entry.stock && entry.stock.toLowerCase() !== stock.toLowerCase()) throw new Error('The reserved market changed; no mint was submitted.');
    if (!entry.mint?.signed) {
      const position = await readShareWorkflows(store, owner);
      try { assertEmptySharePosition(position); }
      catch (error) {
        await store.update<Preparation>(key, (value) => {
          if (value.mint?.signed || value.gas?.signed) throw new Error('A signed preparation must be reconciled before pausing it.');
          return { ...value, state: 'paused' };
        });
        await releaseOperatorNonceLane(store, signer.address, operation);
        throw error;
      }
      entry = await store.update<Preparation>(key, (value) => ({
        ...value, stock: value.stock ?? stock, state: 'reserved',
      }));
    }
    const signStep = async (kind: 'mint' | 'gas') => {
      const to = kind === 'mint' ? stock : owner;
      const data = kind === 'mint' ? encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [owner, twoShares] }) : '0x';
      const value = kind === 'gas' ? gasGrant : 0n;
      const [fees, nonce, estimate] = await Promise.all([
        rpc.estimateFeesPerGas(),
        rpc.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
        rpc.estimateGas({ account: signer.address, to, data, value }),
      ]);
      return signer.signTransaction({ type: 'eip1559', chainId: chain.id, nonce, to, data, value,
        gas: reviewedOperatorGas(estimate, 'transfer'), ...reviewedOperatorFees(fees) });
    };
    async function step(kind: 'mint' | 'gas') {
      const pending = (await store.get<Preparation>(key))?.[kind] ?? {};
      return executeFundingStep(pending, () => signStep(kind), async () => {
        await store.update<Preparation>(key, (value) => {
          if (value.state !== 'reserved') throw new Error('Example-share reservation is paused; no transaction was sent.');
          const original = value[kind];
          if (original?.signed && original.signed !== pending.signed) throw new Error('Another signed operator transaction already reserves this step.');
          if (original?.hash && original.hash !== keccak256(pending.signed!)) throw new Error('Operator transaction journal changed.');
          return { ...value, [kind]: { ...pending } };
        });
      }, rpc);
    }
    await step('mint');
    // Recover a signed gas transaction even if another operation has since funded the wallet.
    const gasPending = (await store.get<Preparation>(key))!.gas?.signed;
    if (gasPending || (await rpc.getBalance({ address: owner })) < gasFloor) await step('gas');
    entry = await store.update<Preparation>(key, (value) => ({ ...value, state: 'ready' }));
    await releaseOperatorNonceLane(store, signer.address, operation);
    return { state: 'ready', sharesRaw: twoShares.toString(), gasGrantAtomic: entry.gas?.hash ? gasGrant.toString() : '0', market: stock };
  } finally { active.delete(key); }
}
