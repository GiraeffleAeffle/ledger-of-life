#!/usr/bin/env python3
"""Exact-image or public HTTPS acceptance. Outputs evidence, never bearer values."""
import argparse, base64, datetime, hashlib, json, os, pathlib, re, secrets, subprocess, tempfile, time, urllib.error, urllib.request
from stat import S_ISDIR, S_ISREG

if not __debug__:
    raise RuntimeError('Acceptance requires Python assertions enabled')

p=argparse.ArgumentParser()
p.add_argument('--image',required=True)
p.add_argument('--release-version',required=True,help='Literal package/Git/image version, for example 0.3.1')
p.add_argument('--evidence',required=True)
p.add_argument('--url',help='Use the live HTTPS origin instead of starting Docker')
p.add_argument('--person',default='max')
p.add_argument('--knowledge-municipality',default='ratzeburg',help='Municipality with a released normalized knowledge record for comparison/similarity acceptance')
p.add_argument('--entity-query',help='Optional source-grounded entity name/identifier; otherwise use a released knowledge mention, then the selected municipality slug')
p.add_argument('--run-id',help='Governed invocation nonce; otherwise generated locally')
p.add_argument('--scratch-dir',help='Private wrapper-owned temporary directory for disposable hash-only material')
p.add_argument('--revocation-trust-file',help='Frozen public cohort trust.json, required for 0.3.2 and later')
p.add_argument('--revocations-file',help='Frozen public cohort revocations.json, required for 0.3.2 and later')
p.add_argument('--revocation-artifact-sha256',help='SHA256 of the exact complete signed artifact bytes')
p.add_argument('--data-manifest-id',help='Exact sealed serving data manifest SHA256')
args=p.parse_args()
version_pattern=r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
if not re.fullmatch(version_pattern,args.release_version): p.error('Literal stable numeric release version required, without a prefix')
image_match=re.fullmatch(r'ghcr\.io/giraeffleaeffle/stadtstack-mcp:'+re.escape(args.release_version)+r'@(sha256:[0-9a-f]{64})',args.image)
if image_match is None: p.error('Exact published image must include the matching literal version tag and immutable digest')
image_digest=image_match.group(1)
image_tag=args.image.split('@',1)[0]
if not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}',args.person): p.error('Invalid person')
if not re.fullmatch(r'[a-z0-9-]{1,80}',args.knowledge_municipality): p.error('Invalid knowledge municipality')
if args.entity_query is not None and not 1<=len(args.entity_query.strip())<=200: p.error('Entity query must contain 1 to 200 nonblank characters')
if args.url and args.url!='https://mcp.stadtstack.eu': p.error('Live origin must be https://mcp.stadtstack.eu')
acceptance_run_id=secrets.token_hex(16) if args.run_id is None else args.run_id
if not re.fullmatch(r'[0-9a-f]{32}',acceptance_run_id): p.error('Run ID must be 32 lowercase hexadecimal characters')

def revocation_cohort(trust_file,artifact_file,artifact_sha256,manifest_id):
    """Validate the frozen public mount; signature/target verification is server-owned."""
    if not all(isinstance(value,str) and value==value.strip() and '\0' not in value for value in (trust_file,artifact_file,artifact_sha256,manifest_id)):
        raise ValueError('Invalid public revocation cohort arguments')
    if not all(re.fullmatch(r'[0-9a-f]{64}',value) for value in (artifact_sha256,manifest_id)):
        raise ValueError('Exact artifact SHA256 and data manifest identity required')
    trust_path,artifact_path=pathlib.Path(trust_file),pathlib.Path(artifact_file)
    if not trust_path.is_absolute() or not artifact_path.is_absolute() or '..' in trust_path.parts or '..' in artifact_path.parts or trust_path.name!='trust.json' or artifact_path.name!='revocations.json' or trust_path.parent!=artifact_path.parent:
        raise ValueError('Public cohort must be trust.json and revocations.json in one absolute directory')
    cohort_dir=trust_path.parent
    for directory in (*reversed(cohort_dir.parents),cohort_dir):
        metadata=directory.lstat()
        sticky_ancestor=directory!=cohort_dir and bool(metadata.st_mode & 0o1000)
        if not S_ISDIR(metadata.st_mode) or metadata.st_uid!=0 or metadata.st_mode & 0o022 and not sticky_ancestor or directory==cohort_dir and not metadata.st_mode & 0o001:
            raise ValueError('Public cohort directory chain must be root-owned, non-writable by others and container-accessible')
    if {entry.name for entry in cohort_dir.iterdir()}!={'trust.json','revocations.json'}:
        raise ValueError('Public cohort directory must contain only trust.json and revocations.json')
    def public_bytes(path,bound):
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            initial=os.fstat(fd)
            if not S_ISREG(initial.st_mode) or initial.st_uid!=0 or initial.st_mode & 0o222 or not initial.st_mode & 0o004 or not 0<initial.st_size<=bound:
                raise ValueError('Public cohort files must be bounded root-owned non-writable container-readable regular files')
            with os.fdopen(fd,'rb',closefd=False) as stream:
                value=stream.read(bound+1)
            final=os.fstat(fd);named=path.lstat()
            identity=lambda metadata:(metadata.st_dev,metadata.st_ino,metadata.st_size,metadata.st_mtime_ns,metadata.st_ctime_ns,metadata.st_mode,metadata.st_uid)
            if len(value)!=initial.st_size or identity(initial)!=identity(final) or identity(initial)!=identity(named):
                raise ValueError('Public cohort changed while being read')
            return value
        finally:
            os.close(fd)
    trust_bytes=public_bytes(trust_path,64*1024)
    artifact_bytes=public_bytes(artifact_path,1024*1024)
    trust=json.loads(trust_bytes.decode('utf-8'));artifact=json.loads(artifact_bytes.decode('utf-8'))
    if not isinstance(trust,dict) or set(trust)!={'schemaVersion','releaseId','expectedArtifactSha256','keys'} or trust['schemaVersion']!='stadtstack-revocation-trust-v1' or trust['releaseId']!=manifest_id or trust['expectedArtifactSha256']!=artifact_sha256:
        raise ValueError('Public trust cohort does not match approved artifact and data release')
    if hashlib.sha256(artifact_bytes).hexdigest()!=artifact_sha256:
        raise ValueError('Signed revocation artifact SHA256 mismatch')
    if not isinstance(trust['keys'],list) or not 1<=len(trust['keys'])<=16:
        raise ValueError('Public trust cohort requires public verification keys')
    key_ids=set()
    for key in trust['keys']:
        if not isinstance(key,dict) or set(key)!={'keyId','publicKeySpki'}:
            raise ValueError('Public trust cohort contains non-public key fields')
        public_key=base64.b64decode(key['publicKeySpki'],validate=True)
        if len(public_key)!=44 or not public_key.startswith(bytes.fromhex('302a300506032b6570032100')) or base64.b64encode(public_key).decode()!=key['publicKeySpki'] or key['keyId']!='ed25519:'+hashlib.sha256(public_key).hexdigest() or key['keyId'] in key_ids:
            raise ValueError('Public trust key identity is invalid')
        key_ids.add(key['keyId'])
    if not isinstance(artifact,dict) or not isinstance(artifact.get('payload'),dict) or artifact['payload'].get('releaseId')!=manifest_id or artifact.get('keyId') not in key_ids:
        raise ValueError('Signed artifact release/key does not match public trust cohort')
    # Canonical schema, signature and target ordering are checked by image startup,
    # using the shared implementation, never a second Python signature verifier.
    return {'directory':str(cohort_dir),'revocationArtifactSha256':artifact_sha256,'revocationTrustSha256':hashlib.sha256(trust_bytes).hexdigest(),'payload':artifact['payload']}

cohort_values=(args.revocation_trust_file,args.revocations_file,args.revocation_artifact_sha256,args.data_manifest_id)
if any(value is not None for value in cohort_values) and not all(value is not None for value in cohort_values):
    p.error('Revocation trust/artifact files, artifact SHA256 and data manifest ID must be supplied together')
if tuple(map(int,args.release_version.split('.'))) >= (0,3,2) and not all(value is not None for value in cohort_values):
    p.error('0.3.2 and later require --revocation-trust-file --revocations-file --revocation-artifact-sha256 --data-manifest-id')
try:
    cohort=revocation_cohort(*cohort_values) if all(value is not None for value in cohort_values) else None
except (ValueError,TypeError,OSError,KeyError) as error:
    p.error('Invalid frozen public revocation cohort: '+str(error))
scratch_dir=pathlib.Path(args.scratch_dir) if args.scratch_dir is not None else pathlib.Path.home()
if args.scratch_dir is not None:
    scratch_stat=scratch_dir.lstat()
    if not scratch_dir.is_absolute() or scratch_dir.is_symlink() or not scratch_dir.is_dir() or scratch_stat.st_uid!=os.getuid() or scratch_stat.st_mode & 0o077:
        p.error('Scratch directory must be private, owned and absolute')
private=pathlib.Path.home()/'.config/stadtstack/mcp-tokens'
# Never give an image under test a real operator credential. Local smoke tokens
# live only in memory and are never accepted by the deployed Secret.
token=(private/(args.person+'.token')).read_text().strip() if args.url else secrets.token_urlsafe(32)
if not re.fullmatch(r'[A-Za-z0-9_-]{43}',token): raise RuntimeError('Invalid private token file')
default_limits={'requestsPerMinute':60,'maxConcurrent':4}
elevated_limits={'requestsPerMinute':300,'maxConcurrent':8}
disposable_tokens={name:secrets.token_urlsafe(32) for name in ('max','buzz','isolated','activation')} if not args.url else {}
container=None
# Home is shared by desktop Docker/Colima; macOS system temp folders may not be.
hash_mount=tempfile.TemporaryDirectory(prefix='.mcp-smoke-hashes-',dir=scratch_dir)
checks={}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener=urllib.request.build_opener(NoRedirect())

def command(argv):
    result=subprocess.run(argv,capture_output=True,text=True)
    if result.returncode: raise RuntimeError('Container operation failed (output withheld)')
    return result.stdout.strip()

def request(path='/mcp',data=None,auth=True,extra=None,method=None,bearer=None,limits=None):
    headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
    if auth: headers['Authorization']='Bearer '+(token if bearer is None else bearer)
    if extra: headers.update(extra)
    body=data.encode() if isinstance(data,str) else json.dumps(data).encode() if data is not None else None
    req=urllib.request.Request(origin+path,data=body,headers=headers,method=method)
    try:
        with opener.open(req,timeout=35) as response:
            return response.status,json.loads(response.read() or b'null')
    except urllib.error.HTTPError as error:
        if error.code==429:
            retry_after=error.headers.get('Retry-After','')
            assert retry_after.isdecimal() and 1<=int(retry_after)<=60, 'Invalid rate-limit Retry-After'
            guidance=json.loads(error.read())
            actual=guidance.get('limits',{})
            assert set(actual)=={'requestsPerMinute','maxConcurrent'}
            assert type(actual['requestsPerMinute']) is int and 1<=actual['requestsPerMinute']<=300
            assert type(actual['maxConcurrent']) is int and 1<=actual['maxConcurrent']<=8
            if limits is not None: assert actual==limits, '429 does not report the authenticated token policy'
            assert guidance=={'ok':False,'error':'rate_limited','retryAfterSeconds':int(retry_after),'limits':actual}, 'Rate-limit JSON/header guidance differs'
            checks['retryAfterSeconds']=int(retry_after)
            return error.code,guidance
        return error.code,None

def call(name,arguments={}):
    status,result=request(data={'jsonrpc':'2.0','id':7,'method':'tools/call','params':{'name':name,'arguments':arguments}})
    assert status==200 and 'result' in result and not result['result'].get('isError'), 'Tool acceptance failed: '+name
    value=result['result']['structuredContent']
    assert value['source']['release'] and value['releasedAt'] and value['respondedAt'] and value['status'] in ('candidate','auto-verified')
    assert 'date' not in value and 'sources' not in value, 'Obsolete envelope date/source aliases remain'
    assert value['source']['release']==checks.setdefault('envelopeRelease',value['source']['release'])
    assert value['releasedAt']==checks.setdefault('releasedAt',value['releasedAt'])
    assert datetime.datetime.fromisoformat(value['releasedAt'].replace('Z','+00:00')).tzinfo is not None
    assert datetime.datetime.fromisoformat(value['respondedAt'].replace('Z','+00:00')).tzinfo is not None
    # Response time may advance between calls; it is not a release/event date.
    checks.setdefault('firstRespondedAt',value['respondedAt'])
    if cohort is not None:
        administrative_view(value['data'].get('administrativeView'))
    checks['lastRespondedAt']=value['respondedAt']
    return value['data']

def administrative_view(view):
    assert isinstance(view,dict) and view['kind']=='signed_administrative_revocation'
    assert view['releaseId']==args.data_manifest_id==checks['envelopeRelease']
    assert view['revocationsSha256']==cohort['revocationArtifactSha256']
    identity=json.dumps(['stadtstack-mcp-read-view-v1',args.data_manifest_id,cohort['revocationArtifactSha256']],separators=(',',':'))
    assert view['viewId']==hashlib.sha256(identity.encode()).hexdigest()
    assert view['sequence']==cohort['payload']['sequence'] and view['issuedAt']==cohort['payload']['issuedAt']
    assert isinstance(view['meaning'],str) and view['meaning'].strip()
    assert view==checks.setdefault('administrativeView',view), 'Administrative view changed during acceptance'

GRAPH_RELATION_TYPES=('operates','funds','implements','plans','decides','approves','amends','located_in','cooperates_with','member_of','cites')
GRAPH_MODALITIES=('asserted','planned','decided','implemented','proposed','conditional','negated','historical')
PATH_MODALITY_BY_TYPE={
    'operates':'asserted','funds':'asserted','amends':'asserted','located_in':'asserted','cooperates_with':'asserted','member_of':'asserted','cites':'asserted',
    'decides':'decided','approves':'decided','implements':'implemented',
}

def graph_path_eligible(edge):
    # Plans are deliberately absent. A decision/approval is never execution.
    required=PATH_MODALITY_BY_TYPE.get(edge['type'])
    return required is not None and edge['modality']==required

def graph_path_policy(policy):
    assert policy['eligibleModalities']==['asserted','decided','implemented']
    assert policy['excludedModalities']==['planned','proposed','conditional','negated','historical']
    assert set(policy['rules'])=={'asserted','decided','implemented'}
    assert all(isinstance(rule,str) and rule.strip() for rule in policy['rules'].values())
    assert isinstance(policy['note'],str) and policy['note'].strip()

def graph_page(value,kind,records_sha):
    assert value['releaseId']==checks['envelopeRelease'] and value['recordsSha256']==records_sha
    if cohort is not None: administrative_view(value['administrativeView'])
    assert isinstance(value['items'],list) and len(value['items'])<=20
    assert isinstance(value['truncated'],bool) and isinstance(value['complete'],bool) and value['complete']==(not value['truncated'])
    assert value['scope'] and (value['nextCursor'] is None or isinstance(value['nextCursor'],str) and value['nextCursor'])
    lower_bound=value['pathsLowerBound'] if kind=='path' else value['matchedLowerBound']
    assert type(lower_bound) is int and lower_bound>=len(value['items'])
    if value['truncated']:
        assert value['total'] is None, 'Incomplete graph search must not claim an exact total'
    else:
        assert type(value['total']) is int and value['total']==lower_bound
    empty_status='not_found_within_hops' if kind=='path' else 'not_found'
    assert value['status']==('found' if lower_bound else 'incomplete' if value['truncated'] else empty_status)
    budget_limits={'searchNodes':10000,'visitedNodes':2000,'examinedEdges':10000,'paths':100,'pathSteps':20000}
    assert all(type(value['budgets'][key]) is int and 1<=value['budgets'][key]<=maximum for key,maximum in budget_limits.items())
    for field,budget in [('examinedNodes','searchNodes'),('visitedNodes','visitedNodes'),('examinedEdges','examinedEdges'),('pathSteps','pathSteps')]:
        if field in value: assert type(value[field]) is int and 0<=value[field]<=value['budgets'][budget]

def graph_evidence(value):
    assert value['recordId'] and value['municipalityId'] and value['chunk']
    for field in ['evidenceHash','textSha256']:
        assert re.fullmatch(r'[0-9a-f]{64}',value[field])
    source=value['source']
    assert source['id'] and source['url'].startswith(('https://','http://')) and source['retrievedAt'] and source['locator']
    assert re.fullmatch(r'[0-9a-f]{64}',source['sha256'])
    if 'relationNormalization' in value:
        normalization=value['relationNormalization']
        assert normalization['version']=='relation-actions-v1'
        for field in ['sourceSha256','textSha256','responseSha256']:
            assert re.fullmatch(r'[0-9a-f]{64}',normalization[field])
        assert normalization['textSha256']==value['textSha256']
        mappings=normalization['mappings']
        assert isinstance(mappings,list) and 1<=len(mappings)<=60
        assert len({mapping['index'] for mapping in mappings})==len(mappings)
        rules={'plans':'explicit-planning','decides':'explicit-decision','approves':'explicit-approval','implements':'explicit-implementation'}
        for mapping in mappings:
            assert type(mapping['index']) is int and 0<=mapping['index']<60
            assert mapping['originalType'] in GRAPH_RELATION_TYPES and mapping['type'] in GRAPH_RELATION_TYPES
            assert mapping['originalModality'] in GRAPH_MODALITIES and mapping['modality'] in GRAPH_MODALITIES
            assert mapping['type'] in rules and mapping['rule']==rules[mapping['type']]
            assert re.fullmatch(r'[0-9a-f]{64}',mapping['quoteSha256']) and re.fullmatch(r'[0-9a-f]{64}',mapping['predicateQuoteSha256'])

def graph_edge(edge):
    assert re.fullmatch(r'edge:[0-9a-f]{64}',edge['id'])
    assert all(re.fullmatch(r'entity:[0-9a-f]{64}',edge[field]) for field in ['fromId','toId'])
    assert edge['type'] in GRAPH_RELATION_TYPES
    assert edge['quote'] and edge['predicateQuote'] and edge['predicateQuote'] in edge['quote']
    assert edge['modality'] in GRAPH_MODALITIES
    assert 'time' in edge and 'conditions' in edge
    if edge['time'] is not None: assert edge['time']['text'] and edge['time']['quote']
    graph_evidence(edge['evidence'])
def ready():
    for _ in range(30):
        try:
            if request('/health',auth=False)[0]==200: return
        except (urllib.error.URLError,TimeoutError,ConnectionError): pass
        time.sleep(1)
    raise RuntimeError('Health did not become ready within 30 seconds')

def disposable_configuration(elevated=False):
    records=[{'id':'smoke','sha256':hashlib.sha256(token.encode()).hexdigest()}]
    for name,value in disposable_tokens.items():
        record={'id':name,'sha256':hashlib.sha256(value.encode()).hexdigest()}
        if elevated and name in ('max','buzz'): record['limits']=elevated_limits
        if elevated and name=='activation': record['limits']={'requestsPerMinute':2,'maxConcurrent':1}
        records.append(record)
    if hashfile.exists(): hashfile.chmod(0o600)
    hashfile.write_text(json.dumps(records));hashfile.chmod(0o444)

def probe_policy(name,limits,require_saturation):
    # Every authenticated HTTP/RPC attempt counts, including malformed requests.
    # A fixed-minute boundary may occur during the probe. Allow two budgets and
    # report aggregate attempts, never claim an exact-window transport test.
    started=time.monotonic()
    accepted=0
    observed=None
    for index in range(2*limits['requestsPerMinute']+1):
        if time.monotonic()-started>=50: break
        payload=None if index%3==0 else '{' if index%3==1 else {'jsonrpc':'2.0','id':index+1,'method':'ping'}
        status,value=request(data=payload,bearer=disposable_tokens[name],limits=limits)
        if status==429:
            observed=value
            break
        assert status==(405 if index%3==0 else 400 if index%3==1 else 200)
        accepted+=1
    elapsed=time.monotonic()-started
    if require_saturation:
        assert observed is not None, 'Default policy saturation was not observed within the bounded probe'
    else:
        assert accepted>60, 'Too few representative requests to exercise elevation'
        if observed is None:
            assert elapsed>=50, 'Two configured minute budgets completed without rate limiting'
    return {'id':name,'configuredLimits':limits,'reportedLimits':observed['limits'] if observed else None,'acceptedAuthenticatedRequests':accepted,'elapsedSeconds':round(elapsed,3),'saturationExercised':observed is not None,'retryAfterSeconds':observed['retryAfterSeconds'] if observed else None,'scope':'disposable local credentials; aggregate wall-clock attempts, exact windows/concurrency require transport tests'}

try:
    if args.url:
        origin=args.url
    else:
        tag_description=command(['docker','buildx','imagetools','inspect',image_tag])
        tag_digests=set(re.findall(r'^Digest:\s*(sha256:[0-9a-f]{64})\s*$',tag_description,re.MULTILINE))
        assert tag_digests=={image_digest}, 'Published image version tag does not point to the selected immutable digest'
        checks['imageTagDigest']=image_digest
        command(['docker','pull','--platform','linux/amd64',args.image])
        # Only hashes are copied; parent directory remains 0700 on the host.
        hashfile=pathlib.Path(hash_mount.name)/'token-hashes.json'
        disposable_configuration()
        cohort_options=[]
        if cohort is not None:
            assert revocation_cohort(*cohort_values)==cohort, 'Frozen public cohort changed before image startup'
            cohort_options=['--mount','type=bind,source='+cohort['directory']+',target=/run/config/mcp-revocations,readonly','--env','STADTSTACK_MCP_RELEASE_DIR=/app/release','--env','STADTSTACK_MCP_REVOCATION_TRUST_FILE=/run/config/mcp-revocations/trust.json','--env','STADTSTACK_MCP_REVOCATIONS_FILE=/run/config/mcp-revocations/revocations.json']
        container=command(['docker','run','--detach','--name','civic-mcp-smoke-'+acceptance_run_id,'--platform','linux/amd64','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','1g','--cpus','1','--publish','127.0.0.1::4318','--mount','type=bind,source='+str(hashfile)+',target=/run/secrets/mcp/token-hashes.json,readonly',*cohort_options,args.image])
        port=command(['docker','port',container,'4318/tcp']).split(':')[-1]
        origin='http://127.0.0.1:'+port
        details=json.loads(command(['docker','inspect',container]))[0]
        assert details['Config']['Image']==args.image and details['Config']['User']=='1000:1000'
        assert details['HostConfig']['ReadonlyRootfs'] and details['HostConfig']['CapDrop']==['ALL']
        if cohort is not None:
            mount=next(mount for mount in details['Mounts'] if mount['Destination']=='/run/config/mcp-revocations')
            assert mount['Type']=='bind' and mount['Source']==cohort['directory'] and mount['RW'] is False
            assert set(cohort_options[3::2])<=set(details['Config']['Env'])
            checks['readOnlyRevocationCohort']=True
        labels=details['Config'].get('Labels') or {}
        assert labels.get('org.opencontainers.image.version')==args.release_version, 'Image OCI version differs from the release tag'
        assert labels.get('org.opencontainers.image.ref.name')==args.release_version, 'Image OCI tag identity differs from the release tag'
        image_revision=labels.get('org.opencontainers.image.revision','')
        assert re.fullmatch(r'[0-9a-f]{40}',image_revision), 'Image lacks an exact source revision'
        tag_object=json.loads(command(['gh','api','repos/GiraeffleAeffle/ledger-of-life/git/ref/tags/'+args.release_version]))['object']
        for _ in range(8):
            if tag_object.get('type')=='commit': break
            assert tag_object.get('type')=='tag', 'Release tag must resolve to a commit'
            tag_object=json.loads(command(['gh','api','repos/GiraeffleAeffle/ledger-of-life/git/tags/'+tag_object['sha']]))['object']
        assert tag_object.get('type')=='commit' and tag_object.get('sha')==image_revision, 'Actual Git tag and image source revision differ'
        checks['gitTag']=args.release_version
        checks['gitTagRevision']=tag_object['sha']
        checks['imageVersion']=labels['org.opencontainers.image.version']
        checks['imageRefName']=labels['org.opencontainers.image.ref.name']
        checks['imageRevision']=image_revision
        checks['nonrootReadOnlyExactImage']=True
    ready()
    checks['health']=True
    assert request(auth=False)[0]==401
    assert request(extra={'Authorization':'Bearer '+'x'*43})[0]==401
    assert request(path='/mcp?token=not-a-token',auth=False)[0]==404
    assert request(extra={'Origin':'https://untrusted.invalid'})[0]==403
    assert request()[0]==405
    checks['authAndOriginAndExactRoute']=True
    status,initial=request(data={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'stadtstack-smoke','version':'1'}}})
    assert status==200 and initial['result']['serverInfo']['name']=='stadtstack-data'
    assert initial['result']['serverInfo']['version']==args.release_version, 'initialize server version differs from the image/Git tag'
    checks['serverVersion']=initial['result']['serverInfo']['version']
    status,listing=request(data={'jsonrpc':'2.0','id':2,'method':'tools/list'})
    assert status==200
    tools=listing['result']['tools'];names=[t['name'] for t in tools]
    expected=['list_cities','list_topics','get_core_bundle','search_signals','search_signals_near','search_signals_along','get_signal','get_sources','get_source','get_changes','search_topics','get_council_items','get_regional_topics','get_release_status','compare_topic','similar','entity_search','graph_neighbors','graph_path','export_records']
    assert sorted(names)==sorted(expected)
    assert all(t['annotations']['readOnlyHint'] and not t['annotations']['destructiveHint'] for t in tools)
    checks['readOnlyTools']=names
    core=call('get_core_bundle')
    filtered=cohort is not None and bool(cohort['payload']['targets'])
    assert (len(core['bundle']['facts'])<=3 if filtered else len(core['bundle']['facts'])==3)
    assert all(f['verification']['status']=='auto-verified' and f['source']['url'] and f['source']['documentDate'] and 'date' not in f for f in core['bundle']['facts'])
    if filtered:
        assert 'version' not in core['bundle'] and 'manifest' not in core
        checks['sharedCoreBundleVersion']=core['sealedIdentity']['coreBundleVersion']
        visible=call('search_topics',{'limit':1,'fields':['id']})
        assert visible['items'], 'The configured administrative view has no visible record for lookup acceptance'
        fact=call('get_signal',{'id':visible['items'][0]['id']})
        assert fact['sourceIds'] and fact['asOf']
    else:
        checks['sharedCoreBundleVersion']=core['bundle']['version']
        fact=call('get_signal',{'id':'lake:straussee-level-2026-09-14'})
        assert fact['verification']['status']=='auto-verified' and fact['sourceIds'] and fact['eventDate']=='2026-09-14' and fact['asOf']
    assert not {'source','sources','date','properties'}.intersection(fact), 'Obsolete full-record aliases remain'
    attribution=call('get_sources',{'id':fact['id']})
    assert attribution['sources'] and attribution['sourceIds']==fact['sourceIds'] and 'source' not in attribution
    source=call('get_source',{'sourceId':fact['sourceIds'][0]})
    assert source['id']==fact['sourceIds'][0] and (source['url'] or source.get('urlWithheldReason')) and (source.get('retrievedAt') or source.get('retrievalNote'))
    assert source in attribution['sources']
    topics=call('list_topics')['topics']
    assert topics
    assert call('search_topics',{'limit':5} if filtered else {'query':'Straussee','limit':5})['items']
    assert call('get_council_items',{'limit':1})['items']
    regional=call('get_regional_topics',{'sourceTypes':['councilAgenda'],'limit':50,'fields':['id','cityId','sourceIds','eventDate','comparisonEligible']})
    eligible=next(item for item in regional['items'] if item['comparisonEligible'])
    regional_search=call('search_signals',{'cityId':eligible['cityId'],'query':eligible['id'],'fields':['id','origin'],'limit':5})
    assert any(item['id']==eligible['id'] and item['origin']=='regional' for item in regional_search['items'])
    projection={'limit':1,'fields':['id','cityId','sourceIds']}
    first=call('search_topics',projection)
    assert first['total']>1 and first['nextCursor'] and set(first['items'][0])==set(projection['fields'])
    following=call('search_topics',{**projection,'cursor':first['nextCursor']})
    assert following['total']==first['total'] and following['items']
    assert (following['items'][0]['cityId'],following['items'][0]['id'])!=(first['items'][0]['cityId'],first['items'][0]['id'])
    status,rejected=request(data={'jsonrpc':'2.0','id':8,'method':'tools/call','params':{'name':'search_topics','arguments':{**projection,'limit':2,'cursor':first['nextCursor']}}})
    assert status==200 and rejected['result'].get('isError'), 'Cursor was accepted with changed query filters'
    release=call('get_release_status')
    assert release['release']['version']==args.release_version==checks['serverVersion'], 'Status and initialized server versions must equal the literal release tag'
    assert release['release']['dataManifestId']==checks['envelopeRelease'], 'Status release points to a different data manifest'
    if cohort is not None:
        assert release['release']['dataManifestId']==args.data_manifest_id, 'Serving manifest differs from approved sealed data'
    if filtered:
        assert 'dataManifest' not in release and 'manifest' not in release
        assert release['sealedIdentity']==core['sealedIdentity']
        assert release['sealedIdentity']['dataManifestId']==args.data_manifest_id
        assert re.fullmatch(r'[0-9a-f]{64}',release['sealedIdentity']['coreBundleSha256'])
    else:
        assert release['manifest']['bundleVersion']==core['bundle']['version'] and release['dataManifest']['id']==checks['envelopeRelease']
    checks['statusReleaseVersion']=release['release']['version']
    checks['statusDataManifestId']=release['release']['dataManifestId']
    coverage=release['knowledgeCoverage']
    if filtered:
        assert set(coverage)=={'scope','administrativeView','municipalities'} and coverage['scope']
        administrative_view(coverage['administrativeView'])
        assert all(set(row)=={'id','publishedRecords','datedStagedRecords'} and row['id'] and type(row['publishedRecords']) is int and type(row['datedStagedRecords']) is int and 0<=row['datedStagedRecords']<=row['publishedRecords'] for row in coverage['municipalities'])
        checks['visibleCoverage']={'municipalities':len(coverage['municipalities']),'publishedRecords':sum(row['publishedRecords'] for row in coverage['municipalities']),'scope':coverage['scope']}
    else:
        accounting=coverage['accounting']
        for field in ('registryMunicipalities','configuredMunicipalities','checkedMunicipalities','attemptedMunicipalities','publishedMunicipalities','checkedWithoutPublishedMunicipalities','unvisitedMunicipalities'):
            assert type(accounting[field]) is int and accounting[field]>=0
        for field in ('runSelectedMunicipalities','preparedMunicipalities'):
            assert accounting[field] is None or type(accounting[field]) is int and 0<=accounting[field]<=accounting['configuredMunicipalities']
        assert accounting['registryMunicipalities']>=accounting['configuredMunicipalities']>=accounting['checkedMunicipalities']>=accounting['publishedMunicipalities']
        assert accounting['checkedMunicipalities']+accounting['unvisitedMunicipalities']==accounting['registryMunicipalities']
        assert accounting['publishedMunicipalities']+accounting['checkedWithoutPublishedMunicipalities']==accounting['checkedMunicipalities']
        assert len(coverage['municipalities'])==accounting['configuredMunicipalities']
        assert sum(row['municipalitiesRegistered'] for row in coverage['districts'])==accounting['registryMunicipalities']
        assert sum(row['municipalitiesAttempted'] for row in coverage['districts'])==accounting['attemptedMunicipalities']
        for row in coverage['municipalities']:
            assert type(row['checked']) is bool and row['status']==('gated_records' if row['publishedRecords'] else 'checked_no_gated_records' if row['checked'] else 'not_checked')
            assert 0<=row['datedStagedRecords']<=row['publishedRecords'] and row['quarantinedRecords']>=0
            for field,key in (('categories','reason'),('failedDeterministicChecks','id')):
                assert all(item[key] and type(item['count']) is int and 0<item['count']<=row['quarantinedRecords'] for item in row['quarantineReasons'][field])
        checks['coverageAccounting']=accounting
    encoded_cursor=first['nextCursor'].split('.')[0]
    cursor_payload=json.loads(base64.urlsafe_b64decode(encoded_cursor+'='*(-len(encoded_cursor)%4)))
    assert cursor_payload['release']==checks['statusDataManifestId']
    checks['sharedDataRelease']=checks['statusDataManifestId']
    checks['sourcedDatedLookups']=True
    checks['topicSourceRegionalCursorContract']=True
    knowledge=call('get_regional_topics',{'municipalityId':args.knowledge_municipality,'limit':50,'fields':['id','cityId','origin','topics']})
    candidates=[item for item in knowledge['items'] if item['origin']=='knowledge']
    assert candidates, 'Selected municipality has no released knowledge record in the discovery page; supply --knowledge-municipality from the release'
    target=next((item for item in candidates if item['topics']),candidates[0])
    topic=target['topics'][0]['id'] if target['topics'] else topics[0]['id']
    comparison_cities=list(dict.fromkeys([target['cityId'],fact['cityId']]))
    comparison=call('compare_topic',{'topic':topic,'cityIds':comparison_cities})
    assert comparison['releaseId']==checks['envelopeRelease'] and comparison['method']['method']=='source-evidenced-case-summary'
    assert comparison['method']['version']=='district-comparison-v2'
    assert {city['cityId'] for city in comparison['cities']}==set(comparison_cities)
    for city in comparison['cities']:
        assert city['coverage'] and 0<=city['sourceBackedRecordCount']<=city['recordCount']
        assert 0<=city['sourceBackedCaseCount']<=city['caseCount']<=city['recordCount']
        assert city['identifiedCaseCount']+city['unresolvedCaseCount']==city['caseCount']
    similar=call('similar',{'id':target['id'],'limit':3})
    assert similar['releaseId']==checks['envelopeRelease'] and similar['method']['method']=='weighted-token-topic-jaccard'
    assert similar['method']['version']=='district-similarity-v2'
    assert target['id'] in similar['target']['memberRecordIds'] and similar['target']['id']==similar['target']['caseId']
    assert similar['total']==similar['totalCases']>=len(similar['items']) and similar['totalRecords']>=similar['totalCases'] and len(similar['items'])<=3
    assert all(item['cityId']!=target['cityId'] and 0<item['score']<=1 and item['sourceIds'] and item['memberRecordIds'] and item['identityStatus'] in ('source_identified','unresolved') and isinstance(item['sharedTerms'],list) and isinstance(item['sharedTopics'],list) for item in similar['items'])
    checks['comparisonAndSimilarity']={'municipality':target['cityId'],'targetRecordId':target['id'],'targetCaseId':similar['target']['caseId'],'crossCityCases':similar['totalCases'],'crossCityRecords':similar['totalRecords']}
    exported=call('export_records',{'municipality':target['cityId'],'limit':1})
    def export_page(page,municipality=None,limit=20):
        assert page['releaseId']==checks['envelopeRelease'] and page['totalRecords']>=page['totalCases']>=0
        assert 0<=page['identifiedCaseCount']<=page['totalCases'] and page['caseCountMeaning']
        assert page['items'] and len(page['items'])<=limit and (page['nextCursor'] is None or isinstance(page['nextCursor'],str))
        for item in page['items']:
            assert (municipality is None or item['cityId']==municipality) and isinstance(item['originalRecord'],dict) and item['originalRecord']
            assert {'id','cityId','recordType','title','statement','topics','eventDate','dateSemantics','sourceIds','comparisonEligible','comparisonReason','origin'}<=set(item)
            if not item['comparisonEligible']: assert item['comparisonReason']
        assert {source['id'] for source in page['sources']}=={source_id for item in page['items'] for source_id in item['sourceIds']}, 'Export sources must describe this page only'
        assert all((source['url'] or source.get('urlWithheldReason')) and (source.get('retrievedAt') or source.get('retrievalNote')) for source in page['sources'])
    export_page(exported,target['cityId'],1)
    default_export=call('export_records')
    export_page(default_export)
    assert len(default_export['items'])==min(20,default_export['totalRecords']), 'Export default page limit differs'
    export_checks={'municipality':target['cityId'],'totalRecords':exported['totalRecords'],'totalCases':exported['totalCases'],'firstRecordId':exported['items'][0]['id'],'defaultPageRecords':len(default_export['items']),'paginationExercised':False}
    if exported['nextCursor'] is not None:
        exported_next=call('export_records',{'municipality':target['cityId'],'limit':1,'cursor':exported['nextCursor']})
        export_page(exported_next,target['cityId'],1)
        assert exported_next['totalRecords']==exported['totalRecords'] and exported_next['totalCases']==exported['totalCases']
        assert exported_next['items'][0]['id']!=exported['items'][0]['id']
        export_checks['paginationExercised']=True
    checks['exportRecords']=export_checks
    # Only IDs/edges returned by the admitted release are used. Empty or bounded
    # discovery is recorded explicitly; inventing an entity or a self-path is not acceptance.
    bound_files={item['path']:item for item in release['dataManifest']['files']} if not filtered else None
    if bound_files is not None:
        assert 'knowledge/graph.json' in bound_files and 'knowledge/records.json' in bound_files
        assert all(re.fullmatch(r'[0-9a-f]{64}',bound_files[path]['sha256']) for path in ['knowledge/graph.json','knowledge/records.json'])
    knowledge_detail=call('get_signal',{'id':target['id']})
    mentions=knowledge_detail['entities']
    assert isinstance(mentions,list) and all(isinstance(mention,dict) and re.fullmatch(r'entity:[0-9a-f]{64}',mention['entityId']) for mention in mentions)
    entity_query=args.entity_query.strip() if args.entity_query is not None else mentions[0]['name'][:200].strip() if mentions else args.knowledge_municipality
    search=call('entity_search',{'query':entity_query,'limit':20})
    records_sha=bound_files['knowledge/records.json']['sha256'] if bound_files is not None else search['recordsSha256']
    assert re.fullmatch(r'[0-9a-f]{64}',records_sha)
    graph_page(search,'entity',records_sha)
    for entity in search['items']:
        assert re.fullmatch(r'entity:[0-9a-f]{64}',entity['id']) and entity['names'] and entity['mentions']
        assert entity['type'] in ['municipality','authority','organization','project','facility','funding_programme','law','place','company']
        assert entity['identityBasis']['kind'] in ['explicit_identifier','municipality_scoped_name','ags_scoped_council_body','source_scoped_name']
        assert entity['identityBasis']['ambiguity']
        for mention in entity['mentions']:
            assert mention['quote'] and mention['name']
            graph_evidence(mention['evidence'])
    entity_id=search['items'][0]['id'] if search['items'] else mentions[0]['entityId'] if mentions else None
    graph_checks={'recordsSha256':records_sha,'graphFileSha256':bound_files['knowledge/graph.json']['sha256'] if bound_files is not None else None,'hashScope':'sealed publication binding; not filtered response bytes','queryOrigin':'operator' if args.entity_query is not None else 'released_mention' if mentions else 'municipality_slug','entityIdOrigin':'entity_search' if search['items'] else 'released_record_mention' if mentions else None,'entitySearch':{'status':search['status'],'returned':len(search['items']),'total':search['total'],'truncated':search['truncated']},'neighbors':{'exercised':False,'reason':'No entity discovered by search or the sampled released record'},'path':{'exercised':False,'reason':'No distinct released endpoints discovered'},'toolsExercised':['entity_search']}
    if entity_id is not None:
        relation_types=[relation for relation in GRAPH_RELATION_TYPES if relation!='member_of' or tuple(map(int,args.release_version.split('.'))) >= (0,3,2)]
        neighbors=call('graph_neighbors',{'id':entity_id,'direction':'both','relationTypes':relation_types,'limit':20})
        graph_page(neighbors,'neighbors',records_sha)
        graph_path_policy(neighbors['pathEligibility'])
        assert neighbors['entity']['id']==entity_id
        for item in neighbors['items']:
            edge=item['edge']
            graph_edge(edge)
            assert item['from']['id']==edge['fromId'] and item['to']['id']==edge['toId']
            assert entity_id in [edge['fromId'],edge['toId']] and type(item['pathEligible']) is bool and item['pathEligible']==graph_path_eligible(edge)
        graph_checks['toolsExercised'].append('graph_neighbors')
        graph_checks['neighbors']={'exercised':True,'entityId':entity_id,'status':neighbors['status'],'returned':len(neighbors['items']),'total':neighbors['total'],'truncated':neighbors['truncated'],'pathEligibility':neighbors['pathEligibility'],'eligibleReturnedEdges':sum(graph_path_eligible(item['edge']) for item in neighbors['items'])}
        edges=[item['edge'] for item in neighbors['items'] if item['edge']['fromId']!=item['edge']['toId']]
        edge=next((edge for edge in edges if graph_path_eligible(edge)),edges[0] if edges else None)
        other_id=next((item['id'] for item in search['items'] if item['id']!=entity_id),None)
        if other_id is None: other_id=next((mention['entityId'] for mention in mentions if mention['entityId']!=entity_id),None)
        if edge is not None or other_id is not None:
            from_id,to_id=(edge['fromId'],edge['toId']) if edge is not None else (entity_id,other_id)
            paths=call('graph_path',{'fromId':from_id,'toId':to_id,'maxHops':5,'limit':20})
            graph_page(paths,'path',records_sha)
            assert paths['direction']=='out' and paths['maxHops']==5 and 'modality' not in paths
            graph_path_policy(paths['pathEligibility'])
            assert paths['pathEligibility']==neighbors['pathEligibility']
            actual_modalities=sorted({path_edge['modality'] for path in paths['items'] for path_edge in path['edges']})
            assert paths['modalities']==actual_modalities, 'Path modality summary must describe only actual returned edges'
            for path in paths['items']:
                assert 1<=path['hops']<=5 and path['hops']==len(path['edges']) and len(path['entities'])==path['hops']+1
                assert path['entities'][0]['id']==from_id and path['entities'][-1]['id']==to_id
                for index,path_edge in enumerate(path['edges']):
                    graph_edge(path_edge)
                    assert graph_path_eligible(path_edge), 'A path edge violates its relation-specific action rule'
                    assert path_edge['fromId']==path['entities'][index]['id'] and path_edge['toId']==path['entities'][index+1]['id']
            if edge is not None and graph_path_eligible(edge) and paths['complete']:
                assert paths['status']=='found' and paths['shortestHops']==1, 'Complete path search lost a released typed eligible direct edge'
            if paths['items']: assert all(path['hops']==paths['shortestHops'] for path in paths['items'])
            graph_checks['toolsExercised'].append('graph_path')
            graph_checks['path']={'exercised':True,'fromId':from_id,'toId':to_id,'status':paths['status'],'returned':len(paths['items']),'total':paths['total'],'shortestHops':paths['shortestHops'],'truncated':paths['truncated'],'modalities':paths['modalities'],'pathEligibility':paths['pathEligibility']}
    checks['graphAcceptance']=graph_checks
    assert request(data='x'*32769)[0]==413
    assert request(data='['+json.dumps({'jsonrpc':'2.0','id':1,'method':'ping'})+']')[0]==400
    checks['sizeAndBatchLimits']=True
    # Never stress live credentials, even when the selected real token is elevated.
    checks['rateLimitExercised']=not bool(args.url)
    if not args.url:
        defaults=[probe_policy(name,default_limits,True) for name in ('max','buzz')]
        assert request(bearer=disposable_tokens['isolated'],limits=default_limits)[0]==405
        disposable_configuration(elevated=True)
        for _ in range(3):
            assert request(bearer=disposable_tokens['activation'],limits=default_limits)[0]==405, 'File change activated policy without restart'
        command(['docker','restart',container])
        port=command(['docker','port',container,'4318/tcp']).split(':')[-1]
        origin='http://127.0.0.1:'+port
        ready()
        activation=probe_policy('activation',{'requestsPerMinute':2,'maxConcurrent':1},True)
        elevated=[probe_policy(name,elevated_limits,False) for name in ('max','buzz')]
        assert request(bearer=disposable_tokens['isolated'],limits=default_limits)[0]==405
        checks['tokenPolicies']={'defaultNamedProfiles':defaults,'explicitProfilesAfterRestart':elevated,'activationProfileAfterRestart':activation,'isolatedTokenUnaffected':True,'startupActivationOnly':True,'concurrencySaturationExercised':False}
        checks['rateLimit']=True
    evidence={'passed':True,'runId':acceptance_run_id,'releaseVersion':checks['serverVersion'],'dataManifestId':checks['statusDataManifestId'],'origin':origin,'checks':checks,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if cohort is not None:
        assert revocation_cohort(*cohort_values)==cohort, 'Frozen public cohort changed during acceptance'
        for field in ('revocationArtifactSha256','revocationTrustSha256'):
            checks[field]=cohort[field]
            evidence[field]=cohort[field]
    if args.url:
        evidence.update(acceptanceScope='public_endpoint_version_data',imageProvenanceVerified=False,runningImageIdentityVerified=False,suppliedImageReference=args.image,imageIdentityNote='Caller-supplied reference is unverified. Endpoint/version/data acceptance does not identify the running image; correlate separately with governed rollout and ReadyPod evidence.')
    else:
        evidence.update(acceptanceScope='exact_local_image',imageProvenanceVerified=True,runningImageIdentityVerified=True,image=args.image,imageTag=args.release_version,imageTagReference=image_tag)
    destination=pathlib.Path(args.evidence);destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(json.dumps(evidence,indent=2)+'\n')
    print(str(destination))
finally:
    try:
        if container: command(['docker','rm','--force',container])
    finally:
        hash_mount.cleanup()
