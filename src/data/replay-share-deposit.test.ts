import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { alsoRecorded, replayFacts, replaySteps, replayUsd } from './replay-share-deposit.ts';

const share = JSON.parse(await readFile(new URL('../../docs/evidence/HOSTED_SHARE_DEPOSIT_ROBINHOOD_TESTNET_2026-10-01.json', import.meta.url), 'utf8'));
const loan = JSON.parse(await readFile(new URL('../../docs/evidence/HOSTED_LOAN_STAKES_ROBINHOOD_TESTNET_2026-10-01.json', import.meta.url), 'utf8'));
const answer = JSON.parse(await readFile(new URL('../../docs/evidence/HOSTED_PER_TOKEN_AI_ANSWER_ROBINHOOD_TESTNET_2026-10-01.json', import.meta.url), 'utf8'));

test('the replay accounts for every share receipt exactly once, under the recorded role', () => {
  const transactions = replaySteps.flatMap((step) => step.transactions);
  assert.deepEqual(transactions.map((tx) => tx.hash), share.steps.map((step: { hash: string }) => step.hash));
  for (const tx of transactions) {
    const evidence = share.steps.find((step: { hash: string }) => step.hash === tx.hash);
    assert.equal(tx.actor, evidence.actor);
    assert.equal(share.accounts[tx.actor], evidence.address);
    assert.equal(tx.amount, evidence.amount);
    assert.equal(tx.explorer, `${share.explorerBase}/tx/${tx.hash}`);
    assert.equal(evidence.status, 'success');
  }
  assert.deepEqual(replaySteps.filter((step) => !step.transactions.length).map((step) => step.id), ['apply', 'agree', 'live']);
});

test('the award and tenant return conserve the recorded pledged shares, without a cash sale', () => {
  const pledged = Number(share.steps.find((step: { action: string }) => step.action.startsWith('pledge')).amount.split(' ')[0]);
  const award = Number(share.steps.find((step: { action: string }) => step.action === 'resolveClaim').amount.split(' ')[0]);
  const returned = Number(share.steps.find((step: { action: string }) => step.action === 'payout(false)').amount.split(' ')[1]);
  assert.equal(replayFacts.pledgedTsla, pledged);
  assert.equal(replayFacts.awardedTsla, award);
  assert.equal(replayFacts.returnedTsla, returned);
  assert.equal(replayFacts.awardedTsla + replayFacts.returnedTsla, replayFacts.pledgedTsla);
  assert.equal(replayFacts.finalEscrowTsla, Number(share.finalReads.escrowTsla));
  assert.equal(replayFacts.finalState, share.finalReads.state);
  assert.ok(replayFacts.awardedTsla * replayFacts.quoteUsd < replayFacts.proposedUsd);
});

test('USD equivalents use the recorded claim quote and keep sub-cent values visible', () => {
  const recordedClaim = share.steps.find((step: { action: string }) => step.action === 'proposeClaim').amount;
  assert.equal(replayFacts.quoteUsd, Number(recordedClaim.split(' at $')[1]));
  assert.equal(replayFacts.securityUsd, Number(share.steps[0].amount.match(/\d+/)[0]));
  assert.equal(replayUsd(replayFacts.pledgedTsla), '$178.132');
  assert.equal(replayUsd(replayFacts.awardedTsla), '$4.987696');
  assert.equal(replayUsd(replayFacts.returnedTsla), '$173.144304');
});

test('adjacent-run links identify the recorded loan, stake and paid-answer transactions', () => {
  const related = alsoRecorded.flatMap((run) => run.transactions);
  const allowed = [...loan.steps, { ...answer.approval, amount: answer.approval.amount }, { ...answer.settlement, amount: answer.settlement.transferred }];
  for (const tx of related) {
    const evidence = allowed.find((step) => step.hash === tx.hash);
    assert.ok(evidence, `Unknown adjacent transaction: ${tx.hash}`);
    assert.equal(tx.amount, evidence.amount);
    assert.equal(tx.explorer, `${share.explorerBase}/tx/${tx.hash}`);
  }
  for (const action of ['depositCollateral', 'borrow', 'repay (took 20.000005)', 'withdrawCollateral', 'buy tHOME', 'sell back tHOME']) {
    const step = loan.steps.find((item: { action: string }) => item.action === action);
    assert.ok(related.some((tx) => tx.hash === step.hash), `Missing ${action}`);
  }
  assert.ok(related.some((tx) => tx.hash === answer.settlement.hash));
  assert.equal(answer.answer.outputTokens * answer.settlement.pricePerOutputTokenAtomic, answer.settlement.transferredAtomic);
});
