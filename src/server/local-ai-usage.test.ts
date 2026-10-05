import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedOutputTokens } from './local-ai-usage.ts';
import { runLocalInference } from './local-ai-runtime.ts';

test('chargeable tokens are the minimum of reported count, prediction cap and received UTF-8 bytes', () => {
  assert.equal(boundedOutputTokens(10000, 128, 'é', '思考'), 8);
  assert.equal(boundedOutputTokens(10000, 4, 'é', '思考'), 4);
  assert.equal(boundedOutputTokens(3, 128, 'é', '思考'), 3);
  assert.equal(boundedOutputTokens(0, 128, 'answer', ''), 0);
  assert.equal(boundedOutputTokens(10000, 128, 'x', { hidden: 'not returned text' }), 1);
  for (const count of [null, undefined, -1, 1.5, Infinity, '20']) {
    assert.equal(boundedOutputTokens(count, 128, 'answer', ''), null);
  }
});

test('direct Ollama inference uses the same bound for both payment networks', async () => {
  const previous = process.env.LOCAL_AI_OLLAMA_URL;
  process.env.LOCAL_AI_OLLAMA_URL = 'http://model.invalid';
  try {
    const fetcher: typeof fetch = async (_url, init) => {
      const job = JSON.parse(String(init?.body));
      assert.equal(job.options.num_predict, 16);
      return Response.json({ model: job.model, done: true, done_reason: 'stop',
        message: { content: 'é', thinking: '思考' }, eval_count: 10000 });
    };
    const result = await runLocalInference({ prompt: 'question', context: 'general', maxOutputTokens: 16 }, fetcher);
    assert.equal(result.usage.outputTokens, 8);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_AI_OLLAMA_URL;
    else process.env.LOCAL_AI_OLLAMA_URL = previous;
  }
});
