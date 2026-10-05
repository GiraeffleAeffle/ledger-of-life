#!/usr/bin/env node
// Operator-only devnet initialization. Pass a key file path; never logs key material.
// node scripts/solana/shares-initialize.mjs /absolute/deployer.json [--send]
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { address, AccountRole, getAddressEncoder, getProgramDerivedAddress, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransaction, partiallySignTransaction, getBase64EncodedWireTransaction, getBase58Decoder } from '@solana/kit';
import { createPublicClient, http, parseAbi } from 'viem';
const rpcUrl=process.env.SOLANA_RPC_URL||'https://api.devnet.solana.com';
const sanitize=(message)=>String(message).split(rpcUrl).join('[redacted RPC]').replace(/https?:\/\/[^\s"'<>]+/g,'[redacted URL]');
async function main() {
const PROGRAM=address('97j5CWWKUALG2XRUBoZ1spqtN5YWJPVdTiRLNN5CWYkQ');
const CASH=address('BCgqGAUvbGobqXrJtEDS437i8r1FffVSGcnwCsHcN2oE');
const AUTHORITY=address('3AoHstmog6FiCcBaVAh8jnB8iVc2v9oUvN2Pnn76YtbH');
const { decodePrice, decodePool, decodeFaucetBudget, verifySharesInitialization } = await import('../../src/finance/solana/shares.ts');
const { parseSolanaSharesManifest } = await import('../../src/server/solana-shares-config.ts');
const evidencePath='docs/evidence/SOLANA_SHARES_DEVNET_DEPLOYMENT_2026-10-05.json';
let prior={};try{prior=JSON.parse(await readFile(evidencePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TOKEN=address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM=address('11111111111111111111111111111111');
const RENT=address('SysvarRent111111111111111111111111111111111');
const keyPath=process.argv[2];if (!keyPath || keyPath.startsWith('--')) throw new Error('Pass the deployer keypair file path.');
const send=process.argv.includes('--send');
const rpc=createSolanaRpc(rpcUrl);
if (await rpc.getGenesisHash().send()!==GENESIS) throw new Error('Devnet genesis mismatch');
const signer=await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(keyPath,'utf8'))));
if (signer.address!=='HEZ9ERxb1W9WfBjUGE6A4jFZU3jUMJRSM1kyERgac38G') throw new Error('Unexpected deployer');
const encoder=getAddressEncoder();const bytes=(a)=>encoder.encode(a);
const pda=async(...seeds)=>(await getProgramDerivedAddress({programAddress:PROGRAM,seeds}))[0];
const shareMint=await pda('share_mint');const price=await pda('price',bytes(shareMint));const pool=await pda('pool',bytes(shareMint));const cashVault=await pda('pool_cash',bytes(pool));const collateralVault=await pda('pool_collateral',bytes(pool));
const faucetBudget=await pda('faucet_budget',bytes(shareMint));
const manifest={...prior.manifest,cluster:'devnet',genesisHash:GENESIS,programId:PROGRAM,cashMint:CASH,shareMint,price,priceAuthority:AUTHORITY,initializer:signer.address,pool,cashVault,collateralVault,faucetBudget,dailyFaucetBudgetAtomic:'50000000',debtExposureCapAtomic:'2000000000'};
const disc=(name)=>createHash('sha256').update(`global:${name}`).digest().subarray(0,8);
const u64=(n)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const meta=(address,role=AccountRole.READONLY)=>({address,role});
const signatures={};let priceSource;
async function submit(label,instructions) {
  const {value:lifetime}=await rpc.getLatestBlockhash({commitment:'finalized'}).send();
  let message=setTransactionMessageFeePayer(signer.address,createTransactionMessage({version:0}));message=setTransactionMessageLifetimeUsingBlockhash(lifetime,message);message=appendTransactionMessageInstructions(instructions,message);
  console.log(JSON.stringify({review:label,genesisHash:GENESIS,feePayer:signer.address,manifest,instructions:instructions.map(instruction=>({programAddress:instruction.programAddress,accounts:instruction.accounts,dataBase64:Buffer.from(instruction.data).toString('base64')}))}));
  const tx=await partiallySignTransaction([signer.keyPair],compileTransaction(message));const wire=getBase64EncodedWireTransaction(tx);const sig=getBase58Decoder().decode(tx.signatures[signer.address]);
  const simulation=await rpc.simulateTransaction(wire,{encoding:'base64',commitment:'confirmed',sigVerify:true}).send();
  if(simulation.value.err) throw new Error(`${label}: ${JSON.stringify(simulation.value.err)} ${simulation.value.logs?.join(' | ')}`);
  console.log(JSON.stringify({label,simulated:true,signature:sig,manifest}));if(!send)return;
  await writeFile(evidencePath,JSON.stringify({...prior,status:'initializing',manifest,priceSource:priceSource??prior.priceSource,pendingInitialization:{label,signature:sig}},null,2)+'\n');
  await rpc.sendTransaction(wire,{encoding:'base64',preflightCommitment:'confirmed'}).send();
  for(let n=0;n<90;n++) {const {value}=await rpc.getSignatureStatuses([sig],{searchTransactionHistory:true}).send();if(value[0]?.err)throw new Error(JSON.stringify(value[0].err));if(value[0]?.confirmationStatus==='finalized'){signatures[label]=sig;console.log(JSON.stringify({label,finalized:true,signature:sig}));return;}await new Promise(r=>setTimeout(r,2000));}
  throw new Error(`Finality unknown: ${sig}; recover before retrying.`);
}
const existing=(await rpc.getAccountInfo(shareMint,{encoding:'base64',commitment:'finalized'}).send()).value;
const instructions=[];
if(!existing) {
  const evm=createPublicClient({transport:http('https://rpc.testnet.chain.robinhood.com',{timeout:15000,retryCount:0})});
  const oracle='0x5196C8713A529bd676B875fB9Cea3F8a47ba48Be';
  const [value,time]=await evm.readContract({address:oracle,abi:parseAbi(['function latestPrice() view returns(uint256,uint256)']),functionName:'latestPrice'});
  if(value<=0n||time<=0n||time>BigInt(Math.floor(Date.now()/1000)))throw new Error('Robinhood mirror has no usable seed price; pass no fabricated valuation');
  priceSource={label:'Robinhood testnet mirror (not Chainlink; test tokens have no value)',chainId:46630,oracle,priceUsdE6:String(value),publishedAt:Number(time)};
  manifest.initialPriceUsdE6=String(value);manifest.initialPricePublishedAt=String(time);
  instructions.push({programAddress:PROGRAM,accounts:[meta(signer.address,AccountRole.WRITABLE_SIGNER),meta(shareMint,AccountRole.WRITABLE),meta(price,AccountRole.WRITABLE),meta(faucetBudget,AccountRole.WRITABLE),meta(TOKEN),meta(SYSTEM),meta(RENT)],data:Buffer.concat([disc('initialize_shares'),u64(value),u64(time)])});
}
const existingPool=(await rpc.getAccountInfo(pool,{encoding:'base64',commitment:'finalized'}).send()).value;
if(!existingPool)instructions.push({programAddress:PROGRAM,accounts:[meta(signer.address,AccountRole.WRITABLE_SIGNER),meta(shareMint),meta(CASH),meta(pool,AccountRole.WRITABLE),meta(cashVault,AccountRole.WRITABLE),meta(collateralVault,AccountRole.WRITABLE),meta(TOKEN),meta(SYSTEM),meta(RENT)],data:disc('initialize_pool')});
await parseSolanaSharesManifest(JSON.stringify(manifest));
if(instructions.length)await submit('initializeSharesAndPool',instructions);
if(send) {
 const fetchState=async(key)=>{const {value}=await rpc.getAccountInfo(key,{encoding:'base64',commitment:'finalized'}).send();if(!value||value.owner!==PROGRAM)throw new Error(`Wrong initialized program account ${key}`);return Buffer.from(value.data[0],'base64');};
 const [priceBytes,poolBytes,budgetBytes]=await Promise.all([fetchState(price),fetchState(pool),fetchState(faucetBudget)]);
 verifySharesInitialization(manifest,decodePrice(priceBytes),decodePool(poolBytes),decodeFaucetBudget(budgetBytes));
 prior=JSON.parse(await readFile(evidencePath,'utf8'));
 if(prior.pendingInitialization){const {value}=await rpc.getSignatureStatuses([prior.pendingInitialization.signature],{searchTransactionHistory:true}).send();if(value[0]?.confirmationStatus!=='finalized'||value[0].err)throw new Error('Initialization receipt not finalized');signatures[prior.pendingInitialization.label]=prior.pendingInitialization.signature;}
 const evidence={...prior,status:'deployed-and-initialized',pendingInitialization:null,recordedAt:new Date().toISOString(),manifest,initializationVerified:true,initializationSignatures:{...prior.initializationSignatures,...signatures},priceSource:priceSource??prior.priceSource,disclosures:['Devnet only. Test tokens have no value.','Fictional shares confer no stock, company, property or rental rights.','Rental deposit earnings belong to the tenant.'],interfaces:{...prior.interfaces,client:'src/finance/solana/shares.ts',config:'src/server/solana-shares-config.ts',configEnvironment:'SOLANA_SHARES_MANIFEST',faucet:'5 tTSLA per verified account per 24 hours; owner plus hosted issuer signatures; global 50 tTSLA per UTC day; PDA mint authority',interest:'Continuous 5% nominal yearly; borrower debt shares; 1e27 precision; total-debt 2000 tUSDC cap including accrued interest blocks new borrowing above cap',escrow:'In-kind payouts; silence escalates to arbitration and never awards the landlord automatically'}};
 await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({manifest,evidencePath}));
}
}
main().catch(error=>{console.error(sanitize(error.message));process.exitCode=1;});
