import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Invalid synthetic arguments must reject before any source/model/publication work.
test('publication and reproducibility CLIs execute their guards through symlink entry paths',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-cli-entry-'));
 try{
  for(const name of ['publish','prepare-knowledge','export-district-sources','corpus-manifest','replay-pipeline']){
   const link=join(directory,name+'.ts');
   await symlink(fileURLToPath(new URL('../src/'+name+'.ts',import.meta.url)),link,'file');
   const result=spawnSync(process.execPath,['--experimental-strip-types',link,'--synthetic-invalid-option'],{encoding:'utf8',timeout:15000});
   assert.ifError(result.error);
   assert.notEqual(result.status,0,`${name} must not silently skip its CLI through a symlink`);
   assert.ok(result.stderr.length>0,`${name} must report rejected arguments`);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
