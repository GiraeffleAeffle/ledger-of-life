import {after} from 'node:test';
import {existsSync,realpathSync} from 'node:fs';
import {dirname,relative,resolve} from 'node:path';
import {APPROVED_OWNER_ROBOTS_OVERRIDE} from '../../src/source-policy.ts';
import type {PoliteFetcherOptions} from '../../src/polite-fetch.ts';
import type {CivicPolicyOptions} from '../../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './civic-policy.ts';

const policiesByRoot=new Map<string,Promise<CivicPolicyOptions>>();
const disposers=new Set<()=>Promise<void>>();
after(async()=>{await Promise.all([...disposers].map(dispose=>dispose()));});

/** Explicit test-only authority provisioning; normal acquisition never provisions. */
export async function politeTestOptions(options:PoliteFetcherOptions):Promise<PoliteFetcherOptions> {
 const target=resolve(options.cacheDir);let existing=target;
 while(!existsSync(existing))existing=dirname(existing);
 const cacheDir=resolve(realpathSync(existing),relative(existing,target));
 const supplied=options.ownerPolicyLane;
 if(supplied?.stateDir!==undefined){
  if(!supplied.authorityId?.startsWith('fixture:')||!supplied.authoritySha256)throw Error('Explicit test policy state requires the full isolated fixture authority');
  return {...options,cacheDir};
 }
 let pending=policiesByRoot.get(cacheDir);
 if(!pending){
  pending=createCivicPolicyTestContext().then(context=>{disposers.add(context.dispose);return context.policy;});policiesByRoot.set(cacheDir,pending);
 }
 const policy=await pending;
 return {...options,cacheDir,ownerPolicyLane:{decisionId:APPROVED_OWNER_ROBOTS_OVERRIDE.id,...policy,...supplied}};
}
