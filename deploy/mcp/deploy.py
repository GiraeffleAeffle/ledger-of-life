#!/usr/bin/env python3
"""VM-only dispatcher: sudo stadtstack-session exec /usr/bin/python3 -I ..."""
import argparse, base64, datetime, hashlib, importlib.util, json, os, pathlib, re, secrets, shutil, signal, subprocess, sys
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
# Root executes a separately reviewed non-root-owned clone; trust only this path.
os.environ['GIT_CONFIG_COUNT']='1'
os.environ['GIT_CONFIG_KEY_0']='safe.directory'
os.environ['GIT_CONFIG_VALUE_0']=str(ROOT)
CACHE = pathlib.Path('/var/lib/stadtstack-mcp-release')
NS = 'stadtstack-mcp'
K = '/usr/local/bin/stadtstack-kubectl'
if os.getuid() != 0 or sys.platform != 'linux':
    raise RuntimeError('Release dispatcher requires the root VM Lease session')
if 'KUBECTL' in os.environ and os.environ['KUBECTL'] != K:
    raise RuntimeError('Cluster access is restricted to the VM kubectl wrapper')
parser = argparse.ArgumentParser(description=__doc__)
mode_group = parser.add_mutually_exclusive_group(required=True)
mode_group.add_argument('--diff-only', dest='mode', action='store_const', const='--diff-only')
mode_group.add_argument('--release', dest='mode', action='store_const', const='--release')
mode = parser.parse_args().mode
digest = os.environ.get('MCP_IMAGE_DIGEST', '')
revision = os.environ.get('MCP_APPROVED_SHA', '')
release_version = os.environ.get('MCP_RELEASE_VERSION', '')
version_pattern = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
if os.environ.get('MCP_RELEASE_MODE') not in (None, mode):
    raise RuntimeError('Conflicting release mode')
if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest) or digest == 'sha256:'+'0'*64: raise RuntimeError('Immutable published digest required')
if not re.fullmatch(r'[0-9a-f]{40}', revision): raise RuntimeError('Approved pushed source required')
if not re.fullmatch(version_pattern, release_version): raise RuntimeError('Explicit literal release version required (for example 0.3.1)')
knowledge_municipality=os.environ.get('MCP_KNOWLEDGE_MUNICIPALITY','')
if not re.fullmatch(r'[a-z0-9-]{1,80}',knowledge_municipality): raise RuntimeError('Released knowledge municipality required for runtime acceptance')
entity_query=os.environ.get('MCP_GRAPH_ENTITY_QUERY')
if entity_query is not None and not 1<=len(entity_query.strip())<=200: raise RuntimeError('Invalid graph entity query')
if mode == '--release' and (os.environ.get('CLUSTER_OPS_MCP_GO') != 'protected-read-only-civic-mcp' or os.environ.get('MCP_SECURITY_REVIEW_ACK') != revision): raise RuntimeError('Explicit release and source-bound security review approvals required')
if not CACHE.exists(): CACHE.mkdir(mode=0o700)
cache_stat = CACHE.lstat()
if not CACHE.is_dir() or CACHE.is_symlink() or cache_stat.st_uid != 0 or cache_stat.st_mode & 0o077:
    raise RuntimeError('Release evidence root must be root-owned mode 0700')
E = CACHE / (revision[:12]+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
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
if cmd(['git','-C',str(ROOT),'status','--porcelain','--untracked-files=all']).stdout:
    raise RuntimeError('Release checkout is not clean; use a fresh clone')
dispatcher_source=cmd(['git','-C',str(ROOT),'show',revision+':deploy/mcp/deploy.py']).stdout
if pathlib.Path(__file__).read_text()!=dispatcher_source:
    raise RuntimeError('Dispatcher is not the exact approved implementation')
package=json.loads(cmd(['git','-C',str(ROOT),'show',revision+':stadtstack-data/package.json']).stdout)
if package.get('version')!=release_version: raise RuntimeError('Approved package version differs from release version')
approved_manifest=json.loads(cmd(['git','-C',str(ROOT),'show',revision+':stadtstack-data/release/release-manifest.json']).stdout)
approved_manifest_id=approved_manifest.get('id','')
if not re.fullmatch(r'[0-9a-f]{64}',approved_manifest_id): raise RuntimeError('Approved data manifest identity missing')

def public_cohort_bytes(variable, maximum):
    value=os.environ.get(variable,'')
    path=pathlib.Path(value)
    if not value or not path.is_absolute():
        raise RuntimeError('Explicit absolute public cohort paths required')
    descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        initial=os.fstat(descriptor)
        if not S_ISREG(initial.st_mode) or initial.st_uid!=0 or initial.st_mode & 0o022 or not 0<initial.st_size<=maximum:
            raise RuntimeError('Public cohort inputs must be bounded root-owned non-writable regular files')
        with os.fdopen(descriptor,'rb',closefd=False) as handle: data=handle.read(maximum+1)
        final=os.fstat(descriptor);named=path.lstat()
        if len(data)!=initial.st_size or (initial.st_dev,initial.st_ino,initial.st_size,initial.st_mtime_ns,initial.st_ctime_ns)!=(final.st_dev,final.st_ino,final.st_size,final.st_mtime_ns,final.st_ctime_ns) or (named.st_dev,named.st_ino)!=(initial.st_dev,initial.st_ino):
            raise RuntimeError('Public cohort changed while reading')
        return data
    finally: os.close(descriptor)

cohort_artifact_sha256=os.environ.get('MCP_REVOCATION_ARTIFACT_SHA256','')
if not re.fullmatch(r'[0-9a-f]{64}',cohort_artifact_sha256):
    raise RuntimeError('Expected exact signed artifact SHA-256 required')
trust_bytes=public_cohort_bytes('MCP_REVOCATION_TRUST_FILE',65536)
artifact_bytes=public_cohort_bytes('MCP_REVOCATIONS_FILE',1048576)
cohort_trust_sha256=hashlib.sha256(trust_bytes).hexdigest()
if hashlib.sha256(artifact_bytes).hexdigest()!=cohort_artifact_sha256:
    raise RuntimeError('Signed artifact hash does not match reviewed cohort')
trust=json.loads(trust_bytes)
if trust.get('schemaVersion')!='stadtstack-revocation-trust-v1' or trust.get('releaseId')!=approved_manifest_id or trust.get('expectedArtifactSha256')!=cohort_artifact_sha256:
    raise RuntimeError('Trust cohort is not bound to approved data and signed artifact')
handoff=json.loads(cmd(['git','-C',str(ROOT),'show',revision+':stadtstack-data/reports/handoff-release-0.3.2.json']).stdout)['signer']
expected_pins={(handoff['keyId'],handoff['publicKeySpki']),(handoff['vmSigner']['keyId'],handoff['vmSigner']['publicKeySpki'])}
if {(key['keyId'],key['publicKeySpki']) for key in trust.get('keys',[])}!=expected_pins or len(trust.get('keys',[]))!=2:
    raise RuntimeError('Governed trust must contain exactly the two approved independent public pins')
cohort_dir=E/'cohort';cohort_dir.mkdir(mode=0o755)
cohort_dir.chmod(0o755)
for name,data in [('trust.json',trust_bytes),('revocations.json',artifact_bytes)]:
    path=cohort_dir/name
    with path.open('xb') as handle: handle.write(data)
    path.chmod(0o444)
(E/'cohort-identity.json').write_text(json.dumps({'dataManifestId':approved_manifest_id,'artifactSha256':cohort_artifact_sha256,'trustSha256':cohort_trust_sha256},indent=2))
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
smoke_args=[sys.executable,'-I',str(approved_smoke),'--image',image,'--release-version',release_version,'--knowledge-municipality',knowledge_municipality,'--run-id',smoke_run_id,'--scratch-dir',str(smoke_scratch),'--evidence',str(smoke_path),'--revocation-trust-file',str(cohort_dir/'trust.json'),'--revocations-file',str(cohort_dir/'revocations.json'),'--revocation-artifact-sha256',cohort_artifact_sha256,'--data-manifest-id',approved_manifest_id]
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
    or smoke.get('dataManifestId')!=approved_manifest_id
    or smoke.get('revocationArtifactSha256')!=cohort_artifact_sha256
    or smoke.get('revocationTrustSha256')!=cohort_trust_sha256
    or smoke.get('runningImageIdentityVerified') is not True or smoke_checks.get('serverVersion')!=release_version
    or smoke_checks.get('statusReleaseVersion')!=release_version or smoke_checks.get('imageVersion')!=release_version
    or smoke_checks.get('imageRefName')!=release_version or smoke_checks.get('imageRevision')!=revision
    or smoke_checks.get('gitTag')!=release_version or smoke_checks.get('gitTagRevision')!=revision
    or smoke_checks.get('imageTagDigest')!=digest or smoke_checks.get('statusDataManifestId')!=approved_manifest_id
    or smoke_checks.get('sharedDataRelease')!=approved_manifest_id
    or smoke_checks.get('revocationArtifactSha256')!=cohort_artifact_sha256
    or smoke_checks.get('revocationTrustSha256')!=cohort_trust_sha256
): raise RuntimeError('Generated exact-image runtime evidence does not match the approved release')
runtime_acceptance={'source':revision,'scriptSha256':smoke_script_sha256,'runId':smoke_run_id,'evidence':str(smoke_path),'evidenceSha256':hashlib.sha256(smoke_bytes).hexdigest(),'dataManifestId':approved_manifest_id,'revocationArtifactSha256':cohort_artifact_sha256,'revocationTrustSha256':cohort_trust_sha256}
kit=E/'kit';kit.mkdir(mode=0o700)
archive=subprocess.Popen(['git','-C',str(ROOT),'archive',revision,'deploy/mcp/chart','deploy/mcp/render.py'],stdout=subprocess.PIPE)
extract=subprocess.run(['tar','-x','-C',str(kit)],stdin=archive.stdout,capture_output=True);archive.stdout.close()
if archive.wait() or extract.returncode: raise RuntimeError('Reviewed chart/renderer export failed')
chart=kit/'deploy/mcp/chart'
renderer_path=kit/'deploy/mcp/render.py'
renderer_spec=importlib.util.spec_from_file_location('approved_mcp_renderer',renderer_path)
renderer=importlib.util.module_from_spec(renderer_spec);renderer_spec.loader.exec_module(renderer)

def render_release(token_revision='1'):
    # binaryData preserves every byte, including the canonical no-newline artifact.
    config={'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'stadtstack-mcp-revocations','namespace':NS,'annotations':{'civic-mcp.stadtstack.eu/revocation-artifact-sha256':cohort_artifact_sha256,'civic-mcp.stadtstack.eu/revocation-trust-sha256':cohort_trust_sha256}},'binaryData':{'trust.json':base64.b64encode(trust_bytes).decode('ascii'),'revocations.json':base64.b64encode(artifact_bytes).decode('ascii')}}
    render=json.dumps(config,indent=2)+'\n---\n'+renderer.render_chart(chart,release_version,digest,cohort_artifact_sha256,token_revision,trust_sha256=cohort_trust_sha256)
    (E/'rendered.yaml').write_text(render)
    return render

render_release()

def boundary():
    resources='deployments,statefulsets,daemonsets,services,ingresses,networkpolicies,pvc,certificates.cert-manager.io,clusterissuers.cert-manager.io'
    rows=json.loads(kub(['get',resources,'-A','-o','json']).stdout)['items']
    return sorted([{'kind':x['kind'],'namespace':x['metadata'].get('namespace',''),'name':x['metadata']['name'],'uid':x['metadata']['uid'],'specSha256':hashlib.sha256(json.dumps(x.get('spec'),sort_keys=True).encode()).hexdigest()} for x in rows if x['metadata'].get('namespace') != NS],key=lambda x:(x['kind'],x['namespace'],x['name']))

before=boundary();(E/'protected-before.json').write_text(json.dumps(before,indent=2))
existing=json.loads(kub(['get','namespace',NS,'-o','json']).stdout)
if existing['metadata'].get('labels',{}).get('app.kubernetes.io/part-of') != 'stadtstack-mcp':
    raise RuntimeError('Existing governed namespace required; stop')
# Validate the existing configuration with the approved server's dependency-free
# policy, before any Namespace or Secret mutation. Never rewrite identity/digests.
policy_export=subprocess.run(['git','-C',str(ROOT),'show',revision+':stadtstack-data/src/mcp-token-config.mjs'],capture_output=True,timeout=60)
if policy_export.returncode: raise RuntimeError('Cannot export approved token policy')
policy_source=policy_export.stdout
policy_path=E/'approved-mcp-token-config.mjs'
with policy_path.open('xb') as handle: handle.write(policy_source)
policy_path.chmod(0o400)
# Read only the named hash key and concurrency identity, never a whole Secret.
# A missing Secret is an operator prerequisite, not permission to create tokens.
secret_snapshot=kub(['-n',NS,'get','secret','civic-mcp-token-hashes','-o=jsonpath={.metadata.uid}{"\\n"}{.metadata.resourceVersion}{"\\n"}{.data.token-hashes\\.json}{"\\n"}'],check=False)
if secret_snapshot.returncode:
    raise RuntimeError('Existing governed auth Secret is required for a limit-only rollout; named hash-key read failed (output withheld)')
snapshot_fields=secret_snapshot.stdout.splitlines()
if len(snapshot_fields)!=3 or not all(snapshot_fields): raise RuntimeError('Existing auth Secret identity and token-hashes.json key are required')
secret_uid,secret_resource_version,current_hash_base64=snapshot_fields
try:
    current_hash_configuration=base64.b64decode(current_hash_base64,validate=True).decode('utf8')
except (ValueError,UnicodeError):
    raise RuntimeError('Existing auth Secret hash configuration is malformed') from None
# Change only explicit policy, using the existing cluster identity/digest records.
hash_configuration=json.dumps([{**record,'limits':{'requestsPerMinute':300,'maxConcurrent':8} if record.get('id') in ('max','buzz') else {'requestsPerMinute':60,'maxConcurrent':4}} for record in json.loads(current_hash_configuration)])
profile_check=r"""
import { pathToFileURL } from 'node:url';
const { validateTokenRecords, DEFAULT_TOKEN_LIMITS, MAX_TOKEN_LIMITS } = await import(pathToFileURL(process.argv[1]).href);
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const supplied = JSON.parse(input);
  const current = validateTokenRecords(JSON.parse(supplied.current));
  const records = validateTokenRecords(JSON.parse(supplied.desired));
  const existing = new Map(current.map(({id, sha256}) => [id, sha256]));
  if (existing.size !== records.length || records.some(({id, sha256}) => existing.get(id) !== sha256)) throw new Error();
  const elevated = new Set(['max', 'buzz']);
  for (const record of records) {
    const expected = elevated.has(record.id) ? MAX_TOKEN_LIMITS : DEFAULT_TOKEN_LIMITS;
    const actual = record.limits ?? DEFAULT_TOKEN_LIMITS;
    if ((elevated.has(record.id) && !record.limits) ||
        actual.requestsPerMinute !== expected.requestsPerMinute ||
        actual.maxConcurrent !== expected.maxConcurrent) throw new Error();
    elevated.delete(record.id);
  }
  if (elevated.size) throw new Error();
  process.stdout.write(JSON.stringify(records.map(({id, limits}) => ({id, limits: limits ?? DEFAULT_TOKEN_LIMITS, explicit: limits !== undefined}))));
} catch {
  process.stderr.write('Invalid token policy or changed existing credential identities/digests\n');
  process.exitCode = 1;
}
"""
profiles=json.loads(cmd(['node','--input-type=module','--eval',profile_check,str(policy_path)],json.dumps({'current':current_hash_configuration,'desired':hash_configuration})).stdout)
records=json.loads(hash_configuration)
token_revision=hashlib.sha256(json.dumps(records,sort_keys=True).encode()).hexdigest()[:16]
token_policy={'source':revision,'validatorSha256':hashlib.sha256(policy_source).hexdigest(),'profiles':profiles,'identityDigestsPreserved':True,'secretUid':secret_uid,'activation':'startup load through tokenSecretRevision rollout; no hot reload','tokenSecretRevision':token_revision}
(E/'token-profiles.json').write_text(json.dumps(token_policy,indent=2))
render_release(token_revision)
(E/'server-dry-run.txt').write_text(kub(['apply','--dry-run=server','-f',str(E/'rendered.yaml')]).stdout)
diff=kub(['diff','-f',str(E/'rendered.yaml')],check=False)
if diff.returncode not in (0,1): raise RuntimeError('Manifest diff failed; output withheld')
(E/'diff.txt').write_text(diff.stdout)
if mode == '--diff-only':
    print('Read-only render and exact-image acceptance complete: '+str(E));raise SystemExit(0)
phrase='release-mcp-'+revision[:12]
if input('Type '+phrase+' to deploy the protected civic MCP: ').strip()!=phrase: raise RuntimeError('Approval not supplied')
# Atomically test the observed identity/version before replacing only the named
# hash key. Conflict or deletion fails closed; never create a missing auth Secret.
# Payload stays on stdin, never command arguments, logs or evidence artifacts.
secret_patch=[
    {'op':'test','path':'/metadata/uid','value':secret_uid},
    {'op':'test','path':'/metadata/resourceVersion','value':secret_resource_version},
    {'op':'replace','path':'/data/token-hashes.json','value':base64.b64encode(json.dumps(records).encode()).decode('ascii')},
]
kub(['-n',NS,'patch','secret','civic-mcp-token-hashes','--type=json','--patch-file=/dev/stdin'],json.dumps(secret_patch))
(E/'applied.txt').write_text(kub(['apply','-f',str(E/'rendered.yaml')]).stdout)
(E/'rollout.txt').write_text(kub(['-n',NS,'rollout','status','deployment/civic-mcp','--timeout=120s']).stdout)
after=boundary();(E/'protected-after.json').write_text(json.dumps(after,indent=2))
if before!=after: raise RuntimeError('Protected non-MCP resources changed; inspect evidence')
pods=json.loads(kub(['-n',NS,'get','pods','-l','app.kubernetes.io/name=civic-mcp','-o','json']).stdout)['items']
summary=[{'name':p['metadata']['name'],'version':p['metadata'].get('labels',{}).get('app.kubernetes.io/version'),'phase':p.get('status',{}).get('phase'),'images':[c['image'] for c in p['spec']['containers']],'containers':[{'name':c['name'],'ready':c.get('ready'),'imageID':c.get('imageID')} for c in p.get('status',{}).get('containerStatuses',[])]} for p in pods]
(E/'pods.json').write_text(json.dumps(summary,indent=2))
if len(summary)!=1 or summary[0]['images']!=[image] or summary[0]['version']!=release_version or not summary[0]['containers'] or not all(c['ready'] and c['imageID'] for c in summary[0]['containers']): raise RuntimeError('Exact versioned deployment not Ready')
(E/'result.json').write_text(json.dumps({'source':revision,'version':release_version,'gitTag':release_version,'imageTag':release_version,'imageTagReference':image_tag,'image':image,'imageIdentityScope':'approved desired reference; observed ReadyPod imageIDs are recorded separately in pods.json','runtimeAcceptance':runtime_acceptance,'tokenPolicy':token_policy,'namespace':NS,'protectedBoundaryUnchanged':True,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2))
print('Civic MCP Ready; public HTTPS acceptance remains required. Evidence: '+str(E))
