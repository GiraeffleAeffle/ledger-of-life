import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Fresh processes exercise each static entrypoint rather than relying on a warm module cache.
test('shared policy and identity contracts load without native processing or authority provisioning',async()=>{
  const home=await mkdtemp(join(tmpdir(),'civic-contract-import-'));
  try{
    for(const file of ['district-schema.ts','source-policy.ts','civic-opt-out.ts','document-origin-rules.ts','district-stage-evidence.ts','mcp-source-identity.ts']){
      const url=new URL('../src/'+file,import.meta.url).href;
      const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import ${JSON.stringify(url)};`],{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH??'',HOME:home,LANG:'C.UTF-8',TZ:'UTC'}});
      assert.equal(result.status,0,`${file}: ${result.error?.name??''} ${result.stderr.slice(0,4000)}`);
      assert.equal(result.stdout,'');
    }
    assert.deepEqual(await readdir(home),[]);
  }finally{await rm(home,{recursive:true,force:true});}
});
