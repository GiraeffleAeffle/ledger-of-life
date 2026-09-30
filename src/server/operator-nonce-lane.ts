import { getAddress } from 'viem';
import type { Store } from './store.ts';

type Lane = { active: string | null };
const laneKey = (signer: string) => `operator-nonce-lane:46630:${getAddress(signer).toLowerCase()}`;

/** Durable, single-writer reservation for a shared operator account across server instances.
 * A failed/unknown write retains its lane until the same journal is reconciled. */
export async function acquireOperatorNonceLane(store: Store, signer: string, operation: string) {
  const key = laneKey(signer);
  try { await store.create<Lane>(key, { active: operation }); return; }
  catch (error) { if (!(await store.get<Lane>(key))) throw error; }
  await store.update<Lane>(key, (lane) => {
    if (lane.active && lane.active !== operation) throw new Error(`The shared operator signer has an unresolved testnet operation (${lane.active}); reconcile it before another operator transfer.`);
    return { active: operation };
  });
}
export async function releaseOperatorNonceLane(store: Store, signer: string, operation: string) {
  await store.update<Lane>(laneKey(signer), (lane) => {
    if (lane.active !== operation) throw new Error('The operator nonce reservation changed before release.');
    return { active: null };
  });
}
export async function releaseOperatorNonceLaneIfOwned(store: Store, signer: string, operation: string) {
  if ((await store.get<Lane>(laneKey(signer)))?.active === operation)
    await releaseOperatorNonceLane(store, signer, operation);
}

