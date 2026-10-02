export type BuildingInflow = { transactionHash: string; logIndex: number; from: string; blockNumber: string; amountRaw: string; explorerUrl: string };
export type IncomeEvidence = { transactionHash: string; amountRaw: string } & (
  { kind: 'gpu' | 'solar'; hostId: string; hostName: string } |
  { kind: 'rent' }
);
type RentAttributionJournal = {
  flatLabel: string; distributor: string; token: string; buildingRaw: string;
  steps: { kind: string; state: string; recipient: string; amountRaw: string; hash?: string }[];
};

/** A confirmed building step is evidence even if the separate landlord transfer is unfinished. */
export function rentPaymentEvidence(journals: RentAttributionJournal[], target: { distributor: string; payoutToken: string }): IncomeEvidence[] {
  const evidence: IncomeEvidence[] = [];
  for (const journal of journals) {
    if (journal.distributor.toLowerCase() !== target.distributor.toLowerCase() ||
        journal.token.toLowerCase() !== target.payoutToken.toLowerCase()) continue;
    for (const step of journal.steps) {
      if (step.kind !== 'building' || step.state !== 'confirmed' || !step.hash ||
          step.recipient.toLowerCase() !== target.distributor.toLowerCase() ||
          step.amountRaw !== journal.buildingRaw) continue;
      evidence.push({ transactionHash: step.hash, amountRaw: step.amountRaw, kind: 'rent' });
    }
  }
  return evidence;
}
const meanings = {
  gpu: 'Confirmed test-dollar payment for a completed GPU answer; this host opted into building payouts.',
  solar: 'Simulated solar feed-in income minted from a signed Home Node kWh reading, not an electricity sale.',
  rent: 'Aggregated confirmed fixed 20% shares of fictional test rent, not full property rent or real property rights. Exact rent receipts are private to the tenancy parties.',
  unattributed: 'Confirmed test-dollar transfer without matching GPU settlement, simulated-solar or rent-share journal evidence.',
} as const;

/** Match each log once; never call all transfers GPU revenue, nor all zero-address mints solar. */
export function attributeBuildingIncome(inflows: BuildingInflow[], evidence: IncomeEvidence[]) {
  const available = new Map<string, IncomeEvidence[]>();
  const privateRentHashes = new Set<string>();
  for (const row of evidence) {
    if (row.kind === 'rent') privateRentHashes.add(row.transactionHash.toLowerCase());
    const key = `${row.transactionHash.toLowerCase()}:${row.amountRaw}`;
    const bucket = available.get(key) ?? [];
    if (!bucket.some(item => item.kind === row.kind &&
        (item.kind === 'rent' || (row.kind !== 'rent' && item.hostId === row.hostId)))) bucket.push(row);
    available.set(key, bucket);
  }
  const totals = new Map<string, { id: string; kind: IncomeEvidence['kind'] | 'unattributed'; name: string; meaning: string; amountRaw: string; receipts: number }>();
  const transactions = inflows.flatMap(row => {
    const key = `${row.transactionHash.toLowerCase()}:${row.amountRaw}`;
    const bucket = available.get(key) ?? [];
    const index = bucket.findIndex(item => item.kind !== 'solar' || /^0x0{40}$/i.test(row.from));
    const match = index >= 0 ? bucket.splice(index, 1)[0] : null;
    const kind = match?.kind ?? 'unattributed';
    const sourceId = match ? match.kind === 'rent' ? 'rent' : `${kind}:${match.hostId}` : 'unattributed';
    const sourceName = match ? match.kind === 'rent' ? 'Rent shares' :
      `${match.kind === 'gpu' ? 'GPU' : 'Simulated solar'} · ${match.hostName}` : 'Unattributed transfers';
    const current = totals.get(sourceId) ?? { id: sourceId, kind, name: sourceName, meaning: meanings[kind], amountRaw: '0', receipts: 0 };
    current.amountRaw = (BigInt(current.amountRaw) + BigInt(row.amountRaw)).toString();
    current.receipts++;
    totals.set(sourceId, current);
    // Keep rent-to-home/tenant transaction linkage inside the authenticated tenancy.
    if (privateRentHashes.has(row.transactionHash.toLowerCase())) return [];
    // Sender wallets are chain evidence, not public tenant information.
    const { from: _from, ...publicRow } = row;
    void _from;
    return [{ ...publicRow, sourceId, sourceName, kind }];
  });
  return { transactions, sources: [...totals.values()] };
}
