'use strict';
// Reliable LLM access across one or more providers (any OpenAI-compatible API):
// soft RPM limiter, per-call timeout, retry with backoff (honouring Retry-After),
// automatic model fallback, automatic PROVIDER fallback (with a cooldown when a
// provider is out of quota or unauthorised), and tolerant JSON parsing.
// Every failure mode ends in either a result or a thrown LlmError; callers
// always have a deterministic fallback, so a flaky provider never silences the bot.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LlmError extends Error {}

function extractJson(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// Daily free allocations and hard quotas do not recover by retrying in a few seconds.
const QUOTA_TEXT = /(daily free allocation|used up|quota|exceeded your current|insufficient_quota|billing|upgrade to)/i;

class Llm {
  constructor(cfg, { fetchImpl } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl || globalThis.fetch;
    this.providers = cfg.providers || [{
      name: 'primary', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey,
      models: [cfg.model, cfg.fallbackModel].filter(Boolean), tpm: cfg.tpm,
    }];
    this.stamps = [];
    this.tok = {};
    this.cool = {}; // provider name -> epoch ms until which it is skipped
    this.usage = {};
    this.onUsage = null;
    this.stats = { calls: 0, failures: 0, fallbacks: 0, lastOkAt: null, lastError: null, lastLatencyMs: null, lastProvider: null };
    this.override = null; // tests / offline mode: async ({system, messages, json}) => string
  }

  get enabled() { return !!(this.override || this.providers.some((p) => p.apiKey)); }

  providerStatus() {
    const now = Date.now();
    return this.providers.map((p) => ({ name: p.name, configured: !!p.apiKey, cooling: (this.cool[p.name] || 0) > now, until: this.cool[p.name] || null }));
  }

  async throttle() {
    const limit = this.cfg.maxRpm;
    if (!limit) return;
    for (;;) {
      const t = Date.now();
      this.stamps = this.stamps.filter((x) => t - x < 60000);
      if (this.stamps.length < limit) { this.stamps.push(t); return; }
      await sleep(Math.min(2000, 60000 - (t - this.stamps[0]) + 25));
    }
  }

  estimate(o) {
    const size = (c) => (Array.isArray(c) ? c.reduce((n, p) => n + (p.type === 'image_url' ? 3000 : String(p.text || '').length), 0) : String(c).length);
    const chars = (o.system || '').length + o.messages.reduce((n, m) => n + size(m.content), 0);
    return Math.ceil(chars / 3.6) + Math.min(o.maxTokens || 500, 350);
  }
  used(key) {
    const t = Date.now();
    const arr = (this.tok[key] || []).filter((x) => t - x.t < 60000);
    this.tok[key] = arr;
    return arr.reduce((n, x) => n + x.n, 0);
  }
  // Exact token counts as the provider reports them, in memory (this.usage) and, through onUsage, in the database.
  record(provider, model, usage) {
    const u = usage || {};
    const prompt = Number(u.prompt_tokens) || 0;
    const completion = Number(u.completion_tokens) || 0;
    const row = (this.usage[model] = this.usage[model] || { calls: 0, prompt: 0, completion: 0 });
    row.calls++; row.prompt += prompt; row.completion += completion;
    if (this.onUsage) { try { this.onUsage({ provider, model, prompt, completion }); } catch { /* accounting must never break a reply */ } }
  }
  hasRoom(c, est) { return !c.provider.tpm || this.used(c.key) + est <= c.provider.tpm; }

  async rawCall(c, { system, messages, json, maxTokens, temperature, thinking }, { dropReasoning = false } = {}) {
    await this.throttle();
    const { provider, model } = c;
    const est = this.estimate({ system, messages, maxTokens });
    const entry = { t: Date.now(), n: est };
    (this.tok[c.key] = this.tok[c.key] || []).push(entry);
    if (provider.kind === 'anthropic') return this.anthropicCall(c, { system, messages, json, maxTokens, temperature, thinking }, entry);
    const body = {
      model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      temperature,
      max_tokens: maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };
    if (/gpt-oss/.test(model) && !dropReasoning) body.reasoning_effort = 'low';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    const t0 = Date.now();
    try {
      const res = await this.fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new LlmError(`LLM ${res.status}: ${errText.slice(0, 300)}`);
        err.status = res.status;
        err.quota = res.status === 429 && QUOTA_TEXT.test(errText);
        err.retryAfter = Number(res.headers.get('retry-after')) || Number((errText.match(/try again in ([\d.]+)s/i) || [])[1]) || 0;
        throw err;
      }
      const data = await res.json();
      if (data.usage && data.usage.total_tokens) entry.n = data.usage.total_tokens;
      this.record(provider.name, model, data.usage);
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text || !String(text).trim()) throw new LlmError('LLM returned empty content');
      this.stats.lastLatencyMs = Date.now() - t0;
      return String(text).trim();
    } catch (e) {
      if (e.name === 'AbortError') { const err = new LlmError('LLM timeout'); err.status = 408; throw err; }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Claude on api.anthropic.com with a Claude Code OAuth token (from "claude setup-token"). The token is only accepted when the
  // system prompt starts with the Claude Code line, so that line is sent first and our own instructions follow as a second block.
  async anthropicCall(c, { system, messages, json, maxTokens, temperature, thinking }, entry) {
    const { provider, model } = c;
    const blocks = (content) => (Array.isArray(content)
      ? content.map((p) => {
        if (p.type === 'image_url') { const m = /^data:([^;]+);base64,(.+)$/.exec((p.image_url && p.image_url.url) || ''); return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null; }
        return { type: 'text', text: String(p.text || '') };
      }).filter(Boolean)
      : String(content));
    const msgs = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks(m.content) }));
    if (json && msgs.length && typeof msgs[msgs.length - 1].content === 'string') msgs[msgs.length - 1].content += `${'\n'}${'\n'}Reply with one JSON object only, no prose and no code fences.`;
    const body = {
      model, max_tokens: Math.max(maxTokens || 0, thinking ? thinking + 4000 : 4000), thinking: thinking ? { type: 'enabled', budget_tokens: thinking } : { type: 'disabled' }, messages: msgs,
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }, ...(system ? [{ type: 'text', text: system }] : [])],
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    const t0 = Date.now();
    try {
      const res = await this.fetch(`${provider.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new LlmError(`LLM ${res.status}: ${errText.slice(0, 300)}`);
        err.status = res.status;
        err.quota = res.status === 429 && /(usage limit|limit reached|credit|quota)/i.test(errText);
        err.retryAfter = Number(res.headers.get('retry-after')) || 0;
        throw err;
      }
      const data = await res.json();
      const u = data.usage || {};
      this.record(provider.name, model, { prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), completion_tokens: u.output_tokens || 0 });
      entry.n = (u.input_tokens || 0) + (u.output_tokens || 0) || entry.n;
      if (process.env.CONCIERGE_DEBUG) console.error('[claude] stop=' + data.stop_reason + ' out=' + (u.output_tokens || 0) + ' max=' + Math.max(maxTokens || 0, 4000) + ' blocks=' + (data.content || []).map((b) => b.type).join(','));
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text.trim()) throw new LlmError('LLM returned empty content');
      this.stats.lastLatencyMs = Date.now() - t0;
      return text.trim();
    } catch (e) {
      if (e.name === 'AbortError') { const err = new LlmError('LLM timeout'); err.status = 408; throw err; }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  candidates(o) {
    const out = [];
    const now = Date.now();
    this.providers.forEach((p, pi) => {
      if (!p.apiKey || (this.cool[p.name] || 0) > now) return;
      const models = pi === 0 && o.model ? [o.model, ...p.models.filter((m) => m !== o.model)] : p.models;
      for (const model of models) out.push({ provider: p, model, key: `${p.name}:${model}`, rank: out.length });
    });
    return out;
  }

  // One logical call. Order of preference: provider 1's models, then provider 2's, and so on.
  // A 429 about quota puts the provider on cooldown and moves on at once; an ordinary
  // rate limit hops to the next candidate. Timeouts and 5xx get one quick retry each.
  async complete(opts) {
    this.stats.calls++;
    const o = { maxTokens: 700, temperature: 0.4, json: false, ...opts };
    if (this.override) return this.override(o);
    if (!this.enabled) throw new LlmError('No LLM API key configured');
    const est = this.estimate(o);
    const flags = {};
    let lastErr;
    for (let round = 0; round < 3; round++) {
      const cands = this.candidates(o);
      if (!cands.length) break; // every provider is cooling down: fail fast, callers have fallbacks
      for (let w = 0; w < 10 && !cands.some((c) => this.hasRoom(c, est)); w++) await sleep(1500);
      const ordered = [...cands.filter((c) => this.hasRoom(c, est)), ...cands.filter((c) => !this.hasRoom(c, est))];
      let wait = 0;
      for (const c of ordered) {
        if ((this.cool[c.provider.name] || 0) > Date.now()) continue;
        const fl = (flags[c.key] = flags[c.key] || { json: o.json, dropReasoning: false });
        for (let a = 0; a < 2; a++) {
          try {
            const text = await this.rawCall(c, { ...o, json: fl.json }, { dropReasoning: fl.dropReasoning });
            this.stats.lastOkAt = Date.now();
            this.stats.lastProvider = c.key;
            if (c.rank > 0) this.stats.fallbacks++;
            return text;
          } catch (e) {
            lastErr = e;
            this.stats.lastError = `${c.key}: ${e.message}`.slice(0, 300);
            if (e.status === 400) { // provider rejected an optional parameter: strip it, retry now
              if (fl.json) { fl.json = false; continue; }
              if (!fl.dropReasoning) { fl.dropReasoning = true; continue; }
              break;
            }
            if (e.quota) { this.cool[c.provider.name] = Date.now() + 30 * 60000; break; }
            if (e.status === 401 || e.status === 403) { this.cool[c.provider.name] = Date.now() + 10 * 60000; break; }
            if (e.status === 404) break;
            if (e.status === 429) { wait = wait ? Math.min(wait, e.retryAfter || 3) : (e.retryAfter || 3); break; }
            if (a === 0) await sleep(400);
          }
        }
      }
      if (round < 2) await sleep(Math.min(8000, Math.max(600, wait * 1000)));
    }
    this.stats.failures++;
    throw lastErr || new LlmError('LLM failed');
  }

  // Looks at one picture and answers the prompt in plain text. Tries each provider's vision model in turn
  // (the two Cloudflare accounts), so an exhausted free allowance on one does not stop photos from being read.
  async vision(opts) {
    this.stats.calls++;
    const o = { maxTokens: 200, temperature: 0.2, ...opts };
    if (this.override) return this.override({ ...o, vision: true, system: o.system || '', messages: [{ role: 'user', content: o.prompt }] });
    const { mime, bytes } = o.image || {};
    if (!bytes || !bytes.length) throw new LlmError('No image to look at');
    const messages = [{ role: 'user', content: [{ type: 'text', text: o.prompt }, { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${Buffer.from(bytes).toString('base64')}` } }] }];
    let lastErr;
    const now = Date.now();
    for (const provider of this.providers) {
      if (!provider.apiKey || !(provider.visionModels || []).length || (this.cool[provider.name] || 0) > now) continue;
      for (const model of provider.visionModels) {
        try {
          const text = await this.rawCall({ provider, model, key: `${provider.name}:${model}`, rank: 0 }, { system: o.system, messages, json: false, maxTokens: o.maxTokens, temperature: o.temperature });
          this.stats.lastOkAt = Date.now();
          return text;
        } catch (e) {
          lastErr = e;
          this.stats.lastError = `${provider.name}:${model}: ${e.message}`.slice(0, 300);
          if (e.quota) this.cool[provider.name] = Date.now() + 30 * 60000;
          else if (e.status === 401 || e.status === 403) this.cool[provider.name] = Date.now() + 10 * 60000;
        }
      }
    }
    this.stats.failures++;
    throw lastErr || new LlmError('No vision model is configured');
  }

  // JSON completion: asks for JSON, tolerates fences/prose, retries once if unparsable.
  async completeJson(opts) {
    let lastText = '';
    for (let i = 0; i < 2; i++) {
      lastText = await this.complete({ ...opts, json: true, temperature: 0.1, maxTokens: opts.maxTokens || 900 });
      if (typeof lastText === 'object') return lastText;
      const parsed = extractJson(lastText);
      if (parsed) return parsed;
    }
    throw new LlmError(`Unparsable JSON from model: ${String(lastText).slice(0, 120)}`);
  }
}

module.exports = { Llm, LlmError, extractJson };
