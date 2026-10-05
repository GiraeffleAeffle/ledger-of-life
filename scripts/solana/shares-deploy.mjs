#!/usr/bin/env node
// Devnet-only operator runner, invoked by deploy-shares.sh with external key paths.
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { address, createSolanaRpc, getAddressDecoder } from '@solana/kit';
const rpcUrl=process.env.SOLANA_RPC_URL||'https://api.devnet.solana.com';
const sanitize=(message)=>String(message).split(rpcUrl).join('[redacted RPC]').replace(/https?:\/\/[^\s"'<>]+/g,'[redacted URL]');
const exec=promisify(execFile);
async function run(command,args,options) {
 try{return await exec(command,args,options);}
 catch(error){throw new Error(sanitize(`Operator subprocess failed (${error.code??'unknown'}): ${error.stderr||'no diagnostic output'}`));}
}
async function main() {
const [deployer,programKey,bufferKey]=process.argv.slice(2);
if(!deployer||!programKey||!bufferKey)throw new Error('Pass deployer, program and buffer keypair file paths');
const solana=resolve(homedir(),'.local/share/solana/install/active_release/bin/solana');
const keygen=resolve(homedir(),'.local/share/solana/install/active_release/bin/solana-keygen');
const PROGRAM=address('97j5CWWKUALG2XRUBoZ1spqtN5YWJPVdTiRLNN5CWYkQ');
const HOUSE=address('CWUN8LKoKNEBJ6SQAVAqDFrb3rDP7vbVXMcf2EoAqjQM');
const DEPLOYER=address('HEZ9ERxb1W9WfBjUGE6A4jFZU3jUMJRSM1kyERgac38G');
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const rpc=createSolanaRpc(rpcUrl);
if(await rpc.getGenesisHash().send()!==GENESIS)throw new Error('Devnet genesis mismatch; mainnet is refused');
if((await run(keygen,['pubkey',deployer])).stdout.trim()!==DEPLOYER)throw new Error('Unexpected deployer address');
const evidencePath='docs/evidence/SOLANA_SHARES_DEVNET_DEPLOYMENT_2026-10-05.json';
const prior=JSON.parse(await readFile(evidencePath,'utf8'));
const binary='target/deploy/shares.so';let binaryBytes;
try{binaryBytes=await readFile(binary);}catch(error){if(error.code!=='ENOENT')throw error;}
const size=binaryBytes?(await stat(binary)).size:prior.programCodeLength;
const programSha256=binaryBytes?createHash('sha256').update(binaryBytes).digest('hex'):prior.programSha256;
if(!Number.isSafeInteger(size)||size<=0||!/^[0-9a-f]{64}$/.test(programSha256)||programSha256!==prior.programSha256||size!==prior.programCodeLength)throw new Error('Local binary does not match the reviewed deployment evidence; review and record it before deploying');
let deployment=prior.deployment;
let {value:programAccount}=await rpc.getAccountInfo(PROGRAM,{encoding:'base64',commitment:'finalized'}).send();
if(!programAccount) {
 if(!binaryBytes)throw new Error('Build the reviewed shares SBF binary before first deployment');
 const loader='BPFLoaderUpgradeab1e11111111111111111111111';
 const bufferAddress=address((await run(keygen,['pubkey',bufferKey])).stdout.trim());
 const {value:bufferAccount}=await rpc.getAccountInfo(bufferAddress,{encoding:'base64',commitment:'finalized'}).send();
 if(bufferAccount) {
  const bytes=Buffer.from(bufferAccount.data[0],'base64');
  if(bufferAccount.owner!==loader||bufferAccount.executable||bytes.length!==size+37||bytes.readUInt32LE(0)!==1||bytes[4]!==1||getAddressDecoder().decode(bytes.subarray(5,37))!==DEPLOYER)throw new Error('Existing buffer length, owner or authority mismatch; no transaction signed');
 }
 const bufferRent=await rpc.getMinimumBalanceForRentExemption(BigInt(size+37)).send();
 const programDataRent=await rpc.getMinimumBalanceForRentExemption(BigInt(size+45)).send();
 const programRent=await rpc.getMinimumBalanceForRentExemption(36n).send();
 const bufferTopUp=bufferRent>(bufferAccount?.lamports??0n)?bufferRent-(bufferAccount?.lamports??0n):0n;
 const minimum=bufferTopUp+programDataRent+programRent+100_000_000n;
 const {value:balance}=await rpc.getBalance(DEPLOYER,{commitment:'finalized'}).send();
 if(balance<minimum)throw new Error(`Insufficient devnet SOL: ${balance} lamports available; need ${minimum}; shortfall ${minimum-balance} lamports. Existing buffer funding credited. No transaction signed.`);
 const {value:house}=await rpc.getAccountInfo(HOUSE,{encoding:'base64',commitment:'finalized'}).send();
 if(!house?.executable)throw new Error('Deploy House first; the two programs share one deployer balance');
 if((await run(keygen,['pubkey',programKey])).stdout.trim()!==PROGRAM)throw new Error('Unexpected shares program keypair address');
 console.log(JSON.stringify({review:'deploy-shares',genesisHash:GENESIS,programId:PROGRAM,bufferAddress,deployer:DEPLOYER,upgradeAuthority:DEPLOYER,programCodeLength:size,programSha256,bufferLamports:String(bufferAccount?.lamports??0n),bufferTopUpLamports:String(bufferTopUp),minimumBalanceLamports:String(minimum),availableLamports:String(balance),transport:'configured devnet RPC; URL withheld'}));
 const output=await run(solana,['program','deploy',binary,'--program-id',programKey,'--buffer',bufferKey,'--keypair',deployer,'--upgrade-authority',deployer,'--url',rpcUrl,'--commitment','finalized','--use-rpc','--max-len',String(size),'--output','json'],{maxBuffer:1024*1024,timeout:600000});
 deployment=JSON.parse(output.stdout);
 console.log(JSON.stringify({status:'deployed',deployment}));
 ({value:programAccount}=await rpc.getAccountInfo(PROGRAM,{encoding:'base64',commitment:'finalized'}).send());
}
const loader='BPFLoaderUpgradeab1e11111111111111111111111';
if(!programAccount?.executable||programAccount.owner!==loader)throw new Error('Program is not finalized under the upgradeable loader');
const programBytes=Buffer.from(programAccount.data[0],'base64');
if(programBytes.readUInt32LE(0)!==2)throw new Error('Invalid Program header');
const programDataAddress=getAddressDecoder().decode(programBytes.subarray(4,36));
const {value:programData}=await rpc.getAccountInfo(programDataAddress,{encoding:'base64',commitment:'finalized'}).send();
if(!programData||programData.owner!==loader)throw new Error('ProgramData unavailable');
const programDataBytes=Buffer.from(programData.data[0],'base64');
if(programDataBytes.readUInt32LE(0)!==3||programDataBytes.length!==size+45||programDataBytes[12]!==1||getAddressDecoder().decode(programDataBytes.subarray(13,45))!==DEPLOYER)throw new Error('ProgramData header, length or upgrade authority mismatch');
const onChainProgramDataSha256=createHash('sha256').update(programDataBytes).digest('hex');
const onChainProgramCodeSha256=createHash('sha256').update(programDataBytes.subarray(45)).digest('hex');
if(onChainProgramCodeSha256!==programSha256)throw new Error('On-chain program bytes do not match the reviewed binary');
const {sharesAddresses,decodePrice}=await import('../../src/finance/solana/shares.ts');
const accounts=await sharesAddresses();
const existing=(await rpc.getMultipleAccounts([accounts.shareMint,accounts.price,accounts.faucetBudget,accounts.pool,accounts.cashVault,accounts.collateralVault],{encoding:'base64',commitment:'finalized'}).send()).value;
if(existing.some(account=>!account)) {
 const {value:balance}=await rpc.getBalance(DEPLOYER,{commitment:'finalized'}).send();
 if(balance<20_000_000n)throw new Error(`Insufficient devnet initialization balance: ${balance} lamports; need 20000000. Program is deployed; rerun to initialize. No initialization transaction signed.`);
}
if(existing[0]&&existing[1]&&existing[2]&&!prior.manifest) {
 const priceAccount=existing[1];
 if(priceAccount.owner!==PROGRAM||priceAccount.executable)throw new Error('Existing price account ownership mismatch');
 const price=decodePrice(Buffer.from(priceAccount.data[0],'base64'));
 // Recovery uses the immutable initializer snapshot, not a fabricated current market quote.
 prior.manifest={...prior.intendedManifest,...accounts,programId:PROGRAM,initializer:DEPLOYER,initialPriceUsdE6:price.initialPriceUsdE6.toString(),initialPricePublishedAt:price.initialPublishedAt.toString()};
 prior.priceSource??={label:'Recovered immutable on-chain initialization price; original source provenance not independently recovered',priceUsdE6:price.initialPriceUsdE6.toString(),publishedAt:Number(price.initialPublishedAt)};
}
await writeFile(evidencePath,JSON.stringify({...prior,status:existing.every(Boolean)?prior.status:'deployed-awaiting-initialization',deployedAt:prior.deployedAt??new Date().toISOString(),deployment,deploymentSignatures:deployment?.signature?[deployment.signature]:prior.deploymentSignatures??[],programSha256,onChainProgramDataSha256,onChainProgramCodeSha256,programDataAddress,programCodeLength:size,upgradeAuthority:DEPLOYER},null,2)+'\n');
const initialized=await run(process.execPath,['--experimental-strip-types','scripts/solana/shares-initialize.mjs',deployer,'--send'],{maxBuffer:1024*1024,timeout:240000});console.log(initialized.stdout);
const evidence=JSON.parse(await readFile(evidencePath,'utf8'));
if(evidence.status!=='deployed-and-initialized'||!evidence.initializationVerified||!evidence.manifest)throw new Error('Initialization verification did not finish');
const cacheDir=resolve(homedir(),'.cache/ledger-solana');await mkdir(cacheDir,{recursive:true,mode:0o700});
const manifestPath=resolve(cacheDir,'shares-manifest.json');await writeFile(manifestPath,JSON.stringify(evidence.manifest,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({status:'deployed-and-initialized',programId:PROGRAM,programDataAddress,onChainProgramDataSha256,onChainProgramCodeSha256,manifestPath,manifest:evidence.manifest,signatures:{deployment:evidence.deploymentSignatures,initialization:evidence.initializationSignatures}}));
}
main().catch(error=>{console.error(sanitize(error.message));process.exitCode=1;});
