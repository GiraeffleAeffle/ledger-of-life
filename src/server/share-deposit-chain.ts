import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getAddress, keccak256, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { SHARE_ORACLE, SHARE_STOCK } from '../domain/deposit-form.ts';
import { agreementDigest, type Agreement } from './agreements.ts';
import { ConflictError } from './errors.ts';
import { sharedMarketRpc, readCollateralSafety, type SharedMarketManifest } from './shared-market.ts';
export type DepositRpc = typeof sharedMarketRpc;
export const FACTORY_ABI = parseAbi([
  'function create((address tenant,address landlord,address arbitrator,uint256 depositValue,bytes32 agreementHash,uint256 responseWindow,uint256 returnWindow,uint256 arbitrationWindow) terms) returns (address)',
  'function escrowFor(address,bytes32) view returns (address)',
  'function predict((address tenant,address landlord,address arbitrator,uint256 depositValue,bytes32 agreementHash,uint256 responseWindow,uint256 returnWindow,uint256 arbitrationWindow) terms) view returns (address)',
  'function implementation() view returns (address)',
  'event Created(bytes32 indexed agreementHash,address indexed escrow,bytes32 indexed salt)',
]);
export const DEPOSIT_ABI: Abi = parseAbi([
  ...['tenant','landlord','arbitrator','factory','stock','oracle'].map(name => `function ${name}() view returns (address)`),
  ...['depositValue','fixedChainId','responseWindow','returnWindow','arbitrationWindow','responseDeadline','returnDeadline','arbitrationStartedAt','landlordOwed','trackedBalance','INITIAL_RATIO_BPS','TOP_UP_RATIO_BPS'].map(name => `function ${name}() view returns (uint256)`),
  'function agreementHash() view returns (bytes32)', 'function state() view returns (uint8)', 'function arbitrationAuthorized() view returns (bool)', 'function custodyShortfall() view returns (bool)',
  'function quote() view returns (uint256,uint256,bool)', 'function claim() view returns ((uint256 usd6,uint256 shares,bytes32 evidenceHash,uint256 price6,uint256 sourceTime))',
  'function pledge(uint256)', 'function withdraw(uint256)', 'function activate()', 'function proposeClaim(uint256,bytes32)', 'function acceptClaim(uint256)', 'function contestClaim()', 'function lowerClaim(uint256)', 'function escalateClaim()', 'function resolveClaim(uint256)', 'function requestReturn()', 'function closeUnclaimed()', 'function closeUnresolved()', 'function payout(bool)',
  'event Pledged(uint256 shares,uint256 price6,uint256 sourceTime)', 'event Activated(uint256 balance,uint256 price6,uint256 sourceTime)', 'event Withdrawn(uint256 shares,uint256 price6,uint256 sourceTime)',
  'event ClaimProposed(uint256 usd6,uint256 shares,bytes32 evidenceHash,uint256 price6,uint256 sourceTime)', 'event ClaimContested()', 'event ClaimEscalated()', 'event ClaimLowered(uint256 usd6,uint256 shares,uint256 price6,uint256 sourceTime,uint256 responseDeadline)', 'event ReturnRequested(uint256 deadline)', 'event Closed(address indexed decisionMaker,uint256 landlordShares)', 'event Paid(address indexed recipient,uint256 shares)',
]);
export const STOCK_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'event Approval(address indexed owner,address indexed spender,uint256 value)']);
export const MIRROR_ABI = parseAbi(['function latest() view returns (uint80,int256,uint256,uint256,uint256)', 'function latestPrice() view returns (uint256,uint256)']);
export type ShareDepositManifest = { chainId: 46630; status: 'not_deployed' | 'deployed'; factory: Address | null; implementation: Address | null; factoryCodeHash: Hex | null; implementationCodeHash: Hex | null; stock: Address; oracle: Address; dependencyCodeHashes: { stock: Hex; oracle: Hex }; collateralIssuer: SharedMarketManifest['collateralIssuer'] };
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function requireDeposit(condition: unknown, message: string): asserts condition { if (!condition) throw new ConflictError(message); }
export async function loadShareDepositManifest(): Promise<ShareDepositManifest | null> {
  let bytes: string;
  try { bytes = await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ process.env.SHARE_DEPOSIT_MANIFEST_FILE || 'contracts/evm/deployments/share-deposit-46630.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const config = JSON.parse(bytes) as ShareDepositManifest;
  requireDeposit(config.chainId === 46630 && same(config.stock, SHARE_STOCK) && same(config.oracle, SHARE_ORACLE), 'Invalid share-deposit assets or network.');
  if (config.status !== 'deployed' || !config.factory || !config.implementation) return null;
  for (const key of ['factory','implementation'] as const) getAddress(config[key]!);
  requireDeposit(/^0x[0-9a-fA-F]{64}$/.test(config.factoryCodeHash ?? '') && /^0x[0-9a-fA-F]{64}$/.test(config.implementationCodeHash ?? ''), 'Missing reviewed deposit code pins.');
  return config;
}
export function depositTerms(agreement: Agreement) {
  const form = agreement.depositForm;
  const hash = agreementDigest(agreement);
  requireDeposit(form?.kind === 'shares' && hash && agreement.parties.tenant && agreement.parties.landlord && agreement.parties.arbitrator, 'All share-deposit parties must join first.');
  requireDeposit(agreement.network === 'robinhood' && form.securityUsd6 === agreement.requiredSecurity, 'Share deposit agreement amount/network mismatch.');
  requireDeposit(Object.values(agreement.parties).every(p => p.wallet.chainType === 'ethereum'), 'Every share-deposit party needs its verified EVM wallet.');
  return { tenant: getAddress(agreement.parties.tenant.wallet.address), landlord: getAddress(agreement.parties.landlord.wallet.address), arbitrator: getAddress(agreement.parties.arbitrator.wallet.address), depositValue: BigInt(form.securityUsd6), agreementHash: hash as Hex, responseWindow: BigInt(form.responseWindow), returnWindow: BigInt(form.returnWindow), arbitrationWindow: BigInt(form.arbitrationWindow) };
}
export async function verifyDepositPins(config: ShareDepositManifest, rpc: DepositRpc) {
  requireDeposit(await rpc.getChainId() === 46630, 'Wrong deposit network.');
  for (const [address, hash] of [[config.factory, config.factoryCodeHash],[config.implementation, config.implementationCodeHash],[config.stock,config.dependencyCodeHashes.stock],[config.oracle,config.dependencyCodeHashes.oracle]] as const) {
    requireDeposit(address && hash, 'Share deposit not deployed yet.');
    const code = await rpc.getCode({ address });
    requireDeposit(code && code !== '0x' && same(keccak256(code), hash), 'Share-deposit reviewed code pin changed.');
  }
  const implementation = await rpc.readContract({ address: config.factory!, abi: FACTORY_ABI, functionName: 'implementation' });
  requireDeposit(same(implementation, config.implementation!), 'Share-deposit factory implementation changed.');
}
export async function boundEscrow(agreement: Agreement, config: ShareDepositManifest, rpc: DepositRpc) {
  const terms = depositTerms(agreement); const form = agreement.depositForm!;
  requireDeposit(form.kind === 'shares' && form.factory && same(form.factory, config.factory!) && same(form.stock, config.stock) && same(form.oracle,config.oracle) && form.chainId === 46630 && form.initialRatioBps === 15000 && form.topUpRatioBps === 12500, 'Accepted deposit deployment differs from reviewed manifest.');
  const [escrow, predicted] = await Promise.all([
    rpc.readContract({ address: config.factory!, abi: FACTORY_ABI, functionName: 'escrowFor', args: [terms.landlord, terms.agreementHash] }),
    rpc.readContract({ address: config.factory!, abi: FACTORY_ABI, functionName: 'predict', args: [terms] }),
  ]);
  if (same(escrow, '0x0000000000000000000000000000000000000000')) return { escrow: null, predicted, terms };
  requireDeposit(same(escrow,predicted), 'Escrow address differs from the accepted CREATE2 terms.');
  const code = await rpc.getCode({ address: escrow });
  requireDeposit(code && same(code, `0x363d3d373d3d3d363d73${config.implementation!.slice(2)}5af43d82803e903d91602b57fd5bf3`), 'Escrow clone implementation mismatch.');
  const expected: Record<string, string | bigint> = { ...terms, factory: config.factory!, stock: config.stock, oracle: config.oracle, fixedChainId: 46630n, INITIAL_RATIO_BPS: 15000n, TOP_UP_RATIO_BPS: 12500n };
  for (const [name,value] of Object.entries(expected)) {
    const actual = await rpc.readContract({ address: escrow, abi: DEPOSIT_ABI, functionName: name });
    requireDeposit(same(String(actual),String(value)), `Escrow ${name} differs from the accepted agreement.`);
  }
  return { escrow, predicted, terms };
}
export async function depositSafety(config: ShareDepositManifest, custody: Address, participants: Address[], shortfall: boolean, rpc: DepositRpc) {
  return readCollateralSafety({ stock: config.stock, collateralIssuer: config.collateralIssuer } as SharedMarketManifest, rpc, { custody, participants, shortfall });
}
