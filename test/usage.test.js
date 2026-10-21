'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Llm } = require('../core/llm');
const pricing = require('../core/pricing');

test('every AI call records the exact tokens the provider reports', async () => {
  const seen = [];
  const cfg = { apiKey: 'k', baseUrl: 'http://x', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', fallbackModel: '', maxRpm: 0, tpm: 0, timeoutMs: 5000, providers: [{ name: 'cloudflare', baseUrl: 'http://x', apiKey: 'k', models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'], tpm: 0 }] };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } }) });
  const llm = new Llm(cfg, { fetchImpl });
  llm.onUsage = (u) => seen.push(u);
  assert.strictEqual(await llm.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] }), 'hello');
  assert.deepStrictEqual(seen, [{ provider: 'cloudflare', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', prompt: 1200, completion: 80 }]);
  assert.strictEqual(llm.usage['@cf/meta/llama-3.3-70b-instruct-fp8-fast'].prompt, 1200);
});

test('cost: 1M input + 1M output tokens on Llama 3.3 70B is $2.546, and unknown models are flagged not guessed', () => {
  const c = pricing.cost([{ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', prompt_tokens: 1e6, completion_tokens: 1e6 }, { model: 'openai/gpt-oss-120b', prompt_tokens: 500, completion_tokens: 500 }]);
  assert.ok(Math.abs(c.usd - 2.546) < 1e-9);
  assert.ok(Math.abs(c.neurons - 231473) < 2);
  assert.strictEqual(c.unpriced_tokens, 1000);
});
