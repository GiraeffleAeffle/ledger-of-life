#!/usr/bin/env node
// TESTNET-ONLY fixture: ephemeral tenant wallet and local operator test keys; no Privy session or real money.
// node --no-warnings --experimental-strip-types --env-file-if-exists=.env.local contracts/evm/script/share-workflows-cycle.mjs
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, defineChain, http, parseAbi, parseAbiItem } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LocalStore } from '../../../src/server/store.ts';
import { earnOnRobinhood, prepareRobinhoodBuy, ROBINHOOD_TESTNET, submitRobinhoodTransaction } from '../../../src/server/robinhood-demo.ts';
import { controlShareMarket, prepareShareAction, readShareWorkflows, startShareMarket, submitShareTransaction } from '../../../src/server/share-workflows.ts';
import { operatorTestCapability } from '../../../src/server/test-capability.ts';

const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const rpc = createPublicClient({ chain, transport: http() });
if ((await rpc.getChainId()) !== 46630 || !operatorTestCapability()) throw new Error('Testnet + operator test capability required.');
const tenant = privateKeyToAccount(generatePrivateKey());
const store = new LocalStore(':memory:');
const evidence = {
  network: 'Robinhood Chain testnet', chainId: 46630, mode: 'ephemeral signed test wallet and operator-held test actors; not a Privy/signed-in wallet proof',
  token: 'official test TSLA and freely minted test USD (no real value)',
  inputs: 'simulated vault yield, isolated operator-set test price and stock desk',
  tenant: tenant.address, deployed: {}, transactionHashes: {}, final: {},
};
async function step(name, action) {
  const result = await action();
  const hashes = typeof result === 'string' ? [result] : result?.hash ? [result.hash, result.deskHash, result.mint, result.approve].filter(Boolean) : [];
  evidence.transactionHashes[name] = hashes;
  console.log(JSON.stringify({ step: name, hashes }));
  return result;
}
async function signWork(name, action, quantity) {
  const prepared = await prepareShareAction(store, tenant.address, action, quantity);
  const hashes = [];
  for (const { transaction } of prepared) {
    const serialized = await tenant.signTransaction({
      chainId: 46630, to: transaction.to, data: transaction.data, value: 0n, nonce: transaction.nonce,
      gas: BigInt(transaction.gas), maxFeePerGas: BigInt(transaction.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas), type: 'eip1559',
    });
    hashes.push((await submitShareTransaction(store, tenant.address, serialized)).hash);
  }
  evidence.transactionHashes[name] = hashes;
  console.log(JSON.stringify({ step: name, hashes }));
}
try {
  const earnings = await step('simulatedEarnings', async () => earnOnRobinhood(store, tenant.address));
  evidence.deployed.earningsEscrow = earnings.escrow;
  evidence.final.claimedEarningsAtomic = earnings.releasedAtomic;
  const released = await rpc.getLogs({
    address: earnings.escrow, event: parseAbiItem('event EarningsReleased(address indexed tenantWallet,uint256 assets,uint256 indexed operationNonce)'),
    args: { tenantWallet: tenant.address }, fromBlock: (await rpc.getBlockNumber()) - 1000n,
  });
  if (released.length !== 1) throw new Error('Expected one test earnings-release event.');
  evidence.transactionHashes.simulatedEarnings = [released[0].transactionHash];
  const purchase = await prepareRobinhoodBuy(tenant.address);
  const buyHashes = [];
  for (const { transaction } of purchase) {
    const serialized = await tenant.signTransaction({
      chainId: 46630, to: transaction.to, data: transaction.data, value: 0n, nonce: transaction.nonce,
      gas: BigInt(transaction.gas), maxFeePerGas: BigInt(transaction.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas), type: 'eip1559',
    });
    buyHashes.push((await submitRobinhoodTransaction(serialized)).hash);
  }
  evidence.transactionHashes.earningsToTestTslaBuy = buyHashes;
  console.log(JSON.stringify({ step: 'earningsToTestTslaBuy', hashes: buyHashes }));
  const init = await startShareMarket(store, tenant.address);
  evidence.deployed.oracle = init.oracle;
  evidence.deployed.desk = init.desk;
  evidence.deployed.pool = init.pool;
  evidence.transactionHashes.marketDeploymentAndFunding = init.transactions;
  const before = await readShareWorkflows(store, tenant.address);
  await step('testLandlordAcceptance', () => controlShareMarket(store, tenant.address, 'landlord_accepts'));
  evidence.deployed.collateralEscrow = (await readShareWorkflows(store, tenant.address)).deployment.escrow;
  const terms = await rpc.readContract({ address: evidence.deployed.collateralEscrow, abi: parseAbi(['function depositValue() view returns (uint256)', 'function initialRatioBps() view returns (uint16)', 'function maintenanceRatioBps() view returns (uint16)']), functionName: 'depositValue' });
  const ratio = await rpc.readContract({ address: evidence.deployed.collateralEscrow, abi: parseAbi(['function initialRatioBps() view returns (uint16)']), functionName: 'initialRatioBps' });
  if (terms.toString() !== before.suggestedDepositAtomic || ratio !== 15000) throw new Error('The accepted deposit did not match the 150% quote');
  evidence.final.acceptedDepositAtomic = terms.toString();
  evidence.final.openingRatioBps = ratio;
  const landlord = await rpc.readContract({ address: evidence.deployed.collateralEscrow, abi: parseAbi(['function landlord() view returns (address)']), functionName: 'landlord' });
  const landlordBefore = await rpc.readContract({ address: ROBINHOOD_TESTNET.usd, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [landlord] });
  await signWork('signedDepositPledge', 'pledge', before.suggestedPledgeRaw);
  const pledged = await readShareWorkflows(store, tenant.address);
  if (pledged.deposit.state !== 1) throw new Error('Test deposit not active');
  await step('testPriceDown30', () => controlShareMarket(store, tenant.address, 'price_down_30'));
  await step('shortfallFlagged', () => controlShareMarket(store, tenant.address, 'flag_shortfall'));
  const cureShares = (BigInt(before.sharesRaw) / 6n).toString();
  await signWork('signedDepositTopUp', 'top_up', cureShares);
  const cured = await readShareWorkflows(store, tenant.address);
  if (cured.deposit.deadline !== 0) throw new Error('Top-up failed to clear shortfall');
  await step('testMoveOutClaim', () => controlShareMarket(store, tenant.address, 'move_out_claim'));
  await signWork('signedMoveOutAcceptance', 'accept_claim');
  await step('claimSaleAndShareReturn', () => controlShareMarket(store, tenant.address, 'settle'));
  const settled = await readShareWorkflows(store, tenant.address);
  if (settled.deposit.state !== 5) throw new Error('Move-out did not settle');
  evidence.final.deposit = settled.deposit;
  await step('restoreTestPrice', () => controlShareMarket(store, tenant.address, 'price_reset'));
  const loanShares = (await readShareWorkflows(store, tenant.address)).sharesRaw;
  await signWork('signedLoanCollateral', 'deposit_collateral', loanShares);
  const loanBefore = await readShareWorkflows(store, tenant.address);
  await signWork('signedBorrow', 'borrow', (BigInt(loanBefore.loan.availableAtomic) * 4n / 5n).toString());
  const borrowed = await readShareWorkflows(store, tenant.address);
  if (BigInt(borrowed.loan.debtAtomic) === 0n || borrowed.loan.ltvBps > 5000) throw new Error('Borrow did not respect max LTV');
  await step('testPriceDown60', () => controlShareMarket(store, tenant.address, 'price_down_60'));
  if ((await readShareWorkflows(store, tenant.address)).loan.ltvBps < 8000) throw new Error('Price drop did not make test loan unhealthy');
  await step('testLiquidation', () => controlShareMarket(store, tenant.address, 'liquidate_loan'));
  await step('restoreTestPriceAfterLiquidation', () => controlShareMarket(store, tenant.address, 'price_reset'));
  await step('testRepaymentFaucet', () => controlShareMarket(store, tenant.address, 'faucet'));
  const outstanding = await readShareWorkflows(store, tenant.address);
  await signWork('signedRepayment', 'repay', (BigInt(outstanding.loan.debtAtomic) + 1000n).toString());
  const repaid = await readShareWorkflows(store, tenant.address);
  if (BigInt(repaid.loan.debtAtomic) !== 0n) throw new Error('Loan was not fully repaid');
  await signWork('signedShareWithdrawal', 'withdraw_collateral', repaid.loan.sharesRaw);
  const final = await readShareWorkflows(store, tenant.address);
  if (BigInt(final.loan.sharesRaw) !== 0n) throw new Error('Loan collateral was not returned');
  evidence.final.loan = final.loan;
  evidence.final.walletSharesRaw = final.sharesRaw;
  const landlordAfter = await rpc.readContract({ address: ROBINHOOD_TESTNET.usd, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [landlord] });
  evidence.final.landlordClaimReceivedAtomic = (landlordAfter - landlordBefore).toString();
  await writeFile(resolve('docs/evidence/SHARE_WORKFLOWS_ROBINHOOD_TESTNET.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, addresses: evidence.deployed, evidence: 'docs/evidence/SHARE_WORKFLOWS_ROBINHOOD_TESTNET.json' }));
} finally {
  await store.close();
}
