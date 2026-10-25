import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Pool} from 'pg';
import {root} from './common.ts';
import type {Step8OperatorInput} from './r1-step8.ts';

/** Read-only and lock-free. Call before constructing the canonical source pass;
 * its output is diagnostic, never a publication or replay capability. */
export async function requireStep8Preflight(input:Step8OperatorInput,pool:Pool){
 const {precheckStep8Publication}=await import(pathToFileURL(join(root,'scripts/r1-step8-precheck.mjs')).href);
 const {report}=await precheckStep8Publication(input,{pool});
 if(report.status!=='static_controls_covered')throw Error('Step8 automatic pre-pass refused: '+JSON.stringify(report.blockers));
 return report;
}
