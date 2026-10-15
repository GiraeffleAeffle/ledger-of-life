import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {Step8InputSchema,step8ReadPlan,discoverStep8Plan,runStep8} from '../src/r1-step8.ts';
import {digest} from '../src/district-adapter-contract.ts';

const [mode,path,sha256,...extra]=process.argv.slice(2);
if(!process.env.STADTSTACK_STEP8_OFFLINE)throw Error('Use scripts/r1-step8.sh: offline transport/provider guard is required');
if(extra.length||!path||!sha256||!['plan','execute','discover'].includes(mode??''))throw Error('Usage: r1-step8.sh plan|execute INPUT_JSON INPUT_SHA256; or discover PRODUCTION_PACKAGE_ROOT DRIVER_ROOT');
if(mode==='discover'){
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,application_name:'r1-step8-read-only-discovery',options:'-c default_transaction_read_only=on'});
 try{console.log(JSON.stringify(await discoverStep8Plan(path,sha256,pool),null,2));}finally{await pool.end();}
}else{
 const bytes=await readFile(path);if(digest(bytes)!==sha256)throw Error('Step8 operator manifest pin mismatch');
 const input=Step8InputSchema.parse(JSON.parse(bytes.toString('utf8')));
 if(mode==='plan')console.log(JSON.stringify(step8ReadPlan(input),null,2));
 else{
  if(!process.env.DATABASE_URL)throw Error('Explicit same-host canonical database required');
  const dsn=new URL(process.env.DATABASE_URL),host=dsn.searchParams.get('host');
  if(!host?.startsWith('/'))throw Error('Offline step8 requires a PostgreSQL Unix-domain socket');
  const pool=new Pool({connectionString:dsn.href,max:2,application_name:'r1-step8'});
  try{console.log(JSON.stringify(await runStep8(input,pool),null,2));}finally{await pool.end();}
 }
}
