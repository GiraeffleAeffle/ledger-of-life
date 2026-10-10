#!/usr/bin/env python3
"""Run only from session.sh's temporary governed credential environment."""
import datetime, hashlib, json, os, pathlib, re, subprocess

release_repo = os.environ.get('MCP_RELEASE_REPO', '')
ROOT = pathlib.Path(release_repo)
if not release_repo or not ROOT.is_absolute() or not ROOT.is_dir() or ROOT.is_symlink() or ROOT.resolve() != ROOT:
    raise RuntimeError('MCP_RELEASE_REPO must name an explicit canonical absolute checkout')
CACHE = pathlib.Path.home() / '.cache/cluster-ops'
NS = 'stadtstack-mcp'
K = os.environ['KUBECTL']
digest = os.environ.get('MCP_IMAGE_DIGEST', '')
revision = os.environ.get('MCP_APPROVED_SHA', '')
mode = os.environ.get('MCP_RELEASE_MODE')
if mode not in ('--diff-only', '--release'): raise RuntimeError('Explicit mode required')
if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest) or digest == 'sha256:'+'0'*64: raise RuntimeError('Immutable published digest required')
if not re.fullmatch(r'[0-9a-f]{40}', revision): raise RuntimeError('Approved pushed source required')
if mode == '--release' and (os.environ.get('CLUSTER_OPS_MCP_GO') != 'protected-read-only-civic-mcp' or os.environ.get('MCP_SECURITY_REVIEW_ACK') != revision): raise RuntimeError('Explicit release and source-bound security review approvals required')
E = CACHE / ('mcp-release-'+revision[:12]+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
E.mkdir(mode=0o700)

def cmd(args, payload=None, check=True):
    result = subprocess.run(args, input=payload, capture_output=True, text=True)
    if check and result.returncode: raise RuntimeError('Command failed: '+str(args[0])+' (output withheld)')
    return result

def kub(args, payload=None, check=True):
    return cmd([K, '--request-timeout=60s', *args], payload, check)

for ref in ['HEAD', '@{upstream}']:
    if cmd(['git', '-C', str(ROOT), 'rev-parse', ref]).stdout.strip() != revision: raise RuntimeError('Approved source/upstream differs')
if cmd(['git','-C',str(ROOT),'rev-parse','--show-toplevel']).stdout.strip()!=str(ROOT):
    raise RuntimeError('Release repository must be its Git worktree root')
if cmd(['git','-C',str(ROOT),'status','--porcelain','--untracked-files=no']).stdout:
    raise RuntimeError('Release checkout has tracked modifications; use a fresh clone')
# Trust GitHub's authenticated run metadata/logs, not caller-written smoke metadata,
# to bind the approved digest to the exact reviewed workflow/source revision.
run_id=os.environ.get('MCP_WORKFLOW_RUN_ID','')
if not re.fullmatch(r'[1-9][0-9]*',run_id): raise RuntimeError('Successful image workflow run ID required')
repository='GiraeffleAeffle/ledger-of-life'
run=json.loads(cmd(['gh','api','repos/'+repository+'/actions/runs/'+run_id]).stdout)
if (run.get('head_sha')!=revision or run.get('path')!='.github/workflows/civic-mcp-image.yml' or run.get('event')!='push' or run.get('status')!='completed' or run.get('conclusion')!='success' or run.get('repository',{}).get('full_name')!=repository or run.get('head_repository',{}).get('full_name')!=repository or not str(run.get('head_branch','')).startswith('civic-mcp-v')): raise RuntimeError('Image workflow identity does not match approved release')
workflow_log=cmd(['gh','run','view',run_id,'--repo',repository,'--log']).stdout
sources=set(re.findall(r'CIVIC_MCP_SOURCE=([0-9a-f]{40})\r?$',workflow_log,re.MULTILINE))
digests=set(re.findall(r'CIVIC_MCP_DIGEST=(sha256:[0-9a-f]{64})\r?$',workflow_log,re.MULTILINE))
if sources!={revision} or digests!={digest}: raise RuntimeError('Trusted workflow digest/source binding failed')
(E/'workflow-identity.json').write_text(json.dumps({'runId':run_id,'url':run['html_url'],'source':revision,'image':'ghcr.io/giraeffleaeffle/stadtstack-mcp@'+digest,'workflow':run['path']},indent=2))
smoke = json.loads(pathlib.Path(os.environ['MCP_SMOKE_EVIDENCE']).read_text())
if smoke.get('image') != 'ghcr.io/giraeffleaeffle/stadtstack-mcp@'+digest or not smoke.get('passed'): raise RuntimeError('Exact-digest smoke evidence required')
kit=E/'kit';kit.mkdir(mode=0o700)
archive=subprocess.Popen(['git','-C',str(ROOT),'archive',revision,'deploy/mcp/chart'],stdout=subprocess.PIPE)
extract=subprocess.run(['tar','-x','-C',str(kit)],stdin=archive.stdout,capture_output=True);archive.stdout.close()
if archive.wait() or extract.returncode: raise RuntimeError('Reviewed chart export failed')
chart=str(kit/'deploy/mcp/chart')
args=['civic-mcp',chart,'-n',NS,'--set-string','image.digest='+digest]
render=cmd(['helm','template',*args]).stdout
if 'kind: Secret' in render or 'kind: Namespace' in render: raise RuntimeError('Chart must not manage credentials/namespace')
(E/'rendered.yaml').write_text(render)

def boundary():
    resources='deployments,statefulsets,daemonsets,services,ingresses,networkpolicies,pvc,certificates.cert-manager.io,clusterissuers.cert-manager.io'
    rows=json.loads(kub(['get',resources,'-A','-o','json']).stdout)['items']
    return sorted([{'kind':x['kind'],'namespace':x['metadata'].get('namespace',''),'name':x['metadata']['name'],'uid':x['metadata']['uid'],'specSha256':hashlib.sha256(json.dumps(x.get('spec'),sort_keys=True).encode()).hexdigest()} for x in rows if x['metadata'].get('namespace') != NS],key=lambda x:(x['kind'],x['namespace'],x['name']))

before=boundary();(E/'protected-before.json').write_text(json.dumps(before,indent=2))
namespace=kub(['get','namespace',NS,'-o','json'],check=False)
if namespace.returncode == 0:
    existing=json.loads(namespace.stdout)
    if existing['metadata'].get('labels',{}).get('app.kubernetes.io/part-of') != 'stadtstack-mcp': raise RuntimeError('Unowned namespace; stop')
    (E/'server-dry-run.txt').write_text(kub(['apply','--dry-run=server','-f',str(E/'rendered.yaml')]).stdout)
else:
    if 'NotFound' not in namespace.stderr: raise RuntimeError('Namespace discovery failed')
    (E/'client-dry-run.txt').write_text(kub(['apply','--dry-run=client','-f',str(E/'rendered.yaml')]).stdout)
if mode == '--diff-only':
    print('Read-only render complete: '+str(E));raise SystemExit(0)
phrase='release-mcp-'+revision[:12]
if input('Type '+phrase+' to deploy the protected civic MCP: ').strip()!=phrase: raise RuntimeError('Approval not supplied')
ns={'apiVersion':'v1','kind':'Namespace','metadata':{'name':NS,'labels':{'app.kubernetes.io/part-of':'stadtstack-mcp','pod-security.kubernetes.io/enforce':'restricted','pod-security.kubernetes.io/audit':'restricted','pod-security.kubernetes.io/warn':'restricted'}}}
kub(['apply','-f','-'],json.dumps(ns))
# Validate and send only salted-independent random-token SHA-256 values, never plaintext.
hashpath=pathlib.Path.home()/'.config/stadtstack/mcp-tokens/token-hashes.json'
stat=hashpath.lstat()
if hashpath.is_symlink() or not hashpath.is_file() or stat.st_uid!=os.getuid() or stat.st_mode & 0o077 or stat.st_nlink!=1: raise RuntimeError('Unsafe token hash file')
records=json.loads(hashpath.read_text())
if not isinstance(records,list) or not records or any(not isinstance(x,dict) or set(x)!= {'id','sha256'} or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}',x['id']) or not re.fullmatch(r'[0-9a-f]{64}',x['sha256']) for x in records): raise RuntimeError('Malformed token hash file')
secret={'apiVersion':'v1','kind':'Secret','metadata':{'name':'civic-mcp-token-hashes','namespace':NS},'type':'Opaque','stringData':{'token-hashes.json':json.dumps(records)}}
kub(['apply','-f','-'],json.dumps(secret))
# Hash revision rolls one replica so limits cannot be bypassed by round-robin pods.
args+=['--set-string','tokenSecretRevision='+hashlib.sha256(json.dumps(records,sort_keys=True).encode()).hexdigest()[:16]]
(E/'server-dry-run.txt').write_text(kub(['apply','--dry-run=server','-f',str(E/'rendered.yaml')]).stdout)
(E/'helm-release.txt').write_text(cmd(['helm','upgrade','--install',*args,'--wait','--timeout','10m']).stdout)
(E/'rollout.txt').write_text(kub(['-n',NS,'rollout','status','deployment/civic-mcp','--timeout=120s']).stdout)
after=boundary();(E/'protected-after.json').write_text(json.dumps(after,indent=2))
if before!=after: raise RuntimeError('Protected non-MCP resources changed; inspect evidence')
pods=json.loads(kub(['-n',NS,'get','pods','-l','app.kubernetes.io/name=civic-mcp','-o','json']).stdout)['items']
summary=[{'name':p['metadata']['name'],'phase':p.get('status',{}).get('phase'),'images':[c['image'] for c in p['spec']['containers']],'containers':[{'name':c['name'],'ready':c.get('ready'),'imageID':c.get('imageID')} for c in p.get('status',{}).get('containerStatuses',[])]} for p in pods]
(E/'pods.json').write_text(json.dumps(summary,indent=2))
image='ghcr.io/giraeffleaeffle/stadtstack-mcp@'+digest
if len(summary)!=1 or summary[0]['images']!=[image] or not summary[0]['containers'] or not all(c['ready'] and c['imageID'] for c in summary[0]['containers']): raise RuntimeError('Exact deployment not Ready')
(E/'result.json').write_text(json.dumps({'source':revision,'image':image,'namespace':NS,'protectedBoundaryUnchanged':True,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2))
print('Civic MCP Ready; public HTTPS acceptance remains required. Evidence: '+str(E))
