import {after} from 'node:test';
import {existsSync,realpathSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {APPROVED_OWNER_ROBOTS_OVERRIDE} from '../../src/source-policy.ts';
import type {PoliteFetcherOptions} from '../../src/polite-fetch.ts';

const policyDirectories=new Set<string>();
const policyDirectoryByRoot=new Map<string,string>();
after(async()=>{await Promise.all([...policyDirectories].map(path=>rm(path,{recursive:true,force:true})));});

/** Real empty-root lane initialization with independent owner-only policy state. */
export function politeTestOptions(options:PoliteFetcherOptions):PoliteFetcherOptions {
 const target=resolve(options.cacheDir);let existing=target;
 while(!existsSync(existing))existing=dirname(existing);
 const cacheDir=resolve(realpathSync(existing),relative(existing,target));
 const stateDir=options.ownerPolicyLane?.stateDir??policyDirectoryByRoot.get(cacheDir)??join(realpathSync(tmpdir()),'stadtstack-test-policy-'+randomUUID());
 policyDirectories.add(stateDir);
 policyDirectoryByRoot.set(cacheDir,stateDir);
 return {...options,cacheDir,ownerPolicyLane:{decisionId:APPROVED_OWNER_ROBOTS_OVERRIDE.id,stateDir}};
}
