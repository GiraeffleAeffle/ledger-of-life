"""Synthetic acceptance-boundary tests: no Docker, network, credentials or cluster."""
import ast
import base64
import contextlib
import datetime
import importlib.util
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import types
import unittest
from stat import S_ISDIR, S_ISREG
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent


def assigned_name(node):
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        return node.targets[0].id
    return None


def smoke_namespace(*names, **values):
    module = ast.parse((ROOT / 'smoke.py').read_text())
    nodes = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if len(nodes) != len(names):
        raise AssertionError('Smoke function boundary changed')
    namespace = {'os': os, 'pathlib': pathlib, 'hashlib': hashlib, 'json': json, 're': re, 'base64': base64, 'datetime': datetime, 'S_ISDIR': S_ISDIR, 'S_ISREG': S_ISREG, **values}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<smoke-functions>', 'exec'), namespace)
    return namespace


@contextlib.contextmanager
def synthetic_cohort():
    """Public synthetic bytes only; simulate root ownership without privileges."""
    with tempfile.TemporaryDirectory() as temporary:
        directory = pathlib.Path(temporary)
        directory.chmod(0o755)
        manifest = 'c' * 64
        spki = bytes.fromhex('302a300506032b6570032100') + bytes(32)
        key_id = 'ed25519:' + hashlib.sha256(spki).hexdigest()
        artifact = {'schemaVersion': 'stadtstack-signed-revocations-v1', 'algorithm': 'Ed25519', 'keyId': key_id, 'payload': {'schemaVersion': 'stadtstack-revocations-v1', 'releaseId': manifest, 'issuedAt': '2026-10-11T00:00:00.000Z', 'sequence': 0, 'targets': []}, 'signature': base64.b64encode(bytes(64)).decode()}
        artifact_bytes = json.dumps(artifact, sort_keys=True, separators=(',', ':')).encode()
        artifact_sha = hashlib.sha256(artifact_bytes).hexdigest()
        trust = {'schemaVersion': 'stadtstack-revocation-trust-v1', 'releaseId': manifest, 'expectedArtifactSha256': artifact_sha, 'keys': [{'keyId': key_id, 'publicKeySpki': base64.b64encode(spki).decode()}]}
        trust_path, artifact_path = directory / 'trust.json', directory / 'revocations.json'
        trust_path.write_text(json.dumps(trust)); artifact_path.write_bytes(artifact_bytes)
        trust_path.chmod(0o444); artifact_path.chmod(0o444)
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid')
        def root_metadata(value):
            result = types.SimpleNamespace(**{field: getattr(value, field) for field in fields})
            result.st_uid = 0
            return result
        real_lstat, real_fstat = pathlib.Path.lstat, os.fstat
        with mock.patch.object(pathlib.Path, 'lstat', lambda path: root_metadata(real_lstat(path))), mock.patch.object(os, 'fstat', lambda fd: root_metadata(real_fstat(fd))):
            yield types.SimpleNamespace(directory=directory, trust_path=trust_path, artifact_path=artifact_path, manifest=manifest, artifact_sha=artifact_sha, artifact=artifact, trust=trust, root_metadata=root_metadata, real_lstat=real_lstat, real_fstat=real_fstat)


class RuntimeAcceptanceTests(unittest.TestCase):
    def test_caller_receipt_is_rejected_before_environment_or_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            supplied = pathlib.Path(temporary) / 'forged.json'
            supplied.write_text(json.dumps({'passed': True, 'releaseVersion': '0.3.1'}))
            result = subprocess.run(
                [sys.executable, '-I', str(ROOT / 'deploy.py')],
                env={'PATH': os.defpath, 'MCP_SMOKE_EVIDENCE': str(supplied)},
                capture_output=True, text=True, timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('MCP_SMOKE_EVIDENCE is not accepted', result.stderr)
            self.assertEqual(json.loads(supplied.read_text()), {'passed': True, 'releaseVersion': '0.3.1'})

    def test_optimized_python_cannot_disable_smoke_assertions(self):
        result = subprocess.run(
            [sys.executable, '-I', '-O', str(ROOT / 'smoke.py')],
            env={'PATH': os.defpath}, capture_output=True, text=True, timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Acceptance requires Python assertions enabled', result.stderr)

    def test_failed_approved_producer_cannot_authorize_with_written_json(self):
        # Execute the real producer/validation block, but export a synthetic script
        # and intercept Docker cleanup. No downstream cluster code is included.
        module = ast.parse((ROOT / 'deploy.py').read_text())
        first = next(i for i, node in enumerate(module.body) if assigned_name(node) == 'approved_smoke')
        last = next(i for i, node in enumerate(module.body) if assigned_name(node) == 'runtime_acceptance')
        self.assertLess(first, last)
        block = compile(ast.Module(body=module.body[first:last + 1], type_ignores=[]), '<approved-smoke-boundary>', 'exec')
        revision, digest, version, manifest = 'a' * 40, 'sha256:' + 'b' * 64, '0.3.2', 'c' * 64
        image_tag = 'ghcr.io/giraeffleaeffle/stadtstack-mcp:' + version
        image = image_tag + '@' + digest
        producer = '''import json,os,pathlib,sys
args=sys.argv
value=lambda key:args[args.index(key)+1]
assert not any(key in os.environ for key in ('KUBECONFIG','KUBECTL','TALOSCONFIG','TALOSCTL','STADTSTACK_PRIVILEGED_LOCK_OWNER'))
version=value('--release-version');image=value('--image');revision='a'*40;manifest=value('--data-manifest-id')
assert pathlib.Path(value('--revocation-trust-file')).name=='trust.json'
assert pathlib.Path(value('--revocations-file')).name=='revocations.json'
artifact=value('--revocation-artifact-sha256');trust='e'*64
checks={'serverVersion':version,'statusReleaseVersion':version,'imageVersion':version,'imageRefName':version,'imageRevision':revision,'gitTag':version,'gitTagRevision':revision,'imageTagDigest':'sha256:'+'b'*64,'statusDataManifestId':manifest,'sharedDataRelease':manifest,'revocationArtifactSha256':artifact,'revocationTrustSha256':trust}
receipt={'passed':True,'image':image,'imageTag':version,'imageTagReference':image.split('@')[0],'releaseVersion':version,'dataManifestId':manifest,'revocationArtifactSha256':artifact,'revocationTrustSha256':trust,'acceptanceScope':'exact_local_image','runId':value('--run-id'),'imageProvenanceVerified':True,'runningImageIdentityVerified':True,'checks':checks}
pathlib.Path(value('--evidence')).write_text(json.dumps(receipt))
raise SystemExit(7)
'''
        calls = []

        def controlled_run(args, **kwargs):
            calls.append(args)
            if args[0] == 'git' and args[-1] == revision + ':deploy/mcp/smoke.py':
                return subprocess.CompletedProcess(args, 0, producer.encode(), b'')
            if args[:3] == ['docker', 'ps', '-aq']:
                return subprocess.CompletedProcess(args, 0, '', '')
            self.fail('Unexpected external command in isolated acceptance test')

        with tempfile.TemporaryDirectory() as temporary:
            evidence = pathlib.Path(temporary)
            evidence.chmod(0o700)
            isolated_os = types.SimpleNamespace(
                environ={'PATH': os.defpath, 'KUBECONFIG': 'synthetic-private-context', 'KUBECTL': 'must-not-execute'},
                getuid=os.getuid, killpg=os.killpg,
            )
            namespace = {
                'E': evidence, 'ROOT': evidence, 'revision': revision, 'digest': digest,
                'release_version': version, 'image_tag': image_tag, 'image': image,
                'approved_manifest_id': manifest, 'knowledge_municipality': 'synthetic-town', 'entity_query': None,
                'cohort_dir': evidence / 'cohort', 'cohort_artifact_sha256': 'd' * 64, 'cohort_trust_sha256': 'e' * 64,
                'os': isolated_os, 'sys': sys, 'secrets': secrets, 'hashlib': hashlib,
                'datetime': datetime, 'signal': signal, 'shutil': shutil, 'json': json, 're': re,
                'S_ISREG': S_ISREG,
                'subprocess': types.SimpleNamespace(run=controlled_run, Popen=subprocess.Popen, PIPE=subprocess.PIPE, TimeoutExpired=subprocess.TimeoutExpired),
            }
            previous_umask = os.umask(0o077)
            try:
                with self.assertRaisesRegex(RuntimeError, 'Approved exact-image smoke failed'):
                    exec(block, namespace)
            finally:
                os.umask(previous_umask)
            self.assertTrue(json.loads((evidence / 'runtime-smoke.json').read_text())['passed'])
            self.assertNotIn('runtime_acceptance', namespace)
            self.assertEqual(json.loads((evidence / 'smoke-execution.json').read_text())['exitCode'], 7)
            self.assertFalse((evidence / 'smoke-scratch').exists())
            self.assertTrue(all(call[0] in ('git', 'docker') for call in calls))

    def test_live_evidence_does_not_attest_a_supplied_image_digest(self):
        module = ast.parse((ROOT / 'smoke.py').read_text())
        candidates = []
        for node in ast.walk(module):
            if not isinstance(node, ast.If) or not isinstance(node.test, ast.Attribute):
                continue
            if not isinstance(node.test.value, ast.Name) or node.test.value.id != 'args' or node.test.attr != 'url':
                continue
            if any(isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name) and call.func.value.id == 'evidence' and call.func.attr == 'update' for child in node.body for call in ast.walk(child)):
                candidates.append(node)
        self.assertEqual(len(candidates), 1)
        supplied = 'ghcr.io/giraeffleaeffle/stadtstack-mcp:0.3.2@sha256:' + 'f' * 64
        evidence = {'passed': True, 'dataManifestId': 'c' * 64, 'revocationArtifactSha256': 'd' * 64, 'revocationTrustSha256': 'e' * 64}
        namespace = {'args': types.SimpleNamespace(url='https://example.invalid', image=supplied, release_version='0.3.2'), 'evidence': evidence, 'image_tag': supplied.split('@')[0]}
        exec(compile(ast.Module(body=candidates, type_ignores=[]), '<live-evidence-scope>', 'exec'), namespace)
        self.assertEqual(evidence['acceptanceScope'], 'public_endpoint_version_data')
        self.assertFalse(evidence['imageProvenanceVerified'])
        self.assertFalse(evidence['runningImageIdentityVerified'])
        self.assertEqual(evidence['suppliedImageReference'], supplied)
        self.assertNotIn('image', evidence)
        self.assertEqual(evidence['dataManifestId'], 'c' * 64)
        self.assertEqual(evidence['revocationArtifactSha256'], 'd' * 64)
        self.assertEqual(evidence['revocationTrustSha256'], 'e' * 64)

    def test_runtime_gate_requires_exact_cohort_hashes_and_manifest(self):
        module = ast.parse((ROOT / 'deploy.py').read_text())
        validation = next(node for node in module.body if isinstance(node, ast.If) and any(isinstance(child, ast.Constant) and child.value == 'Generated exact-image runtime evidence does not match the approved release' for child in ast.walk(node)))
        block = compile(ast.Module(body=[validation], type_ignores=[]), '<runtime-cohort-gate>', 'exec')
        revision, digest, manifest, artifact_sha, trust_sha = 'a' * 40, 'sha256:' + 'b' * 64, 'c' * 64, 'd' * 64, 'e' * 64
        version, nonce = '0.3.2', 'f' * 32
        image_tag = 'ghcr.io/giraeffleaeffle/stadtstack-mcp:' + version
        image = image_tag + '@' + digest
        checks = {'serverVersion': version, 'statusReleaseVersion': version, 'imageVersion': version, 'imageRefName': version, 'imageRevision': revision, 'gitTag': version, 'gitTagRevision': revision, 'imageTagDigest': digest, 'statusDataManifestId': manifest, 'sharedDataRelease': manifest, 'revocationArtifactSha256': artifact_sha, 'revocationTrustSha256': trust_sha}
        receipt = {'image': image, 'imageTag': version, 'imageTagReference': image_tag, 'releaseVersion': version, 'dataManifestId': manifest, 'revocationArtifactSha256': artifact_sha, 'revocationTrustSha256': trust_sha, 'passed': True, 'acceptanceScope': 'exact_local_image', 'runId': nonce, 'imageProvenanceVerified': True, 'runningImageIdentityVerified': True, 'checks': checks}
        namespace = {'image': image, 'image_tag': image_tag, 'release_version': version, 'revision': revision, 'digest': digest, 'approved_manifest_id': manifest, 'cohort_artifact_sha256': artifact_sha, 'cohort_trust_sha256': trust_sha, 'smoke_run_id': nonce}
        exec(block, {**namespace, 'smoke': receipt, 'smoke_checks': checks})
        for field in ('statusDataManifestId', 'sharedDataRelease', 'revocationArtifactSha256', 'revocationTrustSha256'):
            for invalid in (None, '0' * 64):
                altered = {**checks, field: invalid}
                with self.subTest(field=field, invalid=invalid), self.assertRaisesRegex(RuntimeError, 'does not match'):
                    exec(block, {**namespace, 'smoke': {**receipt, 'checks': altered}, 'smoke_checks': altered})
        for field in ('dataManifestId', 'revocationArtifactSha256', 'revocationTrustSha256'):
            for invalid in (None, '0' * 64):
                with self.subTest(top_level=field, invalid=invalid), self.assertRaisesRegex(RuntimeError, 'does not match'):
                    exec(block, {**namespace, 'smoke': {**receipt, field: invalid}, 'smoke_checks': checks})

    def test_local_smoke_never_reads_real_bearer_file(self):
        module = ast.parse((ROOT / 'smoke.py').read_text())
        assignment = next(node for node in module.body if assigned_name(node) == 'token')
        namespace = {'args': types.SimpleNamespace(url=None, person='max'), 'private': pathlib.Path('/must-not-read-real-tokens'), 'secrets': secrets}
        with mock.patch.object(pathlib.Path, 'read_text', side_effect=AssertionError('Local smoke read a real token')):
            exec(compile(ast.Module(body=[assignment], type_ignores=[]), '<disposable-local-token>', 'exec'), namespace)
        self.assertRegex(namespace['token'], r'^[A-Za-z0-9_-]{43}$')

    def test_analysis_profiles_preserve_existing_credentials_and_defaults(self):
        module = ast.parse((ROOT / 'deploy.py').read_text())
        assignment = next(node for node in module.body if assigned_name(node) == 'profile_check')
        script = ast.literal_eval(assignment.value)
        node = shutil.which('node')
        self.assertIsNotNone(node)
        validator = ROOT.parents[1] / 'stadtstack-data/src/mcp-token-config.mjs'
        current = [{'id': name, 'sha256': digit * 64} for name, digit in [('max', '1'), ('buzz', '2'), ('reader', '3')]]
        desired = [{**record, **({'limits': {'requestsPerMinute': 300, 'maxConcurrent': 8}} if record['id'] in ('max', 'buzz') else {})} for record in current]

        def validate(records):
            return subprocess.run(
                [node, '--input-type=module', '--eval', script, str(validator)],
                input=json.dumps({'current': json.dumps(current), 'desired': json.dumps(records)}),
                env={'PATH': os.defpath}, capture_output=True, text=True, timeout=10,
            )

        passed = validate(desired)
        self.assertEqual(passed.returncode, 0)
        profiles = {record['id']: record for record in json.loads(passed.stdout)}
        self.assertEqual(profiles['max']['limits'], {'requestsPerMinute': 300, 'maxConcurrent': 8})
        self.assertEqual(profiles['buzz']['limits'], profiles['max']['limits'])
        self.assertEqual(profiles['reader']['limits'], {'requestsPerMinute': 60, 'maxConcurrent': 4})
        for record in current:
            self.assertNotIn(record['sha256'], passed.stdout + passed.stderr)
        bad_values = []
        rotated = json.loads(json.dumps(desired)); rotated[0]['sha256'] = '4' * 64; bad_values.append(rotated)
        renamed = json.loads(json.dumps(desired)); renamed[0]['id'] = 'different'; bad_values.append(renamed)
        implicit = json.loads(json.dumps(desired)); del implicit[0]['limits']; bad_values.append(implicit)
        escalated = json.loads(json.dumps(desired)); escalated[2]['limits'] = {'requestsPerMinute': 300, 'maxConcurrent': 8}; bad_values.append(escalated)
        malformed = json.loads(json.dumps(desired)); malformed[0]['limits']['extra'] = True; bad_values.append(malformed)
        bad_values.append(desired[:-1])
        for records in bad_values:
            rejected = validate(records)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, '')
            self.assertIn('Invalid token policy or changed existing credential identities/digests', rejected.stderr)

    def test_secret_limit_update_tests_uid_and_resource_version_without_replacing_other_keys(self):
        module = ast.parse((ROOT / 'deploy.py').read_text())
        assignment = next(node for node in module.body if assigned_name(node) == 'secret_patch')
        records = [{'id': 'synthetic', 'sha256': 'a' * 64}]
        namespace = {'secret_uid': 'synthetic-uid', 'secret_resource_version': '42', 'records': records, 'base64': base64, 'json': json}
        exec(compile(ast.Module(body=[assignment], type_ignores=[]), '<hash-key-cas>', 'exec'), namespace)
        operations = namespace['secret_patch']
        self.assertEqual([(item['op'], item['path']) for item in operations], [
            ('test', '/metadata/uid'), ('test', '/metadata/resourceVersion'), ('replace', '/data/token-hashes.json'),
        ])
        self.assertEqual(operations[0]['value'], 'synthetic-uid')
        self.assertEqual(operations[1]['value'], '42')
        self.assertEqual(json.loads(base64.b64decode(operations[2]['value'])), records)


    def test_missing_or_malformed_existing_secret_is_not_permission_to_create_credentials(self):
        module = ast.parse((ROOT / 'deploy.py').read_text())
        first = next(i for i, node in enumerate(module.body) if assigned_name(node) == 'secret_snapshot')
        last = next(i for i, node in enumerate(module.body) if assigned_name(node) == 'hash_configuration')
        block = compile(ast.Module(body=module.body[first:last], type_ignores=[]), '<existing-secret-boundary>', 'exec')
        for status, text, expected in [
            (1, '', 'Existing governed auth Secret is required'),
            (0, 'synthetic-uid\n42\n', 'Existing auth Secret identity and token-hashes.json key are required'),
            (0, 'synthetic-uid\n42\nnot-base64!\n', 'Existing auth Secret hash configuration is malformed'),
        ]:
            calls = []
            def snapshot(args, **kwargs):
                calls.append(args)
                return types.SimpleNamespace(returncode=status, stdout=text)
            with self.assertRaisesRegex(RuntimeError, expected):
                exec(block, {'kub': snapshot, 'NS': 'synthetic-namespace', 'base64': base64})
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][2:4], ['get', 'secret'])

    def test_secret_compare_and_swap_failure_aborts_the_actual_update_statement(self):
        module = ast.parse((ROOT / 'deploy.py').read_text())
        index = next(i for i, node in enumerate(module.body) if assigned_name(node) == 'secret_patch')
        operations = module.body[index:index + 2]
        calls = []
        def conflict(args, payload):
            calls.append(args)
            raise RuntimeError('Synthetic resourceVersion conflict')
        namespace = {'secret_uid': 'synthetic-uid', 'secret_resource_version': 'stale', 'records': [], 'base64': base64, 'json': json, 'kub': conflict, 'NS': 'synthetic'}
        with self.assertRaisesRegex(RuntimeError, 'Synthetic resourceVersion conflict'):
            exec(compile(ast.Module(body=operations, type_ignores=[]), '<secret-conflict-boundary>', 'exec'), namespace)
        self.assertEqual(len(calls), 1)
        self.assertIn('--type=json', calls[0])
        self.assertIn('--patch-file=/dev/stdin', calls[0])


class RevocationCohortTests(unittest.TestCase):
    def test_exact_public_cohort_hashes_and_identity(self):
        validator = smoke_namespace('revocation_cohort')['revocation_cohort']
        with synthetic_cohort() as fixture:
            value = validator(str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)
            self.assertEqual(value['directory'], str(fixture.directory))
            self.assertEqual(value['revocationArtifactSha256'], fixture.artifact_sha)
            self.assertEqual(value['revocationTrustSha256'], hashlib.sha256(fixture.trust_path.read_bytes()).hexdigest())
            self.assertEqual(value['payload'], fixture.artifact['payload'])

    def test_local_image_mounts_projected_cohort_readonly_with_exact_env(self):
        module = ast.parse((ROOT / 'smoke.py').read_text())
        startup = next(node for node in module.body if isinstance(node, ast.Try) and node.body and isinstance(node.body[0], ast.If) and isinstance(node.body[0].test, ast.Attribute) and node.body[0].test.attr == 'url')
        local = startup.body[0].orelse
        first = next(index for index, node in enumerate(local) if assigned_name(node) == 'cohort_options')
        last = next(index for index, node in enumerate(local) if assigned_name(node) == 'container')
        block = compile(ast.Module(body=local[first:last + 1], type_ignores=[]), '<local-cohort-mount>', 'exec')
        with synthetic_cohort() as fixture, tempfile.TemporaryDirectory() as scratch:
            cohort_values = (str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)
            namespace = smoke_namespace('revocation_cohort', 'build_revocation_projection')
            calls = []
            def command(arguments):
                calls.append(arguments)
                return 'synthetic-container'
            image = 'ghcr.io/giraeffleaeffle/stadtstack-mcp:0.3.2@sha256:' + 'b' * 64
            namespace.update(cohort=namespace['revocation_cohort'](*cohort_values), cohort_values=cohort_values, args=types.SimpleNamespace(image=image), command=command, hashfile=pathlib.Path('/synthetic/token-hashes.json'), hash_mount=types.SimpleNamespace(name=scratch), acceptance_run_id='f' * 32)
            with mock.patch.object(os, 'geteuid', return_value=0), mock.patch.object(os, 'chown') as chown, mock.patch.object(os, 'lchown') as lchown:
                exec(block, namespace)
            self.assertEqual(len(calls), 1)
            arguments = calls[0]
            self.assertEqual(arguments[:3], ['docker', 'run', '--detach'])
            self.assertEqual(arguments[-1], image)
            projection = pathlib.Path(namespace['projection'])
            self.assertNotEqual(str(projection), str(fixture.directory))
            self.assertIn('type=bind,source=' + str(projection) + ',target=/run/config/mcp-revocations,readonly', arguments)
            for variable in ('STADTSTACK_MCP_RELEASE_DIR=/app/release', 'STADTSTACK_MCP_REVOCATION_TRUST_FILE=/run/config/mcp-revocations/trust.json', 'STADTSTACK_MCP_REVOCATIONS_FILE=/run/config/mcp-revocations/revocations.json'):
                self.assertEqual(arguments[arguments.index(variable) - 1], '--env')
            revision = next(path for path in projection.iterdir() if path.name.startswith('..20'))
            self.assertEqual(projection.lstat().st_mode & 0o7777, 0o3777)
            self.assertEqual(revision.lstat().st_mode & 0o7777, 0o2755)
            for name in ('trust.json', 'revocations.json'):
                self.assertEqual((revision / name).stat().st_mode & 0o7777, 0o444)
                self.assertEqual((revision / name).read_bytes(), (fixture.directory / name).read_bytes())
                self.assertEqual(os.readlink(projection / name), '..data/' + name)
            self.assertEqual(os.readlink(projection / '..data'), revision.name)
            self.assertEqual(len(chown.call_args_list), 4)
            self.assertEqual(len(lchown.call_args_list), 3)

    def test_changed_file_metadata_is_rejected(self):
        validator = smoke_namespace('revocation_cohort')['revocation_cohort']
        with synthetic_cohort() as fixture:
            reads = 0
            def changed(fd):
                nonlocal reads
                reads += 1
                value = fixture.root_metadata(fixture.real_fstat(fd))
                if reads == 2:
                    value.st_mtime_ns += 1
                return value
            with mock.patch.object(os, 'fstat', changed), self.assertRaisesRegex(ValueError, 'changed while being read'):
                validator(str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)

    def test_wrong_artifact_or_manifest_is_rejected(self):
        validator = smoke_namespace('revocation_cohort')['revocation_cohort']
        with synthetic_cohort() as fixture:
            for artifact_sha, manifest in [('d' * 64, fixture.manifest), (fixture.artifact_sha, 'f' * 64)]:
                with self.subTest(artifact_sha=artifact_sha, manifest=manifest), self.assertRaises(ValueError):
                    validator(str(fixture.trust_path), str(fixture.artifact_path), artifact_sha, manifest)
            fixture.artifact_path.chmod(0o600)
            fixture.artifact_path.write_bytes(fixture.artifact_path.read_bytes() + b'\n')
            fixture.artifact_path.chmod(0o444)
            with self.assertRaisesRegex(ValueError, 'artifact SHA256 mismatch'):
                validator(str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)

    def test_mixed_directory_or_extra_private_material_is_rejected(self):
        validator = smoke_namespace('revocation_cohort')['revocation_cohort']
        with synthetic_cohort() as fixture, tempfile.TemporaryDirectory() as other:
            with self.assertRaisesRegex(ValueError, 'one absolute directory'):
                validator(str(fixture.trust_path), str(pathlib.Path(other) / 'revocations.json'), fixture.artifact_sha, fixture.manifest)
            (fixture.directory / 'not-public.pem').write_text('synthetic, never a key')
            with self.assertRaisesRegex(ValueError, 'must contain only'):
                validator(str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)

    def test_writable_unreadable_symlink_and_oversized_files_are_rejected(self):
        validator = smoke_namespace('revocation_cohort')['revocation_cohort']
        with synthetic_cohort() as fixture:
            for mode in (0o644, 0o440, 0o666):
                fixture.trust_path.chmod(mode)
                with self.subTest(mode=oct(mode)), self.assertRaisesRegex(ValueError, 'container-readable regular files'):
                    validator(str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)
            fixture.trust_path.chmod(0o600)
            fixture.trust_path.write_bytes(b'x' * (64 * 1024 + 1)); fixture.trust_path.chmod(0o444)
            with self.assertRaisesRegex(ValueError, 'bounded root-owned'):
                validator(str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)
            fixture.trust_path.unlink()
            fixture.trust_path.symlink_to(fixture.artifact_path)
            with self.assertRaises(OSError):
                validator(str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)

    def test_non_root_files_and_unsafe_directory_are_rejected(self):
        validator = smoke_namespace('revocation_cohort')['revocation_cohort']
        with synthetic_cohort() as fixture:
            def unowned(fd):
                value = fixture.root_metadata(fixture.real_fstat(fd)); value.st_uid = 1000
                return value
            with mock.patch.object(os, 'fstat', unowned), self.assertRaisesRegex(ValueError, 'root-owned'):
                validator(str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)
            for mode in (0o777, 0o750):
                fixture.directory.chmod(mode)
                with self.subTest(mode=oct(mode)), self.assertRaisesRegex(ValueError, 'directory chain'):
                    validator(str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)
            fixture.directory.chmod(0o755)

    def test_public_trust_rejects_private_fields_and_key_identity_mismatch(self):
        validator = smoke_namespace('revocation_cohort')['revocation_cohort']
        with synthetic_cohort() as fixture:
            mutations = [
                lambda trust: trust['keys'][0].update(privateKey='synthetic'),
                lambda trust: trust['keys'][0].update(keyId='ed25519:' + 'f' * 64),
                lambda trust: trust.update(releaseId='f' * 64),
                lambda trust: trust.update(expectedArtifactSha256='f' * 64),
            ]
            for mutate in mutations:
                trust = json.loads(json.dumps(fixture.trust)); mutate(trust)
                fixture.trust_path.chmod(0o600); fixture.trust_path.write_text(json.dumps(trust)); fixture.trust_path.chmod(0o444)
                with self.subTest(trust=trust), self.assertRaises(ValueError):
                    validator(str(fixture.trust_path), str(fixture.artifact_path), fixture.artifact_sha, fixture.manifest)

    def test_032_missing_cohort_is_rejected_before_credentials_or_commands(self):
        image = 'ghcr.io/giraeffleaeffle/stadtstack-mcp:0.3.2@sha256:' + 'f' * 64
        result = subprocess.run([sys.executable, '-I', str(ROOT / 'smoke.py'), '--image', image, '--release-version', '0.3.2', '--evidence', '/unused-synthetic-receipt'], env={'PATH': os.defpath, 'HOME': '/nonexistent-synthetic-home'}, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('0.3.2 and later require', result.stderr)

    def test_administrative_view_binds_exact_release_artifact_and_sequence(self):
        manifest, artifact_sha = 'c' * 64, 'd' * 64
        identity = json.dumps(['stadtstack-mcp-read-view-v1', manifest, artifact_sha], separators=(',', ':'))
        view = {'kind': 'signed_administrative_revocation', 'releaseId': manifest, 'revocationsSha256': artifact_sha, 'viewId': hashlib.sha256(identity.encode()).hexdigest(), 'sequence': 4, 'issuedAt': '2026-10-11T00:00:00.000Z', 'meaning': 'Administrative withholding, not civic withdrawal'}
        def namespace():
            return smoke_namespace('administrative_view', args=types.SimpleNamespace(data_manifest_id=manifest), checks={'envelopeRelease': manifest}, cohort={'revocationArtifactSha256': artifact_sha, 'payload': {'sequence': 4, 'issuedAt': view['issuedAt']}})
        accepted = namespace(); accepted['administrative_view'](view)
        self.assertEqual(accepted['checks']['administrativeView'], view)
        for field, invalid in [('releaseId', 'f' * 64), ('revocationsSha256', 'f' * 64), ('viewId', 'f' * 64), ('sequence', 3), ('issuedAt', '2026-10-10T00:00:00.000Z')]:
            with self.subTest(field=field), self.assertRaises(AssertionError):
                namespace()['administrative_view']({**view, field: invalid})

    def test_member_of_is_an_asserted_directed_non_action_relation(self):
        module = ast.parse((ROOT / 'smoke.py').read_text())
        mapping = next(node for node in module.body if assigned_name(node) == 'PATH_MODALITY_BY_TYPE')
        namespace = smoke_namespace('graph_path_eligible', PATH_MODALITY_BY_TYPE=ast.literal_eval(mapping.value))
        self.assertTrue(namespace['graph_path_eligible']({'type': 'member_of', 'modality': 'asserted'}))
        self.assertFalse(namespace['graph_path_eligible']({'type': 'member_of', 'modality': 'planned'}))
        self.assertFalse(namespace['graph_path_eligible']({'type': 'plans', 'modality': 'asserted'}))


class ChartRendererTests(unittest.TestCase):
    def renderer(self):
        specification = importlib.util.spec_from_file_location('synthetic_chart_renderer', ROOT / 'render.py')
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module.render_chart

    def test_deterministic_manifest_preserves_governed_directory_mount(self):
        render = self.renderer()
        arguments = (ROOT / 'chart', '0.3.2', 'sha256:' + 'b' * 64, 'd' * 64)
        first = render(*arguments, trust_sha256='e' * 64)
        self.assertEqual(first, render(*arguments, trust_sha256='e' * 64))
        self.assertNotIn('{{', first); self.assertNotIn('}}', first)
        # Deployment, Service, Ingress and three unchanged NetworkPolicies.
        self.assertEqual(len(first.split('\n---\n')), 6)
        for kind in ('Deployment', 'Service', 'Ingress', 'NetworkPolicy'):
            self.assertIn('kind: ' + kind + '\n', first)
        self.assertIn('image: "ghcr.io/giraeffleaeffle/stadtstack-mcp:0.3.2@sha256:' + 'b' * 64 + '"', first)
        self.assertIn('replicas: 1\n', first); self.assertIn('type: Recreate\n', first)
        for name, path in [('STADTSTACK_MCP_RELEASE_DIR', '/app/release'), ('STADTSTACK_MCP_REVOCATION_TRUST_FILE', '/run/config/mcp-revocations/trust.json'), ('STADTSTACK_MCP_REVOCATIONS_FILE', '/run/config/mcp-revocations/revocations.json')]:
            self.assertIn('name: ' + name + '\n              value: ' + path, first)
        self.assertIn('mountPath: /run/config/mcp-revocations\n              readOnly: true', first)
        self.assertIn('name: stadtstack-mcp-revocations\n            optional: false\n            defaultMode: 0444', first)
        self.assertIn('key: trust.json\n                path: trust.json', first)
        self.assertIn('key: revocations.json\n                path: revocations.json', first)
        self.assertNotIn('subPath:', first)
        self.assertIn('revocation-artifact-sha256: "' + 'd' * 64 + '"', first)
        self.assertIn('revocation-trust-sha256: "' + 'e' * 64 + '"', first)
        updated_artifact = render(ROOT / 'chart', '0.3.2', 'sha256:' + 'b' * 64, 'f' * 64, trust_sha256='e' * 64)
        updated_trust = render(*arguments, trust_sha256='f' * 64)
        self.assertEqual(first.replace('d' * 64, 'f' * 64), updated_artifact)
        self.assertEqual(first.replace('e' * 64, 'f' * 64), updated_trust)

    def test_renderer_rejects_mutable_images_invalid_versions_and_injection(self):
        render = self.renderer()
        defaults = {'chart': ROOT / 'chart', 'release_version': '0.3.2', 'digest': 'sha256:' + 'b' * 64, 'artifact_sha256': 'd' * 64, 'trust_sha256': 'e' * 64}
        for field, invalid in [('release_version', '0.3.1'), ('release_version', 'v0.3.2'), ('digest', 'latest'), ('digest', 'sha256:' + '0' * 64), ('artifact_sha256', 'bad'), ('trust_sha256', 'bad'), ('token_revision', '1\ninjected: true')]:
            with self.subTest(field=field, invalid=invalid), self.assertRaises(ValueError):
                render(**{**defaults, field: invalid})

    def test_renderer_rejects_unknown_template_expression(self):
        render = self.renderer()
        with tempfile.TemporaryDirectory() as temporary:
            chart = pathlib.Path(temporary) / 'chart'
            shutil.copytree(ROOT / 'chart', chart)
            service = chart / 'templates/service.yaml'
            service.write_text(service.read_text() + '\nunknown: {{ .Values.unknown }}\n')
            with self.assertRaisesRegex(ValueError, 'Unsupported chart expression'):
                render(chart, '0.3.2', 'sha256:' + 'b' * 64, 'd' * 64, trust_sha256='e' * 64)

if __name__ == '__main__':
    unittest.main()
