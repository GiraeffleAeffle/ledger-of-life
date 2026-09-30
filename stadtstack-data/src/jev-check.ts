import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const mode=process.env.FAITHFULNESS_MODE??'llm';
if(!['llm','hybrid','system_one'].includes(mode)){console.error('Invalid FAITHFULNESS_MODE; expected llm, hybrid, or system_one.');process.exit(1);}
const requiresJev=mode!=='llm';
const hasKey=Boolean(process.env.TYPESAFE_API_KEY);
console.log(`mode=${mode}; TYPESAFE_API_KEY configured=${hasKey}`);
if(requiresJev&&!hasKey){console.error('Jev mode requires TYPESAFE_API_KEY in stadtstack-data/.env.local; value is never displayed.');process.exit(1);}
const python=join(root,`cache/${requiresJev?'venv-jev':'venv'}/bin/python`);
if(!existsSync(python)){console.error(`Missing evaluator environment ${python}; install the documented DeepEval dependency first.`);process.exit(1);}
const code=requiresJev
 ? "import importlib.metadata as m, os, sys; sys.path.insert(0,os.path.join(os.environ['STADTSTACK_DATA_ROOT'],'src')); from deepeval.metrics import FaithfulnessMetric; from faithfulness import CodexJudge; mode=os.environ['FAITHFULNESS_MODE']; kwargs={'threshold':0.8,'async_mode':False,'include_reason':True,'penalize_ambiguous_claims':True,'eval_mode':mode}; kwargs.update({'model':CodexJudge()} if mode=='hybrid' else {}); FaithfulnessMetric(**kwargs); print(m.version('deepeval')); print(m.version('typesafe-sdk')); print('child-key-present='+str(bool(os.getenv('TYPESAFE_API_KEY'))).lower())"
 : "import importlib.metadata as m, os; print(m.version('deepeval')); print('not-applicable'); print('child-key-present='+str(bool(os.getenv('TYPESAFE_API_KEY'))).lower())";
const childEnv:NodeJS.ProcessEnv={...process.env,DEEPEVAL_TELEMETRY_OPT_OUT:'YES',STADTSTACK_DATA_ROOT:root};
if(requiresJev)delete childEnv.OPENAI_API_KEY;
const check=spawnSync(python,['-c',code],{encoding:'utf8',env:childEnv,cwd:root});
if(check.status!==0){console.error(`DeepEval/TypeSafe dependency or local metric-construction check failed in ${python} (status=${check.status??'unknown'}); details redacted.`);process.exit(1);}
const [version,sdkVersion,childKey]=check.stdout.trim().split('\n');
const sdkMinor=/^0\.(\d+)\./.exec(sdkVersion)?.[1];
if(requiresJev&&!/^4\./.test(version)){console.error(`Jev modes require DeepEval 4.x in ${python}; found ${version}.`);process.exit(1);}
if(requiresJev&&(!sdkMinor||Number(sdkMinor)<7)){console.error(`Jev modes require typesafe-sdk >=0.7,<1 in ${python}; found ${sdkVersion}.`);process.exit(1);}
if(childKey!==`child-key-present=${hasKey}`){console.error('Evaluator subprocess did not inherit key configuration as expected.');process.exit(1);}
console.log(`DeepEval ${version}${requiresJev?`; typesafe-sdk ${sdkVersion}; Jev metric constructed locally without a request`:''}; child key presence=${childKey.endsWith('true')}.`);
if(requiresJev)console.log('Configuration is ready; this check does not send a Jev request.');
