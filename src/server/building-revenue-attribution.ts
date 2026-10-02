export type BuildingInflow = { transactionHash: string; logIndex: number; from: string; blockNumber: string; amountRaw: string; explorerUrl: string };
export type IncomeEvidence = { transactionHash: string; amountRaw: string; kind: 'gpu' | 'solar'; hostId: string; hostName: string };
const meanings = {
  gpu: 'Confirmed test-dollar payment for a completed GPU answer; this host opted into building payouts.',
  solar: 'Simulated solar feed-in income minted from a signed Home Node kWh reading, not an electricity sale.',
  unattributed: 'Confirmed test-dollar transfer without matching GPU settlement or simulated-solar journal evidence.',
} as const;

/** Match each log once; never call all transfers GPU revenue, nor all zero-address mints solar. */
export function attributeBuildingIncome(inflows: BuildingInflow[], evidence: IncomeEvidence[]) {
  const available = new Map<string, IncomeEvidence[]>();
  for (const row of evidence) {
    const key = `${row.transactionHash.toLowerCase()}:${row.amountRaw}`;
    const bucket = available.get(key) ?? [];
    if (!bucket.some(item => item.kind === row.kind && item.hostId === row.hostId)) bucket.push(row);
    available.set(key, bucket);
  }
  const totals = new Map<string, { id: string; kind: 'gpu' | 'solar' | 'unattributed'; name: string; meaning: string; amountRaw: string; receipts: number }>();
  const transactions = inflows.map(row => {
    const key = `${row.transactionHash.toLowerCase()}:${row.amountRaw}`;
    const bucket = available.get(key) ?? [];
    const index = bucket.findIndex(item => item.kind !== 'solar' || /^0x0{40}$/i.test(row.from));
    const match = index >= 0 ? bucket.splice(index, 1)[0] : null;
    const kind = match?.kind ?? 'unattributed';
    const sourceId = match ? `${kind}:${match.hostId}` : 'unattributed';
    const sourceName = match ? `${kind === 'gpu' ? 'GPU' : 'Simulated solar'} · ${match.hostName}` : 'Unattributed transfers';
    const current = totals.get(sourceId) ?? { id: sourceId, kind, name: sourceName, meaning: meanings[kind], amountRaw: '0', receipts: 0 };
    current.amountRaw = (BigInt(current.amountRaw) + BigInt(row.amountRaw)).toString();
    current.receipts++;
    totals.set(sourceId, current);
    return { ...row, sourceId, sourceName, kind };
  });
  return { transactions, sources: [...totals.values()] };
}
