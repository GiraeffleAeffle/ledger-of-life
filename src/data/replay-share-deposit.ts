import share from '../../docs/evidence/HOSTED_SHARE_DEPOSIT_ROBINHOOD_TESTNET_2026-10-01.json' with { type: 'json' };
import loan from '../../docs/evidence/HOSTED_LOAN_STAKES_ROBINHOOD_TESTNET_2026-10-01.json' with { type: 'json' };
import answer from '../../docs/evidence/HOSTED_PER_TOKEN_AI_ANSWER_ROBINHOOD_TESTNET_2026-10-01.json' with { type: 'json' };

type RecordedShareStep = {
  actor: string;
  action: string;
  amount: string | null;
  hash: string;
  explorer: string;
};
export type ReplayRole = 'tenant' | 'landlord' | 'arbitrator';
export type ReplayTransaction = {
  actor: ReplayRole;
  action: string;
  amount: string | null;
  hash: string;
  explorer: string;
  stateAfter: string;
};
export type ReplayStep = {
  id: string;
  title: string;
  roles: ReplayRole[];
  action: string;
  amounts: string;
  stateAfter: string;
  note?: string;
  transactions: ReplayTransaction[];
};

function recordedStep(action: string): RecordedShareStep {
  const step = share.steps.find((item) => item.action.startsWith(action));
  if (!step) throw new Error(`Replay evidence is missing ${action}`);
  return step;
}
function numeric(text: string | null): number {
  const number = text?.match(/\d+(?:\.\d+)?/)?.[0];
  if (!number) throw new Error('Replay evidence has no recorded amount');
  return Number(number);
}
const listing = recordedStep('create listing');
const approval = recordedStep('approve exact');
const pledge = recordedStep('pledge shares');
const claim = recordedStep('proposeClaim');
const dispute = recordedStep('contestClaim');
const decision = recordedStep('resolveClaim');
const landlordPayout = recordedStep('payout(true)');
const tenantPayout = recordedStep('payout(false)');
const quote = claim.amount?.match(/at \$(\d+(?:\.\d+)?)/)?.[1];
if (!quote) throw new Error('Replay evidence has no recorded quote');

export const replayFacts = {
  date: share.date,
  network: share.network,
  chainId: share.chainId,
  escrow: share.escrow,
  escrowExplorer: `${share.explorerBase}/address/${share.escrow}`,
  accounts: share.accounts,
  securityUsd: numeric(listing.amount),
  quoteUsd: Number(quote),
  pledgedTsla: numeric(pledge.amount),
  proposedUsd: numeric(claim.amount),
  awardedTsla: numeric(decision.amount),
  returnedTsla: numeric(tenantPayout.amount),
  finalState: share.finalReads.state,
  finalEscrowTsla: numeric(share.finalReads.escrowTsla),
  scope: share.evidenceScope,
};

const usdFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
export function replayUsd(tsla: number): string {
  return `$${usdFormat.format(tsla * replayFacts.quoteUsd)}`;
}
const held = `${replayFacts.pledgedTsla} test TSLA · ${replayUsd(replayFacts.pledgedTsla)} at the recorded quote`;
const security = `$${replayFacts.securityUsd} nominal USD security; shares not yet locked`;
function transaction(step: RecordedShareStep, stateAfter: string): ReplayTransaction {
  if (step.actor !== 'tenant' && step.actor !== 'landlord' && step.actor !== 'arbitrator') throw new Error('Unknown recorded actor');
  return { actor: step.actor, action: step.action, amount: step.amount, hash: step.hash, explorer: step.explorer, stateAfter };
}

export const replaySteps: ReplayStep[] = [
  {
    id: 'find', title: 'Find', roles: ['landlord'],
    action: 'Created the sample share-deposit listing with the recorded nominal USD security.',
    amounts: security, stateAfter: 'Not separately recorded at this stage.',
    transactions: [transaction(listing, 'Preparation state not separately recorded.')],
  },
  {
    id: 'apply', title: 'Apply', roles: ['tenant'],
    action: 'The tenant joined the hosted tenancy; individual application details were not preserved in this evidence.',
    amounts: security, stateAfter: 'Not separately recorded at this stage.',
    note: 'Account and application actions are off-chain. No application transaction is recorded.', transactions: [],
  },
  {
    id: 'agree', title: 'Agree', roles: ['tenant', 'landlord', 'arbitrator'],
    action: 'Three fresh accounts took the tenancy roles; the evidence does not preserve the individual agreement screens.',
    amounts: security, stateAfter: 'AwaitingLock before funding (inferred from the successful pledge).',
    note: 'No separate agreement transaction is recorded. This replay does not invent acceptance times or tenancy terms.', transactions: [],
  },
  {
    id: 'secure', title: 'Secure', roles: ['tenant'],
    action: 'Approved the exact test-TSLA allowance, then pledged the shares; the escrow auto-activated.',
    amounts: held, stateAfter: 'Active; the pledged shares are in custody (inferred from the recorded call).',
    transactions: [transaction(approval, 'AwaitingLock; approval alone does not transfer shares.'), transaction(pledge, 'Active; shares locked.')],
  },
  {
    id: 'live', title: 'Live', roles: ['tenant', 'landlord'],
    action: 'The secured deposit remained active until the landlord proposed the move-out deduction.',
    amounts: held, stateAfter: 'Active, before the recorded claim (inferred).',
    note: 'No separate transaction, occupancy duration or share earnings were recorded for this stage.', transactions: [],
  },
  {
    id: 'move-out', title: 'Move out', roles: ['landlord', 'tenant', 'arbitrator'],
    action: 'The landlord proposed a deduction, the tenant disputed it, and the arbitrator decided a smaller share award.',
    amounts: `Proposed: ${claim.amount}. Decided: ${replayFacts.awardedTsla} test TSLA · ${replayUsd(replayFacts.awardedTsla)} at the recorded quote.`,
    stateAfter: 'Closed after arbitration; payouts still owed (inferred from resolveClaim).',
    transactions: [transaction(claim, 'ClaimPending.'), transaction(dispute, 'ClaimContested.'), transaction(decision, 'Closed; award reserved for the landlord.')],
  },
  {
    id: 'paid-out', title: 'Paid out', roles: ['landlord', 'tenant'],
    action: 'The landlord received the decided award and the tenant received the remaining shares in their own wallets.',
    amounts: `Landlord: ${replayFacts.awardedTsla} test TSLA · ${replayUsd(replayFacts.awardedTsla)}. Tenant: ${replayFacts.returnedTsla} test TSLA · ${replayUsd(replayFacts.returnedTsla)}.`,
    stateAfter: `${share.finalReads.state}; escrow balance ${share.finalReads.escrowTsla} test TSLA (recorded final read).`,
    transactions: [transaction(landlordPayout, `Closed; ${replayFacts.returnedTsla} test TSLA remains for the tenant (derived).`), transaction(tenantPayout, `${share.finalReads.state}; ${share.finalReads.escrowTsla} test TSLA remains (recorded final read).`)],
  },
];

function loanTransaction(action: string, label: string) {
  const step = loan.steps.find((item) => item.action.startsWith(action));
  if (!step) throw new Error(`Replay evidence is missing ${action}`);
  return { label, amount: step.amount, hash: step.hash, explorer: `${loan.explorerBase}/tx/${step.hash}` };
}
export const alsoRecorded = [
  {
    title: 'Loan cycle',
    summary: loan.finalSummary,
    transactions: [loanTransaction('depositCollateral', 'Pledged collateral'), loanTransaction('borrow', 'Borrowed test dollars'), loanTransaction('repay (', 'Repaid in full'), loanTransaction('withdrawCollateral', 'Withdrew collateral')],
  },
  {
    title: 'Fictional stake buy and sell-back',
    summary: 'A separate local-city tHOME test unit round trip, not a legal property interest or a rental-deposit payout.',
    transactions: [loanTransaction('buy tHOME', 'Bought tHOME'), loanTransaction('sell back tHOME', 'Sold back tHOME')],
  },
  {
    title: 'First per-token paid answer',
    summary: `${answer.host.name} answered a public question: ${answer.answer.outputTokens} output tokens, ${answer.settlement.transferred} settled. One answer, not sustained capacity or fiat profit.`,
    transactions: [{ label: answer.approval.action, amount: answer.approval.amount, hash: answer.approval.hash, explorer: answer.approval.explorer }, { label: 'Per-token settlement', amount: answer.settlement.transferred, hash: answer.settlement.hash, explorer: answer.settlement.explorer }],
  },
];

export const replaySources = [
  ['Share tenancy evidence', 'HOSTED_SHARE_DEPOSIT_ROBINHOOD_TESTNET_2026-10-01.json'],
  ['Loan and stake evidence', 'HOSTED_LOAN_STAKES_ROBINHOOD_TESTNET_2026-10-01.json'],
  ['Paid answer evidence', 'HOSTED_PER_TOKEN_AI_ANSWER_ROBINHOOD_TESTNET_2026-10-01.json'],
].map(([label, file]) => ({ label, url: `https://github.com/GiraeffleAeffle/ledger-of-life/blob/develop/docs/evidence/${file}` }));
