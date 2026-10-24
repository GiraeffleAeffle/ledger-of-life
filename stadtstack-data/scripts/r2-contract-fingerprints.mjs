import {execFileSync} from 'node:child_process';
import {lstat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const CONTRACTS={
 preparationExtractor:['district-prepared-document.ts','preparationExtractorSha256'],
 residualPreparation:['district-residual-jobs.ts','residualPreparationContract'],
 residualJob:['district-residual-jobs.ts','residualJobContract'],
 jointExtraction:['district-inference.ts','jointExtractionContract'],
 assessmentQueue:['district-assessment-jobs.ts','assessmentQueueContract'],
 assessmentB:['district-assessment-broker.ts','assessmentBJobContract'],
 acquisition:['district-r1.ts','acquisitionContract'],
 policyRefresh:['district-policy-refresh.ts','policyRefreshContract'],
 structuredStateGauges:['district-structured-jobs.ts','structuredJobContract'],
 operatorRegistry:['district-registry-config.ts','operatorRegistryConfigContractSha256'],
 parserOutput:['district-parser-isolation.ts','parserOutputContractSha256'],
 parserIsolation:['district-parser-isolation.ts','parserIsolationContractSha256'],
 ompOutput:['district-omp-b-runner.ts','ompRunnerOutputContractSha256'],
 ompRunner:['district-omp-b-runner.ts','ompRunnerContractSha256'],
};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const workerIndex=process.argv.indexOf('--worker');
const root=resolve(workerIndex>=0?process.argv.at(-1):process.argv[2]??process.cwd());
if(workerIndex>=0){
 const name=process.argv[workerIndex+1],definition=CONTRACTS[name];
 if(!definition)throw Error('Unknown contract family');
 const closure=new Map();
 const sourceHash=async file=>{
  if(typeof file!=='string'||isAbsolute(file))throw Error('Contract closure contains an absolute/invalid source path');
  const path=resolve(root,'src',file),projectRelative=relative(root,path);
  if(!projectRelative||projectRelative==='..'||projectRelative.startsWith('..'+sep)||isAbsolute(projectRelative))throw Error('Contract closure escapes the project root');
  const metadata=await lstat(path);
  if(!metadata.isFile()||metadata.isSymbolicLink())throw Error('Contract closure source is not a regular file');
  const sha256=hash(await readFile(path)),relativePath=projectRelative.split(sep).join('/'),prior=closure.get(relativePath);
  if(prior&&prior!==sha256)throw Error('Contract source changed during fingerprint');
  closure.set(relativePath,sha256);return sha256;
 };
 const module=await import(pathToFileURL(resolve(root,'src',definition[0])).href);
 const value=name==='structuredStateGauges'?await module[definition[1]]('state-gauges',sourceHash):await module[definition[1]](sourceHash);
 const contractSha256=typeof value==='string'?value:typeof value?.semanticContractSha256==='string'?value.semanticContractSha256:hash(canonical(value));
 console.log(JSON.stringify({contractSha256,exportedValue:value,sourceFiles:[...closure].map(([path,sha256])=>({path,sha256})).sort((a,b)=>a.path.localeCompare(b.path,'en'))}));
}else{
 const script=fileURLToPath(import.meta.url),contracts={};
 for(const name of Object.keys(CONTRACTS)){
  const raw=execFileSync(process.execPath,[...process.execArgv,script,'--worker',name,root],{encoding:'utf8',maxBuffer:8*1024*1024});
  const result=JSON.parse(raw);
  if(!/^[a-f0-9]{64}$/.test(result.contractSha256)||!result.sourceFiles.length)throw Error('Incomplete contract fingerprint: '+name);
  contracts[name]=result;
 }
 const sourceRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const dirty=execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8'}).trim().length>0;
 const payload={schemaVersion:'stadtstack-r2-contract-fingerprint-report-v1',sourceRevision,sourceTreeClean:!dirty,method:'One sequential fresh Node process per exported contract; each process uses the contract API hash callback to record the exact source-file closure.',contractCount:Object.keys(contracts).length,contracts};
 payload.fingerprintSetSha256=hash(canonical({sourceRevision,contracts}));
 if(payload.contractCount!==14)throw Error('Expected exactly fourteen processing contracts');
 process.stdout.write(JSON.stringify(payload,null,2)+'\n');
}
