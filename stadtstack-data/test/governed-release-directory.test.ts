import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtempSync,mkdirSync,symlinkSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {governedReleaseDirectory} from '../src/governed-release-directory.ts';
import {outDir} from '../src/common.ts';
test('live serving requires the explicit absolute MCP release selector',()=>{
 assert.throws(()=>governedReleaseDirectory({}),/STADTSTACK_MCP_RELEASE_DIR/);
 assert.throws(()=>governedReleaseDirectory({STADTSTACK_MCP_RELEASE_DIR:'cache/release'}),/absolute/);
 const directory=mkdtempSync(join(tmpdir(),'governed-release-'));
 try{assert.equal(governedReleaseDirectory({STADTSTACK_MCP_RELEASE_DIR:directory}),realpathSync(directory));}
 finally{rmSync(directory,{recursive:true,force:true});}
});
test('historical tracked output never becomes an implicit live serving root',()=>{
 for(const directory of [outDir,join(outDir,'knowledge'),join(outDir,'..','out'),join(outDir,'..not-parent')])assert.throws(()=>governedReleaseDirectory({STADTSTACK_MCP_RELEASE_DIR:directory}),/Historical release/);
});
test('external-looking symlinks cannot select historical output or its descendants',()=>{
 const root=mkdtempSync(join(tmpdir(),'governed-release-links-'));
 try{
  for(const [name,target] of [['output',outDir],['descendant',join(outDir,'knowledge')]]){
   const link=join(root,name);symlinkSync(target,link,'dir');
   assert.throws(()=>governedReleaseDirectory({STADTSTACK_MCP_RELEASE_DIR:link}),/Historical release/);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('release root rejects symlinks even to real nonhistorical directories and through ancestors',()=>{
 const root=mkdtempSync(join(tmpdir(),'governed-release-chain-'));
 try{
  const real=join(root,'real');mkdirSync(real);mkdirSync(join(real,'release'));
  const link=join(root,'link');symlinkSync(real,link,'dir');
  for(const directory of [link,join(link,'release')])assert.throws(()=>governedReleaseDirectory({STADTSTACK_MCP_RELEASE_DIR:directory}),/real directory components/);
  assert.equal(governedReleaseDirectory({STADTSTACK_MCP_RELEASE_DIR:join(real,'release')}),realpathSync(join(real,'release')));
 }finally{rmSync(root,{recursive:true,force:true});}
});
