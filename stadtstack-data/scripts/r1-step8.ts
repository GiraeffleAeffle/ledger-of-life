import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {step8SocketConnection} from '../src/r1-step8-governance.ts';
import {Step8InputSchema,step8ReadPlan,discoverStep8Plan,runStep8} from '../src/r1-step8.ts';
import {digest} from '../src/district-adapter-contract.ts';
import {auditStep8} from '../src/r1-step8-audit.ts';
import {buildStep8RetainedPlan,assembleStep8Staging} from '../src/r1-step8-staging.ts';

const [mode,path,sha256,...extra]=process.argv.slice(2);
if(!process.env.STADTSTACK_STEP8_OFFLINE)throw Error('Use scripts/r1-step8.sh: offline transport/provider guard is required');
if(extra.length||!path||!['plan','audit','execute','discover','retained-plan','assemble-staging'].includes(mode??'')||(mode==='retained-plan'?sha256!==undefined:!sha256))throw Error('Usage: r1-step8.sh plan|audit|execute|assemble-staging INPUT_JSON INPUT_SHA256; discover PACKAGE_ROOT DRIVER_ROOT; retained-plan PUBLICATION_ROOT');
if(mode==='retained-plan'){
 console.log(JSON.stringify(await buildStep8RetainedPlan(path),null,2));
}else if(mode==='assemble-staging'){
 const bytes=await readFile(path);if(digest(bytes)!==sha256)throw Error('Step8 staging assembly pin mismatch');
 console.log(JSON.stringify(await assembleStep8Staging(JSON.parse(bytes.toString('utf8'))),null,2));
}else if(mode==='discover'){
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,application_name:'r1-step8-read-only-discovery',options:'-c default_transaction_read_only=on'});
 try{console.log(JSON.stringify(await discoverStep8Plan(path,sha256!,pool),null,2));}finally{await pool.end();}
}else{
 const bytes=await readFile(path);if(digest(bytes)!==sha256)throw Error('Step8 operator manifest pin mismatch');
 const input=Step8InputSchema.parse(JSON.parse(bytes.toString('utf8')));
 if(mode==='plan')console.log(JSON.stringify(step8ReadPlan(input),null,2));
 else{
  if(!process.env.DATABASE_URL)throw Error('Explicit same-host canonical database required');
  const dsn=step8SocketConnection(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:dsn,max:2,application_name:'r1-step8'+(mode==='audit'?'-read-only-audit':''),...(mode==='audit'?{options:'-c default_transaction_read_only=on'}:{})});
  try{
   if(mode==='audit'){
    try{const report=await auditStep8(input,pool);console.log(JSON.stringify(report,null,2));if(report.status!=='compatible')process.exitCode=1;}
    catch(error){console.log(JSON.stringify({schemaVersion:'stadtstack-r1-step8-read-only-audit-v1',status:'blocked',writes:[],network:false,providers:false,publicationExecuted:false,blockers:[{scope:'initialization',message:error instanceof Error?error.message:String(error)}]},null,2));process.exitCode=1;}
   }else console.log(JSON.stringify(await runStep8(input,pool),null,2));
  }finally{await pool.end();}
 }
}
