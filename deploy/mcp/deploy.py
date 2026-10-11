#!/usr/bin/env python3
"""Run only from session.sh's temporary governed credential environment."""
import datetime, hashlib, json, os, pathlib, re, secrets, shutil, signal, subprocess, sys
from stat import S_ISREG

os.umask(0o077)
os.environ['GIT_NO_REPLACE_OBJECTS']='1'
if 'MCP_SMOKE_EVIDENCE' in os.environ:
    raise RuntimeError('MCP_SMOKE_EVIDENCE is not accepted; this dispatcher runs the approved smoke itself')

def interrupted(signum, frame):
    raise SystemExit(128 + signum)

for interrupt_signal in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(interrupt_signal, interrupted)

release_repo = os.environ.get('MCP_RELEASE_REPO', '')
ROOT = pathlib.Path(release_repo)
if not release_repo or not ROOT.is_absolute() or not ROOT.is_dir() or ROOT.is_symlink() or ROOT.resolve() != ROOT:
    raise RuntimeError('MCP_RELEASE_REPO must name an explicit canonical absolute checkout')
CACHE = pathlib.Path.home() / '.cache/cluster-ops'
NS = 'stadtstack-mcp'
K = os.environ['KUBECTL']
digest = os.environ.get('MCP_IMAGE_DIGEST', '')
revision = os.environ.get('MCP_APPROVED_SHA', '')
release_version = os.environ.get('MCP_RELEASE_VERSION', '')
version_pattern = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
mode = os.environ.get('MCP_RELEASE_MODE')
if mode not in ('--diff-only', '--release'): raise RuntimeError('Explicit mode required')
if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest) or digest == 'sha256:'+'0'*64: raise RuntimeError('Immutable published digest required')
if not re.fullmatch(r'[0-9a-f]{40}', revision): raise RuntimeError('Approved pushed source required')
if not re.fullmatch(version_pattern, release_version): raise RuntimeError('Explicit literal release version required (for example 0.3.0)')
knowledge_municipality=os.environ.get('MCP_KNOWLEDGE_MUNICIPALITY','')
if not re.fullmatch(r'[a-z0-9-]{1,80}',knowledge_municipality): raise RuntimeError('Released knowledge municipality required for runtime acceptance')
entity_query=os.environ.get('MCP_GRAPH_ENTITY_QUERY')
if entity_query is not None and not 1<=len(entity_query.strip())<=200: raise RuntimeError('Invalid graph entity query')
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
package=json.loads(cmd(['git','-C',str(ROOT),'show',revision+':stadtstack-data/package.json']).stdout)
if package.get('version')!=release_version: raise RuntimeError('Approved package version differs from release version')
approved_manifest=json.loads(cmd(['git','-C',str(ROOT),'show',revision+':stadtstack-data/out/release-manifest.json']).stdout)
approved_manifest_id=approved_manifest.get('id','')
if not re.fullmatch(r'[0-9a-f]{64}',approved_manifest_id): raise RuntimeError('Approved data manifest identity missing')
# Trust GitHub's authenticated run metadata/logs, not caller-written smoke metadata,
# to bind the approved digest to the exact reviewed workflow/source revision.
run_id=os.environ.get('MCP_WORKFLOW_RUN_ID','')
if not re.fullmatch(r'[1-9][0-9]*',run_id): raise RuntimeError('Successful image workflow run ID required')
repository='GiraeffleAeffle/ledger-of-life'
run=json.loads(cmd(['gh','api','repos/'+repository+'/actions/runs/'+run_id]).stdout)
if (run.get('head_sha')!=revision or run.get('path')!='.github/workflows/civic-mcp-image.yml' or run.get('event')!='push' or run.get('status')!='completed' or run.get('conclusion')!='success' or run.get('repository',{}).get('full_name')!=repository or run.get('head_repository',{}).get('full_name')!=repository or run.get('head_branch')!=release_version): raise RuntimeError('Image workflow identity/tag does not match approved release')
workflow_log=cmd(['gh','run','view',run_id,'--repo',repository,'--log']).stdout
sources=set(re.findall(r'CIVIC_MCP_SOURCE=([0-9a-f]{40})\r?$',workflow_log,re.MULTILINE))
digests=set(re.findall(r'CIVIC_MCP_DIGEST=(sha256:[0-9a-f]{64})\r?$',workflow_log,re.MULTILINE))
versions=set(re.findall(r'CIVIC_MCP_VERSION=('+version_pattern+r')\r?$',workflow_log,re.MULTILINE))
if sources!={revision} or digests!={digest} or versions!={release_version}: raise RuntimeError('Trusted workflow digest/source/version binding failed')
# Resolve the actual public Git tag, including bounded annotated-tag chains.
tag_object=json.loads(cmd(['gh','api','repos/'+repository+'/git/ref/tags/'+release_version]).stdout)['object']
for _ in range(8):
    if tag_object.get('type')=='commit': break
    if tag_object.get('type')!='tag': raise RuntimeError('Release tag is not a commit or annotated tag')
    tag_object=json.loads(cmd(['gh','api','repos/'+repository+'/git/tags/'+tag_object['sha']]).stdout)['object']
if tag_object.get('type')!='commit' or tag_object.get('sha')!=revision: raise RuntimeError('Actual Git release tag differs from approved source')
image_repository='ghcr.io/giraeffleaeffle/stadtstack-mcp'
image_tag=image_repository+':'+release_version
tag_description=cmd(['docker','buildx','imagetools','inspect',image_tag]).stdout
tag_digests=set(re.findall(r'^Digest:\s*(sha256:[0-9a-f]{64})\s*$',tag_description,re.MULTILINE))
if tag_digests!={digest}: raise RuntimeError('Published literal image tag differs from approved digest')
image=image_tag+'@'+digest
(E/'workflow-identity.json').write_text(json.dumps({'runId':run_id,'url':run['html_url'],'source':revision,'version':release_version,'gitTag':release_version,'imageTag':release_version,'imageTagReference':image_tag,'image':image,'workflow':run['path']},indent=2))
# A supplied JSON receipt is not authority. Run the approved implementation now,
# in isolation, against the exact image and into this newly created private directory.
approved_smoke=E/'approved-smoke.py'
smoke_export=subprocess.run(['git','-C',str(ROOT),'show',revision+':deploy/mcp/smoke.py'],capture_output=True,timeout=60)
if smoke_export.returncode: raise RuntimeError('Cannot export approved smoke implementation')
smoke_source=smoke_export.stdout
with approved_smoke.open('xb') as handle: handle.write(smoke_source)
approved_smoke.chmod(0o400)
smoke_script_sha256=hashlib.sha256(smoke_source).hexdigest()
smoke_path=E/'runtime-smoke.json'
if smoke_path.exists() or smoke_path.is_symlink(): raise RuntimeError('Runtime evidence path must be fresh')
smoke_run_id=secrets.token_hex(16)
smoke_container='civic-mcp-smoke-'+smoke_run_id
smoke_scratch=E/'smoke-scratch';smoke_scratch.mkdir(mode=0o700)
smoke_args=[sys.executable,'-I',str(approved_smoke),'--image',image,'--release-version',release_version,'--knowledge-municipality',knowledge_municipality,'--run-id',smoke_run_id,'--scratch-dir',str(smoke_scratch),'--evidence',str(smoke_path)]
if entity_query is not None: smoke_args+=['--entity-query',entity_query]
smoke_env=os.environ.copy()
for credential_variable in ('KUBECONFIG','KUBECTL','TALOSCONFIG','TALOSCTL','STADTSTACK_PRIVILEGED_LOCK_OWNER'):
    smoke_env.pop(credential_variable,None)
smoke_started=datetime.datetime.now(datetime.timezone.utc).isoformat()
smoke_process=None
try:
    smoke_process=subprocess.Popen(smoke_args,cwd=str(E),env=smoke_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
    try:
        smoke_process.communicate(timeout=300)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Approved exact-image smoke timed out; output withheld') from None
    if smoke_process.returncode!=0: raise RuntimeError('Approved exact-image smoke failed; output withheld')
finally:
    try:
        if smoke_process is not None and smoke_process.poll() is None:
            try: os.killpg(smoke_process.pid,signal.SIGTERM)
            except ProcessLookupError: pass
            try: smoke_process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                try: os.killpg(smoke_process.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                smoke_process.communicate(timeout=10)
        # Cancellation must not strand the disposable container. The name comes
        # from this invocation's random nonce, never from a caller or old receipt.
        remaining=subprocess.run(['docker','ps','-aq','--filter','name=^/'+smoke_container+'$'],capture_output=True,text=True,timeout=30)
        if remaining.returncode: raise RuntimeError('Cannot confirm disposable smoke-container cleanup')
        container_ids=remaining.stdout.split()
        if len(container_ids)>1 or any(not re.fullmatch(r'[0-9a-f]{12,64}',value) for value in container_ids): raise RuntimeError('Unexpected disposable container identity')
        if container_ids:
            removed=subprocess.run(['docker','rm','--force',*container_ids],capture_output=True,text=True,timeout=30)
            if removed.returncode: raise RuntimeError('Cannot remove disposable smoke container')
    finally:
        try:
            (E/'smoke-execution.json').write_text(json.dumps({'source':revision,'scriptSha256':smoke_script_sha256,'runId':smoke_run_id,'image':image,'version':release_version,'startedAt':smoke_started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':smoke_process.returncode if smoke_process is not None else None,'evidence':str(smoke_path)},indent=2))
        finally:
            shutil.rmtree(smoke_scratch)
smoke_stat=smoke_path.lstat()
if not S_ISREG(smoke_stat.st_mode) or smoke_stat.st_uid!=os.getuid() or smoke_stat.st_mode & 0o077 or smoke_stat.st_nlink!=1 or smoke_stat.st_size>1048576:
    raise RuntimeError('Unsafe generated runtime evidence')
smoke_bytes=smoke_path.read_bytes()
smoke=json.loads(smoke_bytes)
smoke_checks=smoke.get('checks',{})
if (
    smoke.get('image')!=image or smoke.get('imageTag')!=release_version or smoke.get('imageTagReference')!=image_tag or smoke.get('releaseVersion')!=release_version
    or smoke.get('passed') is not True or smoke.get('acceptanceScope')!='exact_local_image'
    or smoke.get('runId')!=smoke_run_id or smoke.get('imageProvenanceVerified') is not True
    or smoke.get('runningImageIdentityVerified') is not True or smoke_checks.get('serverVersion')!=release_version
    or smoke_checks.get('statusReleaseVersion')!=release_version or smoke_checks.get('imageVersion')!=release_version
    or smoke_checks.get('imageRefName')!=release_version or smoke_checks.get('imageRevision')!=revision
    or smoke_checks.get('gitTag')!=release_version or smoke_checks.get('gitTagRevision')!=revision
    or smoke_checks.get('imageTagDigest')!=digest or smoke_checks.get('statusDataManifestId')!=approved_manifest_id
    or smoke_checks.get('sharedDataRelease')!=approved_manifest_id
): raise RuntimeError('Generated exact-image runtime evidence does not match the approved release')
runtime_acceptance={'source':revision,'scriptSha256':smoke_script_sha256,'runId':smoke_run_id,'evidence':str(smoke_path),'evidenceSha256':hashlib.sha256(smoke_bytes).hexdigest(),'dataManifestId':approved_manifest_id}
kit=E/'kit';kit.mkdir(mode=0o700)
archive=subprocess.Popen(['git','-C',str(ROOT),'archive',revision,'deploy/mcp/chart'],stdout=subprocess.PIPE)
extract=subprocess.run(['tar','-x','-C',str(kit)],stdin=archive.stdout,capture_output=True);archive.stdout.close()
if archive.wait() or extract.returncode: raise RuntimeError('Reviewed chart export failed')
chart=str(kit/'deploy/mcp/chart')
args=['civic-mcp',chart,'-n',NS,'--set-string','releaseVersion='+release_version,'--set-string','image.digest='+digest]
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
summary=[{'name':p['metadata']['name'],'version':p['metadata'].get('labels',{}).get('app.kubernetes.io/version'),'phase':p.get('status',{}).get('phase'),'images':[c['image'] for c in p['spec']['containers']],'containers':[{'name':c['name'],'ready':c.get('ready'),'imageID':c.get('imageID')} for c in p.get('status',{}).get('containerStatuses',[])]} for p in pods]
(E/'pods.json').write_text(json.dumps(summary,indent=2))
if len(summary)!=1 or summary[0]['images']!=[image] or summary[0]['version']!=release_version or not summary[0]['containers'] or not all(c['ready'] and c['imageID'] for c in summary[0]['containers']): raise RuntimeError('Exact versioned deployment not Ready')
(E/'result.json').write_text(json.dumps({'source':revision,'version':release_version,'gitTag':release_version,'imageTag':release_version,'imageTagReference':image_tag,'image':image,'imageIdentityScope':'approved desired reference; observed ReadyPod imageIDs are recorded separately in pods.json','runtimeAcceptance':runtime_acceptance,'namespace':NS,'protectedBoundaryUnchanged':True,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2))
print('Civic MCP Ready; public HTTPS acceptance remains required. Evidence: '+str(E))
