#!/usr/bin/env python3
"""Exact-image or public HTTPS acceptance. Outputs evidence, never bearer values."""
import argparse, datetime, hashlib, json, pathlib, re, secrets, subprocess, tempfile, time, urllib.error, urllib.request

p=argparse.ArgumentParser()
p.add_argument('--image',required=True)
p.add_argument('--evidence',required=True)
p.add_argument('--url',help='Use the live HTTPS origin instead of starting Docker')
p.add_argument('--person',default='max')
args=p.parse_args()
if not re.fullmatch(r'ghcr\.io/giraeffleaeffle/stadtstack-mcp@sha256:[0-9a-f]{64}',args.image): p.error('Exact published image digest required')
if not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}',args.person): p.error('Invalid person')
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
        return error.code,None

def call(name,arguments={}):
    status,result=request(data={'jsonrpc':'2.0','id':7,'method':'tools/call','params':{'name':name,'arguments':arguments}})
    assert status==200 and 'result' in result and not result['result'].get('isError'), 'Tool acceptance failed: '+name
    value=result['result']['structuredContent']
    assert value['source'] and value['date'] and value['status'] in ('candidate','auto-verified')
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
    expected=['list_cities','get_core_bundle','search_signals','search_signals_near','search_signals_along','get_signal','get_sources','get_changes','search_topics','get_council_items','get_regional_topics','get_release_status']
    assert sorted(names)==sorted(expected)
    assert all(t['annotations']['readOnlyHint'] and not t['annotations']['destructiveHint'] for t in tools)
    checks['readOnlyTools']=names
    core=call('get_core_bundle')
    assert len(core['bundle']['facts'])==3 and all(f['status']=='auto-verified' and f['source']['url'] and f['date'] for f in core['bundle']['facts'])
    checks['sharedCoreBundleVersion']=core['bundle']['version']
    fact=call('get_signal',{'id':'lake:straussee-level-2026-09-14'})
    assert fact['status']=='auto-verified' and fact['source'] and fact['date']
    assert call('search_topics',{'query':'Straussee','limit':5})['features']
    assert call('get_council_items',{'limit':1})['features']
    assert call('get_regional_topics',{'limit':1})['items']
    assert call('get_release_status')['manifest']['bundleVersion']==core['bundle']['version']
    checks['sourcedDatedLookups']=True
    assert request(data='x'*32769)[0]==413
    assert request(data='['+json.dumps({'jsonrpc':'2.0','id':1,'method':'ping'})+']')[0]==400
    checks['sizeAndBatchLimits']=True
    # Bound the loop to 65; initialize/list/lookup calls also consume this window.
    for _ in range(65):
        if request()[0]==429: break
    else: raise RuntimeError('Per-token rate limit not enforced')
    checks['rateLimit']=True
    evidence={'passed':True,'image':args.image,'origin':origin,'checks':checks,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    destination=pathlib.Path(args.evidence);destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(json.dumps(evidence,indent=2)+'\n')
    print(str(destination))
finally:
    if container: command(['docker','rm','--force',container])
    hash_mount.cleanup()
