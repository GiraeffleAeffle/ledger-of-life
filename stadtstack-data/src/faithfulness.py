"""DeepEval FaithfulnessMetric over source excerpts; never publishes source text."""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from io import StringIO
from deepeval.metrics import FaithfulnessMetric
from deepeval.models import DeepEvalBaseLLM
from deepeval.test_case import LLMTestCase

class CodexJudge(DeepEvalBaseLLM):
    def load_model(self):
        return self

    def get_model_name(self):
        return 'codex:gpt-6-luna'

    def generate(self, prompt, **kwargs):
        with tempfile.NamedTemporaryFile(suffix='.txt', dir='cache', delete=False) as output:
            path = output.name
        try:
            command = ['codex', 'exec', '-m', 'gpt-6-luna', '-s', 'read-only', '--skip-git-repo-check', '-o', path, 'Return only a JSON object valid for the requested schema. No markdown. ' + prompt]
            result = subprocess.run(command, capture_output=True, text=True, timeout=180)
            if result.returncode:
                raise RuntimeError(result.stderr[-1000:])
            with open(path) as handle:
                return handle.read()
        finally:
            os.unlink(path)

    async def a_generate(self, prompt, **kwargs):
        return await asyncio.to_thread(self.generate, prompt, **kwargs)

if __name__ == '__main__':
    payload = json.load(sys.stdin)
    mode = payload.get('mode', 'llm')
    if mode not in ('llm', 'hybrid', 'system_one'):
        raise ValueError('mode must be llm, hybrid, or system_one')
    if mode != 'llm' and not os.environ.get('TYPESAFE_API_KEY'):
        raise RuntimeError('TYPESAFE_API_KEY is required for Jev modes (value redacted)')
    kwargs = {'threshold': payload.get('threshold', 0.8), 'async_mode': False, 'include_reason': True,
              'penalize_ambiguous_claims': payload.get('penalize_ambiguous_claims', True)}
    if mode != 'llm':
        kwargs['eval_mode'] = mode
    if mode != 'system_one':
        kwargs['model'] = CodexJudge()

    evaluator = FaithfulnessMetric(**kwargs)
    case = LLMTestCase(input='Fasse ausschließlich den folgenden öffentlichen Quellenausschnitt in eigenen Worten zusammen.', actual_output=payload['statement'], retrieval_context=[payload['source']])
    with redirect_stdout(StringIO()):
        evaluator.measure(case)
    print(json.dumps({'score': evaluator.score, 'reason': evaluator.reason, 'threshold': evaluator.threshold,
                      'evaluator': f'DeepEval FaithfulnessMetric / {mode}' + (' / Jev' if mode != 'llm' else ' / codex:gpt-6-luna')}))
