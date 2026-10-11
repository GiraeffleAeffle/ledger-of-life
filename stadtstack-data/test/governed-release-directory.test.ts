import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {governedReleaseDirectory} from '../src/governed-release-directory.ts';
import {outDir,cacheDir} from '../src/common.ts';

// Pure configuration fixtures: no release, deployment, source admission or I/O.
test('live serving requires the explicit absolute MCP release selector',()=>{
 assert.throws(()=>governedReleaseDirectory({}),/STADTSTACK_MCP_RELEASE_DIR/);
 assert.throws(()=>governedReleaseDirectory({STADTSTACK_MCP_RELEASE_DIR:'cache/release'}),/absolute/);
 const directory=join(cacheDir,'synthetic-governed-release');
 assert.equal(governedReleaseDirectory({STADTSTACK_MCP_RELEASE_DIR:directory}),resolve(directory));
});
test('historical tracked output never becomes an implicit live serving root',()=>{
 for(const directory of [outDir,join(outDir,'knowledge'),join(outDir,'..not-parent'),join(outDir,'..','out')])assert.throws(()=>governedReleaseDirectory({STADTSTACK_MCP_RELEASE_DIR:directory}),/Historical release/);
});
