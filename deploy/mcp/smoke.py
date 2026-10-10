#!/usr/bin/env python3
"""Exact-image or public HTTPS acceptance. Outputs evidence, never bearer values."""
import argparse, base64, datetime, hashlib, json, pathlib, re, secrets, subprocess, tempfile, time, urllib.error, urllib.request

p=argparse.ArgumentParser()
p.add_argument('--image',required=True)
p.add_argument('--evidence',required=True)
p.add_argument('--url',help='Use the live HTTPS origin instead of starting Docker')
p.add_argument('--person',default='max')
p.add_argument('--knowledge-municipality',default='ratzeburg',help='Municipality with a released normalized knowledge record for comparison/similarity acceptance')
args=p.parse_args()
if not re.fullmatch(r'ghcr\.io/giraeffleaeffle/stadtstack-mcp@sha256:[0-9a-f]{64}',args.image): p.error('Exact published image digest required')
if not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}',args.person): p.error('Invalid person')
if not re.fullmatch(r'[a-z0-9-]{1,80}',args.knowledge_municipality): p.error('Invalid knowledge municipality')
if args.url and args.url!='https://mcp.stadtstack.eu': p.error('Live origin must be https://mcp.stadtstack.eu')
private=pathlib.Path.home()/'.config/stadtstack/mcp-tokens'
# Never give an image under test a real operator credential. Local smoke tokens
# live only in memory and are never accepted by the deployed Secret.
token=(private/(args.person+'.token')).read_text().strip() if args.url else secrets.token_urlsafe(32)
if not re.fullmatch(r'[A-Za-z0-9_-]{43}',token): raise RuntimeError('Invalid private token file')
container=None
# Home is shared by desktop Docker/Colima; macOS system temp folders may not be.
hash_mount=tempfile.TemporaryDirectory(prefix='.mcp-smoke-hashes-',dir=pathlib.Path.home())
checks={}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener=urllib.request.build_opener(NoRedirect())

def command(argv):
    result=subprocess.run(argv,capture_output=True,text=True)
    if result.returncode: raise RuntimeError('Container operation failed (output withheld)')
    return result.stdout.strip()

def request(path='/mcp',data=None,auth=True,extra=None,method=None):
    headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
    if auth: headers['Authorization']='Bearer '+token
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
            assert guidance=={'ok':False,'error':'rate_limited','retryAfterSeconds':int(retry_after),'limits':{'requestsPerMinute':60,'maxConcurrent':4}}, 'Rate-limit JSON/header guidance differs'
            checks['retryAfterSeconds']=int(retry_after)
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
    checks['lastRespondedAt']=value['respondedAt']
    return value['data']

try:
    if args.url:
        origin=args.url
    else:
        command(['docker','pull','--platform','linux/amd64',args.image])
        # Only hashes are copied; parent directory remains 0700 on the host.
        hashfile=pathlib.Path(hash_mount.name)/'token-hashes.json'
        hashfile.write_text(json.dumps([{'id':'smoke','sha256':hashlib.sha256(token.encode()).hexdigest()}]));hashfile.chmod(0o444)
        container=command(['docker','run','--detach','--platform','linux/amd64','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','1g','--cpus','1','--publish','127.0.0.1::4318','--mount','type=bind,source='+str(hashfile)+',target=/run/secrets/mcp/token-hashes.json,readonly',args.image])
        port=command(['docker','port',container,'4318/tcp']).split(':')[-1]
        origin='http://127.0.0.1:'+port
        details=json.loads(command(['docker','inspect',container]))[0]
        assert details['Config']['Image']==args.image and details['Config']['User']=='1000:1000'
        assert details['HostConfig']['ReadonlyRootfs'] and details['HostConfig']['CapDrop']==['ALL']
        checks['nonrootReadOnlyExactImage']=True
    for _ in range(30):
        try:
            if request('/health',auth=False)[0]==200: break
        except (urllib.error.URLError,TimeoutError,ConnectionError): pass
        time.sleep(1)
    else: raise RuntimeError('Health did not become ready within 30 seconds')
    checks['health']=True
    assert request(auth=False)[0]==401
    assert request(extra={'Authorization':'Bearer '+'x'*43})[0]==401
    assert request(path='/mcp?token=not-a-token',auth=False)[0]==404
    assert request(extra={'Origin':'https://untrusted.invalid'})[0]==403
    assert request()[0]==405
    checks['authAndOriginAndExactRoute']=True
    status,initial=request(data={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'stadtstack-smoke','version':'1'}}})
    assert status==200 and initial['result']['serverInfo']['name']=='stadtstack-data'
    status,listing=request(data={'jsonrpc':'2.0','id':2,'method':'tools/list'})
    assert status==200
    tools=listing['result']['tools'];names=[t['name'] for t in tools]
    expected=['list_cities','list_topics','get_core_bundle','search_signals','search_signals_near','search_signals_along','get_signal','get_sources','get_source','get_changes','search_topics','get_council_items','get_regional_topics','get_release_status','compare_topic','similar']
    assert sorted(names)==sorted(expected)
    assert all(t['annotations']['readOnlyHint'] and not t['annotations']['destructiveHint'] for t in tools)
    checks['readOnlyTools']=names
    core=call('get_core_bundle')
    assert len(core['bundle']['facts'])==3 and all(f['verification']['status']=='auto-verified' and f['source']['url'] and f['source']['documentDate'] and 'date' not in f for f in core['bundle']['facts'])
    checks['sharedCoreBundleVersion']=core['bundle']['version']
    fact=call('get_signal',{'id':'lake:straussee-level-2026-09-14'})
    assert fact['verification']['status']=='auto-verified' and fact['sourceIds'] and fact['eventDate']=='2026-09-14' and fact['asOf']
    assert not {'source','sources','date','properties'}.intersection(fact), 'Obsolete full-record aliases remain'
    attribution=call('get_sources',{'id':fact['id']})
    assert attribution['sources'] and attribution['sourceIds']==fact['sourceIds'] and 'source' not in attribution
    source=call('get_source',{'sourceId':fact['sourceIds'][0]})
    assert source['id']==fact['sourceIds'][0] and source['url'] and source['retrievedAt']
    assert source in attribution['sources']
    topics=call('list_topics')['topics']
    assert topics
    assert call('search_topics',{'query':'Straussee','limit':5})['items']
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
    assert release['manifest']['bundleVersion']==core['bundle']['version'] and release['dataManifest']['id']==checks['envelopeRelease']
    encoded_cursor=first['nextCursor'].split('.')[0]
    cursor_payload=json.loads(base64.urlsafe_b64decode(encoded_cursor+'='*(-len(encoded_cursor)%4)))
    assert cursor_payload['release']==release['dataManifest']['id']
    checks['sharedDataRelease']=release['dataManifest']['id']
    checks['sourcedDatedLookups']=True
    checks['topicSourceRegionalCursorContract']=True
    knowledge=call('get_regional_topics',{'municipalityId':args.knowledge_municipality,'limit':50,'fields':['id','cityId','origin','topics']})
    candidates=[item for item in knowledge['items'] if item['origin']=='knowledge']
    assert candidates, 'Selected municipality has no released knowledge record in the discovery page; supply --knowledge-municipality from the release'
    target=next((item for item in candidates if item['topics']),candidates[0])
    topic=target['topics'][0]['id'] if target['topics'] else topics[0]['id']
    comparison_cities=list(dict.fromkeys([target['cityId'],fact['cityId']]))
    comparison=call('compare_topic',{'topic':topic,'cityIds':comparison_cities})
    assert comparison['releaseId']==checks['envelopeRelease'] and comparison['method']['method']=='source-evidenced-stage-summary'
    assert {city['cityId'] for city in comparison['cities']}==set(comparison_cities)
    assert all(city['coverage'] and 0<=city['sourceBackedRecordCount']<=city['recordCount'] for city in comparison['cities'])
    similar=call('similar',{'id':target['id'],'limit':3})
    assert similar['releaseId']==checks['envelopeRelease'] and similar['method']['method']=='weighted-token-topic-jaccard'
    assert similar['target']['id']==target['id'] and similar['total']>=len(similar['items']) and len(similar['items'])<=3
    assert all(item['cityId']!=target['cityId'] and 0<item['score']<=1 and item['sourceIds'] and item['verification'] and isinstance(item['sharedTerms'],list) and isinstance(item['sharedTopics'],list) for item in similar['items'])
    checks['comparisonAndSimilarity']={'municipality':target['cityId'],'targetId':target['id'],'crossCityMatches':similar['total']}
    assert request(data='x'*32769)[0]==413
    assert request(data='['+json.dumps({'jsonrpc':'2.0','id':1,'method':'ping'})+']')[0]==400
    checks['sizeAndBatchLimits']=True
    # Only the disposable local token is stressed. Never exhaust a real user's
    # production quota; live checks rely on the exact-image local rate evidence.
    checks['rateLimitExercised']=not bool(args.url)
    if not args.url:
        for _ in range(65):
            if request()[0]==429: break
        else: raise RuntimeError('Per-token rate limit not enforced')
        checks['rateLimit']=True
        assert 'retryAfterSeconds' in checks
    evidence={'passed':True,'image':args.image,'origin':origin,'checks':checks,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    destination=pathlib.Path(args.evidence);destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(json.dumps(evidence,indent=2)+'\n')
    print(str(destination))
finally:
    if container: command(['docker','rm','--force',container])
    hash_mount.cleanup()
