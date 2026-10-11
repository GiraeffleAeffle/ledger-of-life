"""Synthetic acceptance-boundary tests: no Docker, network, credentials or cluster."""
import ast
import base64
import datetime
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
from stat import S_ISREG

ROOT = pathlib.Path(__file__).resolve().parent


def assigned_name(node):
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        return node.targets[0].id
    return None


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
        revision, digest, version, manifest = 'a' * 40, 'sha256:' + 'b' * 64, '0.3.1', 'c' * 64
        image_tag = 'ghcr.io/giraeffleaeffle/stadtstack-mcp:' + version
        image = image_tag + '@' + digest
        producer = '''import json,os,pathlib,sys
args=sys.argv
value=lambda key:args[args.index(key)+1]
assert not any(key in os.environ for key in ('KUBECONFIG','KUBECTL','TALOSCONFIG','TALOSCTL','STADTSTACK_PRIVILEGED_LOCK_OWNER'))
version=value('--release-version');image=value('--image');revision='a'*40;manifest='c'*64
checks={'serverVersion':version,'statusReleaseVersion':version,'imageVersion':version,'imageRefName':version,'imageRevision':revision,'gitTag':version,'gitTagRevision':revision,'imageTagDigest':'sha256:'+'b'*64,'statusDataManifestId':manifest,'sharedDataRelease':manifest}
receipt={'passed':True,'image':image,'imageTag':version,'imageTagReference':image.split('@')[0],'releaseVersion':version,'acceptanceScope':'exact_local_image','runId':value('--run-id'),'imageProvenanceVerified':True,'runningImageIdentityVerified':True,'checks':checks}
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
        supplied = 'ghcr.io/giraeffleaeffle/stadtstack-mcp:0.3.1@sha256:' + 'f' * 64
        evidence = {'passed': True}
        namespace = {'args': types.SimpleNamespace(url='https://example.invalid', image=supplied, release_version='0.3.1'), 'evidence': evidence, 'image_tag': supplied.split('@')[0]}
        exec(compile(ast.Module(body=candidates, type_ignores=[]), '<live-evidence-scope>', 'exec'), namespace)
        self.assertEqual(evidence['acceptanceScope'], 'public_endpoint_version_data')
        self.assertFalse(evidence['imageProvenanceVerified'])
        self.assertFalse(evidence['runningImageIdentityVerified'])
        self.assertEqual(evidence['suppliedImageReference'], supplied)
        self.assertNotIn('image', evidence)

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
        last = next(i for i, node in enumerate(module.body) if assigned_name(node) == 'hashpath')
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

if __name__ == '__main__':
    unittest.main()
