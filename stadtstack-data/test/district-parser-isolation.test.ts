import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { deflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { extractDocumentText, runDocumentCommand } from '../src/district-document.ts';
import { parserContainerArgs, parserControllerEnvironment, ParserIsolationError, ParserReviewSchema,
  PARSER_ISOLATION_VERSION, PARSER_LIMITS, PARSER_TOOLS, withParserSandbox, readParserReview, type ParserSourceContext, type ParserSandbox } from '../src/district-parser-isolation.ts';
import { metadataPdf } from './fixtures/tdm-pdf.ts';
import { digest } from '../src/district-adapter-contract.ts';
import { PREPARED_VM_ROOT } from '../src/district-prepared-document.ts';
import {classifyDocumentOrigin} from '../src/document-origin.ts';
import {inspectResourcePolicySandbox} from '../src/district-policy-inspection.ts';
import {DOCUMENT_ORIGIN_CLASSIFIER_VERSION} from '../src/document-origin-contract.ts';

const XML = '<Plan><name>Beispielstadt Wärmeplanung</name><datum>2026-10-10</datum></Plan>';
const fixtureCommand = async () => { throw Error('Pure synthetic text/XML fixture must not execute parser commands'); };
const reviewedSecurityTests = process.env.STADTSTACK_PARSER_SECURITY_TESTS === '1';
const securityOptions = { skip: !reviewedSecurityTests, concurrency: false, timeout: 240_000 };
const secretKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SOURCE_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL', 'HTTPS_PROXY', 'SSH_AUTH_SOCK', 'PYTHONPATH', 'PYTHONSTARTUP', 'NODE_OPTIONS'];
async function withInspectionFixture<T>(bytes: Uint8Array, work: (context: ParserSourceContext) => Promise<T>): Promise<T> {
  await readParserReview(); // The test switch is never security authorization.
  // Real sentinel tests use the existing authorized VM authority, not fake receipts or a live-socket fixture bypass.
  const { assertCivicPolicyAuthority, CIVIC_ACQUISITION_DECISION_ID } = await import('../src/civic-opt-out.ts');
  const authority = await assertCivicPolicyAuthority();
  // Keep the registered root/marker durable; canonical scope teardown removes only its owned source scratch.
  const root = join(dirname(PREPARED_VM_ROOT), 'parser-security-fixtures');
  return work({ root, authorityId: authority.authorityId, authoritySha256: authority.authoritySha256,
    decisionId: CIVIC_ACQUISITION_DECISION_ID, kind: 'artifacts', purpose: 'classification',
    bindings: [{ phase: 'pre-admission', url: 'https://parser-fixture.invalid/synthetic-input', sourceSha256: digest(bytes) }] });
}

test('Docker parser contract binds only one artifact and fixed bounded isolation', () => {
  assert.equal(PARSER_LIMITS.inputBytes, 64 * 1024 * 1024);
  const args = parserContainerArgs('sha256:' + 'a'.repeat(64), 'stadtstack-parser-' + randomUUID(), '/tmp/private/document');
  for (const expected of ['--pull=never', '--network=none', '--ipc=none', '--read-only', '--user=65534:65534',
    '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--pids-limit=32', '--memory=512m',
    '--memory-swap=512m', '--cpus=1', '--ulimit=cpu=120:120', '--ulimit=core=0:0', '--log-driver=none', '--entrypoint=/usr/bin/env', '-i', '-I', '-S']) assert.ok(args.includes(expected));
  assert.equal(args.filter(arg => arg === '--mount').length, 1);
  assert.ok(args.includes('type=bind,src=/tmp/private/document,dst=/input/document,readonly,bind-propagation=rprivate'));
  assert.ok(args.includes('--tmpfs=/scratch:rw,noexec,nosuid,nodev,size=134217728,uid=65534,gid=65534,mode=0700'));
  assert.ok(args.includes('--rm')); // Daemon-side removal survives a crashed controller; cleanup proves absence.
  assert.ok(!args.some(arg => /privileged|host=|docker\.sock|\/home\//.test(arg)));
  assert.throws(() => parserContainerArgs('latest', 'stadtstack-parser-' + randomUUID(), null), ParserIsolationError);
  assert.throws(() => parserContainerArgs('sha256:' + 'a'.repeat(64), 'stadtstack-parser-' + randomUUID(), '/tmp/input,src=/etc'), ParserIsolationError);
});

test('controller environment is an explicit allowlist, not inherited secrets or auth configuration', () => {
  const env = parserControllerEnvironment('/tmp/private-job', '/run/docker.sock');
  assert.deepEqual(Object.keys(env).sort(), ['DOCKER_CONFIG', 'DOCKER_HOST', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'].sort());
  for (const key of secretKeys) assert.equal(env[key], undefined);
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/tmp/private-job/home');
  assert.equal(env.DOCKER_CONFIG, '/tmp/private-job/docker-config');
});

test('security authorization requires reviewed immutable image and runner identity', () => {
  const valid = { version: PARSER_ISOLATION_VERSION, imageId: 'sha256:' + 'b'.repeat(64), runnerSha256: 'c'.repeat(64),
    securityReviewId: 'fixture-review', reviewedBy: 'fixture-reviewer', reviewedAt: '2026-10-11T00:00:00Z', dockerSocket: '/run/docker.sock' };
  assert.equal(ParserReviewSchema.parse(valid).imageId, valid.imageId);
  assert.throws(() => ParserReviewSchema.parse({ ...valid, imageId: 'stadtstack-parser:latest' }));
  assert.throws(() => ParserReviewSchema.parse({ ...valid, dockerSocket: 'tcp://localhost:2375' }));
  assert.throws(() => ParserReviewSchema.parse({ ...valid, approved: true }));
});

test('Mac/other unavailable isolation holds rather than executing the host Python/PDF tools', { skip: process.platform === 'linux' }, async () => {
  await assert.rejects(runDocumentCommand('python3', ['-c', 'raise SystemExit(0)']), (error: unknown) => error instanceof ParserIsolationError && error.reason === 'unavailable');
  await assert.rejects(extractDocumentText(metadataPdf(), 'application/pdf'), ParserIsolationError);
  await assert.rejects(extractDocumentText(Buffer.from('not a zip'), 'application/zip'), ParserIsolationError);
  for (const mime of ['text/plain', 'text/html', 'application/json', 'application/xml']) await assert.rejects(extractDocumentText(Buffer.from(XML), mime), ParserIsolationError);
});

test('XML/GML external entities, DTDs, internal expansion and UTF-16 input are rejected without parsing', async () => {
  for (const xml of [
    '<!DOCTYPE Plan SYSTEM "http://127.0.0.1:9/private"><Plan>' + XML + '</Plan>',
    '<!DOCTYPE Plan [<!ENTITY secret SYSTEM "file:///etc/private-secret">]><Plan>&secret;</Plan>',
    '<!DOCTYPE Plan [<!ENTITY a "expansion"><!ENTITY b "&a;&a;&a;">]><Plan>&b;</Plan>',
    '<!ENTITY secret SYSTEM "file:///etc/private-secret">' + XML,
  ]) await assert.rejects(extractDocumentText(Buffer.from(xml), 'application/gml+xml', undefined, fixtureCommand), /DTD\/entity/);
  await assert.rejects(extractDocumentText(Buffer.from(XML, 'utf16le'), 'application/xml', undefined, fixtureCommand), /unsupported encoding/);
  assert.equal((await extractDocumentText(Buffer.from(XML), 'application/xml', undefined, fixtureCommand)).text, XML);
});

// Each source-owned job gets its own test budget; shared production inventory
// enrollment/teardown is outside the sandbox's independently enforced walltime.
const sentence = 'A synthetic public municipal source statement with sufficient original text for parsing.';
for (const fixture of [
  { mime: 'text/plain', input: sentence, text: sentence, method: 'text' },
  { mime: 'text/html', input: `<script>untrusted script</script><p>${sentence}</p>`, text: sentence, method: 'html' },
  { mime: 'application/json', input: JSON.stringify({ statement: sentence }), text: JSON.stringify({ statement: sentence }), method: 'json' },
  { mime: 'application/gml+xml', input: XML, text: XML, method: 'xml' },
]) {
  test(`reviewed default ${fixture.method} branch executes only through the document worker`, securityOptions, async () => {
    const bytes = Buffer.from(fixture.input);
    const parsed = await withInspectionFixture(bytes, context => extractDocumentText(bytes, fixture.mime, context));
    assert.equal(parsed.text, fixture.text); assert.equal(parsed.method, fixture.method);
  });
}
test('reviewed default XML worker rejects unsafe originals', securityOptions, async () => {
  const unsafe = Buffer.from('<!DOCTYPE Plan SYSTEM "file:///etc/private-secret">' + XML);
  await assert.rejects(withInspectionFixture(unsafe, context => extractDocumentText(unsafe, 'application/xml', context)), /XML safety/);
});

test('reviewed regional fixed worker verifies a source-only original bundle without host HTML parsing', securityOptions, async () => {
  const quote = 'Der Beschluss zur Wärmeplanung wurde in der Sitzung beraten.';
  const remainder = 'Weitere Einzelheiten zum Verfahren, zu den offenen Fragen und zur Beteiligung werden im nächsten öffentlichen Termin erörtert. '.repeat(4);
  const source = Buffer.from(`<html><main><p>${quote}</p><p>${remainder}</p></main></html>`), sourceSha256 = digest(source);
  const bundle = Buffer.from(JSON.stringify({version:'district-regional-statement-worker-v1',sourceSha256,sourceBase64:source.toString('base64'),anchors:[quote]}));
  await withInspectionFixture(source, context => withParserSandbox(bundle, async sandbox => {
    const output = (await sandbox.run('node',['--experimental-strip-types','/opt/stadtstack/src/district-regional-statement-worker.ts','/input/document'])).stdout;
    assert.ok(Buffer.byteLength(output) <= 16 * 1024);
    const result = JSON.parse(output);
    assert.equal(result.version,'district-regional-statement-worker-v1'); assert.equal(result.sourceSha256,sourceSha256);
    assert.equal(result.statement,quote); assert.deepEqual(result.statementEvidence,[{quote,sourceSha256,textNormalization:'html-whitespace-v1'}]);
  }, context));
});

test('ZIP boundary validates source XML even when a test command returns malformed content', async () => {
  await assert.rejects(extractDocumentText(Buffer.from('unit seam'), 'application/zip', undefined, async () => JSON.stringify({ text: '<!DOCTYPE Plan SYSTEM "file:///etc/private-secret">' + XML })), /DTD\/entity/);
  await extractDocumentText(Buffer.from('unit seam'), 'application/zip', undefined, async (_file, args) => {
    assert.match(args[1], /stat\.S_ISLNK/);
    assert.match(args[1], /len\(items\)>200/);
    assert.match(args[1], /compress_size\)\*200/);
    assert.match(args[1], /DOCTYPE\|ENTITY/);
    return JSON.stringify({ text: XML, skipped: 0 });
  });
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
type ZipMember = { name: string; text: string; mode?: number; compress?: boolean; encrypted?: boolean; declaredBytes?: number };
/** Complete synthetic ZIPs; malicious fixtures never need a host archive utility. */
function zip(members: ZipMember[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name), plain = Buffer.from(member.text), body = member.compress ? deflateRawSync(plain) : plain;
    const header = Buffer.alloc(30), directory = Buffer.alloc(46), flags = member.encrypted ? 1 : 0;
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(member.compress ? 8 : 0, 8); header.writeUInt32LE(crc32(plain), 14);
    header.writeUInt32LE(body.length, 18); header.writeUInt32LE(member.declaredBytes ?? plain.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(member.compress ? 8 : 0, 10); directory.writeUInt32LE(crc32(plain), 16);
    directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(member.declaredBytes ?? plain.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((member.mode ?? 0o100644) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    locals.push(header, name, body); central.push(directory, name); offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('reviewed sandbox hides sentinel secrets, host files and inherited Python configuration', securityOptions, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stadtstack-security-fixture-'));
  const sentinel = 'sentinel-' + randomUUID(), secret = join(root, 'private-secret');
  const previous: Record<string, string | undefined> = Object.fromEntries(secretKeys.map(key => [key, process.env[key]]));
  try {
    await writeFile(secret, sentinel, { mode: 0o600 });
    await writeFile(join(root, 'other-cas-object'), sentinel, { mode: 0o600 });
    for (const key of secretKeys) process.env[key] = sentinel;
    const bytes = metadataPdf();
    await withInspectionFixture(bytes, context => withParserSandbox(bytes, async sandbox => {
      const probe = `import json,os,sys,resource\npaths=${JSON.stringify([secret, join(root, 'other-cas-object'), '/var/run/docker.sock', '/run/docker.sock', '/root/.aws/credentials'])}\nblocked=[]\nfor path in paths:\n try:\n  open(path,'rb').read(4096)\n  blocked.append(False)\n except OSError:\n  blocked.append(True)\ntry:\n open('/input/document','wb').write(b'overwrite')\n readonly=False\nexcept OSError:\n readonly=True\nv=os.statvfs('/scratch')\nprint(json.dumps({'keys':sorted(os.environ),'blocked':blocked,'readonly':readonly,'uid':os.getuid(),'isolated':sys.flags.isolated,'no_site':sys.flags.no_site,'scratch':v.f_blocks*v.f_frsize,'cpu':resource.getrlimit(resource.RLIMIT_CPU),'memory':resource.getrlimit(resource.RLIMIT_AS)}))`;
      const result = await sandbox.run('python3', ['-c', probe]);
      const evidence = JSON.parse(result.stdout);
      assert.ok(evidence.blocked.every(Boolean)); assert.equal(evidence.readonly, true);
      assert.equal(evidence.uid, 65534); assert.equal(evidence.isolated, 1); assert.equal(evidence.no_site, 1);
      assert.ok(evidence.scratch <= PARSER_LIMITS.scratchBytes); assert.equal(evidence.cpu[1], 120);
      assert.equal(evidence.memory[1], PARSER_LIMITS.memoryBytes);
      assert.deepEqual(evidence.keys, ['HOME', 'LANG', 'LC_ALL', 'OMP_THREAD_LIMIT', 'PATH', 'TESSDATA_PREFIX', 'TMPDIR', 'TZ'].sort());
      for (const tool of PARSER_TOOLS) {
        const version = await sandbox.run(tool, [tool.startsWith('pdf') ? '-v' : '--version']);
        assert.ok(!version.stdout.includes(sentinel) && !version.stderr.includes(sentinel));
      }
      // Inspect the initial environment of each real native parser executable, not a mocked command.
      const childProbe = `import os,subprocess,time,json\nfifo='/scratch/native-probe'\nos.mkfifo(fifo)\nresults=[]\ncommands=[['/usr/bin/pdfinfo',fifo],['/usr/bin/pdftotext',fifo,'-'],['/usr/bin/pdftoppm',fifo,'/scratch/probe'],['/usr/bin/tesseract',fifo,'stdout'],['/usr/bin/python3','-I','-S','-c','import time;time.sleep(2)']]\nfor command in commands:\n p=subprocess.Popen(command,env=dict(os.environ),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)\n try:\n  time.sleep(0.05)\n  data=open('/proc/'+str(p.pid)+'/environ','rb').read()\n  results.append(sorted(item.split(b'=',1)[0].decode() for item in data.split(b'\\x00') if item))\n finally:\n  p.kill()\n  p.wait()\nos.unlink(fifo)\nprint(json.dumps(results))`;
      const childEnvironments = JSON.parse((await sandbox.run('python3', ['-c', childProbe])).stdout) as string[][];
      assert.equal(childEnvironments.length, 5);
      for (const keys of childEnvironments) assert.deepEqual(keys, evidence.keys);
    }, context));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

// Resource gates and origin run sequentially in one real immutable source scope.
test('reviewed batched origin and policy workers hide sentinel secrets', securityOptions, async () => {
  const sentinel = 'sentinel-' + randomUUID();
  const previous = Object.fromEntries(secretKeys.map(key => [key, process.env[key]]));
  try {
    for (const key of secretKeys) process.env[key] = sentinel;
    const html = Buffer.from('<html><title>Beschlussvorlage</title><meta name="tdm-reservation" content="1"><main><p>Herausgeber: Stadt Beispielstadt</p><p>Beschluss zur weiteren Entwicklung des Quartiers in der kommenden Sitzung.</p></main></html>');
    await withInspectionFixture(html, async context => {
      const url = context.bindings[0].url;
      let escapedSandbox!:ParserSandbox;
      await withParserSandbox(html,async sandbox=>{
        escapedSandbox=sandbox;
        const policy = await inspectResourcePolicySandbox(url,{'tdm-policy':'https://policy.example.org/public-policy'},html,'text/html',context,sandbox);
        assert.equal(policy.reservation,1); assert.equal(policy.access,'public');
        const origin = await classifyDocumentOrigin({url,mimeType:'text/html',bytes:html},{scratch:context,sandbox});
        assert.equal(origin.classification,'official_work'); assert.equal(origin.classifierVersion,DOCUMENT_ORIGIN_CLASSIFIER_VERSION);
        assert.ok(!JSON.stringify({origin,policy}).includes(sentinel));
        await assert.rejects(classifyDocumentOrigin({url,mimeType:'text/html',bytes:Buffer.from('different representation')},{scratch:context,sandbox}),ParserIsolationError);
        await assert.rejects(classifyDocumentOrigin({url,mimeType:'text/html',bytes:html},{scratch:{...context},sandbox}),ParserIsolationError);
        const bindings=context.bindings;
        try{
          context.bindings=[...bindings,{phase:'pre-admission',url:'https://other-scope.invalid/input',sourceSha256:digest(html)}];
          await assert.rejects(inspectResourcePolicySandbox(url,{},html,'text/html',context,sandbox),ParserIsolationError);
        }finally{context.bindings=bindings;}
      },context);
      await assert.rejects(classifyDocumentOrigin({url,mimeType:'text/html',bytes:html},{scratch:context,sandbox:escapedSandbox}),ParserIsolationError);
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('reviewed sandbox cannot connect to host loopback or external network', securityOptions, async () => {
  const server = createServer(socket => socket.end('host-network-sentinel'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await withParserSandbox(null, async sandbox => {
      const script = `import socket,json\nresults=[]\nfor host,port in [('127.0.0.1',${address.port}),('192.0.2.1',443)]:\n try:\n  s=socket.create_connection((host,port),timeout=1)\n  s.close()\n  results.append(False)\n except OSError:\n  results.append(True)\nprint(json.dumps(results))`;
      assert.deepEqual(JSON.parse((await sandbox.run('python3', ['-c', script])).stdout), [true, true]);
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('reviewed sandbox enforces output bounds and permits only selected input/tool assets', securityOptions, async () => {
  await withParserSandbox(null, async sandbox => {
    await assert.rejects(sandbox.run('/bin/sh', ['-c', 'true']), ParserIsolationError);
    await assert.rejects(sandbox.run('pdfinfo', ['/etc/passwd']), ParserIsolationError);
    for (const timeoutMs of [0, -1, NaN, PARSER_LIMITS.walltimeMs + 1]) {
      await assert.rejects(sandbox.run('python3', ['--version'], timeoutMs), error => error instanceof ParserIsolationError && error.reason === 'request_rejected');
    }
    await assert.rejects(sandbox.run('python3', ['-c', `import sys;sys.stdout.write('x'*${PARSER_LIMITS.outputBytes + 1})`]), (error: unknown) => error instanceof ParserIsolationError && error.reason === 'resource_limit');
  });
});

test('reviewed sandbox enforces a command deadline after readiness and removes the container', securityOptions, async () => {
  await assert.rejects(withParserSandbox(null, async sandbox => {
    await sandbox.run('python3', ['-c', 'import time;time.sleep(2)'], 50);
  }), error => error instanceof Error && error.name === 'TimeoutError');
});

test('reviewed PDF tools share internal OCR scratch without mounting host output directories', securityOptions, async () => {
  const bytes = metadataPdf();
  await withInspectionFixture(bytes, context => withParserSandbox(bytes, async sandbox => {
    assert.match((await sandbox.run('pdfinfo', ['/input/document'])).stdout, /Pages:\s+1/);
    await sandbox.run('pdftotext', ['-enc', 'UTF-8', '/input/document', '-']);
    const prefix = '/scratch/page-1';
    await sandbox.run('pdftoppm', ['-f', '1', '-l', '1', '-scale-to', '2400', '-singlefile', '-png', '/input/document', prefix]);
    await sandbox.run('tesseract', [prefix + '.png', 'stdout', '-l', 'deu+eng', '--psm', '3']);
  }, context));
});

test('reviewed archive parser accepts bounded source XML', securityOptions, async () => {
  const valid = zip([{ name: 'plan.xml', text: XML }]);
  assert.equal((await withInspectionFixture(valid, context => extractDocumentText(valid, 'application/zip', context))).text, XML);
});
const archiveAttacks: { name: string; members: ZipMember[] }[] = [
  { name: 'parent traversal', members: [{ name: '../escape.xml', text: XML }] },
  { name: 'absolute path', members: [{ name: '/etc/escape.xml', text: XML }] },
  { name: 'Windows drive', members: [{ name: 'C:\\escape.xml', text: XML }] },
  { name: 'backslash path', members: [{ name: 'nested\\escape.xml', text: XML }] },
  { name: 'symlink', members: [{ name: 'link.xml', text: '/etc/private-secret', mode: 0o120777 }] },
  { name: 'encryption', members: [{ name: 'plan.xml', text: XML, encrypted: true }] },
  { name: 'expansion ratio', members: [{ name: 'plan.xml', text: 'a'.repeat(500_000), compress: true }] },
  { name: 'expanded size', members: [{ name: 'plan.xml', text: XML, declaredBytes: 25 * 1024 * 1024 }] },
  { name: 'member count', members: Array.from({ length: 201 }, (_, index) => ({ name: `plan-${index}.xml`, text: XML })) },
  { name: 'external DTD', members: [{ name: 'plan.xml', text: '<!DOCTYPE Plan SYSTEM "http://192.0.2.1/private">' + XML }] },
  { name: 'external entity', members: [{ name: 'plan.xml', text: '<!DOCTYPE Plan [<!ENTITY secret SYSTEM "file:///etc/private-secret">]>' + XML }] },
];
for (const { name, members } of archiveAttacks) {
  test(`reviewed archive parser rejects ${name}`, securityOptions, async () => {
    const bytes = zip(members);
    await assert.rejects(withInspectionFixture(bytes, context => extractDocumentText(bytes, 'application/zip', context)), /archive limit|text limit|XML safety/);
  });
}
