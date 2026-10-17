import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {loadRelease} from './mcp-release.ts';
import {server} from './mcp.ts';

// Local-only evaluation entry. No HTTP listener, hosted defaults or authority writes.
const directory=process.env.STADTSTACK_CANDIDATE_DIRECTORY;
const releaseId=process.env.STADTSTACK_CANDIDATE_RELEASE_ID;
const stateDir=process.env.STADTSTACK_CANDIDATE_POLICY_STATE_DIR;
if(!directory||!releaseId||!/^[a-f0-9]{64}$/.test(releaseId)||!stateDir)throw Error('Explicit candidate directory, identity and VM policy state required');
const policyOptions={stateDir};
const release=await loadRelease(directory,{mode:'vm_candidate',policyOptions});
if(release.dataManifest.id!==releaseId)throw Error('Candidate release identity mismatch');
await server({release,policyOptions}).connect(new StdioServerTransport());
