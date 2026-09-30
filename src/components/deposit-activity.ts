export const operationLabels: Record<string, string> = {
  fund_and_supply: 'Deposit secured and supplied',
  release_earnings: 'Deposit earnings claimed (simulated)',
  propose_claim: 'Move-out deduction proposed',
  respond_to_claim: 'Deduction disputed',
  accept_and_settle: 'Deduction agreed and settled',
  resolve_and_settle: 'Arbitration decision and settlement',
  redeem_and_settle: 'Settlement completed',
  payout: 'Payout sent',
};

/** The operations this person performed that actually happened or failed; a prepared or expired step is not an event. */
export function visibleDepositActivity<Operation extends { role: string; state: string; action: { kind: string } }>(
  role: 'tenant' | 'landlord' | 'arbitrator', operations: Operation[],
): Operation[] {
  return operations.filter((operation) => operation.role === role &&
    ['finalized', 'failed', 'broadcast', 'signed'].includes(operation.state));
}
