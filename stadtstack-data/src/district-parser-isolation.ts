import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { digest, semanticHash, HashSchema,PARSER_INPUT_MAX_BYTES } from './district-adapter-contract.ts';
import type { ManagedSourceContext, ManagedSourceScratch, ManagedDockerContainer, ManagedDockerSession } from './civic-opt-out.ts';
import type { Readable, Writable } from 'node:stream';

export const PARSER_ISOLATION_VERSION = 'district-parser-isolation-v1';
export const PARSER_REVIEW_PATH = '/etc/stadtstack/parser-isolation-review.json';
export const PARSER_TOOLS = ['pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract', 'python3', 'node'] as const;
export type ParserTool = typeof PARSER_TOOLS[number];
export const PARSER_LIMITS = Object.freeze({ inputBytes: PARSER_INPUT_MAX_BYTES, outputBytes: 4 * 1024 * 1024,
  scratchBytes: 128 * 1024 * 1024, memoryBytes: 512 * 1024 * 1024, walltimeMs: 180_000 });
export const ParserReviewSchema = z.object({
  version: z.literal(PARSER_ISOLATION_VERSION), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  runnerSha256: HashSchema, securityReviewId: z.string().min(1).max(200),
  reviewedBy: z.string().min(1).max(200), reviewedAt: z.iso.datetime(),
  dockerSocket: z.string().regex(/^\/run\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.sock$/),
}).strict();
export type ParserReview = z.infer<typeof ParserReviewSchema>;
export type ParserIsolationReason = 'security_review_required' | 'unavailable' | 'resource_limit' | 'command_failed' | 'request_rejected';
export class ParserIsolationError extends Error {
  readonly reason: ParserIsolationReason;
  constructor(reason: ParserIsolationReason) {
    super(`Document parser isolation held: ${reason}`);
    this.name = 'ParserIsolationError';
    this.reason = reason;
  }
}
export type ParserOutput = { stdout: string; stderr: string };
export type ParserSandbox = { run: (tool: string, args: string[], timeoutMs?: number) => Promise<ParserOutput> };
export type ParserSourceContext = ManagedSourceContext & { purpose: 'document' | 'classification' | 'artifact'; signal?: AbortSignal };
const inspectionSandboxes=new WeakMap<ParserSandbox,{context:ParserSourceContext;scopeSha256:string;sourceSha256:string}>();
function inspectionScopeSha256(context:ManagedSourceContext):string {
  const {signal:_signal,...scope}=context as ParserSourceContext;
  return digest(JSON.stringify(scope));
}
/** Reuse is possible only during the real callback, for its exact source snapshot and scope. */
export function assertParserSandboxRepresentation(sandbox:ParserSandbox,sourceSha256:string,context:ManagedSourceContext):void {
  const selected=inspectionSandboxes.get(sandbox);
  if (!selected || selected.context!==context || selected.sourceSha256!==sourceSha256
    || selected.scopeSha256!==inspectionScopeSha256(context)) throw new ParserIsolationError('request_rejected');
}
const execute = promisify(execFile);
const DOCKER = '/usr/bin/docker';
const MAX_PROTOCOL_BYTES = 12 * 1024 * 1024;
const ResponseSchema = z.union([
  z.object({ ready: z.literal(true) }).strict(),
  z.object({ ok: z.literal(true), stdout: z.string(), stderr: z.string() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['resource_limit', 'command_failed', 'request_rejected']) }).strict(),
]);

/** This hash can be inspected without launching Docker, a parser, or a model. */
export async function parserIsolationContractSha256(): Promise<string> {
  const adapters = await readdir(new URL('./adapters/', import.meta.url), { withFileTypes: true });
  if (adapters.some(entry => entry.isSymbolicLink() || entry.isDirectory())) throw new ParserIsolationError('security_review_required');
  const files = ['district-parser-isolation.ts', 'district-parser-worker.py', 'district-document.ts', 'district-document-parser-worker.ts',
    'district-policy-inspection.ts', 'district-policy-inspection-worker.ts', 'pdf-tdm-policy.ts', 'pdf-tdm-policy-worker.ts',
    'district-regional-statement-worker.ts', '../regional/statements.mjs',
    'document-origin.ts', 'document-origin-contract.ts', 'document-origin-rules.ts', 'source-policy.ts', 'public-address.ts',
    '../Dockerfile.parser', '../Dockerfile.parser.dockerignore',
    '../package.json', '../package-lock.json', 'district-adapter-contract.ts', 'district-structured-parser-worker.ts',
    'council-oparl.ts', 'dedupe.ts', 'common.ts', 'civic-opt-out.ts', 'civic-docker.ts',
    ...adapters.filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => 'adapters/' + entry.name)].sort();
  return semanticHash({ version: PARSER_ISOLATION_VERSION, files: await Promise.all(files.map(async file => ({ file, sha256: digest(await readFile(new URL(file, import.meta.url))) }))) });
}

export async function readParserReview(): Promise<ParserReview> {
  if (process.platform !== 'linux') throw new ParserIsolationError('unavailable');
  try {
    // No symlinks or caller-writable authorization file/ancestors. An env var cannot approve a sandbox.
    for (const path of ['/', '/etc', '/etc/stadtstack', PARSER_REVIEW_PATH]) {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 ||
          (path === PARSER_REVIEW_PATH ? !metadata.isFile() || metadata.size > 4096 : !metadata.isDirectory())) {
        throw new ParserIsolationError('security_review_required');
      }
    }
    const handle = await open(PARSER_REVIEW_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    let review: ParserReview;
    try {
      const metadata = await handle.stat();
      if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || metadata.size > 4096) throw new ParserIsolationError('security_review_required');
      review = ParserReviewSchema.parse(JSON.parse(await handle.readFile('utf8')));
    } finally { await handle.close(); }
    if (review.runnerSha256 !== await parserIsolationContractSha256() || Date.parse(review.reviewedAt) > Date.now()) {
      throw new ParserIsolationError('security_review_required');
    }
    return review;
  } catch (error) {
    if (error instanceof ParserIsolationError) throw error;
    throw new ParserIsolationError('security_review_required');
  }
}

/** Only fixed infrastructure values, never process.env, reach the Docker client. */
export function parserControllerEnvironment(jobRoot: string, socket: string): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
    HOME: join(jobRoot, 'home'), TMPDIR: jobRoot, DOCKER_CONFIG: join(jobRoot, 'docker-config'), DOCKER_HOST: `unix://${socket}` };
}

export function parserContainerArgs(imageId: string, name: string, artifactPath: string | null): string[] {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || !/^stadtstack-parser-[a-f0-9-]{36}$/.test(name) ||
      (artifactPath !== null && (!artifactPath.startsWith('/') || /[,\n\r]/.test(artifactPath)))) throw new ParserIsolationError('request_rejected');
  // --rm keeps crash cleanup with the daemon: if this controller dies, stdin closes, the
  // worker exits and Docker removes the container. Attached `run --rm` exits only after
  // removal, so the controller proves absence instead of racing its own forced removal.
  return ['run', '--rm', '--interactive', '--pull=never', '--name', name, '--network=none', '--ipc=none',
    '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
    '--pids-limit=32', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--ulimit=cpu=120:120',
    '--ulimit=nofile=64:64', '--ulimit=nproc=32:32', '--ulimit=fsize=33554432:33554432', '--ulimit=core=0:0',
    '--stop-timeout=1', '--log-driver=none', '--workdir=/scratch',
    '--tmpfs=/scratch:rw,noexec,nosuid,nodev,size=134217728,uid=65534,gid=65534,mode=0700',
    ...(artifactPath ? ['--mount', `type=bind,src=${artifactPath},dst=/input/document,readonly,bind-propagation=rprivate`] : []),
    '--entrypoint=/usr/bin/env', imageId, '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
    'LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'TZ=UTC', 'HOME=/scratch/home', 'TMPDIR=/scratch/tmp',
    'TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata', 'OMP_THREAD_LIMIT=1',
    '/usr/bin/python3', '-I', '-S', '/opt/stadtstack/parser-worker.py'];
}

function sandboxArgs(args: string[], originalPath: string | null): string[] {
  if (args.length > 32 || args.some(arg => arg.length > 65536 || arg.includes('\0'))) throw new ParserIsolationError('request_rejected');
  return args.map(arg => {
    if (originalPath && arg === originalPath) return '/input/document';
    if (originalPath && dirname(arg) === dirname(originalPath) && /^page-\d+(?:\.png)?$/.test(basename(arg))) return '/scratch/' + basename(arg);
    if (arg.startsWith('/') && arg !== '/input/document' && arg !== '/opt/stadtstack/src/district-structured-parser-worker.ts' && arg !== '/opt/stadtstack/src/district-document-parser-worker.ts' && arg !== '/opt/stadtstack/src/district-policy-inspection-worker.ts' && arg !== '/opt/stadtstack/src/pdf-tdm-policy-worker.ts' && arg !== '/opt/stadtstack/src/district-regional-statement-worker.ts' && !/^\/scratch\/page-\d+(?:\.png)?$/.test(arg)) throw new ParserIsolationError('request_rejected');
    return arg;
  });
}

/** One job, one selected read-only artifact, internal bounded scratch; never a host-parser fallback. */
export async function withParserSandbox<T>(artifact: string | Uint8Array | null, consume: (sandbox: ParserSandbox) => Promise<T>, sourceContext?: ParserSourceContext): Promise<T> {
  sourceContext?.signal?.throwIfAborted();
  const review = await readParserReview(); // This gate precedes all Docker operations.
  const scopeSha256=sourceContext?.purpose==='classification'&&artifact!==null?inspectionScopeSha256(sourceContext):undefined;
  if (artifact !== null && !sourceContext) throw new ParserIsolationError('request_rejected');
  try {
    const socket = await lstat(review.dockerSocket);
    if (!socket.isSocket() || (socket.uid !== 0 && socket.uid !== process.getuid?.())) throw new ParserIsolationError('unavailable');
  } catch { throw new ParserIsolationError('unavailable'); }
  const executeIn = async (jobRoot: string, scope?: ManagedSourceScratch): Promise<T> => {
    const env = parserControllerEnvironment(jobRoot, review.dockerSocket);
    const name = 'stadtstack-parser-' + randomUUID();
    let child: ChildProcess | undefined;
    let container: ManagedDockerContainer | undefined;
    let session: ManagedDockerSession | undefined;
    let stdin: Writable | undefined, stdout: Readable | undefined, stderr: Readable | undefined;
    let timer: NodeJS.Timeout | undefined;
    let pending: { resolve: (value: z.infer<typeof ResponseSchema>) => void; reject: (error: Error) => void } | undefined;
    let failure: Error | undefined;
    let abort: ((error: Error) => void) | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      abort?.(failure);
      pending?.reject(failure);
      pending = undefined;
      stdin?.destroy();
      child?.kill('SIGKILL');
    };
    const cancelled = () => fail(scope?.signal.reason instanceof Error ? scope.signal.reason : new ParserIsolationError('unavailable'));
    scope?.signal.addEventListener('abort', cancelled, { once: true });
    try {
      await scope?.assertActive();
      await Promise.all([mkdir(env.HOME!, { mode: 0o700 }), mkdir(env.DOCKER_CONFIG!, { mode: 0o700 })]);
      let selected: string | null = null;
      let selectedSha256:string|undefined;
      if (artifact !== null) {
        let bytes: Uint8Array;
        if (typeof artifact === 'string') {
          // Host-only authority code is deliberately absent from the credential-free image.
          const { assertManagedSourceReadable } = await import('./civic-opt-out.ts');
          if (!sourceContext) throw new ParserIsolationError('request_rejected');
          const { purpose: _purpose, ...readContext } = sourceContext;
          for (const binding of sourceContext.bindings) await assertManagedSourceReadable(artifact, { ...readContext, sourceUrl: binding.url });
          const handle = await open(artifact, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const metadata = await handle.stat();
            if (!metadata.isFile() || metadata.size > PARSER_LIMITS.inputBytes) throw new ParserIsolationError('request_rejected');
            const buffer = Buffer.allocUnsafe(metadata.size + 1);
            let total = 0;
            while (total < buffer.length) {
              const result = await handle.read(buffer, total, buffer.length - total, null);
              if (!result.bytesRead) break;
              total += result.bytesRead;
            }
            const after = await handle.stat();
            if (total !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) throw new ParserIsolationError('request_rejected');
            bytes = buffer.subarray(0, total);
          } finally { await handle.close(); }
        } else bytes = artifact;
        if (bytes.byteLength > PARSER_LIMITS.inputBytes) throw new ParserIsolationError('request_rejected');
        selected = join(jobRoot, 'document');
        if (!scope) throw new ParserIsolationError('request_rejected');
        const contentSha256 = digest(bytes);
        selectedSha256=contentSha256;
        if (sourceContext?.bindings.some(binding => 'sourceSha256' in binding && binding.sourceSha256 === contentSha256)) {
          await scope.writeSource('document', bytes);
        } else {
          // Derived bundles retain ALL original scope bindings; never label their digest as an original.
          await scope.assertActive();
          const handle = await open(selected, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          await scope.assertActive();
        }
        await chmod(selected, 0o444); // Parent 0700 scope stays private; only this file is mounted.
        await scope.assertActive();
      }
      let buffer = '';
      const receive = () => new Promise<z.infer<typeof ResponseSchema>>((resolve, reject) => {
        if (failure) { reject(failure); return; }
        if (pending) { reject(new ParserIsolationError('request_rejected')); return; }
        pending = { resolve, reject };
      });
      if (scope) {
        container = await scope.createContainer({ socketPath: review.dockerSocket, imageId: review.imageId, contractSha256: review.runnerSha256, artifactRelativePath: selected ? 'document' : null });
        session = await container.start();
        ({ stdin, stdout, stderr } = session);
      } else {
        // Source-free tool-version/probe jobs cannot receive an artifact.
        const binary = await lstat(DOCKER);
        if (!binary.isFile() || binary.uid !== 0 || (binary.mode & 0o022) !== 0) throw new ParserIsolationError('unavailable');
        child = spawn(DOCKER, parserContainerArgs(review.imageId, name, null), { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        stdin = child.stdin!; stdout = child.stdout!; stderr = child.stderr!;
        child.on('error', () => fail(new ParserIsolationError('unavailable')));
        child.on('exit', () => fail(new ParserIsolationError('unavailable')));
      }
      const stopped = new Promise<never>((_resolve, reject) => { abort = reject; });
      const ready = Promise.race([receive(), stopped]);
      if (session) void session.completion.then(() => fail(new ParserIsolationError('unavailable')), () => fail(new ParserIsolationError('unavailable')));
      stdin.on('error', () => fail(new ParserIsolationError('unavailable')));
      let stderrBytes = 0;
      stderr.on('data', (data: Buffer) => { stderrBytes += data.length; if (stderrBytes > 16 * 1024) fail(new ParserIsolationError('resource_limit')); });
      stdout.setEncoding('utf8');
      stdout.on('data', (data: string) => {
        buffer += data;
        if (Buffer.byteLength(buffer) > MAX_PROTOCOL_BYTES) { fail(new ParserIsolationError('resource_limit')); return; }
        while (buffer.includes('\n')) {
          const boundary = buffer.indexOf('\n');
          const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
          try {
            const response = ResponseSchema.parse(JSON.parse(line));
            if (!pending) { fail(new ParserIsolationError('request_rejected')); return; }
            const request = pending; pending = undefined; request.resolve(response);
          } catch { fail(new ParserIsolationError('request_rejected')); return; }
        }
      });
      timer = setTimeout(() => fail(new ParserIsolationError('resource_limit')), PARSER_LIMITS.walltimeMs);
      if (!('ready' in await ready)) throw new ParserIsolationError('unavailable');
      const run = async (tool: string, args: string[], timeoutMs?: number): Promise<ParserOutput> => {
        await scope?.assertActive();
        if (!PARSER_TOOLS.includes(tool as ParserTool) || pending) throw new ParserIsolationError('request_rejected');
        if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PARSER_LIMITS.walltimeMs)) throw new ParserIsolationError('request_rejected');
        const request = JSON.stringify({ tool, args: sandboxArgs(args, typeof artifact === 'string' ? artifact : null) }) + '\n';
        if (Buffer.byteLength(request) > 128 * 1024) throw new ParserIsolationError('request_rejected');
        const result = receive();
        // Tool-specific deadlines exclude durable host enrollment; cancellation
        // and the independent supervisor/whole-job bounds still cover the job.
        const commandTimer = timeoutMs === undefined ? undefined : setTimeout(() => fail(new DOMException('Parser command timed out', 'TimeoutError')), timeoutMs);
        let response: z.infer<typeof ResponseSchema>;
        try { stdin!.write(request); response = await result; }
        finally { clearTimeout(commandTimer); }
        if ('ready' in response) throw new ParserIsolationError('request_rejected');
        if (!response.ok) throw new ParserIsolationError(response.reason);
        const decode = (value: string) => {
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ParserIsolationError('request_rejected');
          const bytes = Buffer.from(value, 'base64');
          if (bytes.length > PARSER_LIMITS.outputBytes) throw new ParserIsolationError('resource_limit');
          return bytes.toString('utf8');
        };
        await scope?.assertActive();
        return { stdout: decode(response.stdout), stderr: decode(response.stderr) };
      };
      const sandbox:ParserSandbox={run};
      if(sourceContext&&scopeSha256&&selectedSha256)inspectionSandboxes.set(sandbox,{context:sourceContext,scopeSha256,sourceSha256:selectedSha256});
      try {
        const result = await Promise.race([consume(sandbox), stopped]);
        await scope?.assertActive();
        return result;
      } finally { inspectionSandboxes.delete(sandbox); }
    } finally {
      clearTimeout(timer);
      scope?.signal.removeEventListener('abort', cancelled);
      stdin?.end();
      if (container) await container.remove(); // Canonical durable removal proof precedes scratch unlink.
      if (child) {
        const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve(true)
          : new Promise<boolean>(resolve => child!.once('exit', () => resolve(true)));
        let exitTimer: NodeJS.Timeout | undefined;
        const exitedInTime = await Promise.race([exited, new Promise<boolean>(resolve => { exitTimer = setTimeout(() => resolve(false), 10_000); })]);
        clearTimeout(exitTimer);
        // Only a normal CLI exit implies the attached `run --rm` saw daemon-side removal; a
        // killed/failed CLI (timeouts and failures SIGKILL it) can leave the worker running.
        if (!exitedInTime || child.exitCode !== 0 || child.signalCode !== null) {
          try { await execute(DOCKER, ['rm', '--force', name], { env, timeout: 10_000, maxBuffer: 16 * 1024, encoding: 'utf8' }); }
          catch { /* absence below is the only cleanup proof */ }
          child.kill('SIGKILL');
        }
        let present = true;
        try { await execute(DOCKER, ['container', 'inspect', '--format', '{{.Id}}', name], { env, timeout: 10_000, maxBuffer: 16 * 1024, encoding: 'utf8' }); }
        catch (error) {
          const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
          present = !/No such (?:container|object)/i.test(stderr);
        }
        if (present) throw new ParserIsolationError('unavailable');
      }
    }
  };
  if (sourceContext) {
    // Platform-specific host lifecycle is not present in the read-only parser image.
    const { withManagedSourceScratch } = await import('./civic-opt-out.ts');
    return withManagedSourceScratch(sourceContext.root, sourceContext.bindings, scope => executeIn(scope.directory, scope), sourceContext);
  }
  const jobRoot = await mkdtemp(join(tmpdir(), 'stadtstack-parser-tools-'));
  try { return await executeIn(jobRoot); } finally { await rm(jobRoot, { recursive: true, force: true }); }
}

export async function collectParserToolVersions(tools: readonly ParserTool[], sourceContext?: ParserSourceContext): Promise<Record<string, string>> {
  return withParserSandbox(null, async sandbox => {
    const versions: Record<string, string> = {};
    for (const tool of tools) {
      const result = await sandbox.run(tool, [tool.startsWith('pdf') ? '-v' : '--version']);
      const line = (result.stdout + '\n' + result.stderr).split('\n').find(line => line.trim());
      if (!line || line.length > 300 || !/\d/.test(line)) throw new ParserIsolationError('command_failed');
      versions[tool] = line.trim();
    }
    return versions;
  }, sourceContext);
}
