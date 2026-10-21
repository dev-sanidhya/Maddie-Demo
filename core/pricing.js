'use strict';
// What AI calls cost. Cloudflare Workers AI bills in "neurons" (about $0.011 per 1,000) after a free
// allowance of 10,000 neurons per account per day. Prices are per million tokens, taken from
// developers.cloudflare.com/workers-ai/platform/pricing (check there if they change).
const FREE_NEURONS_PER_DAY = 10000;
const USD_PER_1K_NEURONS = 0.011;
const MODELS = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { inUsd: 0.293, outUsd: 2.253, inNeurons: 26668, outNeurons: 204805 },
  '@cf/openai/gpt-oss-120b': { inUsd: 0.35, outUsd: 0.75, inNeurons: 31818, outNeurons: 68182 },
};
const priceOf = (model) => MODELS[model] || null; // other providers (the Groq backup) are not priced here

function cost(rows) {
  let usd = 0; let neurons = 0; let unpriced = 0;
  for (const r of rows) {
    const p = priceOf(r.model);
    if (!p) { unpriced += (r.prompt_tokens || 0) + (r.completion_tokens || 0); continue; }
    usd += ((r.prompt_tokens || 0) * p.inUsd + (r.completion_tokens || 0) * p.outUsd) / 1e6;
    neurons += ((r.prompt_tokens || 0) * p.inNeurons + (r.completion_tokens || 0) * p.outNeurons) / 1e6;
  }
  return { usd, neurons: Math.round(neurons), unpriced_tokens: unpriced };
}
module.exports = { MODELS, priceOf, cost, FREE_NEURONS_PER_DAY, USD_PER_1K_NEURONS };
