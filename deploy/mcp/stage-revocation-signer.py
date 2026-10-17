#!/usr/bin/python3
"""Install a separately reviewed root-owned copy; never invoke this file from a home directory as root."""
import argparse
import base64
import ctypes
import hashlib
import json
import io
import os
import pathlib
import re
import resource
import shutil
import selectors
import signal
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time

STAGES = pathlib.Path('/var/lib/stadtstack-signer-stages')
OUTPUT = pathlib.Path('/var/lib/stadtstack-cohorts/0.3.2')
NODE_NAME = 'node-v24.21.0-linux-x64'
NODE_ORIGIN = 'https://nodejs.org/dist/v24.21.0/'
SELECTED = (
    'deploy/mcp/sign-revocation-cohort.mjs',
    'stadtstack-data/package.json', 'stadtstack-data/package-lock.json',
    'stadtstack-data/src/civic-revocations.ts',
    'stadtstack-data/src/mcp-revocation-config.ts',
    'stadtstack-data/src/data-release.ts', 'stadtstack-data/release',
)
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1',
       'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_CONFIG_GLOBAL': '/dev/null',
       'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0',
       'GIT_NO_LAZY_FETCH': '1', 'GIT_ALLOW_PROTOCOL': ''}

# Hard acceptance budgets; quota counts bytes even after temporary inputs are removed.
MIB = 1024 * 1024
STAGE_BYTES = 2 * 1024 * MIB
OBJECT_BYTES, OBJECT_COUNT = 512 * MIB, 200_000
SOURCE_BYTES, SOURCE_FILE_BYTES = 512 * MIB, 128 * MIB
NODE_ARCHIVE_BYTES, NODE_FILE_BYTES = 64 * MIB, 256 * MIB
NODE_EXPANDED_BYTES, NODE_MEMBERS = 512 * MIB, 20_000
ZOD_ARCHIVE_BYTES, ZOD_EXPANDED_BYTES, ZOD_MEMBERS = 8 * MIB, 32 * MIB, 2_000
CHECKSUM_BYTES = MIB
CHUNK_BYTES = 64 * 1024
COMMAND_SECONDS, COMMAND_CPU_SECONDS = 300, 120


class StageBudget:
    def __init__(self):
        self.used = 0

    def charge(self, amount):
        if amount < 0 or self.used + amount > STAGE_BYTES:
            raise ValueError('Aggregate staging byte quota exceeded')
        self.used += amount


def child_limits(node=False):
    # V8 reserves virtual address space; its heap has a separate explicit 256 MiB cap.
    address_bytes = (16 * 1024 if node else 1024) * MIB
    resource.setrlimit(resource.RLIMIT_AS, (address_bytes, address_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (COMMAND_CPU_SECONDS, COMMAND_CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (OBJECT_BYTES, OBJECT_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def subprocess_limits(node, user):
    child_limits(node)
    if user is not None:
        os.setgroups([])
        os.setgid(user[1])
        os.setuid(user[0])


def execute(args, output, max_bytes, cwd=None, input_bytes=None, budget=None, prefix_check=None, node=False, user=None):
    process = subprocess.Popen(args, cwd=cwd, env=ENV, stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                               preexec_fn=lambda: subprocess_limits(node, user))
    total, errors, prefix = 0, 0, bytearray()
    deadline = time.monotonic() + COMMAND_SECONDS
    try:
        if input_bytes is not None:
            process.stdin.write(input_bytes)
            process.stdin.close()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, True)
            selector.register(process.stderr, selectors.EVENT_READ, False)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Command wall-clock budget exceeded')
                for key, _ in selector.select(min(remaining, 1)):
                    chunk = os.read(key.fileobj.fileno(), CHUNK_BYTES)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    if not key.data:
                        errors += len(chunk)
                        if errors > CHUNK_BYTES:
                            raise ValueError('Command diagnostic byte budget exceeded')
                        continue
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError('Command output byte budget exceeded')
                    if prefix_check is not None and len(prefix) < 12:
                        prefix.extend(chunk[:12 - len(prefix)])
                        if len(prefix) == 12:
                            prefix_check(prefix)
                    if budget is not None:
                        budget.charge(len(chunk))
                    output.write(chunk)
        if process.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
            raise ValueError('Bounded command failed')
        return total
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()
        process.stderr.close()
        if process.stdin is not None:
            process.stdin.close()


def pack_header(prefix):
    magic, version, count = struct.unpack('>4sII', prefix)
    if magic != b'PACK' or version not in (2, 3) or not 0 < count <= OBJECT_COUNT:
        raise ValueError('Git pack header/object-count budget rejected')


def trusted_chain(path, mode=None):
    for part in (*reversed(path.parents), path):
        info = part.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Unsafe root directory chain')
    if mode is not None and stat.S_IMODE(path.lstat().st_mode) != mode:
        raise ValueError('Unexpected directory mode')


def ensure_directory(path, mode):
    trusted_chain(path.parent)
    try:
        path.mkdir(mode=mode)
        path.chmod(mode)  # Restore only our newly created directory after umask 077.
    except FileExistsError:
        pass
    trusted_chain(path, mode)


def run(args, cwd=None, node=False, user=None):
    output = io.BytesIO()
    execute(args, output, 8 * MIB, cwd=cwd, node=node, user=user)
    return output.getvalue()


def command_file(args, path, max_bytes, budget, input_bytes=None, prefix_check=None, expected_bytes=None, user=None):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        size = execute(args, stream, max_bytes, input_bytes=input_bytes, budget=budget, prefix_check=prefix_check, user=user)
        if size <= 0 or expected_bytes is not None and size != expected_bytes:
            raise ValueError('Command file size mismatch')
        stream.flush()
        os.fsync(stream.fileno())
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or os.fstat(stream.fileno()).st_size != size:
            raise ValueError('Command output must be a bounded regular file')


def download(url, path, max_bytes, budget):
    # Independent stdout cap also handles chunked responses without Content-Length.
    command_file(['/usr/bin/curl', '--disable', '--fail', '--silent', '--show-error',
                  '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2',
                  '--connect-timeout', '30', '--max-time', str(COMMAND_SECONDS),
                  '--max-filesize', str(max_bytes), url], path, max_bytes, budget)


def safe_members(archive, max_members, max_file_bytes, max_expanded_bytes, unused_links=False):
    seen, expanded = set(), 0
    for member in archive:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or len(path.parts) > 16 or len(member.name) > 4096 or member.name in seen:
            raise ValueError('Unsafe or duplicate archive member')
        seen.add(member.name)
        if len(seen) > max_members or not 0 <= member.size <= max_file_bytes:
            raise ValueError('Archive member count/size budget exceeded')
        expanded += member.size
        if expanded > max_expanded_bytes:
            raise ValueError('Archive expansion byte budget exceeded')
        if member.issparse() or not (member.isfile() or member.isdir() or unused_links and (member.issym() or member.islnk())):
            raise ValueError('Archive links, sparse and special files are forbidden')
        yield member


def exclusive_stream(path, source, expected_bytes, budget, mode=0o600):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, 'wb') as stream:
        size = 0
        while True:
            chunk = source.read(min(CHUNK_BYTES, expected_bytes - size + 1))
            if not chunk:
                break
            size += len(chunk)
            if size > expected_bytes:
                raise ValueError('Expanded member exceeds declared budget')
            budget.charge(len(chunk))
            stream.write(chunk)
        if size != expected_bytes:
            raise ValueError('Expanded member size mismatch')
        stream.flush()
        os.fsync(stream.fileno())


def exclusive_bytes(path, data, budget):
    exclusive_stream(path, io.BytesIO(data), len(data), budget)


def rename_absent(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        raise OSError(ctypes.get_errno(), 'Stage already exists or atomic publication failed')


def stage(args, destination):
    ensure_directory(STAGES, 0o700)
    ensure_directory(OUTPUT.parent, 0o755)
    ensure_directory(OUTPUT, 0o755)
    temporary = pathlib.Path(tempfile.mkdtemp(prefix='.pending-', dir=STAGES))
    try:
        budget = StageBudget()
        # Reserve bounded Git-generated metadata/index files and filesystem-entry headroom.
        budget.charge(544 * MIB)
        clone = temporary / 'objects'
        source = pathlib.Path(args.source).resolve(strict=True)
        if not source.is_dir():
            raise ValueError('Source must be a local Git repository directory')
        owner = source.stat()
        if owner.st_uid == 0:
            raise ValueError('Source must be a normal-user-owned repository')
        source_user = (owner.st_uid, owner.st_gid)
        source_git = ['/usr/bin/git', '--no-replace-objects', '-c', 'safe.directory=',
                      '-c', 'safe.directory=' + str(source), '-c', 'core.fsmonitor=false',
                      '-c', 'core.hooksPath=/dev/null', '-c', 'pack.threads=1', '-C', str(source)]
        common_directory = pathlib.Path(run(source_git + ['rev-parse', '--path-format=absolute', '--git-common-dir'], user=source_user).decode().strip())
        if (common_directory / 'objects/info/alternates').exists() or (common_directory / 'objects/info/alternates').is_symlink():
            raise ValueError('Source Git object alternates are forbidden')
        # Only the approved commit closure, never all unrelated user-controlled objects.
        # Source mutation is detected by root-side strict index-pack/fsck and the exact SHA.
        templates = temporary / 'empty-templates'
        templates.mkdir(mode=0o700)
        run(['/usr/bin/git', 'init', '--bare', '--template=' + str(templates), str(clone)])
        git = ['/usr/bin/git', '--no-replace-objects', '--git-dir=' + str(clone),
               '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
               '-c', 'pack.threads=1', '-c', 'pack.writeReverseIndex=false']
        incoming = clone / 'objects/pack/approved.pack'
        command_file(source_git + ['pack-objects', '--revs', '--stdout', '--window=0',
                                   '--depth=50', '--window-memory=64m', '--threads=1'],
                     incoming, OBJECT_BYTES - 32 * MIB, budget, input_bytes=(args.commit + '\n').encode(),
                     prefix_check=pack_header, user=source_user)
        with incoming.open('rb') as stream:
            header = stream.read(12)
        if len(header) != 12:
            raise ValueError('Truncated Git pack header')
        pack_header(header)
        pack_hash = run(git + ['index-pack', '--strict', str(incoming)]).decode().strip()
        index = incoming.with_suffix('.idx')
        if not re.fullmatch(r'[a-f0-9]{40}', pack_hash) or not stat.S_ISREG(index.lstat().st_mode) or index.stat().st_size > 32 * MIB:
            raise ValueError('Git index identity/byte budget rejected')
        incoming.rename(incoming.parent / ('pack-' + pack_hash + '.pack'))
        index.rename(index.parent / ('pack-' + pack_hash + '.idx'))
        if run(git + ['rev-parse', '--verify', args.commit + '^{commit}']).decode().strip() != args.commit:
            raise ValueError('Approved SHA must identify the exact commit')
        run(git + ['update-ref', 'refs/heads/approved', args.commit])
        if run(git + ['for-each-ref', '--format=%(refname) %(objectname)']).decode().strip() != 'refs/heads/approved ' + args.commit:
            raise ValueError('Only the approved commit ref may be present')
        run(git + ['fsck', '--full', '--strict', '--no-reflogs'])
        entries = run(git + ['ls-tree', '-r', '-z', args.commit, '--', *SELECTED])
        repo = temporary / 'repo'
        repo.mkdir(mode=0o700)
        exported = set()
        source_bytes = 0
        for entry in entries.split(b'\0'):
            if not entry:
                continue
            metadata, name = entry.split(b'\t', 1)
            mode, kind, object_id = metadata.split(b' ')
            relative = pathlib.PurePosixPath(name.decode('utf-8'))
            if mode not in (b'100644', b'100755') or kind != b'blob' or relative.is_absolute() or '..' in relative.parts or len(relative.parts) > 6 or len(name) > 4096:
                raise ValueError('Only committed regular source/release files are allowed')
            target = repo.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            # cat-file does not apply .gitattributes, checkout filters or export substitutions.
            size = int(run(git + ['cat-file', '-s', object_id.decode()]))
            file_limit = 4 * MIB if str(relative) in ('stadtstack-data/package.json', 'stadtstack-data/package-lock.json', 'stadtstack-data/release/release-manifest.json') else SOURCE_FILE_BYTES
            source_bytes += size
            if not 0 < size <= file_limit or source_bytes > SOURCE_BYTES or len(exported) >= 10_000:
                raise ValueError('Approved source export byte/file-count budget exceeded')
            command_file(git + ['cat-file', 'blob', object_id.decode()], target, size, budget, expected_bytes=size)
            exported.add(str(relative))
        required = set(SELECTED[:-1]) | {'stadtstack-data/release/release-manifest.json'}
        if not required <= exported:
            raise ValueError('Approved commit lacks signer, canonical code or sealed release')
        shutil.rmtree(clone)
        package = repo / 'stadtstack-data'
        shutil.rmtree(templates)
        if json.loads((package / 'package.json').read_text())['version'] != '0.3.2':
            raise ValueError('Only 0.3.2 may be staged')
        lock = json.loads((package / 'package-lock.json').read_text())
        if lock.get('version') != '0.3.2' or lock['packages']['']['version'] != '0.3.2':
            raise ValueError('Lockfile version mismatch')
        zod = lock['packages']['node_modules/zod']
        if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', zod['version']):
            raise ValueError('Invalid locked Zod version')
        zod_url = 'https://registry.npmjs.org/zod/-/zod-' + zod['version'] + '.tgz'
        if zod['resolved'] != zod_url or not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', zod['integrity']):
            raise ValueError('Exact npm registry URL and SHA512 integrity required')
        download(NODE_ORIGIN + 'SHASUMS256.txt', temporary / 'SHASUMS256.txt', CHECKSUM_BYTES, budget)
        node_tar = temporary / (NODE_NAME + '.tar.xz')
        download(NODE_ORIGIN + node_tar.name, node_tar, NODE_ARCHIVE_BYTES, budget)
        matches = []
        for line in (temporary / 'SHASUMS256.txt').read_text().splitlines():
            fields = line.split()
            if len(fields) == 2 and fields[1] == node_tar.name:
                matches.append(fields[0])
        if len(matches) != 1 or not re.fullmatch(r'[a-f0-9]{64}', matches[0]):
            raise ValueError('Missing or ambiguous official Node SHA256')
        with node_tar.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != matches[0]:
                raise ValueError('Node SHA256 mismatch')
        runtime = temporary / 'runtime'
        runtime.mkdir(mode=0o700)
        found_node = False
        with tarfile.open(node_tar, 'r|xz') as archive:
            for member in safe_members(archive, NODE_MEMBERS, NODE_FILE_BYTES, NODE_EXPANDED_BYTES, unused_links=True):
                if member.name != NODE_NAME + '/bin/node':
                    continue
                if not member.isfile() or member.size <= 0:
                    raise ValueError('Node executable must be a bounded regular archive member')
                with archive.extractfile(member) as stream:
                    exclusive_stream(runtime / 'node', stream, member.size, budget, 0o700)
                found_node = True
        if not found_node:
            raise ValueError('Verified archive lacks the Node executable')
        zod_tar = temporary / 'zod.tgz'
        download(zod_url, zod_tar, ZOD_ARCHIVE_BYTES, budget)
        with zod_tar.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha512').digest()
        if digest != base64.b64decode(zod['integrity'][7:], validate=True):
            raise ValueError('Zod SHA512 integrity mismatch')
        dependency = package / 'node_modules/zod'
        dependency.mkdir(parents=True, mode=0o700)
        with tarfile.open(zod_tar, 'r|gz') as archive:
            for member in safe_members(archive, ZOD_MEMBERS, ZOD_EXPANDED_BYTES, ZOD_EXPANDED_BYTES):
                parts = pathlib.PurePosixPath(member.name).parts
                if parts[0] != 'package':
                    raise ValueError('Unexpected npm tarball root')
                target = dependency.joinpath(*parts[1:])
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    with archive.extractfile(member) as stream:
                        exclusive_stream(target, stream, member.size, budget)
        if json.loads((dependency / 'package.json').read_text())['version'] != zod['version']:
            raise ValueError('Extracted dependency version mismatch')
        node_tar.unlink()
        zod_tar.unlink()
        (temporary / 'SHASUMS256.txt').unlink()
        exclusive_bytes(temporary / 'stage.json', json.dumps({
            'version': '0.3.2', 'sourceSha': args.commit, 'sequence': args.sequence,
            'nodeVersion': '24.21.0', 'nodeArchiveSha256': matches[0],
            'zodVersion': zod['version'], 'zodIntegrity': zod['integrity'],
        }).encode(), budget)
        # Verify the candidate with the canonical codec before publishing the stage, without a key.
        run([str(runtime / 'node'), '--max-old-space-size=256', '--input-type=module', '-e',
             "import {verifyDataRelease} from './repo/stadtstack-data/src/data-release.ts'; await verifyDataRelease('./repo/stadtstack-data/release');"], cwd=temporary, node=True)
        for current, directories, files in os.walk(temporary, topdown=False):
            for name in files:
                path = pathlib.Path(current) / name
                path.chmod(0o555 if path == runtime / 'node' else 0o444)
            pathlib.Path(current).chmod(0o700 if pathlib.Path(current) == temporary else 0o555)
        rename_absent(temporary, destination)
        temporary = None
        print(json.dumps({'sourceSha': args.commit, 'sequence': args.sequence,
                          'stage': str(destination), 'version': '0.3.2'}))
    finally:
        if temporary is not None:
            shutil.rmtree(temporary)


def sign(args, destination):
    trusted_chain(destination, 0o700)
    for current, directories, files in os.walk(destination, followlinks=False):
        trusted_chain(pathlib.Path(current))
        for name in directories + files:
            path = pathlib.Path(current) / name
            info = path.lstat()
            if info.st_uid != 0 or info.st_mode & 0o022 or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError('Stage must contain only root-controlled regular files/directories')
    metadata = json.loads((destination / 'stage.json').read_text())
    if metadata['sourceSha'] != args.commit or metadata['sequence'] != args.sequence or metadata['version'] != '0.3.2':
        raise ValueError('Stage metadata mismatch')
    os.chdir(destination)
    os.execve(destination / 'runtime/node', [str(destination / 'runtime/node'),
              str(destination / 'repo/deploy/mcp/sign-revocation-cohort.mjs'),
              '--source-sha', args.commit, '--sequence', str(args.sequence)], {})


def main():
    if os.getuid() != 0:
        raise ValueError('Root-only staging/signing procedure')
    if sys.platform != 'linux' or os.uname().machine != 'x86_64':
        raise ValueError('This procedure is restricted to Linux x86_64')
    # The installed entry point itself and every ancestor must be protected before use.
    installed = pathlib.Path(__file__).absolute()
    trusted_chain(installed.parent)
    info = installed.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('Install the reviewed staging script in a root-controlled location first')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    for action in ('stage', 'sign'):
        sub = commands.add_parser(action)
        sub.add_argument('--commit', required=True)
        sub.add_argument('--sequence', required=True)
        if action == 'stage':
            sub.add_argument('--source', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{40}', args.commit) or not re.fullmatch(r'0|[1-9][0-9]*', args.sequence):
        raise ValueError('Exact lowercase 40-hex approved commit and sequence required')
    args.sequence = int(args.sequence)
    if args.sequence > 9007199254740991:
        raise ValueError('Sequence must be a nonnegative safe integer')
    destination = STAGES / (args.commit + '-s' + str(args.sequence))
    if args.action == 'stage':
        resource.setrlimit(resource.RLIMIT_AS, (1024 * MIB, 16 * 1024 * MIB))
        resource.setrlimit(resource.RLIMIT_CPU, (580, 600))
        resource.setrlimit(resource.RLIMIT_FSIZE, (OBJECT_BYTES, OBJECT_BYTES))
        def deadline_failure(signum, frame):
            raise TimeoutError('Staging process time budget exceeded')
        signal.signal(signal.SIGALRM, deadline_failure)
        signal.signal(signal.SIGXCPU, deadline_failure)
        signal.alarm(1800)
        stage(args, destination)
    else:
        sign(args, destination)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Root signer staging/signing failed; no unsigned fallback.', file=sys.stderr)
        sys.exit(1)
