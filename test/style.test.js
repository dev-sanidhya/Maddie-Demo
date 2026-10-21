'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeReply, tidyEmojis, polish, emojisIn } = require('../core/validator');
const { Agent } = require('../core/agent');
const { DEFAULTS, sanitize } = require('../core/settings');

const lead = { meta: {} };
const light = (t, o = {}) => sanitizeReply(t, lead, { emojis: 'light', ...o });

test('light mode keeps at most two tasteful emojis, one per sentence, from the approved set', () => {
  assert.strictEqual(emojisIn(light('Lovely, a 3BHK in Kharadi ✨ Do you have a style in mind 🏡 🎨 🌿?')).length <= 2, true);
  assert.strictEqual(light('That sounds great 😂🔥💯'), 'That sounds great');
  assert.strictEqual(light('Two in one sentence ✨🏡 is too many'), 'Two in one sentence ✨ is too many');
  assert.deepStrictEqual(emojisIn(light('A 🏡 thought. Another 🏡 thought. A third ✨ one. And 🎨 more.')), ['🏡', '✨']);
});

test('emojis come on about every other message, never two in a row, and declines carry none', () => {
  assert.strictEqual(light('Sounds lovely ✨', { previous: 'Welcome to Interio Arty ✨' }), 'Sounds lovely');
  assert.strictEqual(light('Sounds lovely 🏡', { previous: 'Welcome to Interio Arty ✨' }), 'Sounds lovely', 'the message after an emoji goes plain');
  assert.strictEqual(light('Sounds lovely 🏡', { previous: 'Welcome to Interio Arty.' }), 'Sounds lovely 🏡');
  assert.strictEqual(light('Thank you for sharing, we cannot take this one on 🙏✨', { declining: true }), 'Thank you for sharing, we cannot take this one on');
});

test('with emojis off the text is left exactly as the model wrote it', () => {
  assert.strictEqual(sanitizeReply('Hello there 😊', lead, { emojis: 'off' }), 'Hello there 😊');
});

test('polish removes filler openers, stock chatbot phrases and extra exclamation marks', () => {
  assert.strictEqual(polish('Absolutely! A modular kitchen suits that space well.'), 'A modular kitchen suits that space well.');
  assert.strictEqual(polish("Great question, a typical home takes 6 to 10 weeks. I'm here to help with anything else."), 'A typical home takes 6 to 10 weeks.');
  assert.strictEqual(polish('Lovely! Warm woods would work! Shall we plan it!'), 'Lovely! Warm woods would work. Shall we plan it.');
  assert.strictEqual(sanitizeReply('Certainly! We handle the civil work too.', lead, { polish: true }), 'We handle the civil work too.');
  assert.strictEqual(sanitizeReply('Certainly! We handle the civil work too.', lead, {}), 'Certainly! We handle the civil work too.', 'off by default');
});

test('settings default to plain replies, and only accept the two known emoji modes', () => {
  const s = sanitize(JSON.parse(JSON.stringify(DEFAULTS)));
  assert.strictEqual(s.agent.emojis, 'off');
  assert.strictEqual(s.agent.polish, false);
  const t = JSON.parse(JSON.stringify(DEFAULTS)); t.agent.emojis = 'lots'; t.agent.polish = 1;
  const u = sanitize(t);
  assert.strictEqual(u.agent.emojis, 'off');
  assert.strictEqual(u.agent.polish, true);
});

test('the prompt only invites emojis and the premium standard when the studio turned them on', async () => {
  const seen = [];
  const agent = new Agent({ llm: { complete: async (o) => { seen.push(o.system); return 'Hello there.'; } } });
  const base = JSON.parse(JSON.stringify(DEFAULTS));
  const ctx = (agentCfg) => ({ lead: { meta: {}, name: 'Riya' }, settings: { ...base, agent: { ...base.agent, ...agentCfg } }, designer: null, summary: '' });
  await agent.reply({ type: 'ASK', field: 'city' }, ctx({}), [{ role: 'user', text: 'hi' }]);
  await agent.reply({ type: 'ASK', field: 'city' }, ctx({ emojis: 'light', polish: true }), [{ role: 'user', text: 'hi' }]);
  assert.match(seen[0], /No emojis unless the customer used them first/);
  assert.doesNotMatch(seen[0], /WRITING STANDARD/);
  assert.match(seen[1], /ONE small, tasteful emoji/);
  assert.match(seen[1], /WRITING STANDARD/);
  assert.doesNotMatch(seen[1], /No emojis unless/);
});

test('design-brochure clichés are dropped so replies stay specific', () => {
  assert.strictEqual(polish('Warm woods can create a really cozy and inviting atmosphere. Brass fittings pair well with them.'), 'Brass fittings pair well with them.');
  assert.strictEqual(polish('That sounds like a wonderful space. With possession next month we can start straight away.'), 'With possession next month we can start straight away.');
});
