"""Private parser protocol; only invoked inside the reviewed, networkless image."""
import base64
import json
import os
import resource
import re
import selectors
import signal
import subprocess
import sys
import time
TOOLS = {name: '/usr/bin/' + name for name in
         ('pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract', 'python3')}
TOOLS['node'] = '/usr/local/bin/node'
ENV = {
    'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
    'TZ': 'UTC', 'HOME': '/scratch/home', 'TMPDIR': '/scratch/tmp',
    'TESSDATA_PREFIX': '/usr/share/tesseract-ocr/5/tessdata',
    'OMP_THREAD_LIMIT': '1',
}
MAX_OUTPUT = 4 * 1024 * 1024
MAX_REQUEST = 128 * 1024

def assert_isolation():
    # A Docker warning about ignored limits is not an acceptable sandbox.
    if os.getuid() != 65534 or os.getgid() != 65534:
        raise RuntimeError('isolation')
    if not os.statvfs('/').f_flag & os.ST_RDONLY:
        raise RuntimeError('isolation')
    scratch = os.statvfs('/scratch')
    if not 0 < scratch.f_blocks * scratch.f_frsize <= 128 * 1024 * 1024:
        raise RuntimeError('isolation')
    required = os.ST_NOEXEC | os.ST_NOSUID | os.ST_NODEV
    if scratch.f_flag & required != required:
        raise RuntimeError('isolation')
    if os.path.exists('/input/document') and not os.statvfs('/input/document').f_flag & os.ST_RDONLY:
        raise RuntimeError('isolation')
    if any(name != 'lo' for name in os.listdir('/sys/class/net')):
        raise RuntimeError('isolation')
    with open('/proc/self/status', encoding='ascii') as source:
        status = dict(line.rstrip().split(':', 1) for line in source if ':' in line)
    if int(status['CapEff'].strip(), 16) != 0 or status['NoNewPrivs'].strip() != '1':
        raise RuntimeError('isolation')
    # Require cgroup v2's observable, enforced job limits rather than an unbounded rootless daemon.
    for filename, maximum in (('memory.max', 512 * 1024 * 1024), ('memory.swap.max', 0), ('pids.max', 32)):
        with open('/sys/fs/cgroup/' + filename, encoding='ascii') as source:
            value = source.read(100).strip()
        if value == 'max' or int(value) > maximum:
            raise RuntimeError('isolation')
    with open('/sys/fs/cgroup/cpu.max', encoding='ascii') as source:
        quota, period = source.read(100).split()
    if quota == 'max' or int(quota) > int(period):
        raise RuntimeError('isolation')


def reply(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def command_failure_reason(name, args, status, stderr):
    # Exit 64 is reserved by the fixed policy worker for a proven elision refusal.
    if name == 'node' and status == 64 and '/opt/stadtstack/src/district-policy-inspection-worker.ts' in args:
        return 'request_rejected'
    if name == 'node' and b'FATAL ERROR:' in stderr and b'heap out of memory' in stderr:
        return 'heap_limit'
    return 'command_failed'


def run_tool(request):
    name = request.get('tool')
    args = request.get('args')
    if name not in TOOLS or not isinstance(args, list) or len(args) > 32:
        raise ValueError('request')
    if any(not isinstance(arg, str) or '\x00' in arg or len(arg) > 65536 for arg in args):
        raise ValueError('request')
    if name == 'python3':
        # -I ignores user/environment startup configuration; -S excludes site packages.
        args = ['-I', '-S'] + args
    elif name == 'node':
        # Type stripping uses Wasm; explicit bounds checks avoid its 10-GiB
        # virtual-memory trap-handler reservation under our fixed RLIMIT_AS.
        args = ['--disable-wasm-trap-handler', '--max-old-space-size=256'] + args
    def child_limits():
        # V8 reserves a multi-GB address cage; the cgroup still caps resident memory at 512 MiB.
        limit = 8 * 1024 * 1024 * 1024 if name == 'node' else 512 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    process = subprocess.Popen([TOOLS[name]] + args, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=ENV, close_fds=True, start_new_session=True,
                               preexec_fn=child_limits)
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    deadline = time.monotonic() + 120
    try:
        with selectors.DefaultSelector() as selector:
            for stream, label in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, label)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('deadline')
                for key, _ in selector.select(min(remaining, 0.25)):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    target = buffers[key.data]
                    if len(target) + len(data) > MAX_OUTPUT:
                        raise OverflowError('resource_limit')
                    target.extend(data)
            status = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        if status != 0:
            return {'ok': False, 'reason': command_failure_reason(name, args, status, buffers['stderr'])}
        return {'ok': True, **{key: base64.b64encode(value).decode('ascii')
                              for key, value in buffers.items()}}
    finally:
        # A parser must not leave grandchildren running between commands.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()
        process.stderr.close()
        if name == 'tesseract' and args and args[0].startswith('/scratch/page-') and args[0].endswith('.png'):
            try:
                os.unlink(args[0])
            except FileNotFoundError:
                pass


def assert_node_security_version():
    # Source-free probe before readiness: the image review alone must not let an
    # old HTTP/TLS/Brotli-vulnerable Node binary consume an untrusted document.
    result = run_tool({'tool': 'node', 'args': ['--version']})
    if not result.get('ok'):
        raise RuntimeError('security_review_required')
    version = base64.b64decode(result['stdout'], validate=True).decode('ascii')
    match = re.fullmatch(r'v(22|24)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\n?', version)
    if not match:
        raise RuntimeError('security_review_required')
    major, minor, patch = map(int, match.groups())
    if not (major == 22 and (minor, patch) >= (23, 4)
            or major == 24 and (minor, patch) >= (22, 1)):
        raise RuntimeError('security_review_required')


def main():
    os.environ.clear()
    os.environ.update(ENV)
    os.umask(0o077)
    os.closerange(3, 1024)
    for kind, value in ((resource.RLIMIT_CORE, 0), (resource.RLIMIT_NOFILE, 64),
                        (resource.RLIMIT_NPROC, 32), (resource.RLIMIT_CPU, 120),
                        (resource.RLIMIT_AS, 8 * 1024 * 1024 * 1024),
                        (resource.RLIMIT_FSIZE, 32 * 1024 * 1024)):
        resource.setrlimit(kind, (value, value))
    # Enforced inside the container even if the host controller disappears.
    signal.alarm(180)
    assert_isolation()
    os.makedirs(ENV['HOME'], mode=0o700, exist_ok=True)
    os.makedirs(ENV['TMPDIR'], mode=0o700, exist_ok=True)
    assert_node_security_version()
    reply({'ready': True})
    while True:
        line = sys.stdin.buffer.readline(MAX_REQUEST + 1)
        if not line:
            return
        if len(line) > MAX_REQUEST or not line.endswith(b'\n'):
            reply({'ok': False, 'reason': 'request_rejected'})
            return
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or set(request) != {'tool', 'args'}:
                raise ValueError('request')
            reply(run_tool(request))
        except (TimeoutError, subprocess.TimeoutExpired):
            reply({'ok': False, 'reason': 'deadline'})
        except (MemoryError, OverflowError):
            reply({'ok': False, 'reason': 'resource_limit'})
        except Exception:
            # Never return parser stderr, command arguments or input contents on failure.
            reply({'ok': False, 'reason': 'command_failed'})


if __name__ == '__main__':
    main()
